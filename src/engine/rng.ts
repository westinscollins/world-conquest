import type { GameState } from './types';

/** mulberry32 step: returns [value 0..1, nextState]. */
export function mulberry(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** Draw from the game's rolling RNG (state is persisted in saves). */
export function rand(s: GameState): number {
  const [v, n] = mulberry(s.rng);
  s.rng = n;
  return v;
}
export function randInt(s: GameState, lo: number, hi: number) {
  return lo + Math.floor(rand(s) * (hi - lo + 1));
}

/** Independent stream for a sub-simulation (battle), reproducible from its seed. */
export class Stream {
  constructor(private state: number) {}
  next() {
    const [v, n] = mulberry(this.state);
    this.state = n;
    return v;
  }
  range(lo: number, hi: number) { return lo + (hi - lo) * this.next(); }
  get seed() { return this.state; }
}

/** Stateless deterministic hash noise (for weather etc.). */
export function hashNoise(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return mulberry(h)[0];
}
