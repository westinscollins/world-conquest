import type { GameState } from './types';
import { SAVE_VERSION, AIR } from './config';
import { newWing } from './military';
import { invalidateTerritory, invalidateArmies, invalidateDiplo } from './world';
import { resetSupplyCache } from './supply';
import { infraOf } from './economy';
import { recomputeTechMods } from './research';
import { NPROV } from './geo';
import { newGov } from './policy';
import { newRegime } from './regime';

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
  if (raw.version < 6) for (const n of Object.values<any>(raw.nations)) n.gov ??= newGov();
  if (raw.version < 7) {
    for (const n of Object.values<any>(raw.nations)) { n.regime ??= newRegime(); n.arsenal.ballistic ??= 0; n.arsenal.recon ??= 0; }
    raw.operations ??= [];
  }
  if (raw.version < 8) {
    // aircraft used to fly inside armies: they become air wings based where their army stood
    raw.airWings ??= {};
    const wings = new Map<string, number>();
    for (const a of Object.values<any>(raw.armies)) {
      const planes = a.units.filter((u: any) => u.type === 'air');
      if (!planes.length) continue;
      a.units = a.units.filter((u: any) => u.type !== 'air');
      const key = `${a.owner}|${a.location}`;
      let w = wings.has(key) ? raw.airWings[wings.get(key)!] : null;
      if (!w || w.units.length >= AIR.MAX_WING) {
        w = newWing(s, a.owner, a.location);
        const m = raw.nations[a.owner]?.regime?.air?.mission;
        w.mission = m === 'defense' ? 'defense' : 'support';
        wings.set(key, w.id);
      }
      w.units.push(...planes);
    }
    for (const a of Object.values<any>(raw.armies)) if (!a.units.length) { const g = a.generalId != null ? raw.generals[a.generalId] : null; if (g) g.armyId = null; delete raw.armies[a.id]; }
  }
  if (raw.version < 9) {
    // submarines (battle command and campaign orders are optional fields, filled in when used)
    for (const f of Object.values<any>(raw.fleets)) f.ships.submarine ??= 0;
  }
  s.version = SAVE_VERSION;
  // derived data is recomputed rather than trusted
  for (const p of s.provinces) p.infra = infraOf(p);
  for (const n of Object.values(s.nations)) recomputeTechMods(n);
  return s;
}
