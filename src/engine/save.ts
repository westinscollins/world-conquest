import type { GameState } from './types';
import { SAVE_VERSION } from './config';
import { invalidateTerritory, invalidateArmies, invalidateDiplo } from './world';
import { resetSupplyCache } from './supply';
import { infraOf } from './economy';
import { recomputeTechMods } from './research';
import { NPROV } from './geo';

export interface SaveMeta { slot: string; name: string; nation: string; day: number; savedAt: number; version: number; campaign: string; }

export function serialize(s: GameState): string {
  return JSON.stringify(s);
}

/** Parse and migrate a save. Throws with a readable message if the save is unusable. */
export function deserialize(json: string): GameState {
  let raw: any;
  try { raw = JSON.parse(json); } catch { throw new Error('Save file is corrupted (invalid JSON).'); }
  if (!raw || typeof raw !== 'object' || !raw.nations || !raw.provinces) throw new Error('Not a World Conquest save file.');
  if (raw.version > SAVE_VERSION) throw new Error(`Save was made by a newer version (v${raw.version}).`);
  const s = migrate(raw);
  if (s.provinces.length !== NPROV) throw new Error('Save was made with a different world map.');
  invalidateTerritory(); invalidateArmies(); invalidateDiplo(); resetSupplyCache();
  return s;
}

/** Bring older saves up to date, filling fields introduced later with safe defaults. */
export function migrate(raw: any): GameState {
  const s = raw as GameState;
  if (raw.version < 2) {
    for (const n of Object.values<any>(raw.nations)) { n.claims ??= {}; n.reparations ??= []; n.shipyard ??= []; }
    raw.proposals ??= [];
  }
  if (raw.version < 3) {
    for (const n of Object.values<any>(raw.nations)) { n.lastFactories ??= 0; n.shortages ??= { food: 0, steel: 0, oil: 0, rare: 0 }; n.resourceNet ??= { food: 0, steel: 0, oil: 0, rare: 0 }; }
    raw.stats ??= { battles: 0, wars: 0, peaceDeals: 0, annexations: 0 };
    if (raw.tutorial) { raw.tutorial.flags ??= {}; raw.tutorial.startProvinces ??= 2; }
  }
  if (raw.version < 4) {
    raw.players ??= [raw.player];
    raw.eventSeq ??= raw.nextId ?? 0;
  }
  if (raw.version < 5) {
    for (const n of Object.values<any>(raw.nations)) { n.arsenal ??= { drone: 0, missile: 0, nuke: 0 }; n.nukeProgram ??= -1; n.warheads ??= []; n.embargoUntil ??= 0; }
    raw.strikes ??= [];
  }
  s.version = SAVE_VERSION;
  // derived data is recomputed rather than trusted
  for (const p of s.provinces) p.infra = infraOf(p);
  for (const n of Object.values(s.nations)) recomputeTechMods(n);
  return s;
}
