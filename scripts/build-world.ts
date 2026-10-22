/**
 * Offline world builder.
 *
 * Turns Natural Earth (public domain) country borders + populated places into a
 * connected province graph for the game:
 *  - provinces = Voronoi cells seeded on real cities, clipped to real borders
 *  - land adjacency from a high-resolution raster (exact shared borders)
 *  - strait crossings between nearby coasts on different landmasses
 *  - sea zones (named) flood-filled over ocean pixels, with sea lanes
 *  - terrain sampled from NASA Blue Marble colour + elevation imagery
 *
 * Output: src/data/world.json (gameplay geography) and public/geo/*.json (render-only).
 * Run: npx tsx scripts/build-world.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { Delaunay } from 'd3-delaunay';
import { geoArea } from 'd3-geo';
import polygonClipping from 'polygon-clipping';
import { execSync } from 'node:child_process';

type Pt = [number, number];
type Ring = Pt[];
type Poly = Ring[];
type MultiPoly = Poly[];

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RAW = path.join(ROOT, 'data-raw');
const W = 2048; // map units width (equirectangular)
const H = 1024;
const RS = 2; // raster scale (raster = 4096 x 2048)
const RW = W * RS;
const RH = H * RS;
const LAT_MIN = -58;

const proj = (lon: number, lat: number): Pt => [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
const unproj = (x: number, y: number): Pt => [(x / W) * 360 - 180, 90 - (y / H) * 180];

const readJSON = (f: string) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));

// ---------- image sampling (via python/PIL → raw bytes) ----------
function loadRaw(file: string, w: number, h: number, mode: 'L' | 'RGB'): Uint8Array {
  const out = path.join(RAW, `${file}.${w}x${h}.${mode}.raw`);
  if (!fs.existsSync(out)) {
    execSync(
      `python3 -I -c "from PIL import Image; im=Image.open('${path.join(RAW, file)}').convert('${mode}').resize((${w},${h}), Image.BILINEAR); open('${out}','wb').write(im.tobytes())"`,
    );
  }
  return new Uint8Array(fs.readFileSync(out));
}
const elev = loadRaw('earth-topology.png', RW, RH, 'L');
const color = loadRaw('earth-blue-marble.jpg', RW, RH, 'RGB');

// ---------- geometry helpers ----------
function ringArea(r: Ring) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}
function polyArea(p: Poly) {
  return p.reduce((s, r, i) => s + (i === 0 ? ringArea(r) : -ringArea(r)), 0);
}
function bbox(mp: MultiPoly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of mp) for (const [x, y] of p[0]) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Scanline even-odd fill of a multipolygon into an Int16 raster. */
function rasterize(mp: MultiPoly, raster: Int16Array, id: number) {
  for (const poly of mp) {
    const edges: [number, number, number, number][] = [];
    let ymin = Infinity, ymax = -Infinity;
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const ax = a[0] * RS, ay = a[1] * RS, bx = b[0] * RS, by = b[1] * RS;
        if (ay === by) continue;
        edges.push([ax, ay, bx, by]);
        ymin = Math.min(ymin, ay, by); ymax = Math.max(ymax, ay, by);
      }
    }
    const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(RH - 1, Math.ceil(ymax));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const xs: number[] = [];
      for (const [ax, ay, bx, by] of edges) {
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(RW - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) raster[y * RW + x] = id;
      }
    }
  }
}

function toPath(mp: MultiPoly, minStep = 0.35): string {
  let d = '';
  for (const poly of mp) for (const ring of poly) {
    const pts: Pt[] = [];
    for (const p of ring) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) pts.push(p);
    }
    if (pts.length < 3) continue;
    d += 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L') + 'Z';
  }
  return d;
}

function geomToMulti(g: any): MultiPoly {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.map((p: number[][][]) => p.map((r) => r.map(([lon, lat]) => proj(lon, Math.max(lat, LAT_MIN - 2)))));
}

// ---------- load countries ----------
const countriesGeo = readJSON('ne_50m_admin_0_countries.geojson');
const citiesGeo = readJSON('ne_50m_populated_places_simple.geojson');

interface CountryBuild {
  id: string; name: string; continent: string; subregion: string; pop: number; gdp: number;
  geom: MultiPoly; geoFeatures: any[]; income: string; mapcolor: number;
}
const groups = new Map<string, CountryBuild>();
for (const f of countriesGeo.features) {
  const p = f.properties;
  if (p.CONTINENT === 'Antarctica' || p.ADM0_A3 === 'ATF' || p.ADM0_A3 === 'SGS' || p.ADM0_A3 === 'HMD') continue;
  const key = p.ADM0_A3 === 'PSX' ? 'PSX' : p.SOV_A3;
  let g = groups.get(key);
  if (!g) {
    g = { id: '', name: '', continent: '', subregion: '', pop: 0, gdp: 0, geom: [], geoFeatures: [], income: '', mapcolor: 1 };
    groups.set(key, g);
  }
  if (p.HOMEPART === 1 || !g.id) {
    g.id = p.ADM0_A3; g.name = p.NAME; g.continent = p.CONTINENT; g.subregion = p.SUBREGION;
    g.income = p.INCOME_GRP; g.mapcolor = p.MAPCOLOR9;
  }
  g.pop += p.POP_EST || 0;
  g.gdp += p.GDP_MD || 0;
  g.geoFeatures.push(f);
  for (const poly of geomToMulti(f.geometry)) g.geom.push(poly);
}
// rename a few for game display brevity
const RENAME: Record<string, string> = { USA: 'United States', COD: 'Congo (DRC)', COG: 'Congo', CAF: 'Central African Rep.', DOM: 'Dominican Rep.', BIH: 'Bosnia', SSD: 'South Sudan', GNQ: 'Eq. Guinea' };

const countries: CountryBuild[] = [];
for (const g of groups.values()) {
  // drop micro fragments (< 0.5 map unit²), keep the country if anything left
  g.geom = g.geom.filter((p) => polyArea(p) > 0.5 || g.geom.length === 1);
  const total = g.geom.reduce((s, p) => s + polyArea(p), 0);
  if (total < 1.2) continue; // micro-states are not playable entities
  // drop far-flung tiny islands (< 3 units² and < 8% of country)
  g.geom = g.geom.filter((p) => polyArea(p) > 3 || polyArea(p) / total > 0.08);
  if (RENAME[g.id]) g.name = RENAME[g.id];
  countries.push(g);
}
countries.sort((a, b) => a.id.localeCompare(b.id));
console.log('countries', countries.length);

// country raster
const craster = new Int16Array(RW * RH).fill(-1);
countries.forEach((c, i) => rasterize(c.geom, craster, i));

// ---------- seeds ----------
const cities = citiesGeo.features.map((f: any) => {
  const p = f.properties;
  const [x, y] = proj(p.longitude, p.latitude);
  return { name: p.nameascii || p.name, pop: p.pop_max || 0, cap: p.adm0cap === 1, x, y, a3: p.adm0_a3, sov: p.sov_a3 };
});
function countryAt(x: number, y: number) {
  const rx = Math.floor(x * RS), ry = Math.floor(y * RS);
  if (rx < 0 || ry < 0 || rx >= RW || ry >= RH) return -1;
  // search small neighbourhood (coastal cities can sit just offshore at this resolution)
  for (let r = 0; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const xx = rx + dx, yy = ry + dy;
    if (xx < 0 || yy < 0 || xx >= RW || yy >= RH) continue;
    const v = craster[yy * RW + xx];
    if (v >= 0) return v;
  }
  return -1;
}
const cityByCountry: (typeof cities)[] = countries.map(() => []);
for (const c of cities) {
  const ci = countryAt(c.x, c.y);
  if (ci >= 0) cityByCountry[ci].push(c);
}

function kmArea(c: CountryBuild) {
  return c.geoFeatures.reduce((s, f) => s + geoArea(f) * 6371 * 6371, 0);
}

interface Seed { x: number; y: number; name: string; cityPop: number; capital: boolean; }
const DIRS = ['Northern', 'North-Eastern', 'Eastern', 'South-Eastern', 'Southern', 'South-Western', 'Western', 'North-Western'];

const provinces: any[] = [];
const praster = new Int16Array(RW * RH).fill(-1);

countries.forEach((c, ci) => {
  const area = kmArea(c);
  const target = Math.max(1, Math.min(30, Math.round(0.6 + Math.sqrt(area / 45000) + Math.sqrt(c.pop / 40e6))));
  const [bx0, by0, bx1, by1] = bbox(c.geom);
  const totalUnits = c.geom.reduce((s, p) => s + polyArea(p), 0);
  const minDist = 0.55 * Math.sqrt(totalUnits / target);
  const seeds: Seed[] = [];
  const cs = cityByCountry[ci].slice().sort((a, b) => (b.cap ? 1e12 : b.pop) - (a.cap ? 1e12 : a.pop));
  for (const city of cs) {
    if (seeds.length >= target) break;
    if (seeds.every((s) => Math.hypot(s.x - city.x, s.y - city.y) >= minDist)) {
      seeds.push({ x: city.x, y: city.y, name: city.name, cityPop: city.pop, capital: city.cap && !seeds.some((s) => s.capital) });
    }
  }
  // collect country pixels (sub-sampled) for farthest-point filling and island seeding
  const pix: Pt[] = [];
  const step = Math.max(1, Math.round(Math.sqrt(((bx1 - bx0) * (by1 - by0) * RS * RS) / 40000)));
  for (let y = Math.floor(by0 * RS); y <= Math.ceil(by1 * RS) && y < RH; y += step)
    for (let x = Math.floor(bx0 * RS); x <= Math.ceil(bx1 * RS) && x < RW; x += step)
      if (x >= 0 && y >= 0 && craster[y * RW + x] === ci) pix.push([(x + 0.5) / RS, (y + 0.5) / RS]);
  const centroid = pix.length ? [pix.reduce((s, p) => s + p[0], 0) / pix.length, pix.reduce((s, p) => s + p[1], 0) / pix.length] : [(bx0 + bx1) / 2, (by0 + by1) / 2];
  const addFar = () => {
    let best: Pt | null = null, bd = -1;
    for (const p of pix) {
      const d = seeds.length ? Math.min(...seeds.map((s) => Math.hypot(s.x - p[0], s.y - p[1]))) : 1e9;
      if (d > bd) { bd = d; best = p; }
    }
    if (!best) return false;
    seeds.push({ x: best[0], y: best[1], name: '', cityPop: 0, capital: false });
    return true;
  };
  while (seeds.length < target && pix.length > seeds.length) if (!addFar()) break;
  // significant islands with no seed get their own
  const kmOf = (poly: Poly) => { const b = bbox([poly]); const lat = unproj(0, (b[1] + b[3]) / 2)[1]; return polyArea(poly) * (40075 / W) ** 2 * Math.cos((lat * Math.PI) / 180); };
  const islands = c.geom.filter((poly) => kmOf(poly) > 18000).sort((a, b) => kmOf(b) - kmOf(a));
  let islandSeeds = 0;
  for (const poly of islands) {
    if (islandSeeds >= Math.max(2, Math.ceil(target / 2))) break;
    const pb = bbox([poly]);
    const has = seeds.some((s) => s.x >= pb[0] && s.x <= pb[2] && s.y >= pb[1] && s.y <= pb[3] && pointInPoly(s.x, s.y, poly));
    if (!has) {
      // largest city on the island or a central interior point
      const isl = cityByCountry[ci].filter((ct) => pointInPoly(ct.x, ct.y, poly)).sort((p, q) => q.pop - p.pop)[0];
      const ipix = pix.filter((p) => pointInPoly(p[0], p[1], poly));
      const ip = isl ? [isl.x, isl.y] : ipix.length ? ipix[Math.floor(ipix.length / 2)] : poly[0][0];
      seeds.push({ x: ip[0], y: ip[1], name: isl ? isl.name : '', cityPop: isl ? isl.pop : 0, capital: false });
      islandSeeds++;
    }
  }
  if (!seeds.some((s) => s.capital) && seeds.length) {
    seeds.sort((a, b) => b.cityPop - a.cityPop);
    seeds[0].capital = true;
  }
  // name the unnamed seeds by compass direction
  const used = new Set<string>();
  for (const s of seeds) if (s.name) used.add(s.name);
  for (const s of seeds) {
    if (s.name) continue;
    const ang = Math.atan2(-(s.y - centroid[1]), s.x - centroid[0]);
    const idx = Math.round(((Math.PI / 2 - ang) / (2 * Math.PI)) * 8 + 8) % 8;
    let nm = Math.hypot(s.x - centroid[0], s.y - centroid[1]) < minDist * 0.6 ? `Central ${c.name}` : `${DIRS[idx]} ${c.name}`;
    let k = 2;
    const base = nm;
    while (used.has(nm)) nm = `${base} ${['', '', 'II', 'III', 'IV', 'V', 'VI'][k++] || k}`;
    used.add(nm);
    s.name = nm;
  }

  // voronoi clip
  let cells: MultiPoly[];
  if (seeds.length === 1) cells = [c.geom];
  else {
    const del = Delaunay.from(seeds.map((s) => [s.x, s.y] as Pt));
    const vor = del.voronoi([bx0 - 5, by0 - 5, bx1 + 5, by1 + 5]);
    cells = seeds.map((_, i) => {
      const cell = vor.cellPolygon(i) as Pt[];
      if (!cell) return [];
      try {
        return polygonClipping.intersection([cell] as any, c.geom as any) as MultiPoly;
      } catch (e) {
        return [];
      }
    });
  }
  seeds.forEach((s, i) => {
    let mp = cells[i];
    if (!mp || !mp.length) return;
    mp = mp.filter((p) => polyArea(p) > 0.05);
    if (!mp.length) return;
    const id = provinces.length;
    provinces.push({ id, country: c.id, ci, name: s.name, seed: [s.x, s.y], cityPop: s.cityPop, capital: s.capital, geom: mp });
    rasterize(mp, praster, id);
  });
});
console.log('provinces', provinces.length);

function pointInPoly(x: number, y: number, poly: Poly) {
  let inside = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// ---------- per-province pixel stats ----------
const N = provinces.length;
const stats = provinces.map(() => ({ n: 0, e: 0, e2: 0, r: 0, g: 0, b: 0, sx: 0, sy: 0, lat: 0, dark: 0 }));
for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
  const id = praster[y * RW + x];
  if (id < 0) continue;
  const s = stats[id];
  const i = y * RW + x;
  const e = elev[i];
  s.n++; s.e += e; s.e2 += e * e;
  s.r += color[i * 3]; s.g += color[i * 3 + 1]; s.b += color[i * 3 + 2];
  s.sx += x; s.sy += y;
}

// ---------- land adjacency ----------
const adj = new Map<string, number>();
const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
  const a = praster[y * RW + x];
  if (a < 0) continue;
  // wrap horizontally across the antimeridian
  const xr = (x + 1) % RW;
  const b1 = praster[y * RW + xr];
  if (b1 >= 0 && b1 !== a) adj.set(key(a, b1), (adj.get(key(a, b1)) || 0) + 1);
  if (y + 1 < RH) {
    const b2 = praster[(y + 1) * RW + x];
    if (b2 >= 0 && b2 !== a) adj.set(key(a, b2), (adj.get(key(a, b2)) || 0) + 1);
  }
}
const neighbors: Set<number>[] = provinces.map(() => new Set());
for (const [k, n] of adj) {
  if (n < 2) continue;
  const [a, b] = k.split('|').map(Number);
  neighbors[a].add(b); neighbors[b].add(a);
}

// ---------- sea zones ----------
const SEAS: [string, number, number][] = [
  ['North Atlantic', -40, 45], ['Labrador Sea', -55, 58], ['Sargasso Sea', -60, 28], ['Caribbean Sea', -75, 15],
  ['Gulf of Mexico', -90, 25], ['Central Atlantic', -30, 15], ['Gulf of Guinea', 2, 0], ['South Atlantic', -20, -25],
  ['Argentine Sea', -55, -45], ['Brazil Basin', -32, -8], ['Cape Basin', 8, -35], ['Celtic Sea', -10, 49],
  ['North Sea', 3, 56], ['Norwegian Sea', 3, 68], ['Barents Sea', 40, 74], ['Baltic Sea', 19, 57],
  ['Bay of Biscay', -5, 45], ['Western Mediterranean', 4, 39], ['Central Mediterranean', 17, 35], ['Eastern Mediterranean', 30, 34],
  ['Aegean Sea', 25, 38.5], ['Black Sea', 34, 43], ['Caspian Sea', 50, 41], ['Red Sea', 38, 20], ['Gulf of Aden', 48, 12.5],
  ['Persian Gulf', 51, 27], ['Arabian Sea', 65, 15], ['Bay of Bengal', 88, 14], ['Western Indian Ocean', 55, -10],
  ['Mozambique Channel', 41, -20], ['Central Indian Ocean', 80, -15], ['Southern Indian Ocean', 75, -40], ['Eastern Indian Ocean', 100, -20],
  ['Timor Sea', 125, -12], ['Andaman Sea', 96, 10], ['Java Sea', 110, -5], ['South China Sea', 114, 13], ['Celebes Sea', 122, 3],
  ['Philippine Sea', 132, 18], ['East China Sea', 125, 29], ['Yellow Sea', 123, 36], ['Sea of Japan', 135, 40],
  ['Sea of Okhotsk', 148, 54], ['Bering Sea', -178, 58], ['Gulf of Alaska', -145, 55], ['Northeast Pacific', -135, 38],
  ['Eastern Pacific', -110, 15], ['Central Pacific', -155, 20], ['Northwest Pacific', 160, 35], ['Western Pacific', 160, 10],
  ['Coral Sea', 155, -18], ['Tasman Sea', 160, -38], ['Great Australian Bight', 130, -38], ['South Pacific', -140, -25],
  ['Southeast Pacific', -95, -30], ['Peru Basin', -85, -10], ['Polynesian Sea', -160, -10], ['Southern Ocean', 20, -52],
  ['Drake Passage', -65, -56], ['Greenland Sea', -10, 75], ['Baffin Bay', -65, 72], ['Hudson Bay', -85, 59],
  ['Kara Sea', 70, 74], ['Laptev Sea', 125, 75], ['East Siberian Sea', 165, 72], ['Beaufort Sea', -140, 72],
  ['Arctic Ocean', 0, 82], ['Gulf of Bothnia', 20, 62], ['Pacific Antarctic', -130, -52], ['Indian Antarctic', 110, -50],
];
const SW = W, SH = H; // sea raster at 1 unit resolution
const sraster = new Int16Array(SW * SH).fill(-1);
const landAtUnit = (x: number, y: number) => {
  // a unit cell is land if most of its 4 raster sub-pixels are land
  let n = 0;
  for (let dy = 0; dy < RS; dy++) for (let dx = 0; dx < RS; dx++) if (craster[(y * RS + dy) * RW + x * RS + dx] >= 0) n++;
  return n >= 2;
};
const yTop = Math.floor(proj(0, 85)[1]), yBot = Math.ceil(proj(0, LAT_MIN)[1]);
const isWater = new Uint8Array(SW * SH);
for (let y = yTop; y < yBot; y++) for (let x = 0; x < SW; x++) if (!landAtUnit(x, y)) isWater[y * SW + x] = 1;
// multi-source BFS with lat-weighted distance (Dijkstra-lite via bucket queue)
{
  const dist = new Float32Array(SW * SH).fill(Infinity);
  const heap: [number, number][] = [];
  const push = (d: number, i: number) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  SEAS.forEach(([, lon, lat], si) => {
    let [x, y] = proj(lon, lat).map(Math.floor);
    // nudge into water if the anchor is on land
    outer: for (let r = 0; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = (x + dx + SW) % SW, yy = y + dy;
      if (yy >= 0 && yy < SH && isWater[yy * SW + xx]) { x = xx; y = yy; break outer; }
    }
    const i = y * SW + x;
    if (!isWater[i]) { console.warn('sea seed on land', SEAS[si][0]); return; }
    dist[i] = 0; sraster[i] = si; push(0, i);
  });
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const x = i % SW, y = (i / SW) | 0;
    const lat = unproj(x, y)[1];
    const cx = Math.cos((lat * Math.PI) / 180);
    const nb: [number, number, number][] = [[(x + 1) % SW, y, cx], [(x - 1 + SW) % SW, y, cx], [x, y + 1, 1], [x, y - 1, 1]];
    for (const [nx, ny, w] of nb) {
      if (ny < 0 || ny >= SH) continue;
      const j = ny * SW + nx;
      if (!isWater[j]) continue;
      const nd = d + w;
      if (nd < dist[j]) { dist[j] = nd; sraster[j] = sraster[i]; push(nd, j); }
    }
  }
}
const seaStats = SEAS.map(() => ({ n: 0, sx: 0, sy: 0 }));
const seaAdj = new Set<string>();
for (let y = yTop; y < yBot; y++) for (let x = 0; x < SW; x++) {
  const s = sraster[y * SW + x];
  if (s < 0) continue;
  seaStats[s].n++; seaStats[s].sx += x; seaStats[s].sy += y;
  const r = sraster[y * SW + ((x + 1) % SW)];
  if (r >= 0 && r !== s) seaAdj.add(key(s, r));
  if (y + 1 < SH) { const d = sraster[(y + 1) * SW + x]; if (d >= 0 && d !== s) seaAdj.add(key(s, d)); }
}
// canals and narrow straits closed at this resolution
const SEA_LINKS: [string, string][] = [['Black Sea', 'Aegean Sea'], ['Persian Gulf', 'Arabian Sea'], ['Red Sea', 'Eastern Mediterranean'], ['Caribbean Sea', 'Eastern Pacific'], ['Western Mediterranean', 'Central Atlantic'], ['Western Mediterranean', 'Bay of Biscay'], ['Baltic Sea', 'North Sea'], ['Gulf of Bothnia', 'Baltic Sea'], ['Aegean Sea', 'Eastern Mediterranean'], ['Central Mediterranean', 'Eastern Mediterranean'], ['Western Mediterranean', 'Central Mediterranean'], ['Red Sea', 'Gulf of Aden']];
for (const [a, b] of SEA_LINKS) seaAdj.add(key(SEAS.findIndex((s) => s[0] === a), SEAS.findIndex((s) => s[0] === b)));
// coastal provinces: province raster pixel within 2 raster px of water unit
const provSeas: Map<number, number>[] = provinces.map(() => new Map());
for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
  const a = praster[y * RW + x];
  if (a < 0) continue;
  for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
    const ux = Math.floor((((x + dx) % RW + RW) % RW) / RS), uy = Math.floor((y + dy) / RS);
    if (uy < 0 || uy >= SH) continue;
    const s = sraster[uy * SW + ux];
    if (s >= 0) provSeas[a].set(s, (provSeas[a].get(s) || 0) + 1);
  }
}

// ---------- straits ----------
const straits = new Set<string>();
{
  const R = 9; // raster px (~0.8 degree)
  for (let y = R; y < RH - R; y += 1) for (let x = 0; x < RW; x += 1) {
    const a = praster[y * RW + x];
    if (a < 0) continue;
    // coastal pixel only
    const coastal = praster[y * RW + ((x + 1) % RW)] < 0 || praster[y * RW + ((x - 1 + RW) % RW)] < 0 || praster[(y + 1) * RW + x] < 0 || praster[(y - 1) * RW + x] < 0;
    if (!coastal) continue;
    if ((x + y) % 2) continue; // thin out
    for (let dy = -R; dy <= R; dy += 3) for (let dx = -R; dx <= R; dx += 3) {
      if (dx * dx + dy * dy > R * R) continue;
      const xx = (x + dx + RW) % RW, yy = y + dy;
      const b = praster[yy * RW + xx];
      if (b < 0 || b === a || neighbors[a].has(b)) continue;
      // require water in between (midpoint is not land)
      const mx = (x + Math.round(dx / 2) + RW) % RW, my = y + Math.round(dy / 2);
      if (praster[my * RW + mx] >= 0) continue;
      straits.add(key(a, b));
    }
  }
}
// remove straits where the two provinces are already connected within 2 land hops (avoid noise)
const strait: Set<number>[] = provinces.map(() => new Set());
for (const k of straits) {
  const [a, b] = k.split('|').map(Number);
  let near = false;
  for (const n of neighbors[a]) if (neighbors[n].has(b)) near = true;
  if (near) continue;
  strait[a].add(b); strait[b].add(a);
}

// ---------- rivers ----------
const riversGeo = readJSON('ne_50m_rivers_lake_centerlines.geojson');
const riverProv = new Uint8Array(N);
const riverPaths: string[] = [];
for (const f of riversGeo.features) {
  if (f.properties.scalerank > 6 || !f.geometry) continue;
  const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const line of lines) {
    const pts = line.map(([lon, lat]: number[]) => proj(lon, lat));
    let d = '';
    let last: Pt | null = null;
    for (const p of pts) {
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.6) continue;
      d += (d ? 'L' : 'M') + `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      last = p;
      const id = praster[Math.floor(p[1] * RS) * RW + Math.floor(p[0] * RS)];
      if (id >= 0 && f.properties.scalerank <= 5) riverProv[id] = 1;
    }
    if (d.includes('L')) riverPaths.push(`${d}|${f.properties.scalerank}`);
  }
}
const lakesGeo = readJSON('ne_50m_lakes.geojson');
const lakePaths: string[] = [];
for (const f of lakesGeo.features) {
  if (f.properties.scalerank > 3) continue;
  lakePaths.push(toPath(geomToMulti(f.geometry), 0.5));
}

// ---------- terrain classification ----------
function classify(s: (typeof stats)[0], latDeg: number) {
  const n = Math.max(1, s.n);
  const e = s.e / n;
  const sd = Math.sqrt(Math.max(0, s.e2 / n - e * e));
  const r = s.r / n, g = s.g / n, b = s.b / n;
  const bright = (r + g + b) / 3;
  const absLat = Math.abs(latDeg);
  let terrain = 'plains';
  if (bright > 175 && b > 150) terrain = 'arctic';
  else if (absLat > 63 && bright > 70) terrain = 'arctic';
  else if (e > 90 || (e > 60 && sd > 30) || sd > 55) terrain = 'mountains';
  else if (r > g * 1.12 && bright > 105) terrain = 'desert';
  else if (e > 45 || sd > 22) terrain = 'hills';
  else if (absLat < 14 && g >= r && bright < 85) terrain = 'jungle';
  else if (absLat > 56 && g >= r * 0.95 && bright < 85) terrain = 'taiga';
  else if (sd < 3 && e < 8 && absLat < 60) terrain = 'plains';
  else if ((g > r * 1.2 && bright < 60) || (g > r && bright < 38)) terrain = 'forest';
  return { terrain, elevation: Math.round(e), rugged: Math.round(sd), green: +(g / Math.max(1, r)).toFixed(2), bright: Math.round(bright) };
}

// deterministic hash for resource sprinkling
const hash = (s: string) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
// broad, fictionalised oil basins (lon0, lat0, lon1, lat1)
const OIL: number[][] = [[34, 12, 60, 38], [44, 36, 56, 42], [60, 52, 90, 68], [-106, 26, -88, 36], [-74, 2, -60, 12], [3, 3, 9, 8], [-2, 54, 8, 62], [9, 24, 25, 33], [100, 35, 125, 48], [-120, 50, -108, 60], [-155, 66, -142, 71], [10, -10, 14, -3], [93, 2, 119, 7], [-98, 17, -90, 24], [-5, 27, 10, 33], [-80, -5, -75, 2]];
const inBox = (lon: number, lat: number, b: number[]) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

// population distribution
const habit: Record<string, number> = { plains: 1, forest: 0.6, taiga: 0.15, jungle: 0.45, hills: 0.75, mountains: 0.3, desert: 0.08, arctic: 0.03 };
const outProvs = provinces.map((p, i) => {
  const s = stats[i];
  const cx = s.n ? s.sx / s.n / RS : p.seed[0];
  const cy = s.n ? s.sy / s.n / RS : p.seed[1];
  const [lon, lat] = unproj(cx, cy);
  const t = classify(s, lat);
  const areaKm = Math.round(s.n * (111.32 / (RS * W / 360)) ** 2 * Math.cos((lat * Math.PI) / 180) * 1); // approx
  // label point: seed city (inside) else centroid
  return { i, cx, cy, lon, lat, ...t, areaKm };
});
const countryProvs: number[][] = countries.map(() => []);
provinces.forEach((p, i) => countryProvs[p.ci].push(i));
const popOut = new Array(N).fill(0);
countries.forEach((c, ci) => {
  const ids = countryProvs[ci];
  const cityTot = ids.reduce((s, i) => s + provinces[i].cityPop, 0) || 1;
  const hab = ids.map((i) => outProvs[i].areaKm * habit[outProvs[i].terrain]);
  const habTot = hab.reduce((a, b) => a + b, 0) || 1;
  ids.forEach((i, k) => { popOut[i] = Math.round(c.pop * (0.55 * (provinces[i].cityPop / cityTot) + 0.45 * (hab[k] / habTot))); });
});

const world = {
  meta: { width: W, height: H, view: [0, Math.floor(proj(0, 84)[1]), W, Math.ceil(proj(0, LAT_MIN)[1] - proj(0, 84)[1])], source: 'Natural Earth 1:50m (public domain); terrain sampled from NASA Blue Marble (public domain)' },
  countries: countries.map((c, ci) => ({
    id: c.id, name: c.name, continent: c.continent, subregion: c.subregion, pop: c.pop, gdp: c.gdp, income: c.income, mapcolor: c.mapcolor,
    provinces: countryProvs[ci], capital: countryProvs[ci].find((i) => provinces[i].capital) ?? countryProvs[ci][0],
  })),
  provinces: provinces.map((p, i) => {
    const o = outProvs[i];
    let seas = [...provSeas[i].entries()].filter(([, n]) => n >= 2).map(([s]) => s);
    if (!p.neighbors?.length && !neighbors[i].size && !strait[i].size && !seas.length) {
      // tiny island: attach to nearest sea zone
      let best = 0, bd = Infinity;
      SEAS.forEach(([, lon, lat], si) => { const [sx, sy] = proj(lon, lat); const d = Math.hypot(sx - o.cx, sy - o.cy); if (d < bd) { bd = d; best = si; } });
      seas = [best];
    }
    let oil = 0, steel = 0, food = 0, rare = 0;
    if (OIL.some((b) => inBox(o.lon, o.lat, b)) && hash(p.name + 'o') < 0.75) oil = o.terrain === 'desert' ? 3 : 2;
    else if (hash(p.name + 'o2') < 0.06) oil = 1;
    if (o.terrain === 'hills' || o.terrain === 'mountains') steel = hash(p.name + 's') < 0.55 ? 2 : 1;
    else if (hash(p.name + 's2') < 0.18) steel = 1;
    if (o.terrain === 'plains') food = 3; else if (o.terrain === 'forest' || o.terrain === 'hills' || o.terrain === 'jungle') food = 2; else if (o.terrain !== 'arctic' && o.terrain !== 'desert') food = 1;
    if (riverProv[i] && food < 3) food++;
    if ((o.terrain === 'mountains' || o.terrain === 'desert' || o.terrain === 'jungle') && hash(p.name + 'r') < 0.3) rare = 1;
    return {
      id: i, name: p.name, country: p.country, path: toPath(p.geom),
      x: +o.cx.toFixed(1), y: +o.cy.toFixed(1), lx: +p.seed[0].toFixed(1), ly: +p.seed[1].toFixed(1),
      lat: +o.lat.toFixed(1), areaKm: o.areaKm, pop: popOut[i], cityPop: p.cityPop, capital: p.capital,
      terrain: o.terrain, green: o.green, bright: o.bright, elevation: o.elevation, rugged: o.rugged, river: !!riverProv[i],
      resources: { food, steel, oil, rare },
      neighbors: [...neighbors[i]].sort((a, b) => a - b), straits: [...strait[i]].sort((a, b) => a - b), seas,
    };
  }),
  seas: SEAS.map(([name], si) => {
    const st = seaStats[si];
    const adjS: number[] = [];
    for (const k of seaAdj) { const [a, b] = k.split('|').map(Number); if (a === si) adjS.push(b); if (b === si) adjS.push(a); }
    const [lon, lat] = st.n ? unproj(st.sx / st.n, st.sy / st.n) : [SEAS[si][1], SEAS[si][2]];
    const [ax, ay] = proj(SEAS[si][1], SEAS[si][2]);
    return { id: si, name, x: +ax.toFixed(1), y: +ay.toFixed(1), cells: st.n, lat: +lat.toFixed(1), lon: +lon.toFixed(1), neighbors: adjS.sort((a, b) => a - b) };
  }).filter(() => true),
};
// country borders (outer country outlines) for crisp rendering
const borders = countries.map((c) => ({ id: c.id, d: toPath(c.geom, 0.3) }));

fs.mkdirSync(path.join(ROOT, 'src/data'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'public/geo'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'src/data/world.json'), JSON.stringify(world));
fs.writeFileSync(path.join(ROOT, 'public/geo/decor.json'), JSON.stringify({ rivers: riverPaths, lakes: lakePaths, borders }));

// stats
const tcount: Record<string, number> = {};
for (const p of world.provinces) tcount[p.terrain] = (tcount[p.terrain] || 0) + 1;
console.log('terrain', tcount);
console.log('isolated (no land/strait/sea)', world.provinces.filter((p) => !p.neighbors.length && !p.straits.length && !p.seas.length).map((p) => p.name));
console.log('straits', world.provinces.reduce((s, p) => s + p.straits.length, 0) / 2);
console.log('seas', world.seas.map((s) => `${s.name}:${s.cells}:${s.neighbors.length}`).join(', '));
console.log('size', (fs.statSync(path.join(ROOT, 'src/data/world.json')).size / 1e6).toFixed(2), 'MB');
