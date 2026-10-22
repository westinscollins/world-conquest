import type { GameState, Weather } from './types';
import { PROV } from './geo';
import { weatherFor } from './config';
import { hashNoise } from './rng';
import { monthOf } from './events';

/** Weather is a pure function of (seed, province region, 3-day window) — reproducible and save-free. */
export function provinceWeather(s: GameState, p: number): Weather {
  const g = PROV[p];
  // regional coherence: neighbouring provinces share weather cells (~10 degree cells)
  const cell = Math.floor(g.x / 55) * 131 + Math.floor(g.y / 55);
  const roll = hashNoise(s.seed, cell, Math.floor(s.day / 3));
  return weatherFor(g.lat, monthOf(s, s.day), roll, g.terrain);
}
