/**
 * Precision strikes (drones, cruise missiles) and strategic nuclear weapons.
 * Strikes hit a province held by an enemy: they kill troops, disorganise them, wreck buildings and
 * infrastructure. Nuclear weapons do all of that on a catastrophic scale — and turn the whole world
 * against the user: a 10-year global trade embargo, collapsing relations, casus belli for everyone
 * and nuclear retaliation from any armed enemy.
 */
import type { BuildingKind, GameState, Nation, StrikeRecord } from './types';
import { STRIKES, NUKE, AIR_DEFENSE, UNITS, SAM_MAX, SAM_EACH } from './config';
import { PROV, distKm } from './geo';
import { atWar, armiesIn, controlledBy, enemiesOf, invalidateArmies, invalidateDiplo, rel, livingNations } from './world';
import { addEvent } from './events';
import { hashNoise } from './rng';
import { armyStrength, deleteArmy, industryBonus } from './military';
import { infraOf } from './economy';
import { airCover } from './air';
import { fmt } from './economy';

export type StrikeKind = 'drone' | 'missile' | 'nuke' | 'ballistic' | 'recon';
export type Munition = Exclude<StrikeKind, 'nuke'>;

/** Price of one drone or missile for this nation. */
export function munitionCost(kind: Munition, n: Nation) {
  return STRIKES[kind].cost * (1 - industryBonus(n).discount) * n.priceIndex;
}
export function nukeProgramCost(n: Nation) { return NUKE.programCost * n.priceIndex; }
export function warheadCost(n: Nation) { return NUKE.warheadCost * n.priceIndex; }

/** Distance (km) from the nearest land the nation holds; 0 if a fleet of theirs is off the coast. */
export function strikeDistance(s: GameState, by: string, p: number): { km: number; fleet: boolean } {
  const fleet = Object.values(s.fleets).some((f) => f.owner === by && PROV[p].seas.includes(f.sea));
  let km = Infinity;
  for (const q of controlledBy(s, by)) { const d = distKm(q, p); if (d < km) km = d; }
  return { km, fleet };
}

export function inRange(s: GameState, by: string, kind: StrikeKind, p: number) {
  if (kind === 'nuke') return true;
  const d = strikeDistance(s, by, p);
  if (d.fleet) return true; // ships carry drones and missiles to any coast
  return d.km <= STRIKES[kind].range;
}

/** Share of incoming strikes shot down by enemy air wings in and around the target. */
export function interceptRate(s: GameState, by: string, p: number, kind: StrikeKind) {
  if (kind === 'nuke') return 0;
  // enemy fighters covering the target (air-defence or ground-support missions in range)
  const wings = airCover(s, by, p);
  // and the defender's SAM batteries
  const owner = s.nations[s.provinces[p].controller];
  const extra = owner?.regime ? Math.min(SAM_MAX * SAM_EACH, owner.regime.sam * SAM_EACH) : 0;
  return Math.min(0.85, Math.min(AIR_DEFENSE.MAX, wings * AIR_DEFENSE.PER_AIR_WING) + extra) * STRIKES[kind].intercept;
}

export function checkStrike(s: GameState, n: Nation, kind: StrikeKind, p: number, count = 1): string | null {
  const st = s.provinces[p];
  if (!st) return 'Unknown province.';
  const hostileArmies = armiesIn(s, p).some((a) => atWar(s, a.owner, n.id));
  if (!atWar(s, n.id, st.controller) && !hostileArmies) return 'You can only strike provinces held by, or occupied by, a nation you are at war with.';
  if (count < 1) return 'Choose how many to launch.';
  if (n.arsenal[kind] < count) return kind === 'nuke' ? 'You have no nuclear weapons ready.' : `You only have ${n.arsenal[kind]} ${STRIKES[kind as Munition].plural}. Buy more in the Military panel.`;
  if (!inRange(s, n.id, kind, p)) return `${PROV[p].name} is out of range (${STRIKES[kind as Munition].range.toLocaleString()} km from land you hold). Advance, or move a fleet off the coast.`;
  return null;
}

/** Buildings hit first by precision strikes: logistics and industry. */
const TARGET_ORDER: BuildingKind[] = ['depot', 'railway', 'power', 'factory', 'port', 'road', 'fort', 'mine', 'farm', 'lab'];

/** Fire `count` drones/missiles, or one nuclear weapon, at province p. */
export function launchStrike(s: GameState, n: Nation, kind: StrikeKind, p: number, count = 1): { ok: boolean; message: string; record?: StrikeRecord } {
  const err = checkStrike(s, n, kind, p, kind === 'nuke' ? 1 : count);
  if (err) return { ok: false, message: err };
  if (kind === 'nuke') return nuclearStrike(s, n, p);
  const spec = STRIKES[kind];
  if (kind === 'recon') {
    n.arsenal.recon -= count;
    const rate = interceptRate(s, n.id, p, kind);
    const lost = Math.min(count, Math.floor(count * rate + hashNoise(s.seed, p, s.day, count, 3)));
    if (lost >= count) return { ok: true, message: `All ${count} recon drone${count > 1 ? 's were' : ' was'} shot down over ${PROV[p].name}.` };
    n.regime.recon[p] = s.day + 30;
    const foes = armiesIn(s, p).filter((a) => atWar(s, a.owner, n.id));
    const comp = new Map<string, number>();
    for (const a of foes) for (const u of a.units) comp.set(UNITS[u.type].short, (comp.get(UNITS[u.type].short) ?? 0) + 1);
    const men = foes.reduce((t, a) => t + armyStrength(a), 0);
    return { ok: true, message: `Recon over ${PROV[p].name}: ${foes.length ? `${Math.round(men).toLocaleString()} enemy troops (${[...comp].map(([k, v]) => `${v} ${k}`).join(', ')})` : 'no enemy troops'}. Targeting data valid 30 days (+6% attack).` };
  }
  const st = s.provinces[p];
  const target = st.controller;
  n.arsenal[kind] -= count;
  const rate = interceptRate(s, n.id, p, kind);
  const intercepted = Math.min(count, Math.floor(count * rate + hashNoise(s.seed, p, s.day, count, kind === 'drone' ? 1 : 2)));
  const hits = count - intercepted;
  let killed = 0;
  // troops
  const frac = 1 - Math.pow(1 - spec.kill, hits);
  for (const a of armiesIn(s, p)) {
    if (!atWar(s, a.owner, n.id)) continue;
    for (const u of a.units) {
      const loss = u.strength * frac;
      u.strength -= loss; killed += loss;
      u.org = Math.max(0, u.org - Math.min(0.5, spec.org * hits));
      u.equipment = Math.max(0, u.equipment - frac * 0.6);
    }
    a.entrench = Math.max(0, a.entrench - 0.05 * hits);
    a.units = a.units.filter((u) => u.strength > UNITS[u.type].personnel * 0.08);
    if (!a.units.length) deleteArmy(s, a.id);
  }
  // buildings & infrastructure
  const destroyed: string[] = [];
  let buildingHits = Math.floor(hits * spec.hitBuilding + hashNoise(s.seed, p, s.day, 7));
  for (const k of TARGET_ORDER) {
    while (buildingHits > 0 && st.buildings[k] > 0) { st.buildings[k]--; buildingHits--; destroyed.push(k); }
    if (buildingHits <= 0) break;
  }
  st.damage = Math.min(0.9, st.damage + spec.damage * hits);
  st.infra = infraOf(st);
  recordCasualties(s, n.id, target, killed);
  invalidateArmies();
  const rec = record(s, { by: n.id, target, province: p, kind, count, intercepted, killed: Math.round(killed), buildings: destroyed });
  const what = destroyed.length ? `, destroyed ${summarise(destroyed)}` : '';
  const msg = `${count} ${spec.plural} hit ${PROV[p].name}: ${intercepted ? `${intercepted} shot down, ` : ''}${Math.round(killed).toLocaleString()} troops killed or wounded${what}.`;
  addEvent(s, 'battle', `${n.name} strike on ${PROV[p].name} (${s.nations[target]?.name}): ${msg.split(': ')[1]}`, [n.id, target], { province: p, important: false });
  return { ok: true, message: msg, record: rec };
}

function nuclearStrike(s: GameState, n: Nation, p: number): { ok: boolean; message: string; record?: StrikeRecord } {
  const st = s.provinces[p];
  const target = st.controller;
  const victim = s.nations[st.owner];
  n.arsenal.nuke -= 1;
  let killed = 0;
  for (const q of [p, ...PROV[p].neighbors]) {
    const k = q === p ? NUKE.kill : NUKE.nearbyKill;
    for (const a of armiesIn(s, q)) {
      for (const u of a.units) { const loss = u.strength * k; u.strength -= loss; killed += loss; u.org *= 1 - k; }
      a.units = a.units.filter((u) => u.strength > UNITS[u.type].personnel * 0.08);
      if (!a.units.length) deleteArmy(s, a.id);
    }
  }
  const civ = st.pop * NUKE.popLoss;
  st.pop -= civ;
  st.dev *= 1 - NUKE.devLoss;
  st.damage = 0.95;
  st.resistance = 100;
  const destroyed: string[] = [];
  for (const k of TARGET_ORDER) { const lost = Math.ceil(st.buildings[k] / 2); if (lost > 0) { st.buildings[k] -= lost; for (let i = 0; i < lost; i++) destroyed.push(k); } }
  st.infra = infraOf(st);
  if (victim) victim.stability = Math.max(0, victim.stability - 15);
  recordCasualties(s, n.id, target, killed);
  invalidateArmies();
  const rec = record(s, { by: n.id, target, province: p, kind: 'nuke', count: 1, intercepted: 0, killed: Math.round(killed + civ), buildings: destroyed });
  addEvent(s, 'war', `☢ ${n.name} used a nuclear weapon on ${PROV[p].name}! About ${Math.round((killed + civ) / 1000).toLocaleString()} thousand dead. The world is horrified.`, [n.id, target, st.owner], { province: p, important: true });
  worldReaction(s, n);
  // nuclear-armed enemies answer in kind
  for (const e of enemiesOf(s, n.id)) {
    const en = s.nations[e];
    if (!en?.alive || en.isPlayer || en.arsenal.nuke < 1) continue;
    const tgt = retaliationTarget(s, en, n);
    if (tgt == null) continue;
    en.arsenal.nuke -= 1;
    const tst = s.provinces[tgt];
    let k2 = 0;
    for (const a of armiesIn(s, tgt)) { for (const u of a.units) { const l = u.strength * NUKE.kill; u.strength -= l; k2 += l; } a.units = a.units.filter((u) => u.strength > UNITS[u.type].personnel * 0.08); if (!a.units.length) deleteArmy(s, a.id); }
    const c2 = tst.pop * NUKE.popLoss;
    tst.pop -= c2; tst.dev *= 1 - NUKE.devLoss; tst.damage = 0.95;
    for (const k of TARGET_ORDER) tst.buildings[k] -= Math.ceil(tst.buildings[k] / 2);
    tst.infra = infraOf(tst);
    n.stability = Math.max(0, n.stability - 15);
    record(s, { by: e, target: n.id, province: tgt, kind: 'nuke', count: 1, intercepted: 0, killed: Math.round(k2 + c2), buildings: [] });
    addEvent(s, 'war', `☢ ${en.name} retaliated with a nuclear strike on ${PROV[tgt].name}!`, [e, n.id], { province: tgt, important: true });
  }
  invalidateArmies();
  return { ok: true, message: `Nuclear strike on ${PROV[p].name}. ${Math.round((killed + civ) / 1000).toLocaleString()} thousand dead. Every nation has cut trade with you.`, record: rec };
}

/** The price of using nuclear weapons. */
function worldReaction(s: GameState, n: Nation) {
  n.embargoUntil = s.day + NUKE.embargoDays;
  n.infamy = 100;
  n.stability = Math.max(0, n.stability + NUKE.stability);
  n.warSupport = Math.max(0, n.warSupport + NUKE.warSupport);
  for (const o of livingNations(s)) {
    if (o.id === n.id) continue;
    const r = rel(s, n.id, o.id);
    r.value = Math.max(-100, r.value + NUKE.relations);
    r.trade = false;
    if (o.overlord !== n.id) r.alliance = false;
    r.nap = 0;
    o.claims[n.id] = s.day + NUKE.embargoDays; // everyone now has a casus belli against you
  }
  invalidateDiplo();
  addEvent(s, 'diplomacy', `The world imposes a total embargo on ${n.name} for ${NUKE.embargoDays / 365} years: no trade, no treaties, no imports. Alliances are void and every nation has a casus belli.`, [n.id], { important: true });
}

function retaliationTarget(s: GameState, by: Nation, victim: Nation): number | null {
  // the attacker's biggest army in reach, else its capital
  let best: number | null = null, bs = 0;
  for (const a of Object.values(s.armies)) if (a.owner === victim.id && !a.embarked) { const v = armyStrength(a); if (v > bs) { bs = v; best = a.location; } }
  void by;
  if (best != null && bs > 20000) return best;
  return s.provinces[victim.capital]?.controller === victim.id ? victim.capital : best;
}

function recordCasualties(s: GameState, by: string, target: string, killed: number) {
  if (killed <= 0) return;
  const w = s.wars.find((x) => (x.attackers.includes(by) && x.defenders.includes(target)) || (x.defenders.includes(by) && x.attackers.includes(target)));
  if (w) { if (w.attackers.includes(by)) w.casualtiesD += killed; else w.casualtiesA += killed; }
  const a = s.nations[by], b = s.nations[target];
  if (a) a.stats.casualtiesInflicted += killed;
  if (b) b.stats.casualtiesSuffered += killed;
}

function record(s: GameState, r: Omit<StrikeRecord, 'id' | 'day'>): StrikeRecord {
  s.eventSeq = (s.eventSeq ?? 0) + 1;
  const rec: StrikeRecord = { id: s.eventSeq, day: s.day, ...r };
  s.strikes.push(rec);
  if (s.strikes.length > 40) s.strikes.splice(0, s.strikes.length - 40);
  return rec;
}

const NAMES: Partial<Record<string, string>> = { depot: 'supply depot', railway: 'railway', power: 'power plant', factory: 'factory', port: 'port', road: 'road network', fort: 'fortification', mine: 'mine', farm: 'farm', lab: 'research institute' };
function summarise(list: string[]) {
  const c = new Map<string, number>();
  for (const k of list) c.set(k, (c.get(k) ?? 0) + 1);
  return [...c].map(([k, v]) => `${v > 1 ? `${v}× ` : ''}${NAMES[k] ?? k}`).join(', ');
}

// ---------------------------------------------------------------- procurement
export function buyMunitions(s: GameState, n: Nation, kind: Munition, count: number): string | null {
  void s;
  if (count < 1 || count > 100) return 'Order between 1 and 100.';
  const cost = munitionCost(kind, n) * count;
  if (n.treasury < cost) return `Insufficient funds: ${count} ${STRIKES[kind].plural} cost ${fmt(cost)}.`;
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  n.arsenal[kind] += count;
  return null;
}
export function startNuclearProgram(s: GameState, n: Nation): string | null {
  if (n.nukeProgram >= 0) return n.nukeProgram === 0 ? 'You are already a nuclear power.' : 'The programme is already running.';
  const cost = nukeProgramCost(n);
  if (n.treasury < cost) return `A nuclear programme costs ${fmt(cost)}.`;
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  n.nukeProgram = NUKE.programDays;
  // the world notices
  for (const o of livingNations(s)) if (o.id !== n.id) rel(s, n.id, o.id).value = Math.max(-100, rel(s, n.id, o.id).value - 10);
  addEvent(s, 'diplomacy', `${n.name} has begun a nuclear weapons programme. Neighbours and the great powers are alarmed.`, [n.id], { important: true });
  return null;
}
export function buildWarhead(s: GameState, n: Nation): string | null {
  void s;
  if (n.nukeProgram !== 0) return 'You need a completed nuclear programme first.';
  const cost = warheadCost(n);
  if (n.treasury < cost) return `An ICBM costs ${fmt(cost)}.`;
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  n.warheads.push(NUKE.warheadDays);
  return null;
}

/** Daily: programme and warhead construction; the embargo keeps relations frozen. */
export function strategicDaily(s: GameState, n: Nation) {
  if (n.nukeProgram > 0 && --n.nukeProgram === 0) addEvent(s, 'military', `${n.name} has tested its first nuclear weapon and can now build ICBMs.`, [n.id], { important: true });
  if (n.warheads.length) {
    for (let i = 0; i < n.warheads.length; i++) n.warheads[i]--;
    const done = n.warheads.filter((d) => d <= 0).length;
    if (done) { n.warheads = n.warheads.filter((d) => d > 0); n.arsenal.nuke += done; if (n.isPlayer) addEvent(s, 'military', `${done} ICBM${done > 1 ? 's' : ''} ready.`, [n.id]); }
  }
  if (n.embargoUntil > s.day && s.day % 7 === 0) {
    for (const o of livingNations(s)) if (o.id !== n.id) { const r = rel(s, n.id, o.id); if (r.value > -40) r.value = -40; r.trade = false; }
  }
}

/** AI: buy and fire drones and missiles while at war (never nuclear first). Weekly. */
export function aiStrikes(s: GameState, n: Nation) {
  const enemies = enemiesOf(s, n.id);
  if (!enemies.length) return;
  const out = Math.max(1, n.budget.output);
  if (n.treasury > out * 0.15 && !n.bankrupt) {
    const spend = out * 0.008;
    const drones = Math.min(30, Math.floor((spend * 0.6) / munitionCost('drone', n)));
    const missiles = out > 400 ? Math.min(12, Math.floor((spend * 0.4) / munitionCost('missile', n))) : 0;
    if (drones > 0) buyMunitions(s, n, 'drone', drones);
    if (missiles > 0) buyMunitions(s, n, 'missile', missiles);
    if (out > 2000 && n.arsenal.ballistic < 6) buyMunitions(s, n, 'ballistic', 2);
  }
  // targets: the largest enemy army in range, else the most valuable enemy province in range
  for (const kind of ['drone', 'missile', 'ballistic'] as const) {
    if (n.arsenal[kind] < 1) continue;
    let best: number | null = null, bs = 0;
    for (const a of Object.values(s.armies)) {
      if (!atWar(s, a.owner, n.id) || a.embarked) continue;
      const v = armyStrength(a) * (a.battleId != null ? 1.5 : 1);
      if (v > bs && inRange(s, n.id, kind, a.location)) { bs = v; best = a.location; }
    }
    if (best == null && kind !== 'drone') {
      for (const e of enemies) for (const p of controlledBy(s, e)) { const st = s.provinces[p]; const v = st.buildings.factory + st.buildings.power + st.buildings.railway + st.buildings.depot * 2; if (v > bs && inRange(s, n.id, kind, p)) { bs = v; best = p; } }
    }
    if (best != null) launchStrike(s, n, kind, best, Math.min(n.arsenal[kind], kind === 'drone' ? 8 : kind === 'missile' ? 4 : 2));
  }
}
