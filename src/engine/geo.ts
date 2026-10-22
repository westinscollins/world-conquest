import worldData from '../data/world.json';
import type { WorldGeo, ProvinceGeo } from './types';

export const WORLD = worldData as unknown as WorldGeo;
export const PROV: ProvinceGeo[] = WORLD.provinces;
export const NPROV = PROV.length;
export const COUNTRY_GEO = Object.fromEntries(WORLD.countries.map((c) => [c.id, c]));

const KM_PER_UNIT = 40075 / WORLD.meta.width;

export function lonLat(x: number, y: number): [number, number] {
  return [(x / WORLD.meta.width) * 360 - 180, 90 - (y / WORLD.meta.height) * 180];
}
const distCache = new Map<number, number>();
/** Great-circle distance between two province centres (km), memoised. */
export function distKm(a: number, b: number): number {
  const k = a < b ? a * 4096 + b : b * 4096 + a;
  let d = distCache.get(k);
  if (d === undefined) {
    const pa = PROV[a], pb = PROV[b];
    d = haversine(pa.x, pa.y, pb.x, pb.y);
    if (distCache.size < 200000) distCache.set(k, d);
  }
  return d;
}
export function haversine(x1: number, y1: number, x2: number, y2: number) {
  const [lo1, la1] = lonLat(x1, y1), [lo2, la2] = lonLat(x2, y2);
  const r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export { KM_PER_UNIT };

/** Land/strait neighbours with crossing type. */
export function landLinks(p: number): { to: number; strait: boolean }[] {
  const g = PROV[p];
  return [...g.neighbors.map((to) => ({ to, strait: false })), ...g.straits.map((to) => ({ to, strait: true }))];
}
export function isAdjacent(a: number, b: number) {
  return PROV[a].neighbors.includes(b) || PROV[a].straits.includes(b);
}
export function isStrait(a: number, b: number) {
  return PROV[a].straits.includes(b);
}
export const isCoastal = (p: number) => PROV[p].seas.length > 0;

/** BFS over sea zones; returns path of sea ids from any of `from` zones to any of `to` zones. */
export function seaRoute(from: number[], to: number[]): number[] | null {
  const target = new Set(to);
  const prev = new Map<number, number>();
  const q: number[] = [];
  for (const f of from) { prev.set(f, -1); q.push(f); }
  while (q.length) {
    const s = q.shift()!;
    if (target.has(s)) {
      const path = [s];
      let c = prev.get(s)!;
      while (c !== -1) { path.unshift(c); c = prev.get(c)!; }
      return path;
    }
    for (const n of WORLD.seas[s].neighbors) if (!prev.has(n)) { prev.set(n, s); q.push(n); }
  }
  return null;
}
