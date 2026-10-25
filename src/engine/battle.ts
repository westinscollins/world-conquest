/**
 * Battle simulation.
 *
 * Battles run day by day in phases: initial engagement → main fighting → morale & organisation
 * checks → reinforcement & resupply → advance / stalemate / withdrawal → resolution.
 * Combat width limits how many formations can fight at once; reserves rotate in as front-line
 * units lose organisation. Attacks are resolved against the target's defence (or breakthrough when
 * defending against counter-attacks): hits beyond that value are far more damaging, so quality,
 * armour and positions matter more than raw numbers. Randomness is seeded and bounded (±12%/day).
 */
import type { Army, Battle, BattleCommand, BattleFactor, BattleSide, GameState, Posture, SupportKind, Tactic, Unit, War } from './types';
import { COMBAT, POSTURES, TERRAIN, UNITS, WEATHER, MIL, ROE, AIR, SHIPS, TACTICS, TACTIC_EDGE, FLANK_TERRAIN, BATTLE_SUPPORT } from './config';
import { PROV, isStrait, landLinks, distKm } from './geo';
import { Stream } from './rng';
import { armiesIn, atWar, isFriendly, warBetween, invalidateArmies, controlledBy, playerEdge } from './world';
import { armyStrength, armyOrg, armyMorale, armyEquip, qualityOf, setArmyLocation, deleteArmy, armyPower } from './military';
import { provinceWeather } from './weather';
import { addEvent } from './events';
import { setController } from './territory';
import { TRAITS, fleetPower } from './military';
import { battleAirFor, battleSides, navalAir, airNear, rangeOf } from './air';
import { munitionCost } from './strikes';

// ---------------------------------------------------------------- side evaluation
interface SideEval {
  soft: number; hard: number; defense: number; breakthrough: number; hardness: number; recon: number; air: number;
  cas: { soft: number; hard: number }; naval: number; seaCtl: number; airWings: number;
  front: Unit[]; reserve: Unit[]; support: Unit[]; speed: number; width: number;
  supply: number; generalAtk: number; generalDef: number; trait: string;
  equipment: number; quality: number;
}

/**
 * Warships off the coast: the share of the province's waters a side controls (fleets and naval
 * aircraft), and the gunfire its ships there add to the fighting ashore.
 */
export function navalSupport(s: GameState, province: number, leader: string, side: Set<string>, enemy: Set<string>) {
  let control = 0, fire = 0;
  for (const z of PROV[province].seas) {
    let own = navalAir(s, leader, z), hostile = 0, guns = 0;
    for (const f of Object.values(s.fleets)) {
      if (f.sea !== z) continue;
      const n = s.nations[f.owner];
      if (side.has(f.owner)) {
        own += fleetPower(f, n);
        guns += (f.ships.destroyer * SHIPS.destroyer.attack + f.ships.cruiser * SHIPS.cruiser.attack + f.ships.battlegroup * SHIPS.battlegroup.attack) * (n?.techMods.quality.ships ?? 1) * (0.4 + 0.6 * f.org);
      } else if (enemy.has(f.owner)) hostile += fleetPower(f, n);
    }
    const ctl = own > 0 ? own / (own + hostile) : 0;
    control = Math.max(control, ctl);
    if (ctl >= 0.5) fire += guns * ctl;
  }
  return { control, fire: fire * COMBAT.NAVAL_FIRE };
}

function unitEff(u: Unit, q: number) {
  const sp = UNITS[u.type];
  return (u.strength / sp.personnel) * (0.3 + 0.7 * u.equipment) * q * (1 + 0.25 * u.experience) * (0.55 + 0.45 * u.morale);
}

function evaluate(s: GameState, armies: Army[], b: Battle, isAttacker: boolean, widthMult = 1): SideEval {
  const owner = armies[0]?.owner;
  const n = owner ? s.nations[owner] : undefined;
  const t = TERRAIN[b.terrain];
  const all: Unit[] = [];
  let supplyW = 0, supplyT = 0, speed = Infinity;
  let gA = 1, gD = 1, trait = 'none';
  for (const a of armies) {
    for (const u of a.units) all.push(u);
    const w = armyStrength(a);
    supplyW += a.lastSupplyRatio * w; supplyT += w;
    for (const u of a.units) if (u.type !== 'air') speed = Math.min(speed, UNITS[u.type].speed);
    if (a.generalId != null) {
      const g = s.generals[a.generalId];
      if (g && g.attack + g.defense > gA + gD) { gA = g.attack; gD = g.defense; trait = g.trait; }
    }
  }
  // the national air force and navy join in
  const [sa, sd] = battleSides(s, b);
  const nav = navalSupport(s, b.province, isAttacker ? b.attacker.nation : b.defender.nation, isAttacker ? sa : sd, isAttacker ? sd : sa);
  // a landing can only put so many troops ashore at once; holding the sea lets more land
  const width = Math.round(t.width * widthMult * (b.amphibious && isAttacker ? 0.6 + 0.3 * nav.control : 1));
  const line = all.filter((u) => !UNITS[u.type].support && u.strength > 50).sort((x, y) => y.org - x.org);
  const support = all.filter((u) => UNITS[u.type].support && u.strength > 20);
  const front: Unit[] = [];
  let used = 0;
  for (const u of line) {
    if (u.org < 0.08) continue;
    if (used + UNITS[u.type].width > width) break;
    front.push(u); used += UNITS[u.type].width;
  }
  const reserve = line.filter((u) => !front.includes(u));
  const air = battleAirFor(b.id);
  const ev: SideEval = {
    soft: 0, hard: 0, defense: 0, breakthrough: 0, hardness: 0, recon: 0,
    air: (isAttacker ? air?.aSup : air?.dSup) ?? 0, cas: { ...((isAttacker ? air?.aCas : air?.dCas) ?? { soft: 0, hard: 0 }) }, airWings: (isAttacker ? air?.aWings : air?.dWings) ?? 0,
    naval: nav.fire, seaCtl: nav.control,
    front, reserve, support, speed: isFinite(speed) ? speed : 20, width, supply: supplyT ? supplyW / supplyT : 1, generalAtk: gA, generalDef: gD, trait, equipment: 0, quality: 1,
  };
  let hw = 0, eqT = 0, qT = 0;
  for (const u of front) {
    const sp = UNITS[u.type];
    const q = n ? qualityOf(n, u.type) : 1;
    const e = unitEff(u, q) * (0.6 + 0.4 * u.org);
    const terr = u.type === 'armored' || u.type === 'mechanized' ? t.armor : 1;
    ev.soft += sp.soft * e * terr; ev.hard += sp.hard * e * terr;
    ev.defense += sp.defense * e; ev.breakthrough += sp.breakthrough * e * terr;
    ev.hardness += sp.hardness; hw++;
    ev.recon += sp.recon * e;
    eqT += u.equipment; qT += q;
  }
  ev.hardness = hw ? ev.hardness / hw : 0;
  ev.equipment = hw ? eqT / hw : 0;
  ev.quality = hw ? qT / hw : 1;
  for (const u of support) {
    const sp = UNITS[u.type];
    const q = n ? qualityOf(n, u.type) : 1;
    const e = unitEff(u, q) * (0.6 + 0.4 * u.org);
    if (u.type === 'artillery') { ev.soft += sp.soft * e; ev.hard += sp.hard * e; ev.defense += sp.defense * e; }
    if (u.type === 'recon') ev.recon += sp.recon * e * (n?.techMods.recon ?? 1);
    if (u.type === 'air') ev.air += sp.air * e;
    if (u.type === 'engineers') ev.defense += sp.defense * e;
  }
  return ev;
}

const posture = (armies: Army[]): Posture => armies[0]?.posture ?? 'balanced';

// ---------------------------------------------------------------- battle creation
export function startBattle(s: GameState, attackers: Army[], province: number, from: number): Battle | null {
  const atkOwner = attackers[0].owner;
  const defenders = armiesIn(s, province).filter((a) => atWar(s, a.owner, atkOwner) && !a.embarked);
  if (!defenders.length) return null;
  const war = warBetween(s, atkOwner, defenders[0].owner);
  const g = PROV[province];
  const id = s.nextId++;
  const b: Battle = {
    id, province, startDay: s.day, endDay: null,
    attacker: makeSide(s, attackers), defender: makeSide(s, defenders),
    attackerPosture: posture(attackers), defenderPosture: posture(defenders),
    terrain: g.terrain, weather: provinceWeather(s, province), fort: s.provinces[province].buildings.fort, river: g.river,
    strait: isStrait(from, province), amphibious: false,
    timeline: [], factors: [], result: null, summary: '', seed: (s.seed ^ (id * 2654435761)) >>> 0, warId: war?.id ?? -1, fromProvince: from,
  };
  ensureCmd(b);
  for (const a of [...attackers, ...defenders]) {
    if (a.battleId != null && s.battles[a.battleId] && s.battles[a.battleId].result == null) detachFromBattle(s, a, s.battles[a.battleId]);
    a.battleId = id;
  }
  s.battles[id] = b;
  s.activeBattles.push(id);
  s.stats.battles++;
  if (war) { war.battles++; war.lastBattleDay = s.day; }
  const pl = s.player;
  if (atkOwner === pl || defenders.some((d) => d.owner === pl)) {
    addEvent(s, 'battle', `Battle of ${g.name} begins: ${s.nations[atkOwner].name} attacks ${s.nations[defenders[0].owner].name}.`, [atkOwner, defenders[0].owner], { province, battleId: id, important: true });
  }
  return b;
}

function makeSide(s: GameState, armies: Army[]): BattleSide {
  const nation = armies[0].owner;
  const gen = armies.map((a) => (a.generalId != null ? s.generals[a.generalId]?.name : null)).find(Boolean) ?? null;
  const st = armies.reduce((t, a) => t + armyStrength(a), 0);
  const w = (f: (a: Army) => number) => armies.reduce((t, a) => t + f(a) * armyStrength(a), 0) / Math.max(1, st);
  return {
    nation, armyIds: armies.map((a) => a.id), general: gen,
    startStrength: st, startEquip: w(armyEquip), startOrg: w(armyOrg), startMorale: w(armyMorale), startSupply: w((a) => a.lastSupplyRatio),
    strength: st, org: w(armyOrg), morale: w(armyMorale),
    losses: { killed: 0, wounded: 0, equipment: 0, equipmentValue: 0 },
    units: armies.reduce((t, a) => t + a.units.length, 0),
  };
}

function detachFromBattle(s: GameState, a: Army, b: Battle) {
  b.attacker.armyIds = b.attacker.armyIds.filter((x) => x !== a.id);
  b.defender.armyIds = b.defender.armyIds.filter((x) => x !== a.id);
  a.battleId = null;
}

/** Add an arriving army to an ongoing battle (reinforcement). */
export function joinBattle(s: GameState, b: Battle, a: Army, asAttacker: boolean) {
  const side = asAttacker ? b.attacker : b.defender;
  if (side.armyIds.includes(a.id)) return;
  side.armyIds.push(a.id);
  side.startStrength += armyStrength(a);
  side.units += a.units.length;
  a.battleId = b.id;
  b.timeline[b.timeline.length - 1]?.events.push(`${a.name} (${s.nations[a.owner].name}) joins the battle as ${asAttacker ? 'attacker' : 'defender'} reinforcement.`);
}

// ---------------------------------------------------------------- modifiers (shared by sim + explanations)
interface Mods { atk: Record<string, number>; def: Record<string, number>; aDefMods: Record<string, number>; dAtkMods: Record<string, number>; }

function modifiers(s: GameState, b: Battle, A: SideEval, D: SideEval, aArm: Army[], dArm: Army[]): Mods {
  const t = TERRAIN[b.terrain];
  const w = WEATHER[b.weather];
  const atk: Record<string, number> = {};
  const def: Record<string, number> = {};
  const aDefMods: Record<string, number> = {};
  const dAtkMods: Record<string, number> = {};
  const hasEng = A.support.some((u) => u.type === 'engineers');
  atk['Terrain'] = t.attack;
  if (b.river) atk['River crossing'] = hasEng ? 1 - (1 - COMBAT.RIVER_PENALTY) / 2 : COMBAT.RIVER_PENALTY;
  if (b.strait) atk['Strait crossing'] = COMBAT.STRAIT_PENALTY;
  if (b.amphibious) {
    const am = s.nations[aArm[0].owner]?.techMods.amphibious ?? 0;
    const base = COMBAT.AMPHIBIOUS_PENALTY + 0.3 * A.seaCtl; // escorts and naval cover make landings far less costly
    atk['Amphibious landing'] = base + (1 - base) * am;
  }
  atk['Weather'] = w.attack;
  dAtkMods['Weather'] = w.attack;
  atk['Supply'] = COMBAT.OUT_OF_SUPPLY_ATTACK + (1 - COMBAT.OUT_OF_SUPPLY_ATTACK) * Math.min(1, A.supply);
  dAtkMods['Supply'] = COMBAT.OUT_OF_SUPPLY_ATTACK + (1 - COMBAT.OUT_OF_SUPPLY_ATTACK) * Math.min(1, D.supply);
  def['Supply'] = 0.6 + 0.4 * Math.min(1, D.supply);
  aDefMods['Supply'] = 0.6 + 0.4 * Math.min(1, A.supply);
  const pa = POSTURES[b.attackerPosture], pd = POSTURES[b.defenderPosture];
  atk['Posture'] = pa.attack;
  // reconnaissance data from recon drones
  const aN = s.nations[b.attacker.nation];
  if ((aN?.regime?.recon[b.province] ?? 0) > s.day) atk['Targeting data'] = 1.06;
  def['Posture'] = pd.defense;
  dAtkMods['Posture'] = pd.attack < 1 ? Math.max(0.85, pd.attack) : pd.attack;
  aDefMods['Posture'] = pa.defense;
  atk['General'] = 1 + COMBAT.GENERAL_PER_SKILL * (A.generalAtk - 1) + (A.trait === 'aggressive' ? 0.12 : A.trait === 'cautious' ? -0.05 : 0) + (A.trait === 'mountaineer' && (b.terrain === 'mountains' || b.terrain === 'hills') ? 0.25 : 0);
  def['General'] = 1 + COMBAT.GENERAL_PER_SKILL * (D.generalDef - 1) + (D.trait === 'entrencher' ? 0.1 : 0) + (D.trait === 'mountaineer' && (b.terrain === 'mountains' || b.terrain === 'hills') ? 0.15 : 0);
  dAtkMods['General'] = 1 + COMBAT.GENERAL_PER_SKILL * (D.generalAtk - 1) * 0.5;
  if (A.trait === 'armored') atk['General'] += 0.06 * (A.front.filter((u) => u.type === 'armored' || u.type === 'mechanized').length / Math.max(1, A.front.length)) * 3;
  // positions
  def['Terrain'] = t.defense;
  if (b.fort > 0) def['Fortifications'] = 1 + COMBAT.FORT_PER_LEVEL * b.fort * (hasEng ? 0.6 : 1);
  const ent = dArm.reduce((m, a) => Math.max(m, a.entrench), 0);
  if (ent > 0.02) def['Entrenchment'] = 1 + COMBAT.ENTRENCH_MAX_BONUS * ent * (b.attackerPosture === 'mobile' ? 0.6 : 1);
  // recon: intelligence advantage
  const rA = A.recon * w.recon + 1, rD = D.recon * w.recon + 1;
  const reconAdv = Math.max(-1, Math.min(1, (rA - rD) / (rA + rD)));
  atk['Reconnaissance'] = 1 + 0.12 * reconAdv;
  def['Reconnaissance'] = 1 - 0.06 * reconAdv;
  // air superiority (fighters, carriers and air defences over the battlefield; weather already counted)
  const airA = A.air, airD = D.air;
  if (airA + airD > 0.5) {
    const sup = (airA - airD) / (airA + airD);
    atk['Air superiority'] = 1 + AIR.SUPERIORITY * sup;
    dAtkMods['Air superiority'] = 1 - AIR.SUPERIORITY * 0.8 * sup;
  }
  // mobile manoeuvre
  if (b.attackerPosture === 'mobile') {
    const open = { plains: 1, desert: 1, hills: 0.35, forest: 0.25, taiga: 0.25, arctic: 0.1, jungle: -0.6, mountains: -0.6 }[b.terrain];
    const spd = Math.max(-0.5, Math.min(1, A.speed / Math.max(1, D.speed) - 1));
    atk['Manoeuvre'] = 1 + Math.max(-0.15, Math.min(0.3, (0.25 * spd + 0.15 * reconAdv) * open + (A.trait === 'armored' ? 0.05 : 0)));
  }
  // fatigue
  const fat = aArm.reduce((m, a) => Math.max(m, a.fatigue), 0);
  if (fat > 0.05) atk['Fatigue'] = 1 - 0.3 * fat;
  // difficulty: human players' armies fight better
  const ea = playerEdge(s, b.attacker.nation), ed = playerEdge(s, b.defender.nation);
  if (ea !== 1) { atk['Difficulty'] = ea; aDefMods['Difficulty'] = ea; }
  if (ed !== 1) { def['Difficulty'] = ed; dAtkMods['Difficulty'] = ed; }
  return { atk, def, aDefMods, dAtkMods };
}
const prod = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a * b, 1);

// ---------------------------------------------------------------- daily step
function applyDamage(units: Unit[], support: Unit[], dmg: number, casMult: number, orgMult: number, enemyHard: number, rnd: Stream, side: BattleSide, n: { techMods: { casualtyRecovery: number } } | undefined) {
  if (!units.length) units = support;
  if (!units.length) return 0;
  let killed = 0;
  const per = dmg / units.length;
  const apply = (u: Unit, share: number) => {
    const sp = UNITS[u.type];
    const orgLoss = per * share * COMBAT.DAMAGE_SCALE * orgMult * rnd.range(0.9, 1.1);
    u.org = Math.max(0, u.org - orgLoss);
    const strLossFrac = per * share * COMBAT.STRENGTH_SCALE * casMult * (1 - 0.4 * sp.hardness) * rnd.range(0.85, 1.15) / 10;
    const lost = Math.min(u.strength, u.strength * strLossFrac);
    u.strength -= lost;
    killed += lost;
    const eqLoss = Math.min(u.equipment, u.equipment * strLossFrac * (1 + sp.hardness * enemyHard * 1.5));
    u.equipment -= eqLoss;
    side.losses.equipmentValue += eqLoss * Object.values(sp.equip).reduce((a, b) => a + (b || 0), 0);
    side.losses.equipment += eqLoss;
    u.morale = Math.max(0.05, u.morale - orgLoss * 0.25 - strLossFrac * 0.8);
  };
  for (const u of units) apply(u, 1);
  for (const u of support) if (!units.includes(u)) apply(u, u.type === 'artillery' ? 0.3 : 0.15);
  void n;
  return killed;
}

export function battleDaily(s: GameState, b: Battle) {
  const rnd = new Stream(b.seed);
  const aArm = b.attacker.armyIds.map((id) => s.armies[id]).filter((a): a is Army => !!a && a.battleId === b.id);
  // defenders: still in the province; new hostile armies arriving there join automatically
  const dArm = b.defender.armyIds.map((id) => s.armies[id]).filter((a): a is Army => !!a && a.location === b.province && a.battleId === b.id);
  const atkOwner = b.attacker.nation;
  for (const a of armiesIn(s, b.province)) {
    if (a.battleId == null && atWar(s, a.owner, atkOwner) && !a.embarked && a.units.length) { joinBattle(s, b, a, false); dArm.push(a); }
  }
  if (!aArm.length || !dArm.length) { endBattle(s, b, !dArm.length ? 'attacker' : 'defender', aArm, dArm, !dArm.length ? 'The defenders abandoned the position.' : 'The attacking force broke off.'); b.seed = rnd.seed; return; }
  const day = b.timeline.length + 1;
  b.weather = provinceWeather(s, b.province);
  const A = evaluate(s, aArm, b, true), D = evaluate(s, dArm, b, false);
  const m = modifiers(s, b, A, D, aArm, dArm);
  const events: string[] = [];
  let phase = day === 1 ? 'Initial engagement' : 'Main fighting';
  const pa = POSTURES[b.attackerPosture], pd = POSTURES[b.defenderPosture];

  // defender strategic withdrawal: rear-guard action then retreat
  if (b.defenderPosture === 'withdrawal' && day >= 2) {
    phase = 'Withdrawal';
    events.push('Defenders execute a planned withdrawal under rear-guard cover.');
    b.timeline.push(dayRecord(day, phase, aArm, dArm, 0, 0, events));
    b.seed = rnd.seed;
    endBattle(s, b, 'attacker', aArm, dArm, 'The defenders withdrew in good order, trading ground for time.');
    return;
  }

  // ---- battle command: today's manoeuvres and the support each side called in
  const C = ensureCmd(b);
  const tA = C.a.plan, tD = C.d.plan;
  const edge: 'a' | 'd' | null = TACTICS[tA].beats === tD ? 'a' : TACTICS[tD].beats === tA ? 'd' : null;
  const used: { side: 'a' | 'd'; kind: SupportKind }[] = [];
  let fireA = 1, fireD = 1, wideA = 1, wideD = 1;
  const revealed = { a: false, d: false };
  for (const side of ['a', 'd'] as const) {
    const mine = side === 'a' ? aArm : dArm, theirs = side === 'a' ? dArm : aArm;
    const ownSide = side === 'a' ? A : D, other = side === 'a' ? D : A;
    for (const k of C[side].queued) {
      let mult = 1;
      if (k === 'barrage') {
        mult = 1.2;
        for (const x of theirs) x.entrench = Math.max(0, x.entrench - 0.2);
        events.push(`${side === 'a' ? 'Attacker' : 'Defender'} artillery lays down a massive barrage.`);
      } else if (k === 'drone') {
        // enemy fighters overhead can shoot the drones down
        const share = ownSide.air + other.air > 0.5 ? other.air / (ownSide.air + other.air) : 0;
        if (rnd.next() < 0.35 * share) { events.push(`${side === 'a' ? 'Attacker' : 'Defender'} drones are shot down by enemy fighters.`); continue; }
        mult = 1.1;
        for (const u of other.front) u.org = Math.max(0, u.org - 0.03);
        revealed[side] = true;
        events.push(`${side === 'a' ? 'Attacker' : 'Defender'} drones strike the enemy line and spot their next move.`);
      } else if (k === 'air') {
        mult = 1.25;
        events.push(`${side === 'a' ? 'Attacker' : 'Defender'} aircraft fly a concentrated strike.`);
      } else if (k === 'reserves') {
        if (side === 'a') wideA = 1.5; else wideD = 1.5;
        events.push(`${side === 'a' ? 'Attacker' : 'Defender'} commits the reserve to the line.`);
      } else if (k === 'rally') {
        for (const x of mine) for (const u of x.units) { u.org = Math.min(1, u.org + 0.25); u.morale = Math.min(1, u.morale + 0.1); }
        events.push(`${side === 'a' ? 'The attacking' : 'The defending'} general rallies the troops.`);
      }
      if (side === 'a') fireA *= mult; else fireD *= mult;
      used.push({ side, kind: k });
    }
    C[side].queued = [];
  }
  if (wideA !== 1 || wideD !== 1) {
    // the reserve goes into the line: a wider front for the day
    Object.assign(A, evaluate(s, aArm, b, true, wideA));
    Object.assign(D, evaluate(s, dArm, b, false, wideD));
  }
  const tacA = TACTICS[tA].dealt * TACTICS[tD].taken * (tA === 'flank' ? FLANK_TERRAIN[b.terrain] : 1) * (edge === 'a' ? TACTIC_EDGE.WIN : edge === 'd' ? TACTIC_EDGE.LOSE : 1) * fireA * (wideD > 1 ? 1.1 : 1);
  const tacD = TACTICS[tD].dealt * TACTICS[tA].taken * (tD === 'flank' ? FLANK_TERRAIN[b.terrain] : 1) * (edge === 'd' ? TACTIC_EDGE.WIN : edge === 'a' ? TACTIC_EDGE.LOSE : 1) * fireD * (wideA > 1 ? 1.1 : 1);
  events.push(edge === 'a' ? `The attackers' ${TACTICS[tA].label.toLowerCase()} beats the defenders' ${TACTICS[tD].label.toLowerCase()}.`
    : edge === 'd' ? `The defenders' ${TACTICS[tD].label.toLowerCase()} beats the attackers' ${TACTICS[tA].label.toLowerCase()}.`
    : `Both sides ${tA === 'assault' ? 'assault' : tA === 'hold' ? 'hold their lines' : 'try to flank'}: neither gains the upper hand.`);

  const probe = day === 1 ? 0.6 : 1;
  const spreadA = 1 + COMBAT.RANDOM_SPREAD * (rnd.next() * 2 - 1);
  const spreadD = 1 + COMBAT.RANDOM_SPREAD * (rnd.next() * 2 - 1);
  const atkMult = prod(m.atk) * probe * spreadA;
  const defMult = prod(m.def);
  const dAtkMult = prod(m.dAtkMods) * probe * spreadD;
  const aDefMult = prod(m.aDefMods);
  // close air support (stronger for the side that holds the sky) and naval gunfire add firepower
  const shareA = A.air + D.air > 0.5 ? A.air / (A.air + D.air) : 0.5;
  const strikeA = { soft: A.cas.soft * AIR.CAS * (0.35 + 0.65 * shareA), hard: A.cas.hard * AIR.CAS * (0.35 + 0.65 * shareA) };
  const strikeD = { soft: D.cas.soft * AIR.CAS * (1 - 0.65 * shareA), hard: D.cas.hard * AIR.CAS * (1 - 0.65 * shareA) };
  const hitsA = ((A.soft + strikeA.soft + A.naval) * (1 - D.hardness) + (A.hard + strikeA.hard + A.naval * 0.3) * D.hardness) * atkMult;
  const hitsD = ((D.soft + strikeD.soft + D.naval) * (1 - A.hardness) + (D.hard + strikeD.hard + D.naval * 0.3) * A.hardness) * dAtkMult;
  const defD = D.defense * defMult;
  const defA = A.breakthrough * aDefMult + A.defense * 0.25 * aDefMult; // attackers rely on breakthrough
  // defence absorbs attacks up to its value; prepared positions also blunt what gets through
  const roeA = ROE[s.nations[atkOwner]?.regime?.roe ?? 'standard'].damage, roeD = ROE[s.nations[b.defender.nation]?.regime?.roe ?? 'standard'].damage;
  const dmgToD = tacA * roeA * (Math.min(hitsA, defD) * 0.1 + Math.max(0, hitsA - defD) * 0.4) / Math.sqrt(Math.max(0.5, defMult));
  const dmgToA = tacD * roeD * (Math.min(hitsD, defA) * 0.1 + Math.max(0, hitsD - defA) * 0.4) / Math.sqrt(Math.max(0.5, aDefMult));
  const nA = s.nations[atkOwner], nD = s.nations[b.defender.nation];
  const casA = pa.casualties * (A.trait === 'aggressive' ? 1.15 : A.trait === 'cautious' ? 0.8 : 1);
  const casD = pd.casualties * (D.trait === 'cautious' ? 0.8 : 1);
  const orgA = pa.orgLoss * (A.trait === 'inspiring' ? 0.85 : 1) / (nA?.techMods.organisation ?? 1);
  const orgD = pd.orgLoss * (D.trait === 'inspiring' ? 0.85 : 1) / (nD?.techMods.organisation ?? 1);
  const killedD = applyDamage(D.front, D.support, dmgToD, casD, orgD, A.hard / Math.max(1, A.soft + A.hard), rnd, b.defender, nD);
  const killedA = applyDamage(A.front, A.support, dmgToA, casA, orgA, D.hard / Math.max(1, D.soft + D.hard), rnd, b.attacker, nA);
  b.attacker.losses.killed += killedA; b.defender.losses.killed += killedD;
  if (day === 1) {
    events.push(`Reconnaissance and artillery duel. ${A.recon > D.recon * 1.3 ? 'Attacker scouts locate the defensive line.' : D.recon > A.recon * 1.3 ? 'Defender screens deny the attacker a clear picture.' : 'Neither side gains an intelligence edge.'}`);
    if (A.air + D.air > 1) events.push(A.air > D.air * 1.5 ? `Attacker air forces own the skies (${A.airWings} wing${A.airWings === 1 ? '' : 's'} overhead).` : D.air > A.air * 1.5 ? `Defender air forces own the skies (${D.airWings} wing${D.airWings === 1 ? '' : 's'} overhead).` : 'Both air forces contest the skies.');
    if (A.naval > 0.5) events.push('Attacker warships shell the defences from offshore.');
    if (D.naval > 0.5) events.push('Defender warships fire on the attackers from offshore.');
  }
  if (hitsA > defD * 1.4) events.push('Attackers achieve a local breakthrough.');
  if (hitsD > defA * 1.6) events.push('Counter-attack inflicts heavy losses on the assault waves.');
  // morale & organisation check
  const aOrg = avgOrg(aArm), dOrg = avgOrg(dArm);
  const aMor = avgMorale(aArm), dMor = avgMorale(dArm);
  // reserves rotate
  if (A.reserve.length && A.front.some((u) => u.org < 0.2)) events.push(`Attacker rotates fresh formations from reserve (${A.reserve.length} waiting).`);
  if (D.reserve.length && D.front.some((u) => u.org < 0.2)) events.push(`Defender commits reserves (${D.reserve.length} available).`);
  if (A.supply < 0.5) events.push('Attacker ammunition and fuel are running low.');
  if (D.supply < 0.5) events.push('Defender is short of supplies.');
  // digging in during battle
  for (const a of dArm) a.entrench = Math.max(0, a.entrench - 0.02);
  for (const a of aArm) a.fatigue = Math.min(1, a.fatigue + 0.03);
  b.timeline.push({ ...dayRecord(day, phase, aArm, dArm, dmgToA, dmgToD, events), aTactic: tA, dTactic: tD, edge, support: used });
  b.attacker.strength = aArm.reduce((t, a) => t + armyStrength(a), 0);
  b.defender.strength = dArm.reduce((t, a) => t + armyStrength(a), 0);
  b.attacker.org = aOrg; b.defender.org = dOrg; b.attacker.morale = aMor; b.defender.morale = dMor;
  b.factors = explain(s, b, A, D, m, strikeA, strikeD);
  if (Math.abs(tacA / tacD - 1) >= 0.015) b.factors.unshift({ label: 'Battle command', side: tacA >= tacD ? 'attacker' : 'defender', value: +(Math.max(tacA, tacD) / Math.min(tacA, tacD) - 1).toFixed(3), detail: `Today: ${TACTICS[tA].label} vs ${TACTICS[tD].label}${used.length ? ' · ' + used.map((u) => `${u.side === 'a' ? 'attacker' : 'defender'} ${BATTLE_SUPPORT[u.kind].label.toLowerCase()}`).join(', ') : ''}` });
  planTomorrow(s, b, rnd, A, D, revealed, aArm, dArm);

  // ---- decision checks
  const rout = (org: number, mor: number) => mor < 0.22 && org < 0.35 && rnd.next() < 0.5;
  const dBroken = dOrg < 0.12 || D.front.length + D.reserve.length === 0 || rout(dOrg, dMor);
  const aBroken = aOrg < pa.retreatAt || A.front.length + A.reserve.length === 0 || rout(aOrg, aMor);
  b.seed = rnd.seed;
  if (dBroken && !aBroken) { endBattle(s, b, 'attacker', aArm, dArm, ''); return; }
  if (aBroken) { endBattle(s, b, 'defender', aArm, dArm, ''); return; }
  if (day >= COMBAT.MAX_DAYS) { endBattle(s, b, 'stalemate', aArm, dArm, ''); return; }
}

// ---------------------------------------------------------------- battle command
const newCmd = (plan: Tactic): BattleCommand => ({ order: 'auto', plan, queued: [], cooldown: {}, hint: null, hintSure: 0 });
/** The command state of a battle (battles from older saves get one on first use). */
export function ensureCmd(b: Battle) {
  // the opening moves vary from battle to battle (attackers lean to assault, defenders to hold)
  return (b.cmd ??= { a: newCmd((['assault', 'assault', 'flank', 'hold'] as Tactic[])[b.seed % 4]), d: newCmd((['hold', 'hold', 'assault', 'flank'] as Tactic[])[(b.seed >>> 4) % 4]) });
}
const TACTIC_LIST: Tactic[] = ['assault', 'hold', 'flank'];
const counterTo = (t: Tactic) => TACTIC_LIST.find((x) => TACTICS[x].beats === t)!;
/**
 * The general's choice for tomorrow when nobody gives orders: usually the move that beats what the
 * enemy did today, sometimes the same again, sometimes anything; aggressive generals like to
 * assault and cautious ones to hold. Players who read the enemy's habits (and their scouts'
 * reports) can stay a step ahead.
 */
function generalPick(rnd: Stream, mine: Tactic, theirs: Tactic, trait: string): Tactic {
  const r = rnd.next();
  if (trait === 'aggressive' && r < 0.15) return 'assault';
  if (trait === 'cautious' && r < 0.15) return 'hold';
  if (r < 0.5) return counterTo(theirs);
  if (r < 0.7) return mine;
  return TACTIC_LIST[Math.floor(rnd.next() * 3) % 3];
}
/** Where a commander's strike aircraft can reach: squadrons whose base is within range. */
export function squadronsInRange(s: GameState, nation: string, p: number) {
  let n = 0;
  for (const w of Object.values(s.airWings ?? {})) {
    if (w.owner !== nation || w.rebase) continue;
    const km = distKm(w.base, p);
    for (const u of w.units) if (km <= rangeOf(u.type) && u.strength > 0) n++;
  }
  return n;
}

function planTomorrow(s: GameState, b: Battle, rnd: Stream, A: SideEval, D: SideEval, revealed: { a: boolean; d: boolean }, aArm: Army[], dArm: Army[]) {
  const C = ensureCmd(b);
  const today = { a: C.a.plan, d: C.d.plan };
  for (const side of ['a', 'd'] as const) {
    const c = C[side];
    const n = s.nations[side === 'a' ? b.attacker.nation : b.defender.nation];
    const ev = side === 'a' ? A : D;
    c.plan = c.order !== 'auto' ? c.order : generalPick(rnd, today[side], today[side === 'a' ? 'd' : 'a'], ev.trait);
    if (!n) continue;
    const org = avgOrg(side === 'a' ? aArm : dArm);
    // generals on both sides call in support now and then on their own (a player can call it
    // when it matters most instead); they rally a wavering army
    if (org < 0.35 && canSupport(s, b, side, 'rally') == null && rnd.next() < 0.6) queueSupport(s, b, side, 'rally');
    for (const k of ['barrage', 'air', 'drone', 'reserves'] as SupportKind[]) {
      if (canSupport(s, b, side, k) != null || c.queued.length) continue;
      if (rnd.next() < 0.2 && (k !== 'drone' || n.arsenal.drone > 0) && n.treasury > supportCost(s, b, side, k) * 10 + 1) queueSupport(s, b, side, k);
    }
  }
  // scouts report what the enemy will do tomorrow: right more often with better reconnaissance,
  // certain after a drone strike saw it
  const rA = A.recon + 1, rD = D.recon + 1;
  const adv = (rA - rD) / (rA + rD);
  for (const side of ['a', 'd'] as const) {
    const enemy = C[side === 'a' ? 'd' : 'a'].plan;
    const n = s.nations[side === 'a' ? b.attacker.nation : b.defender.nation];
    let sure = Math.max(0.45, Math.min(0.85, 0.62 + 0.25 * (side === 'a' ? adv : -adv) + ((n?.regime?.recon[b.province] ?? 0) > s.day ? 0.1 : 0)));
    if (revealed[side]) sure = 1;
    const right = rnd.next() < sure;
    const others = TACTIC_LIST.filter((t) => t !== enemy);
    C[side].hint = right ? enemy : others[Math.floor(rnd.next() * 2) % 2];
    C[side].hintSure = +sure.toFixed(2);
  }
}

/** Which side of a battle a nation commands ('a' attacker, 'd' defender), or null. */
export function commandSide(s: GameState, b: Battle, nation: string): 'a' | 'd' | null {
  if (b.attacker.nation === nation) return 'a';
  if (b.defender.nation === nation) return 'd';
  if (b.attacker.armyIds.some((id) => s.armies[id]?.owner === nation)) return 'a';
  if (b.defender.armyIds.some((id) => s.armies[id]?.owner === nation)) return 'd';
  return null;
}
/** Why a side cannot call in this support now (null = it can). */
export function canSupport(s: GameState, b: Battle, side: 'a' | 'd', k: SupportKind): string | null {
  const c = ensureCmd(b)[side];
  const sp = BATTLE_SUPPORT[k];
  const nation = side === 'a' ? b.attacker.nation : b.defender.nation;
  const n = s.nations[nation];
  if (!n) return 'No commander.';
  if (b.result != null) return 'The battle is over.';
  if (c.queued.includes(k)) return 'Already ordered for tomorrow.';
  if ((c.cooldown[k] ?? 0) > s.day) return k === 'rally' ? 'The troops have already been rallied in this battle.' : `Ready again in ${(c.cooldown[k] ?? 0) - s.day} day${(c.cooldown[k] ?? 0) - s.day === 1 ? '' : 's'}.`;
  const armies = (side === 'a' ? b.attacker : b.defender).armyIds.map((id) => s.armies[id]).filter(Boolean) as Army[];
  if (k === 'barrage' && !armies.some((a) => a.units.some((u) => u.type === 'artillery' && u.strength > 50))) return 'Needs artillery in the battle.';
  if (k === 'air' && squadronsInRange(s, nation, b.province) === 0) return 'No air wing within range of this battle.';
  if (k === 'reserves' && armies.reduce((t, a) => t + a.units.filter((u) => !UNITS[u.type].support).length, 0) <= TERRAIN[b.terrain].width / 2) return 'No reserve: every formation is already in the line.';
  if (supportCost(s, b, side, k) > n.treasury) return 'Not enough money.';
  return null;
}
export function supportCost(s: GameState, b: Battle, side: 'a' | 'd', k: SupportKind) {
  const n = s.nations[side === 'a' ? b.attacker.nation : b.defender.nation];
  if (!n) return 0;
  if (k === 'drone') return n.arsenal.drone > 0 ? 0 : munitionCost('drone', n);
  return BATTLE_SUPPORT[k].cost * n.priceIndex;
}
/** Pay for and order a support action for tomorrow's fighting (checked with canSupport first). */
export function queueSupport(s: GameState, b: Battle, side: 'a' | 'd', k: SupportKind) {
  const n = s.nations[side === 'a' ? b.attacker.nation : b.defender.nation];
  const c = ensureCmd(b)[side];
  const cost = supportCost(s, b, side, k);
  if (k === 'drone' && n.arsenal.drone > 0) n.arsenal.drone--;
  n.treasury -= cost;
  n.ledgerMonth.expense += cost;
  c.queued.push(k);
  c.cooldown[k] = k === 'rally' ? 1e9 : s.day + BATTLE_SUPPORT[k].cooldown;
}
function avgOrg(armies: Army[]) { const t = armies.reduce((x, a) => x + armyStrength(a), 0) || 1; return armies.reduce((x, a) => x + armyOrg(a) * armyStrength(a), 0) / t; }
function avgMorale(armies: Army[]) { const t = armies.reduce((x, a) => x + armyStrength(a), 0) || 1; return armies.reduce((x, a) => x + armyMorale(a) * armyStrength(a), 0) / t; }
function dayRecord(day: number, phase: string, aArm: Army[], dArm: Army[], aDamage: number, dDamage: number, events: string[]) {
  return {
    day, phase,
    aStrength: Math.round(aArm.reduce((t, a) => t + armyStrength(a), 0)), dStrength: Math.round(dArm.reduce((t, a) => t + armyStrength(a), 0)),
    aOrg: +avgOrg(aArm).toFixed(3), dOrg: +avgOrg(dArm).toFixed(3), aMorale: +avgMorale(aArm).toFixed(3), dMorale: +avgMorale(dArm).toFixed(3),
    aDamage: +aDamage.toFixed(1), dDamage: +dDamage.toFixed(1), events,
  };
}

// ---------------------------------------------------------------- explanation
function explain(s: GameState, b: Battle, A: SideEval, D: SideEval, m: Mods, casA = { soft: 0, hard: 0 }, casD = { soft: 0, hard: 0 }): BattleFactor[] {
  const f: BattleFactor[] = [];
  const push = (label: string, side: 'attacker' | 'defender', mult: number, detail: string) => { if (Math.abs(mult - 1) >= 0.015) f.push({ label, side, value: +(mult - 1).toFixed(3), detail }); };
  const t = TERRAIN[b.terrain];
  push('Terrain', 'attacker', m.atk['Terrain'], `${t.label}: attack ×${t.attack.toFixed(2)}`);
  push('Terrain', 'defender', m.def['Terrain'], `${t.label}: defence ×${t.defense.toFixed(2)}`);
  if (m.atk['River crossing']) push('River crossing', 'attacker', m.atk['River crossing'], 'Assault across a major river');
  if (m.atk['Strait crossing']) push('Strait crossing', 'attacker', m.atk['Strait crossing'], 'Attack across a sea strait');
  if (m.atk['Amphibious landing']) push('Amphibious landing', 'attacker', m.atk['Amphibious landing'], 'Landing from the sea');
  push('Weather', 'attacker', m.atk['Weather'], WEATHER[b.weather].label);
  push('Supply', 'attacker', m.atk['Supply'], `Attacker supplied at ${Math.round(A.supply * 100)}%`);
  push('Supply', 'defender', m.def['Supply'], `Defender supplied at ${Math.round(D.supply * 100)}%`);
  if (m.def['Fortifications']) push('Fortifications', 'defender', m.def['Fortifications'], `Level ${b.fort} fortifications`);
  if (m.def['Entrenchment']) push('Entrenchment', 'defender', m.def['Entrenchment'], 'Prepared defensive positions');
  push('Posture', 'attacker', m.atk['Posture'], POSTURES[b.attackerPosture].label);
  push('Posture', 'defender', m.def['Posture'], POSTURES[b.defenderPosture].label);
  push('Leadership', 'attacker', m.atk['General'], b.attacker.general ? `${b.attacker.general} (attack ${A.generalAtk}${A.trait !== 'none' ? ', ' + TRAITS[A.trait as keyof typeof TRAITS].label : ''})` : 'No general assigned');
  push('Leadership', 'defender', m.def['General'], b.defender.general ? `${b.defender.general} (defence ${D.generalDef}${D.trait !== 'none' ? ', ' + TRAITS[D.trait as keyof typeof TRAITS].label : ''})` : 'No general assigned');
  push('Reconnaissance', 'attacker', m.atk['Reconnaissance'], 'Intelligence and scouting advantage');
  if (m.atk['Air superiority']) push('Air superiority', 'attacker', m.atk['Air superiority'], `Air power ${A.air.toFixed(0)} vs ${D.air.toFixed(0)} (${A.airWings} vs ${D.airWings} air wings overhead)`);
  const fire = (x: SideEval, c: { soft: number; hard: number }) => 1 + Math.min(1.5, (c.soft + c.hard + x.naval * 1.3) / Math.max(1, x.soft + x.hard));
  if (casA.soft + casA.hard > 0.3) push('Close air support', 'attacker', 1 + Math.min(1.5, (casA.soft + casA.hard) / Math.max(1, A.soft + A.hard)), 'Strike aircraft hitting the defenders');
  if (casD.soft + casD.hard > 0.3) push('Close air support', 'defender', 1 + Math.min(1.5, (casD.soft + casD.hard) / Math.max(1, D.soft + D.hard)), 'Strike aircraft hitting the attackers');
  if (A.naval > 0.3) push('Naval gunfire', 'attacker', fire(A, { soft: 0, hard: 0 }), 'Warships offshore shelling the defences');
  if (D.naval > 0.3) push('Naval gunfire', 'defender', fire(D, { soft: 0, hard: 0 }), 'Warships offshore firing on the attackers');
  if (m.atk['Manoeuvre']) push('Mobile manoeuvre', 'attacker', m.atk['Manoeuvre'], 'Speed and recon exploited for flanking');
  if (m.atk['Fatigue']) push('Fatigue', 'attacker', m.atk['Fatigue'], 'Exhausted from marching and fighting');
  if (m.atk['Difficulty']) push('Difficulty', 'attacker', m.atk['Difficulty'], 'Player bonus for this difficulty');
  if (m.def['Difficulty']) push('Difficulty', 'defender', m.def['Difficulty'], 'Player bonus for this difficulty');
  // equipment & quality
  push('Equipment', 'attacker', 0.3 + 0.7 * A.equipment, `Front-line formations ${Math.round(A.equipment * 100)}% equipped`);
  push('Equipment', 'defender', 0.3 + 0.7 * D.equipment, `Front-line formations ${Math.round(D.equipment * 100)}% equipped`);
  if (Math.abs(A.quality - D.quality) > 0.03) push('Technology', A.quality > D.quality ? 'attacker' : 'defender', 1 + Math.abs(A.quality - D.quality), `Equipment quality ${A.quality.toFixed(2)} vs ${D.quality.toFixed(2)}`);
  // numbers & armour
  const ratio = (b.attacker.strength + 1) / (b.defender.strength + 1);
  if (ratio > 1.3 || ratio < 0.77) push('Numbers', ratio > 1 ? 'attacker' : 'defender', 1 + Math.min(1, Math.abs(Math.log(ratio)) * 0.3), `${Math.round(b.attacker.strength).toLocaleString()} vs ${Math.round(b.defender.strength).toLocaleString()} personnel (combat width ${A.width})`);
  if (A.hardness > 0.4 && D.hard < A.soft * 0.4) push('Armor', 'attacker', 1 + A.hardness * 0.3, 'Enemy lacks anti-armor capability');
  if (D.hardness > 0.4 && A.hard < D.soft * 0.4) push('Armor', 'defender', 1 + D.hardness * 0.3, 'Attacker lacks anti-armor capability');
  push('Organisation', 'attacker', 0.6 + 0.4 * b.attacker.startOrg / 0.8, `Started at ${Math.round(b.attacker.startOrg * 100)}% organisation`);
  push('Organisation', 'defender', 0.6 + 0.4 * b.defender.startOrg / 0.8, `Started at ${Math.round(b.defender.startOrg * 100)}% organisation`);
  void s;
  return f.sort((x, y) => Math.abs(y.value) - Math.abs(x.value));
}

// ---------------------------------------------------------------- resolution
function endBattle(s: GameState, b: Battle, result: 'attacker' | 'defender' | 'stalemate', aArm: Army[], dArm: Army[], note: string) {
  b.result = result;
  b.endDay = s.day;
  s.activeBattles = s.activeBattles.filter((id) => id !== b.id);
  const aN = s.nations[b.attacker.nation], dN = s.nations[b.defender.nation];
  const war = s.wars.find((w) => w.id === b.warId) as War | undefined;
  // wounded / killed split, recovery to manpower
  for (const [side, n] of [[b.attacker, aN], [b.defender, dN]] as const) {
    const tot = side.losses.killed;
    side.losses.wounded = Math.round(tot * COMBAT.WOUNDED_SHARE);
    const killed = tot - side.losses.wounded;
    if (n) n.manpower += side.losses.wounded * n.techMods.casualtyRecovery;
    side.losses.killed = Math.round(killed);
  }
  const lostA = b.attacker.losses.killed + b.attacker.losses.wounded;
  const lostD = b.defender.losses.killed + b.defender.losses.wounded;
  for (const a of [...aArm, ...dArm]) { a.battleId = null; }
  const g = PROV[b.province];
  const pst = s.provinces[b.province];
  // infrastructure damage proportional to intensity
  pst.damage = Math.min(0.9, pst.damage + Math.min(0.25, (lostA + lostD) / 60000 + b.timeline.length * 0.006));
  // retreat / advance
  let retreatNote = '';
  if (result === 'attacker') {
    for (const d of dArm) retreatNote += retreat(s, d, b.province, b.attacker.nation, b.defender);
    // victorious attackers advance into the province
    for (const a of aArm) {
      if (!s.armies[a.id]) continue;
      setArmyLocation(s, a, b.province);
      a.moveProgress = 0;
      if (a.path[0] === b.province) a.path.shift();
      a.entrench = 0;
    }
    const ctrl = pst.controller;
    if (atWar(s, ctrl, b.attacker.nation) || (pst.owner === b.attacker.nation && ctrl !== b.attacker.nation)) setController(s, b.province, b.attacker.nation);
  } else {
    for (const a of aArm) { a.path = []; a.moveProgress = 0; }
  }
  // experience & generals
  for (const a of [...aArm, ...dArm]) {
    for (const u of a.units) u.experience = Math.min(1, u.experience + 0.04 + b.timeline.length * 0.004);
    if (a.generalId != null && s.generals[a.generalId]) {
      const gen = s.generals[a.generalId];
      const won = (result === 'attacker' && a.owner === b.attacker.nation) || (result === 'defender' && a.owner === b.defender.nation);
      gen.xp += won ? 12 : 5;
      if (gen.xp >= 40) { gen.xp -= 40; const k = (['attack', 'defense', 'logistics'] as const)[b.id % 3]; if (gen[k] < 5) gen[k]++; }
    }
  }
  // remove destroyed armies
  for (const a of [...aArm, ...dArm]) {
    if (!s.armies[a.id]) continue;
    a.units = a.units.filter((u) => u.strength > UNITS[u.type].personnel * 0.08);
    if (!a.units.length) deleteArmy(s, a.id);
  }
  // war accounting
  if (war) {
    const aIsA = war.attackers.includes(b.attacker.nation);
    if (aIsA) { war.casualtiesA += lostA; war.casualtiesD += lostD; } else { war.casualtiesA += lostD; war.casualtiesD += lostA; }
  }
  for (const [n, lost, inflicted, won] of [[aN, lostA, lostD, result === 'attacker'], [dN, lostD, lostA, result === 'defender']] as const) {
    if (!n) continue;
    n.stats.casualtiesSuffered += lost; n.stats.casualtiesInflicted += inflicted;
    if (won) n.stats.battlesWon++; else n.stats.battlesLost++;
    const base = Math.max(20000, n.manpower + 50000);
    n.warExhaustion = Math.min(100, n.warExhaustion + (lost / base) * 60 + 0.4);
    n.warSupport = Math.max(0, Math.min(100, n.warSupport + (won ? 1.5 : -2)));
  }
  const winner = result === 'attacker' ? aN : result === 'defender' ? dN : null;
  const top = b.factors.filter((f) => winner && ((f.side === 'attacker') === (result === 'attacker') ? f.value > 0 : f.value < 0)).slice(0, 3).map((f) => f.label.toLowerCase());
  b.summary = result === 'stalemate'
    ? `After ${b.timeline.length} days neither side could force a decision. The attackers fell back exhausted.`
    : `${winner?.name} won after ${b.timeline.length} day${b.timeline.length > 1 ? 's' : ''}${top.length ? `, decided mainly by ${listJoin(top)}` : ''}. ${note}${retreatNote}`.trim();
  const involvesPlayer = b.attacker.nation === s.player || b.defender.nation === s.player;
  addEvent(s, 'battle', `Battle of ${g.name}: ${result === 'stalemate' ? 'stalemate' : `${winner?.name} victorious`}. Losses ${Math.round(lostA).toLocaleString()} (${aN?.name}) vs ${Math.round(lostD).toLocaleString()} (${dN?.name}).`, [b.attacker.nation, b.defender.nation], { province: b.province, battleId: b.id, important: involvesPlayer });
  invalidateArmies();
}
const listJoin = (a: string[]) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

/** Retreat a defeated army to the best adjacent friendly province, or it surrenders. */
function retreat(s: GameState, a: Army, from: number, enemy: string, side: BattleSide): string {
  const options = landLinks(from).map((l) => l.to).filter((p) => {
    const c = s.provinces[p].controller;
    return (c === a.owner || isFriendly(s, a.owner, c)) && !armiesIn(s, p).some((x) => atWar(s, x.owner, a.owner));
  });
  if (!options.length) {
    const lost = armyStrength(a);
    side.losses.killed += lost * 0.2; side.losses.wounded += 0;
    const n = s.nations[a.owner];
    if (n) n.stats.casualtiesSuffered += lost;
    deleteArmy(s, a.id);
    return ` ${a.name} was encircled and surrendered (${Math.round(lost).toLocaleString()} personnel captured).`;
  }
  // prefer provinces farther from the enemy's controlled territory and with more own troops
  const enemyCtrl = new Set(controlledBy(s, enemy));
  options.sort((x, y) => score(y) - score(x));
  function score(p: number) {
    let sc = 0;
    for (const nb of PROV[p].neighbors) if (enemyCtrl.has(nb)) sc -= 1;
    sc += armiesIn(s, p).filter((x) => x.owner === a.owner).length * 0.5;
    if (p === s.nations[a.owner]?.capital) sc += 1;
    return sc - distKm(from, p) / 2000;
  }
  setArmyLocation(s, a, options[0]);
  a.path = []; a.moveProgress = 0; a.entrench = 0;
  for (const u of a.units) { u.org = Math.max(0, u.org * 0.6); u.equipment *= 0.95; }
  return '';
}

/** Quick expected-outcome estimate used for intel reports and AI. Returns attacker win probability 0..1. */
export function estimateBattle(s: GameState, attackers: Army[], province: number, from: number, defenders?: Army[], noise = 0): { odds: number; aPower: number; dPower: number; notes: string[] } {
  const atkOwner = attackers[0].owner;
  const defs = defenders ?? armiesIn(s, province).filter((a) => atWar(s, a.owner, atkOwner));
  const notes: string[] = [];
  if (!defs.length) return { odds: 1, aPower: 1, dPower: 0, notes: ['No defenders: the province will be occupied on arrival.'] };
  const g = PROV[province];
  const t = TERRAIN[g.terrain];
  const w = WEATHER[provinceWeather(s, province)];
  let aP = attackers.reduce((x, a) => x + armyPower(s, a), 0);
  let dP = defs.reduce((x, a) => x + armyPower(s, a), 0) * (1 + noise);
  // air forces in range
  const airA = airNear(s, atkOwner, province), airD = airNear(s, defs[0].owner, province);
  if (airA + airD > 0.5) {
    const sup = (airA - airD) / (airA + airD);
    aP *= 1 + AIR.SUPERIORITY * sup + Math.max(0, sup) * 0.2;
    dP *= 1 - AIR.SUPERIORITY * 0.5 * sup;
    if (Math.abs(sup) > 0.3) notes.push(sup > 0 ? 'Your air force rules the skies here.' : 'The enemy air force rules the skies here.');
  }
  const fort = s.provinces[province].buildings.fort;
  aP *= t.attack * w.attack * (g.river ? COMBAT.RIVER_PENALTY : 1) * (isStrait(from, province) ? COMBAT.STRAIT_PENALTY : 1) * POSTURES[attackers[0].posture].attack;
  dP *= t.defense * (1 + COMBAT.FORT_PER_LEVEL * fort) * (1 + COMBAT.ENTRENCH_MAX_BONUS * Math.max(...defs.map((d) => d.entrench))) * 1.35; // defender advantage
  if (t.attack < 0.9) notes.push(`${t.label} favours the defender (attack ×${t.attack}).`);
  if (g.river) notes.push('River crossing: −15% attack (engineers halve this).');
  if (fort) notes.push(`Fortifications level ${fort}: +${fort * 12}% defence.`);
  if (w.attack < 0.95) notes.push(`${w.label}: attack ×${w.attack}.`);
  const sup = attackers.reduce((m, a) => Math.min(m, a.lastSupplyRatio), 1);
  if (sup < 0.8) notes.push(`Your supply is at ${Math.round(sup * 100)}% — combat effectiveness reduced.`);
  aP *= playerEdge(s, atkOwner);
  dP *= playerEdge(s, defs[0].owner);
  const r = aP / Math.max(0.01, dP);
  const odds = 1 / (1 + Math.exp(-3.2 * Math.log(r)));
  return { odds, aPower: aP, dPower: dP, notes };
}

export { MIL };
