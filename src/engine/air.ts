/**
 * Air forces. Squadrons of fighters and bombers are based at airfields (any province the nation
 * holds) and fly their wing's mission within each squadron's range of the base:
 *  - support:  over every friendly battle in range — fighters fight for the skies, bombers and
 *              fighters strike enemy troops (close air support);
 *  - defense:  over friendly soil — cover defensive battles and intercept raids, drones, missiles;
 *  - bombing:  one enemy province — troops, factories, power plants, railways;
 *  - naval:    one sea zone — enemy ships, and sea control for your fleets and landings.
 * A wing covering several battles splits its sorties between them. Wings lose aircraft to enemy
 * fighters and air defences and refit at their base. Carriers add air power over their waters.
 * Everything here is deterministic (no random draws), so multiplayer copies stay identical.
 */
import type { AirMission, AirWing, Battle, GameState, Nation, Unit, UnitType } from './types';
import { AIR, UNITS, WEATHER, TERRAIN } from './config';
import { PROV, WORLD, distKm, haversine } from './geo';
import { atWar, isFriendly, armiesIn, controlledBy } from './world';
import { qualityOf, unitEquipCost, newWing } from './military';
import { provinceWeather } from './weather';
import { addEvent } from './events';

export const isAirType = (t: UnitType): t is 'air' | 'bomber' => t === 'air' || t === 'bomber';

export function wingsOf(s: GameState, id: string): AirWing[] {
  return Object.values(s.airWings ?? {}).filter((w) => w.owner === id);
}
export function createWing(s: GameState, owner: string, base: number, units: Unit[], name?: string): AirWing {
  const w = newWing(s, owner, base);
  w.units = units;
  if (name) w.name = name;
  return w;
}

/** Combat value of one squadron: crews, aircraft, technology, experience and readiness. */
export function squadronEff(u: Unit, n?: Nation) {
  const sp = UNITS[u.type];
  const q = n ? qualityOf(n, u.type) : 1;
  return (u.strength / sp.personnel) * (0.15 + 0.85 * u.equipment) * q * (1 + 0.3 * u.experience) * (0.4 + 0.6 * u.org);
}
/** Aircraft in a squadron (for display). */
export function planesOf(u: Unit) {
  return Math.round((AIR.PLANES[u.type] ?? 20) * u.equipment * Math.min(1, u.strength / UNITS[u.type].personnel));
}
export const wingPlanes = (w: AirWing) => w.units.reduce((t, u) => t + planesOf(u), 0);
export const rangeOf = (t: UnitType) => AIR.RANGE[t] ?? 1000;
/** The farthest any squadron of the wing can fly. */
export const wingRange = (w: AirWing) => w.units.reduce((m, u) => Math.max(m, rangeOf(u.type)), 0);
export const seaKm = (p: number, zone: number) => haversine(PROV[p].x, PROV[p].y, WORLD.seas[zone].x, WORLD.seas[zone].y);
const flying = (w: AirWing) => !w.rebase && w.units.length > 0;

/** Every nation fighting on each side of a battle (co-belligerents included). */
export function battleSides(s: GameState, b: Battle): [Set<string>, Set<string>] {
  const a = new Set([b.attacker.nation]), d = new Set([b.defender.nation]);
  const war = s.wars.find((w) => w.id === b.warId);
  if (war) {
    const aIsA = war.attackers.includes(b.attacker.nation);
    for (const x of aIsA ? war.attackers : war.defenders) a.add(x);
    for (const x of aIsA ? war.defenders : war.attackers) d.add(x);
  }
  return [a, d];
}

// ---------------------------------------------------------------- battles
export interface BattleAir { aSup: number; dSup: number; aCas: { soft: number; hard: number }; dCas: { soft: number; hard: number }; aWings: number; dWings: number }
const battleAir = new Map<number, BattleAir>();
/** Air power each side brought over a battle today (computed before the battles are fought). */
export function battleAirFor(id: number): BattleAir | undefined { return battleAir.get(id); }

/** Daily, before battles: which wings fly over which battles, and how strong each side is in the air. */
export function computeBattleAir(s: GameState) {
  battleAir.clear();
  const battles = s.activeBattles.map((id) => s.battles[id]).filter((b): b is Battle => !!b && b.result == null);
  if (!battles.length) return;
  const sides = new Map(battles.map((b) => [b.id, battleSides(s, b)] as const));
  for (const b of battles) battleAir.set(b.id, { aSup: 0, dSup: 0, aCas: { soft: 0, hard: 0 }, dCas: { soft: 0, hard: 0 }, aWings: 0, dWings: 0 });
  const covers: [AirWing, Battle[]][] = [];
  for (const w of Object.values(s.airWings ?? {})) {
    if (!flying(w) || (w.mission !== 'support' && w.mission !== 'defense')) continue;
    const list: Battle[] = [];
    for (const b of battles) {
      const [A, D] = sides.get(b.id)!;
      if (!A.has(w.owner) && !D.has(w.owner)) continue;
      if (w.mission === 'defense') {
        const st = s.provinces[b.province];
        if (st.owner !== w.owner && st.controller !== w.owner && !isFriendly(s, w.owner, st.owner)) continue;
      }
      const km = distKm(w.base, b.province);
      if (w.units.some((u) => km <= rangeOf(u.type))) list.push(b);
    }
    if (list.length) covers.push([w, list]);
  }
  for (const [w, list] of covers) {
    const n = s.nations[w.owner];
    for (const b of list) {
      const ba = battleAir.get(b.id)!;
      const isA = sides.get(b.id)![0].has(w.owner);
      const sky = WEATHER[provinceWeather(s, b.province)].air * TERRAIN[b.terrain].air / list.length;
      const km = distKm(w.base, b.province);
      for (const u of w.units) {
        if (km > rangeOf(u.type)) continue;
        const e = squadronEff(u, n) * sky;
        if (isA) ba.aSup += UNITS[u.type].air * e; else ba.dSup += UNITS[u.type].air * e;
        if (w.mission === 'support') {
          const c = isA ? ba.aCas : ba.dCas;
          c.soft += UNITS[u.type].soft * e; c.hard += UNITS[u.type].hard * e;
        }
      }
      if (isA) ba.aWings++; else ba.dWings++;
    }
  }
  for (const b of battles) {
    const ba = battleAir.get(b.id)!;
    const [A, D] = sides.get(b.id)!;
    const sky = WEATHER[provinceWeather(s, b.province)].air * TERRAIN[b.terrain].air;
    // carrier aircraft over their waters
    for (const f of Object.values(s.fleets)) {
      if (f.ships.battlegroup < 0.05 || !PROV[b.province].seas.includes(f.sea)) continue;
      const v = f.ships.battlegroup * AIR.CARRIER_AIR * (0.4 + 0.6 * f.org) * (s.nations[f.owner]?.techMods.quality.ships ?? 1) * sky;
      if (A.has(f.owner)) { ba.aSup += v; ba.aCas.soft += v * 0.4; } else if (D.has(f.owner)) { ba.dSup += v; ba.dCas.soft += v * 0.4; }
    }
    // air-defence batteries over their own territory
    const owner = s.provinces[b.province].owner;
    const sam = (s.nations[owner]?.regime?.sam ?? 0) * AIR.SAM_AIR;
    if (sam) { if (A.has(owner)) ba.aSup += sam; else if (D.has(owner)) ba.dSup += sam; }
  }
  // losses: the side that holds the sky shoots down the other's aircraft
  for (const [w, list] of covers) {
    let frac = 0;
    for (const b of list) {
      const ba = battleAir.get(b.id)!;
      const isA = sides.get(b.id)![0].has(w.owner);
      const own = isA ? ba.aSup : ba.dSup, enemy = isA ? ba.dSup : ba.aSup;
      if (enemy > 0.5) frac += AIR.LOSS * (enemy / Math.max(1, own + enemy)) * (enemy > own ? 1.4 : 0.8) / list.length;
    }
    w.last.sorties = list.length;
    if (frac > 0) lose(s, w, frac);
  }
}

function lose(s: GameState, w: AirWing, frac: number) {
  let lost = 0;
  for (const u of w.units) {
    const before = planesOf(u);
    u.equipment = Math.max(0, u.equipment * (1 - frac));
    u.strength = Math.max(0, u.strength * (1 - frac * 0.4));
    u.org = Math.max(0, u.org - frac * 3);
    lost += before - planesOf(u);
  }
  w.last.lost += lost;
  w.units = w.units.filter((u) => u.equipment > 0.04 && u.strength > UNITS[u.type].personnel * 0.1);
  if (!w.units.length) {
    delete s.airWings[w.id];
    addEvent(s, 'battle', `${w.name} of ${s.nations[w.owner]?.name} was wiped out.`, [w.owner], { important: s.nations[w.owner]?.isPlayer });
  }
}

/** Air power a nation can put over a province (estimates: intel reports and the AI). */
export function airNear(s: GameState, nation: string, p: number): number {
  let v = 0;
  for (const w of Object.values(s.airWings ?? {})) {
    if (!flying(w) || (w.mission !== 'support' && w.mission !== 'defense')) continue;
    if (w.owner !== nation && !isFriendly(s, w.owner, nation)) continue;
    const km = distKm(w.base, p);
    for (const u of w.units) if (km <= rangeOf(u.type)) v += UNITS[u.type].air * squadronEff(u, s.nations[w.owner]);
  }
  return v;
}

// ---------------------------------------------------------------- interception & sea control
/** Fighter cover over a province against enemies of `by` (drives interception of strikes and raids). */
export function airCover(s: GameState, by: string, p: number): number {
  let cover = 0;
  for (const w of Object.values(s.airWings ?? {})) {
    if (!flying(w) || (w.mission !== 'defense' && w.mission !== 'support') || !atWar(s, w.owner, by)) continue;
    const km = distKm(w.base, p);
    for (const u of w.units) if (km <= rangeOf(u.type)) cover += UNITS[u.type].air * squadronEff(u, s.nations[w.owner]) / 10;
  }
  return cover;
}
/** Naval strike power a nation's wings bring to a sea zone (counts toward sea control). */
export function navalAir(s: GameState, nation: string, zone: number): number {
  let p = 0;
  for (const w of Object.values(s.airWings ?? {})) {
    if (!flying(w) || w.mission !== 'naval' || w.target !== zone) continue;
    if (w.owner !== nation && !isFriendly(s, w.owner, nation)) continue;
    const km = seaKm(w.base, zone);
    for (const u of w.units) if (km <= rangeOf(u.type)) p += (u.type === 'bomber' ? 8 : 3) * squadronEff(u, s.nations[w.owner]);
  }
  return p;
}

// ---------------------------------------------------------------- missions
/** Airbases can be set up in any province the nation holds (captured airfields included). */
export function canBase(s: GameState, owner: string, p: number) {
  return s.provinces[p]?.controller === owner;
}
export function checkMission(s: GameState, w: AirWing, mission: AirMission, target: number | null): string | null {
  if (mission === 'bombing') {
    if (target == null || !s.provinces[target]) return 'Choose an enemy province to bomb (right-click it).';
    const st = s.provinces[target];
    if (!atWar(s, w.owner, st.controller) && !armiesIn(s, target).some((a) => atWar(s, a.owner, w.owner))) return `${PROV[target].name} is not held by an enemy.`;
    const km = distKm(w.base, target);
    if (!w.units.some((u) => km <= rangeOf(u.type))) return `${PROV[target].name} is out of range (${Math.round(km).toLocaleString()} km; this wing reaches ${wingRange(w).toLocaleString()} km). Rebase closer.`;
  }
  if (mission === 'naval') {
    if (target == null || !WORLD.seas[target]) return 'Choose a sea zone (right-click it).';
    const km = seaKm(w.base, target);
    if (!w.units.some((u) => km <= rangeOf(u.type))) return `The ${WORLD.seas[target].name} is out of range (${Math.round(km).toLocaleString()} km). Rebase closer.`;
  }
  return null;
}
export function setMission(s: GameState, w: AirWing, mission: AirMission, target: number | null = null): string | null {
  const err = checkMission(s, w, mission, target);
  if (err) return err;
  w.mission = mission;
  w.target = mission === 'bombing' || mission === 'naval' ? target : null;
  w.bombAcc = 0;
  return null;
}
export function rebaseWing(s: GameState, w: AirWing, to: number): string | null {
  if (to === w.base) { w.rebase = null; return null; }
  if (!canBase(s, w.owner, to)) return `${PROV[to].name} can't host an airbase: it must be territory you hold.`;
  const km = distKm(w.base, to);
  w.rebase = { to, days: Math.max(1, Math.min(6, Math.round(AIR.REBASE_DAYS + km / 1500))) };
  return null;
}

/** Daily: rebasing, bombing raids, naval strikes, refits. */
export function airMissionsDaily(s: GameState) {
  for (const w of Object.values(s.airWings ?? {})) {
    w.last = { sorties: 0, lost: 0, kills: 0 }; // (today's battle cover is counted after this)
    const n = s.nations[w.owner];
    if (!n?.alive) { delete s.airWings[w.id]; continue; }
    if (w.rebase) {
      if (--w.rebase.days <= 0) { w.base = w.rebase.to; w.rebase = null; }
      continue;
    }
    // the airbase was lost: fly to the nearest friendly province
    if (s.provinces[w.base].controller !== w.owner) {
      const home = controlledBy(s, w.owner).sort((a, b) => distKm(w.base, a) - distKm(w.base, b))[0];
      if (home == null) { delete s.airWings[w.id]; continue; }
      w.rebase = { to: home, days: 1 };
      if (n.isPlayer) addEvent(s, 'military', `${w.name} lost its airbase and is flying to ${PROV[home].name}.`, [w.owner], { province: home });
      continue;
    }
    if (w.mission === 'bombing') bombingRun(s, w, n);
    else if (w.mission === 'naval') navalStrike(s, w, n);
    refit(w, n);
  }
}

function bombingRun(s: GameState, w: AirWing, n: Nation) {
  const p = w.target;
  if (p == null || checkMission(s, w, 'bombing', p)) { w.mission = 'support'; w.target = null; return; }
  const st = s.provinces[p];
  const km = distKm(w.base, p);
  const sky = WEATHER[provinceWeather(s, p)].air;
  let bomb = 0, escort = 0;
  for (const u of w.units) {
    if (km > rangeOf(u.type)) continue;
    const e = squadronEff(u, n) * sky;
    bomb += (UNITS[u.type].soft + UNITS[u.type].hard) * 0.5 * e;
    escort += UNITS[u.type].air * e;
  }
  if (bomb <= 0) return;
  // enemy fighters and air defences over the target
  const defender = s.nations[st.controller];
  const flak = airCover(s, w.owner, p) * 10 + (defender?.regime?.sam ?? 0) * AIR.SAM_AIR;
  const through = escort + flak > 0 ? Math.max(0.2, 1 - flak / (escort + flak) * 0.8) : 1;
  const hit = bomb * through;
  w.last.sorties = 1;
  // troops in the province
  const troops = armiesIn(s, p).filter((a) => atWar(s, a.owner, w.owner));
  for (const a of troops) for (const u of a.units) {
    const f = Math.min(0.02, hit * AIR.BOMB_TROOPS / troops.length);
    u.strength *= 1 - f; u.org = Math.max(0, u.org - f * 4); u.equipment *= 1 - f * 0.5;
  }
  // industry and infrastructure
  w.bombAcc += hit;
  const lost: string[] = [];
  while (w.bombAcc >= AIR.BOMB_BUILDING) {
    w.bombAcc -= AIR.BOMB_BUILDING;
    const k = (['power', 'railway', 'factory', 'depot', 'port'] as const).find((x) => st.buildings[x] > 0);
    if (!k) { st.damage = Math.min(0.9, st.damage + 0.02); break; }
    st.buildings[k]--;
    st.damage = Math.min(0.9, st.damage + 0.03);
    st.infra = 1 + st.buildings.road + st.buildings.railway * 2;
    lost.push(k);
  }
  if (flak > 0) lose(s, w, AIR.BOMB_LOSS * (flak / (escort + flak)));
  if (lost.length && (n.isPlayer || defender?.isPlayer)) {
    s.eventSeq = (s.eventSeq ?? 0) + 1;
    s.strikes.push({ id: s.eventSeq, day: s.day, by: w.owner, target: st.controller, province: p, kind: 'bombing', count: w.units.length, intercepted: 0, killed: 0, buildings: lost.map((k) => `${k} in ${PROV[p].name}`) });
    if (s.strikes.length > 40) s.strikes.splice(0, s.strikes.length - 40);
    addEvent(s, 'battle', `${w.name} (${n.name}) bombed ${PROV[p].name}: destroyed ${lost.join(', ')}.`, [w.owner, st.controller], { province: p });
  }
}

function navalStrike(s: GameState, w: AirWing, n: Nation) {
  const z = w.target;
  if (z == null || checkMission(s, w, 'naval', z)) { w.mission = 'defense'; w.target = null; return; }
  const power = navalAir(s, w.owner, z);
  if (power <= 0) return;
  for (const f of Object.values(s.fleets)) {
    if (f.sea !== z || !atWar(s, f.owner, w.owner)) continue;
    const frac = Math.min(0.08, power * AIR.NAVAL_STRIKE);
    for (const k in f.ships) { const kk = k as keyof typeof f.ships; f.ships[kk] = Math.max(0, f.ships[kk] * (1 - frac)); }
    f.org = Math.max(0, f.org - frac * 2);
    w.last.sorties = 1;
    // ships' anti-aircraft fire
    lose(s, w, AIR.LOSS * 0.3);
    if (s.day % 5 === 0 && (n.isPlayer || s.nations[f.owner]?.isPlayer)) addEvent(s, 'battle', `${w.name} struck the ${f.name} in the ${WORLD.seas[z].name} (−${Math.round(frac * 100)}% ships).`, [w.owner, f.owner]);
  }
}

/** Replace lost aircraft and crews at the base (paid from the treasury), recover readiness. */
function refit(w: AirWing, n: Nation) {
  const resting = w.mission === 'idle' ? 2 : 1;
  for (const u of w.units) {
    const sp = UNITS[u.type];
    u.org = Math.min(1, u.org + 0.05 * resting);
    if (u.strength < sp.personnel && n.manpower > 0) {
      const add = Math.min(sp.personnel - u.strength, sp.personnel * AIR.REFIT * resting, n.manpower);
      u.strength += add; n.manpower -= add;
    }
    if (u.equipment < 1 && n.treasury > 0 && !n.bankrupt) {
      const frac = Math.min(1 - u.equipment, AIR.REFIT * resting);
      const cost = frac * unitEquipCost(u.type, n);
      u.equipment += frac;
      n.treasury -= cost; n.ledgerMonth.expense += cost;
    }
  }
}

/** Points toward the national military strength rating. */
export function airPoints(s: GameState, id: string) {
  let p = 0;
  for (const w of wingsOf(s, id)) for (const u of w.units) p += UNITS[u.type].points;
  return p;
}
