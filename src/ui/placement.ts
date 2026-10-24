// Where to draw a province's map pieces so they sit on its land and not out at sea: coastal cities
// often lie right on the shore, so "just below the city" can be open water. Each block of pieces
// tries spots around the city (below first), then towards the middle of the province, and takes
// the first one that is wholly on the province's land (or else the one with the most land under it).
import { PROV } from '../engine/geo';

interface Shape { rings: Float64Array[]; minX: number; minY: number; maxX: number; maxY: number }
const shapes = new Map<number, Shape>();

/** The province outline as polygons (its SVG path only uses M, L and Z). */
function shapeOf(p: number): Shape {
  let sh = shapes.get(p);
  if (sh) return sh;
  const rings: Float64Array[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const part of PROV[p].path.split('M')) {
    const nums = part.replace(/Z/g, '').split(/[L,\s]+/).filter(Boolean).map(Number);
    if (nums.length < 6) continue;
    const r = Float64Array.from(nums);
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < minX) minX = r[i]; if (r[i] > maxX) maxX = r[i];
      if (r[i + 1] < minY) minY = r[i + 1]; if (r[i + 1] > maxY) maxY = r[i + 1];
    }
    rings.push(r);
  }
  sh = { rings, minX, minY, maxX, maxY };
  shapes.set(p, sh);
  return sh;
}

/** Point in polygon (even-odd over every ring, so islands and holes work). */
function inside(sh: Shape, x: number, y: number) {
  if (x < sh.minX || x > sh.maxX || y < sh.minY || y > sh.maxY) return false;
  let c = false;
  for (const r of sh.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) c = !c;
    }
  }
  return c;
}

/** Distance from a point to the nearest border segment. */
function edgeDist(sh: Shape, x: number, y: number) {
  let best = Infinity;
  for (const r of sh.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = r[j], ay = r[j + 1], bx = r[i], by = r[i + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const ex = ax + t * dx - x, ey = ay + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

const middles = new Map<number, [number, number]>();
/** The point deepest inside the province's land (a coarse grid search, refined once). */
export function landMiddle(p: number): [number, number] {
  const hit = middles.get(p);
  if (hit) return hit;
  const sh = shapeOf(p);
  let best: [number, number] = [PROV[p].lx, PROV[p].ly], bestD = inside(sh, best[0], best[1]) ? edgeDist(sh, best[0], best[1]) : -1;
  const search = (x0: number, y0: number, x1: number, y1: number, n: number) => {
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * j) / n;
      if (!inside(sh, x, y)) continue;
      const d = edgeDist(sh, x, y);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
  };
  search(sh.minX, sh.minY, sh.maxX, sh.maxY, 12);
  const cw = (sh.maxX - sh.minX) / 12, ch = (sh.maxY - sh.minY) / 12;
  search(best[0] - cw, best[1] - ch, best[0] + cw, best[1] + ch, 6);
  middles.set(p, best);
  return best;
}

/** A block of pieces: its size, and each piece's centre (from the block's centre) and size. */
export interface Layout { key: string; w: number; h: number; pieces: [number, number, number, number][] }
const scaled = (L: Layout, f: number): Layout => ({ key: L.key, w: L.w * f, h: L.h * f, pieces: L.pieces.map(([x, y, w, h]) => [x * f, y * f, w * f, h * f]) });

/**
 * How much of a block centred at (x, y) is on the province's land: each piece is sampled at its
 * middle (counting double: a piece whose middle is on land looks on land) and its four corners.
 * 1 = wholly on land.
 */
function landShare(sh: Shape, x: number, y: number, L: Layout) {
  let k = 0, all = 0;
  for (const [dx, dy, pw, ph] of L.pieces) {
    const mx = x + dx, my = y + dy;
    if (inside(sh, mx, my)) k += 2;
    for (const [fx, fy] of CORNERS) if (inside(sh, mx + fx * pw, my + fy * ph)) k++;
    all += 6;
  }
  return all ? k / all : 1;
}
const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];

/** Ways to set a block next to the city, in order of preference ([dx, dy]: which side). */
export const BELOW: [number, number][] = [[0, 1], [0, -1], [-1, 1], [1, 1], [-1, 0], [-1, -1], [1, -1], [1, 0]];
export const LEFT: [number, number][] = [[-1, 0], [-1, -1], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 1], [1, 0]];

export type Box = [number, number, number, number]; // x0, y0, x1, y1
const overlaps = (x: number, y: number, w: number, h: number, b: Box) => x + w / 2 > b[0] && x - w / 2 < b[2] && y + h / 2 > b[1] && y - h / 2 < b[3];
const placed = new Map<string, [number, number, number]>();

/**
 * Centre for a block of pieces in province p, `gap` away from the city marker, preferring the
 * sides in `prefer` and keeping clear of `avoid` (pieces already there). Returns [x, y, share of
 * the pieces on land]. If no spot next to the city is wholly on land, the whole province is
 * searched for the spot with the most land, nearest the city. Cached: the caller passes sizes
 * rounded to the zoom level, so there are few distinct ones.
 */
export function placeBlock(p: number, L: Layout, gap: number, prefer: [number, number][] = BELOW, avoid?: Box): [number, number, number] {
  const { w, h } = L;
  const key = `${p}|${L.key}|${w.toFixed(2)}|${h.toFixed(2)}|${gap.toFixed(2)}|${prefer === BELOW ? 'b' : 'l'}|${avoid ? avoid.map((v) => v.toFixed(1)).join(',') : ''}`;
  const hit = placed.get(key);
  if (hit) return hit;
  if (placed.size > 6000) placed.clear();
  const sh = shapeOf(p);
  const { lx, ly } = PROV[p];
  const at = ([dx, dy]: [number, number], far: number): [number, number] => [lx + dx * (gap + w / 2) * far, ly + dy * (gap + h / 2) * far];
  const mid = landMiddle(p);
  const tries: [number, number][] = [
    ...prefer.map((d) => at(d, 1)),
    // towards the middle of the province's land
    ...[0.35, 0.7, 1].map((t): [number, number] => [lx + (mid[0] - lx) * t, ly + gap + h / 2 + (mid[1] - ly - gap - h / 2) * t]),
    ...prefer.map((d) => at(d, 2)),
  ];
  if (avoid) {
    // right beside the pieces already there
    const [x0, y0, x1, y1] = avoid, m = gap * 0.3, ax = (x0 + x1) / 2, ay = (y0 + y1) / 2;
    tries.push([x0 - m - w / 2, ay], [x1 + m + w / 2, ay], [ax, y0 - m - h / 2], [ax, y1 + m + h / 2], [x0 - m - w / 2, y0 - m - h / 2], [x1 + m + w / 2, y0 - m - h / 2]);
  }
  const diag = Math.hypot(sh.maxX - sh.minX, sh.maxY - sh.minY) || 1;
  const search = (allowOverlap: boolean): [number, number, number] => {
    let best: [number, number, number] = [tries[0][0], tries[0][1], -1];
    const consider = (x: number, y: number, penalty = 0) => {
      if (!allowOverlap && avoid && overlaps(x, y, w, h, avoid)) return false;
      const share = landShare(sh, x, y, L);
      if (share - penalty > best[2] + 1e-9) best = [x, y, share - penalty];
      return share === 1 && !penalty;
    };
    for (const [x, y] of tries) if (consider(x, y)) return best;
    // pieces bigger than the whole province (zoomed far out): nothing better to find
    if (w * h > 1.5 * (sh.maxX - sh.minX) * (sh.maxY - sh.minY)) return best;
    // anywhere in the province: the most land under the pieces, then the nearest to the city
    const N = 7;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = sh.minX + ((sh.maxX - sh.minX) * i) / N, y = sh.minY + ((sh.maxY - sh.minY) * j) / N;
      consider(x, y, (0.04 * Math.hypot(x - lx, y - ly)) / diag);
    }
    return best;
  };
  let best = search(false);
  // nowhere clear of the other pieces is mostly land (a small island): rather overlap them than float at sea
  if (avoid && best[2] < 0.5) { const over = search(true); if (over[2] > best[2] + 0.25) best = over; }
  if (best[2] < 0) best = [tries[0][0], tries[0][1], 0];
  placed.set(key, best);
  return best;
}

/**
 * placeBlock for the block's real size when the spot is looked up at a rounded zoom (`f` = rounded
 * size / real size): the edge facing the city keeps its distance from it. Returns [x, y, share].
 */
export function placeOnLand(p: number, L: Layout, gap: number, f: number, prefer: [number, number][] = BELOW, avoid?: Box): [number, number, number] {
  const [qx, qy, share] = placeBlock(p, scaled(L, f), gap * f, prefer, avoid);
  const near = (q: number, c: number, size: number) => (q > c + 1e-6 ? q - (size * f) / 2 + size / 2 : q < c - 1e-6 ? q + (size * f) / 2 - size / 2 : q);
  return [near(qx, PROV[p].lx, L.w), near(qy, PROV[p].ly, L.h), share];
}
