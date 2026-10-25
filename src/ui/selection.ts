// Army selection shared by the map, the army bar, the Military roster and hotkeys.
// Armies are numbered #1, #2… in the order they were raised, so "select 1-6" always means the same armies.
import { store } from './store';
import type { GameState } from '../engine/types';

export function myArmies(g: GameState) {
  return Object.values(g.armies).filter((a) => a.owner === g.player).sort((a, b) => a.id - b.id);
}
/** Army id -> its number (#1…). */
export function armyNumbers(g: GameState): Map<number, number> {
  const m = new Map<number, number>();
  myArmies(g).forEach((a, i) => m.set(a.id, i + 1));
  return m;
}
export function selectedIds(): number[] {
  const ui = store.ui;
  return ui.selectedArmy != null ? [ui.selectedArmy, ...ui.group.filter((x) => x !== ui.selectedArmy)] : [];
}
export function setSelection(ids: number[], focus = false) {
  const g = store.game;
  if (!g) return;
  const list = ids.filter((id) => g.armies[id]?.owner === g.player);
  if (!list.length) { store.setUI({ selectedArmy: null, group: [] }); return; }
  const a = g.armies[list[0]];
  store.setUI({ selectedArmy: list[0], group: list.slice(1), selectedFleet: null, selectedProvince: a.location });
  if (focus) window.dispatchEvent(new CustomEvent('wc-focus', { detail: a.location }));
}
/** Parse "1-6, 8, 10-11" into army ids. */
export function parseRange(g: GameState, text: string): number[] {
  const list = myArmies(g);
  const out = new Set<number>();
  for (const part of text.split(/[ ,;]+/)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (list[i - 1]) out.add(list[i - 1].id);
  }
  return [...out];
}
/** Control groups (per computer): Shift+digit stores the selection, digit recalls it. */
const KEY = 'wc-ctrl-groups';
let groups: Record<string, number[]> = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
export function ctrlGroup(k: number): number[] { return groups[k] ?? []; }
export function setCtrlGroup(k: number, ids: number[]) {
  groups = { ...groups, [k]: ids };
  try { localStorage.setItem(KEY, JSON.stringify(groups)); } catch { /* private mode */ }
  store.emit();
}
export function groupOf(id: number): number | null {
  for (const k in groups) if (groups[k].includes(id)) return +k;
  return null;
}
