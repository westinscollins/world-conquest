// Close-up map detail: when zoomed in, provinces are drawn with their terrain — forests of
// little trees, mountain peaks with snow, rolling hills, dunes, fields and snowfields — clipped
// to each province's shape, at a constant size on screen.
import { memo } from 'react';
import { PROV } from '../engine/geo';
import type { Terrain } from '../engine/types';

/** Each province outline as rings of points, and its bounding box (map units). */
const RINGS: Float32Array[][] = PROV.map((p) => p.path.split(/(?=M)/).map((sub) => Float32Array.from((sub.match(/-?\d+(\.\d+)?/g) ?? []).map(Number))));
const BOX: [number, number, number, number][] = RINGS.map((rings) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (let i = 0; i + 1 < r.length; i += 2) {
    const x = r[i], y = r[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
});
/** Is the point inside the province (even-odd over all its rings)? */
function inside(p: number, x: number, y: number) {
  let c = false;
  for (const r of RINGS[p]) {
    for (let i = 0, j = r.length - 2; i + 1 < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) c = !c;
    }
  }
  return c;
}
export const provinceBox = (p: number) => BOX[p];

const hash = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/** One terrain symbol, drawn in screen pixels around (0,0). */
function symbol(t: Terrain, v: number): string {
  switch (t) {
    case 'forest': return v < 0.5 ? 'M0,-6L3.6,1H-3.6Z M-0.6,1h1.2v2.4h-1.2Z' : 'M0,-5.2a3.4,3.4 0 1 1 0,6.8a3.4,3.4 0 1 1 0,-6.8Z M-0.6,1.4h1.2v2.2h-1.2Z';
    case 'taiga': return 'M0,-7L2.6,-2.6H1.4L3.6,1.4H-3.6L-1.4,-2.6H-2.6Z M-0.6,1.4h1.2v2h-1.2Z';
    case 'jungle': return 'M-3,0a3,3 0 1 1 3,-3a3,3 0 1 1 3,3a3,3 0 1 1 -6,0Z';
    case 'mountains': return 'M-7,3L-1.5,-6.5L1.2,-2.2L2.8,-4.5L7,3Z';
    case 'hills': return 'M-6,2Q-3,-3.5 0,2Q3,-2.5 6,2';
    case 'desert': return 'M-6,1Q-3,-2 0,1T6,1';
    case 'arctic': return 'M-1.2,0a1.2,1.2 0 1 0 2.4,0a1.2,1.2 0 1 0 -2.4,0';
    default: return 'M-7,-4.5h14v9h-14Z';
  }
}
const STYLE: Record<Terrain, { fill?: string; stroke?: string; op: number; step: number }> = {
  forest: { fill: '#1d4521', op: 0.75, step: 15 },
  taiga: { fill: '#1b3a2a', op: 0.75, step: 15 },
  jungle: { fill: '#11451f', op: 0.7, step: 14 },
  mountains: { fill: '#5b544e', op: 0.8, step: 22 },
  hills: { stroke: '#4a4130', op: 0.65, step: 17 },
  desert: { stroke: '#9c7c45', op: 0.6, step: 19 },
  arctic: { fill: '#ffffff', op: 0.6, step: 14 },
  plains: { fill: '#7d8a45', op: 0.14, step: 21 },
};

/** Terrain symbols for the provinces in view (only drawn when zoomed in). */
const FIELDS = ['#c9b45a', '#8f9c45', '#6f8a3a', '#b8a24e', '#9aa85a'];
export const TerrainDecor = memo(function TerrainDecor({ x, y, w, h, px, k }: { x: number; y: number; w: number; h: number; px: number; k: number }) {
  const out: JSX.Element[] = [];
  let budget = 1500; // keep the page light however much is in view
  const zs = Math.min(1.8, Math.max(1, k / 8)); // symbols grow a little as you zoom in
  for (let p = 0; p < PROV.length && budget > 0; p++) {
    const [x0, y0, x1, y1] = BOX[p];
    if (x1 < x || x0 > x + w || y1 < y || y0 > y + h) continue;
    const t = PROV[p].terrain;
    const st = STYLE[t];
    const step = st.step * px * zs;
    const gx0 = Math.max(x0, x), gx1 = Math.min(x1, x + w), gy0 = Math.max(y0, y), gy1 = Math.min(y1, y + h);
    const sym: JSX.Element[] = [];
    // a fixed grid in map space (so symbols don't jump when panning), jittered per cell
    for (let gy = Math.floor(gy0 / step); gy * step <= gy1 && budget > 0; gy++) {
      for (let gx = Math.floor(gx0 / step); gx * step <= gx1 && budget > 0; gx++) {
        const r = hash(gx, gy);
        if (t === 'plains' && r > 0.55) continue;
        if ((t === 'hills' || t === 'desert') && r > 0.7) continue;
        const sx = (gx + 0.2 + 0.6 * hash(gy, gx)) * step, sy = (gy + 0.2 + 0.6 * r) * step + (gx % 2) * step * 0.5;
        if (!inside(p, sx, sy)) continue;
        const s = (0.8 + 0.5 * hash(gx + 7, gy + 3)) * zs;
        // fields come in a patchwork of crops
        const fill = t === 'plains' ? FIELDS[Math.floor(hash(gx + 3, gy + 11) * FIELDS.length)] : undefined;
        sym.push(<path key={`${gx}:${gy}`} d={symbol(t, r)} fill={fill} transform={`translate(${sx.toFixed(2)},${sy.toFixed(2)}) scale(${(px * s).toFixed(4)}${t === 'plains' ? ` ${(px * s * (0.7 + 0.6 * r)).toFixed(4)}) rotate(${Math.round((hash(gx, gy + 5) - 0.5) * 30)}` : ''})`} />);
        budget--;
      }
    }
    if (!sym.length) continue;
    out.push(
      <g key={p} fill={st.fill ?? 'none'} stroke={st.stroke ?? (t === 'mountains' ? '#2c2824' : 'none')} strokeWidth={st.stroke ? 1.3 * px : t === 'mountains' ? 0.5 * px : 0} opacity={st.op}>
        {sym}
        {t === 'mountains' && sym.map((e) => <path key={`s${e.key}`} d="M-1.5,-6.5L1.2,-2.2L0,-3L-1.4,-2.4L-2.6,-4.6Z" transform={e.props.transform} fill="#f3f5f7" stroke="none" />)}
      </g>,
    );
  }
  return <g className="terrain-decor" pointerEvents="none">{out}</g>;
});
