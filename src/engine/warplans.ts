/**
 * War planning: coordinated offensives, bulk orders for many armies, field engineering,
 * scorched earth, partisans, mercenaries, border fortification and technology licensing.
 */
import type { Army, GameState, Nation, UnitType } from './types';
import { UNITS, MERCENARY_MULT, BUILDINGS } from './config';
import { PROV, distKm, landLinks } from './geo';
import { atWar, armiesIn, isFriendly, ownedBy, controlledBy, invalidateArmies, alliesOf, peekRel } from './world';
import { findPath, newUnit, createArmy, recruitCost, armyOrg } from './military';
import { estimateBattle } from './battle';
import { addEvent } from './events';
import { infraOf, startConstruction, buildCost } from './economy';
import { TECH_BY_ID, canResearch, recomputeTechMods } from './research';

const own = (s: GameState, n: Nation, ids: number[]) => ids.map((id) => s.armies[id]).filter((a): a is Army => !!a && a.owner === n.id);

// ---------------------------------------------------------------- coordinated offensive
/**
 * Selected armies march to friendly provinces next to the target, wait until all have arrived
 * (or 30 days pass), then attack together on the same day.
 */
export function createOperation(s: GameState, n: Nation, armyIds: number[], target: number): { ok: boolean; message: string } {
  const armies = own(s, n, armyIds).filter((a) => a.battleId == null && !a.embarked);
  if (!armies.length) return { ok: false, message: 'Select at least one army that is not in battle.' };
  const ctrl = s.provinces[target].controller;
  if (!atWar(s, n.id, ctrl) && !armiesIn(s, target).some((a) => atWar(s, a.owner, n.id))) return { ok: false, message: 'The target must be an enemy province.' };
  const staging: Record<number, number> = {};
  const cands = [...PROV[target].neighbors, ...PROV[target].straits].filter((p) => { const c = s.provinces[p].controller; return (c === n.id || isFriendly(s, n.id, c)) && !armiesIn(s, p).some((x) => atWar(s, x.owner, n.id)); });
  if (!cands.length) return { ok: false, message: `You hold no province next to ${PROV[target].name} to stage from.` };
  for (const a of armies) {
    let best: number | null = null, bd = Infinity;
    for (const p of cands) { const d = distKm(a.location, p); if (d < bd) { bd = d; best = p; } }
    if (best == null) continue;
    if (a.location !== best) { const path = findPath(s, a, best, { avoidEnemy: true }); if (!path) continue; a.path = path; a.moveProgress = 0; }
    a.stance = 'hold';
    staging[a.id] = best;
  }
  const ids = Object.keys(staging).map(Number);
  if (!ids.length) return { ok: false, message: 'None of the selected armies can reach a staging area.' };
  s.operations = s.operations.filter((o) => !o.armyIds.some((x) => ids.includes(x)));
  s.operations.push({ id: s.nextId++, owner: n.id, armyIds: ids, target, staging, state: 'staging', start: s.day, deadline: s.day + 30 });
  invalidateArmies();
  return { ok: true, message: `Operation against ${PROV[target].name}: ${ids.length} armies moving to their start lines. They attack together when all are in place (or in 30 days).` };
}
export function cancelOperation(s: GameState, n: Nation, id: number): string | null {
  const o = s.operations.find((x) => x.id === id && x.owner === n.id);
  if (!o) return 'No such operation.';
  s.operations = s.operations.filter((x) => x !== o);
  return null;
}
/** Daily: launch operations whose armies are in place. */
export function operationsDaily(s: GameState) {
  if (!s.operations?.length) return;
  for (const o of [...s.operations]) {
    const armies = o.armyIds.map((id) => s.armies[id]).filter((a): a is Army => !!a);
    if (!armies.length || s.day > o.deadline + 60) { s.operations = s.operations.filter((x) => x !== o); continue; }
    if (o.state === 'staging') {
      const ready = armies.every((a) => a.location === o.staging[a.id] && !a.path.length && a.battleId == null);
      if (!ready && s.day < o.deadline) continue;
      let go = 0;
      for (const a of armies) { if (a.battleId != null || a.embarked) continue; const p = findPath(s, a, o.target); if (p && p.length <= 2) { a.path = p; a.moveProgress = 0; go++; } }
      o.state = 'attacking';
      const n = s.nations[o.owner];
      if (n?.isPlayer) addEvent(s, 'battle', `Operation against ${PROV[o.target].name} launched: ${go} armies attack together.`, [o.owner], { province: o.target, important: true });
      invalidateArmies();
    } else if (armies.every((a) => !a.path.length && a.battleId == null)) {
      s.operations = s.operations.filter((x) => x !== o);
    }
  }
}

// ---------------------------------------------------------------- bulk orders
/** Each army attacks the adjacent enemy province where its odds are best (if any). */
export function attackNearest(s: GameState, n: Nation, armyIds: number[]): { ok: boolean; message: string } {
  let sent = 0;
  for (const a of own(s, n, armyIds)) {
    if (a.battleId != null || a.embarked) continue;
    let best: number | null = null, bo = -1;
    for (const l of landLinks(a.location)) {
      const st = s.provinces[l.to];
      const foes = armiesIn(s, l.to).filter((x) => atWar(s, x.owner, n.id));
      if (!atWar(s, n.id, st.controller) && !foes.length) continue;
      const odds = foes.length ? estimateBattle(s, [a], l.to, a.location, foes, 0).odds : 1.2;
      if (odds > bo) { bo = odds; best = l.to; }
    }
    if (best != null) { a.path = [best]; a.moveProgress = 0; sent++; }
  }
  return sent ? { ok: true, message: `${sent} ${sent === 1 ? 'army attacks' : 'armies attack'} the nearest enemy positions.` } : { ok: false, message: 'None of the selected armies is next to an enemy province.' };
}
/** Engineers dig field fortifications at once ($0.3M per formation). */
export function digIn(s: GameState, n: Nation, armyIds: number[]): { ok: boolean; message: string } {
  const list = own(s, n, armyIds).filter((a) => a.battleId == null && !a.path.length && !a.embarked && a.entrench < 0.8);
  const units = list.reduce((t, a) => t + a.units.length, 0);
  const cost = units * 0.3 * n.priceIndex;
  if (!list.length) return { ok: false, message: 'Select halted armies that are not already dug in.' };
  if (n.treasury < cost) return { ok: false, message: `Digging in costs $${cost.toFixed(1)}M.` };
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  for (const a of list) { a.entrench = 0.8; a.stance = 'hold'; }
  return { ok: true, message: `${list.length} armies dug in (trenches and minefields, 80% entrenchment) for $${cost.toFixed(1)}M.` };
}

// ---------------------------------------------------------------- scorched earth & partisans
export function scorchedEarth(s: GameState, n: Nation, p: number): string | null {
  const st = s.provinces[p];
  if (st.owner !== n.id || st.controller !== n.id) return 'Only in provinces you own and hold.';
  const threatened = [p, ...PROV[p].neighbors].some((q) => armiesIn(s, q).some((a) => atWar(s, a.owner, n.id)));
  if (!threatened) return 'Scorched earth needs enemy troops in or next to the province.';
  for (const k in st.buildings) { const key = k as keyof typeof st.buildings; if (key !== 'fort') st.buildings[key] = Math.floor(st.buildings[key] / 2); }
  st.damage = Math.min(0.9, st.damage + 0.4);
  st.infra = infraOf(st);
  st.scorchedUntil = s.day + 365;
  n.stability = Math.max(0, n.stability - 3);
  if (n.regime) n.regime.groups.workers = Math.max(0, n.regime.groups.workers - 5);
  invalidateArmies();
  addEvent(s, 'war', `${n.name} burned ${PROV[p].name}: rail, depots and factories destroyed so the enemy cannot use them.`, [n.id], { province: p, important: true });
  return null;
}
export function fundPartisans(s: GameState, n: Nation, p: number): string | null {
  const st = s.provinces[p];
  if (st.owner !== n.id || st.controller === n.id || !atWar(s, n.id, st.controller)) return 'Partisans can only be funded in your provinces occupied by an enemy.';
  const cost = 3 * n.priceIndex;
  if (n.treasury < cost) return 'Insufficient funds.';
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  st.partisansUntil = Math.max(st.partisansUntil ?? 0, s.day) + 120;
  st.resistance = Math.min(100, st.resistance + 20);
  return null;
}
/** Daily: partisans harass occupiers. */
export function partisansDaily(s: GameState) {
  for (const st of s.provinces) {
    if (!st.partisansUntil || st.partisansUntil <= s.day) { if (st.partisansUntil) delete st.partisansUntil; continue; }
    if (st.controller === st.owner) { delete st.partisansUntil; continue; }
    for (const a of armiesIn(s, st.id)) if (a.owner === st.controller) for (const u of a.units) { u.strength *= 0.997; u.org = Math.max(0, u.org - 0.004); }
  }
}

// ---------------------------------------------------------------- mercenaries
export const MERC_TYPES: UnitType[] = ['infantry', 'mechanized', 'armored', 'recon'];
export function mercenaryCost(t: UnitType, n: Nation) { return recruitCost(t, n) * MERCENARY_MULT; }
export function hireMercenaries(s: GameState, n: Nation, t: UnitType, p: number): string | null {
  if (!MERC_TYPES.includes(t)) return 'Mercenary companies offer infantry, mechanized, armored and recon units.';
  const st = s.provinces[p];
  if (st.owner !== n.id || st.controller !== n.id) return 'Mercenaries muster in a province you own and hold.';
  const cost = mercenaryCost(t, n);
  if (n.treasury < cost) return `Mercenaries cost $${cost.toFixed(1)}M up front.`;
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  const u = newUnit(s, t, 1, 0.45); u.org = 0.7; u.morale = 0.6;
  let army = armiesIn(s, p).find((a) => a.owner === n.id && !a.battleId && !a.path.length && a.units.length < 24);
  if (!army) army = createArmy(s, n.id, p, [], `${['Free', 'Iron', 'Black', 'Grey', 'Wolf'][s.nextId % 5]} Company`);
  army.units.push(u);
  if (n.regime) n.regime.groups.military = Math.max(0, n.regime.groups.military - 3);
  invalidateArmies();
  addEvent(s, 'military', `Mercenaries hired: ${UNITS[t].label} ready at once in ${PROV[p].name}.`, [n.id], { province: p });
  return null;
}

// ---------------------------------------------------------------- fortify the border
export function borderProvinces(s: GameState, n: Nation): number[] {
  return controlledBy(s, n.id).filter((p) => s.provinces[p].owner === n.id && PROV[p].neighbors.some((q) => { const c = s.provinces[q].controller; return c !== n.id && !isFriendly(s, n.id, c) && (atWar(s, n.id, c) || (peekRel(s, n.id, c)?.value ?? 0) < -20); }));
}
export function fortifyBorder(s: GameState, n: Nation): { ok: boolean; message: string } {
  const list = borderProvinces(s, n);
  let k = 0, spent = 0;
  for (const p of list) {
    const c = buildCost(s, n, p, 'fort');
    if (!c.ok || n.treasury < c.cost) continue;
    const r = startConstruction(s, n, p, 'fort');
    if (r.ok) { k++; spent += r.cost; }
  }
  return k ? { ok: true, message: `Fortifications under construction in ${k} border provinces ($${spent.toFixed(1)}M, ${BUILDINGS.fort.days} days).` } : { ok: false, message: list.length ? 'No border province can take another fort level (or funds are short).' : 'You have no threatened border.' };
}

// ---------------------------------------------------------------- technology licensing
/** Partners (allies or trade partners) who already have the technology. */
export function licensors(s: GameState, n: Nation, tech: string): string[] {
  const out: string[] = [];
  for (const o of Object.values(s.nations)) {
    if (!o.alive || o.id === n.id || !o.research.done.includes(tech)) continue;
    const r = peekRel(s, n.id, o.id);
    if (r?.trade || r?.alliance || alliesOf(s, n.id).includes(o.id)) out.push(o.id);
  }
  return out;
}
export function licenseCost(n: Nation, tech: string) { return (TECH_BY_ID[tech]?.cost ?? 20) * 1.1 * n.priceIndex; }
export function licenseTech(s: GameState, n: Nation, tech: string): string | null {
  const t = TECH_BY_ID[tech];
  if (!t || n.research.done.includes(tech)) return 'Unknown or already known.';
  if (!canResearch(n, tech)) return 'You need the prerequisite technologies first.';
  const from = licensors(s, n, tech);
  if (!from.length) return 'No ally or trade partner has this technology to license.';
  const cost = licenseCost(n, tech);
  if (n.treasury < cost) return `A licence costs $${cost.toFixed(0)}M.`;
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  s.nations[from[0]].treasury += cost * 0.5;
  n.research.done.push(tech);
  if (n.research.current === tech) { n.research.current = null; n.research.progress = 0; }
  n.research.queue = n.research.queue.filter((q) => q !== tech);
  recomputeTechMods(n);
  addEvent(s, 'research', `Licensed ${t.name} from ${s.nations[from[0]].name} (${t.effect}).`, [n.id], { important: true });
  return null;
}

/** Armies that are idle (for selection helpers). */
export const isIdle = (a: Army) => a.battleId == null && !a.path.length && !a.embarked;
export const lowOrg = (a: Army) => armyOrg(a) < 0.35;
void ownedBy;
