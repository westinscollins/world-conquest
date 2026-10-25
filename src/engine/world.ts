// Runtime lookups over GameState (ownership indices, relations, wars). Indices are derived data
// and never saved; they are invalidated whenever ownership/control changes.
import type { Army, GameState, Nation, Relation, War } from './types';
import { NPROV, PROV } from './geo';
import { PLAYER_HELP } from './config';

let cacheFor: GameState | null = null;
let cacheVersion = -1;
let version = 0;
let owned: Map<string, number[]> = new Map();
let controlled: Map<string, number[]> = new Map();
let armiesAt: Map<number, number[]> = new Map();
let armiesVersion = -1;
let armyVersion = 0;

export function invalidateTerritory() { version++; }
export function invalidateArmies() { armyVersion++; }

function rebuild(s: GameState) {
  if (cacheFor === s && cacheVersion === version) return;
  owned = new Map(); controlled = new Map();
  for (const p of s.provinces) {
    (owned.get(p.owner) || owned.set(p.owner, []).get(p.owner)!).push(p.id);
    (controlled.get(p.controller) || controlled.set(p.controller, []).get(p.controller)!).push(p.id);
  }
  cacheFor = s; cacheVersion = version;
  armiesVersion = -1;
}
export function ownedBy(s: GameState, id: string): number[] { rebuild(s); return owned.get(id) || []; }
export function controlledBy(s: GameState, id: string): number[] { rebuild(s); return controlled.get(id) || []; }

export function armiesIn(s: GameState, province: number): Army[] {
  rebuild(s);
  if (armiesVersion !== armyVersion) {
    armiesAt = new Map();
    for (const a of Object.values(s.armies)) {
      if (a.embarked) continue;
      (armiesAt.get(a.location) || armiesAt.set(a.location, []).get(a.location)!).push(a.id);
    }
    armiesVersion = armyVersion;
  }
  return (armiesAt.get(province) || []).map((id) => s.armies[id]).filter(Boolean);
}

export const relKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export function rel(s: GameState, a: string, b: string): Relation {
  const k = relKey(a, b);
  let r = s.relations[k];
  if (!r) { r = { value: 0, alliance: false, nap: 0, trade: false, truceUntil: 0 }; s.relations[k] = r; }
  return r;
}
export function peekRel(s: GameState, a: string, b: string): Relation | undefined { return s.relations[relKey(a, b)]; }

export function warBetween(s: GameState, a: string, b: string): War | undefined {
  for (const w of s.wars) {
    if ((w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a))) return w;
  }
  return undefined;
}
export const atWar = (s: GameState, a: string, b: string) => a !== b && !!warBetween(s, a, b);
export function enemiesOf(s: GameState, a: string): string[] {
  const out = new Set<string>();
  for (const w of s.wars) {
    if (w.attackers.includes(a)) w.defenders.forEach((d) => out.add(d));
    if (w.defenders.includes(a)) w.attackers.forEach((d) => out.add(d));
  }
  return [...out];
}
export function isAtWar(s: GameState, a: string) { return s.wars.some((w) => w.attackers.includes(a) || w.defenders.includes(a)); }
let allyCache: { s: GameState | null; day: number; version: number; map: Map<string, Set<string>> } = { s: null, day: -1, version: -1, map: new Map() };
let diploVersion = 0;
/** Call whenever alliances or overlord relations change. */
export function invalidateDiplo() { diploVersion++; }
export const diploVersionNow = () => diploVersion;
function allyMap(s: GameState) {
  if (allyCache.s !== s || allyCache.day !== s.day || allyCache.version !== diploVersion) {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { (map.get(a) || map.set(a, new Set()).get(a)!).add(b); };
    for (const k in s.relations) if (s.relations[k].alliance) { const [a, b] = k.split('|'); add(a, b); add(b, a); }
    allyCache = { s, day: s.day, version: diploVersion, map };
  }
  return allyCache.map;
}
export function alliesOf(s: GameState, a: string): string[] {
  return [...(allyMap(s).get(a) ?? [])].filter((id) => s.nations[id]?.alive);
}
/** How much the game favours human players at this game's difficulty (see PLAYER_HELP). */
export const playerHelp = (s: GameState) => PLAYER_HELP[s.settings?.difficulty] ?? PLAYER_HELP.standard;
/** A human player's combat edge (1 for AI nations). */
export const playerEdge = (s: GameState, id: string) => (s.nations[id]?.isPlayer ? playerHelp(s).combat : 1);
export function isFriendly(s: GameState, a: string, b: string) {
  if (a === b) return true;
  if (allyMap(s).get(a)?.has(b)) return true;
  const na = s.nations[a], nb = s.nations[b];
  return na?.overlord === b || nb?.overlord === a;
}

/** Nations sharing a land/strait border with `id`. */
export function neighborsOf(s: GameState, id: string): string[] {
  const out = new Set<string>();
  for (const p of controlledBy(s, id)) {
    for (const n of PROV[p].neighbors) { const c = s.provinces[n].controller; if (c !== id) out.add(c); }
    for (const n of PROV[p].straits) { const c = s.provinces[n].controller; if (c !== id) out.add(c); }
  }
  return [...out].filter((x) => s.nations[x]?.alive);
}

export function livingNations(s: GameState): Nation[] { return Object.values(s.nations).filter((n) => n.alive); }

export function nationOutputShareOfWorld(s: GameState, id: string) {
  let tot = 0;
  for (const n of livingNations(s)) tot += n.budget.output;
  return tot ? s.nations[id].budget.output / tot : 0;
}
export const provinceCount = () => NPROV;
