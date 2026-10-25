/**
 * Logistics. Supply flows from hubs (capital, depots, connected ports, major cities) through
 * friendly-controlled provinces. Reach decays with infrastructure-weighted distance, each province
 * has a throughput ceiling, and every hub has finite capacity shared by the armies drawing on it.
 * Every shortfall carries an explicit cause and suggested fixes for the UI.
 */
import { focusOf } from './policy';
import type { Army, GameState, Nation } from './types';
import { PROV, WORLD, distKm, landLinks } from './geo';
import { controlledBy, isFriendly, atWar, playerHelp } from './world';
import { MIL, WEATHER } from './config';
import { armySupplyDemand, armyFuelShare } from './military';
import { provinceWeather } from './weather';

export interface SupplyNet {
  nation: string;
  cap: Float32Array;     // supply/day reachable from best hub (before throughput)
  through: Float32Array; // local throughput limit
  hub: Int32Array;       // best hub province (-1 unreachable)
  dist: Float32Array;    // effective km to hub
  hubs: Map<number, { cap: number; kind: string; load: number }>;
}

const RANGE_KM = 520;
const MAX_HOP_KM = 400;
// static: connected components of the sea-zone graph
const SEA_COMP: number[] = (() => {
  const comp = new Array(WORLD.seas.length).fill(-1);
  let c = 0;
  for (let i = 0; i < comp.length; i++) {
    if (comp[i] >= 0) continue;
    const q = [i]; comp[i] = c;
    while (q.length) { const z = q.pop()!; for (const nb of WORLD.seas[z].neighbors) if (comp[nb] < 0) { comp[nb] = c; q.push(nb); } }
    c++;
  }
  return comp;
})();
let zonePower: { s: GameState | null; day: number; byZone: Map<number, { owner: string; p: number }[]> } = { s: null, day: -1, byZone: new Map() };
function zoneFleets(s: GameState) {
  if (zonePower.s !== s || zonePower.day !== s.day) {
    const byZone = new Map<number, { owner: string; p: number }[]>();
    for (const f of Object.values(s.fleets)) {
      const pw = f.ships.destroyer * 8 + f.ships.cruiser * 19 + f.ships.battlegroup * 50;
      (byZone.get(f.sea) || byZone.set(f.sea, []).get(f.sea)!).push({ owner: f.owner, p: pw });
    }
    zonePower = { s, day: s.day, byZone };
  }
  return zonePower.byZone;
}
let nets = new Map<string, SupplyNet>();
let netsDay = -1;
let netsState: GameState | null = null;

export function resetSupplyCache() { nets = new Map(); netsDay = -1; }

function hubsFor(s: GameState, n: Nation): Map<number, { cap: number; kind: string; load: number }> {
  const hubs = new Map<number, { cap: number; kind: string; load: number }>();
  const ctrl = controlledBy(s, n.id);
  const add = (p: number, cap: number, kind: string) => {
    const h = hubs.get(p);
    if (!h) hubs.set(p, { cap, kind, load: 0 });
    else { h.cap += cap; h.kind = h.kind + ' + ' + kind; }
  };
  const capP = s.provinces[n.capital];
  if (capP && capP.controller === n.id) add(n.capital, 30 + n.budget.output / 18, 'Capital');
  // home ports reachable from the capital region give sea supply to other ports
  const homePorts: number[] = [];
  for (const p of ctrl) {
    const st = s.provinces[p];
    if (st.buildings.depot > 0 && st.owner === n.id) add(p, 26 * n.techMods.supplyThroughput, 'Supply depot');
    if (st.buildings.port > 0 && st.owner === n.id && st.status === 'core') homePorts.push(p);
    if (PROV[p].cityPop > 1.5e6 && st.owner === n.id && st.status === 'core' && p !== n.capital) add(p, 10 + PROV[p].cityPop / 1e6, 'Major city');
    else if (st.pop > 6e6 && st.owner === n.id && st.status === 'core' && p !== n.capital) add(p, 6 + st.pop / 2e6, 'Regional centre');
  }
  const homeComps = new Set<number>();
  for (const h of homePorts) for (const z of PROV[h].seas) homeComps.add(SEA_COMP[z]);
  for (const p of ctrl) {
    const st = s.provinces[p];
    if (st.buildings.port <= 0 || !PROV[p].seas.length) continue;
    // a port works as a hub if a sea route links it to a core home port (blockades reduce it)
    const ok = homePorts.length > 0 && (homePorts.includes(p) || homeComps.has(SEA_COMP[PROV[p].seas[0] ?? 0]) || PROV[p].seas.some((z) => homeComps.has(SEA_COMP[z])));
    if (ok) add(p, (14 + 8 * st.buildings.port) * (1 - blockadeLevel(s, n.id, p) * 0.7), st.owner === n.id ? 'Port' : 'Captured port');
  }
  if (!hubs.size && ctrl.length) add(ctrl[0], 12, 'Provisional HQ');
  return hubs;
}

/** 0..1: hostile naval superiority in the sea zones touching a province. */
export function blockadeLevel(s: GameState, nation: string, p: number): number {
  let worst = 0;
  const zones = zoneFleets(s);
  for (const sea of PROV[p].seas) {
    let hostile = 0, own = 0;
    for (const f of zones.get(sea) ?? []) {
      const pw = f.p;
      if (f.owner === nation) own += pw; else if (atWar(s, f.owner, nation)) hostile += pw; else if (isFriendly(s, f.owner, nation)) own += pw;
    }
    if (hostile > 0) worst = Math.max(worst, hostile / (hostile + own));
  }
  return worst;
}

export function throughputOf(s: GameState, n: Nation, p: number) {
  const st = s.provinces[p];
  // large or populous provinces (one province can stand for a whole Chinese or Russian region)
  // have many roads, rail lines and towns, so they can feed proportionally more troops
  const g = PROV[p];
  const size = Math.min(5, Math.max(1, Math.sqrt(g.areaKm / 60000))) + Math.min(3, g.pop / 2e7);
  return (5 + 3 * st.infra + 4 * st.buildings.railway) * size * (focusOf(st) === 'military' ? 1.4 : 1) * ((st.scorchedUntil ?? 0) > s.day && n.id !== st.owner ? 0.35 : 1) * ((st.partisansUntil ?? 0) > s.day && n.id !== st.owner ? 0.7 : 1) * ((n.gov?.decrees.cyberHit ?? 0) > s.day ? 0.8 : 1) * n.techMods.supplyThroughput * (1 - 0.5 * st.damage);
}

export function computeNet(s: GameState, n: Nation): SupplyNet {
  const N = s.provinces.length;
  const net: SupplyNet = { nation: n.id, cap: new Float32Array(N), through: new Float32Array(N), hub: new Int32Array(N).fill(-1), dist: new Float32Array(N).fill(Infinity), hubs: hubsFor(s, n) };
  const range = RANGE_KM * n.techMods.supplyRange;
  // multi-source best-first search maximising delivered capacity; heap stored in flat arrays
  const best = net.cap;
  let hk: number[] = [], hp: number[] = [], hh: number[] = [], hd: number[] = [];
  let size = 0;
  const swap = (i: number, j: number) => { let t = hk[i]; hk[i] = hk[j]; hk[j] = t; t = hp[i]; hp[i] = hp[j]; hp[j] = t; t = hh[i]; hh[i] = hh[j]; hh[j] = t; t = hd[i]; hd[i] = hd[j]; hd[j] = t; };
  const push = (k: number, p: number, h: number, d: number) => {
    hk[size] = k; hp[size] = p; hh[size] = h; hd[size] = d;
    let i = size++;
    while (i > 0) { const pa = (i - 1) >> 1; if (hk[pa] >= hk[i]) break; swap(pa, i); i = pa; }
  };
  const popTop = () => {
    size--;
    if (size > 0) {
      swap(0, size);
      let i = 0;
      for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < size && hk[a] > hk[m]) m = a; if (b < size && hk[b] > hk[m]) m = b; if (m === i) break; swap(m, i); i = m; }
    }
  };
  const hubCap = new Map<number, number>();
  for (const [p, h] of net.hubs) { push(h.cap, p, p, 0); hubCap.set(p, h.cap); }
  const pass = new Int8Array(N); // 0 unknown, 1 passable, -1 blocked
  const passable = (p: number) => {
    if (pass[p] === 0) { const c = s.provinces[p].controller; pass[p] = c === n.id || isFriendly(s, n.id, c) ? 1 : -1; }
    return pass[p] === 1;
  };
  while (size > 0) {
    const cap = hk[size > 0 ? 0 : 0], p = hp[0], hub = hh[0], d = hd[0];
    popTop();
    if (cap <= best[p] || (net.hub[p] >= 0 && cap <= best[p])) continue;
    best[p] = cap; net.hub[p] = hub; net.dist[p] = d;
    const hcap = hubCap.get(hub)!;
    const g = PROV[p];
    for (let i = 0; i < g.neighbors.length + g.straits.length; i++) {
      const strait = i >= g.neighbors.length;
      const to = strait ? g.straits[i - g.neighbors.length] : g.neighbors[i];
      if (!passable(to)) continue;
      const st = s.provinces[to];
      const infra = st.infra + st.buildings.railway * 2;
      // one province can be a whole region with its own road and rail grid: cap the distance per hop
      const nd = d + (Math.min(MAX_HOP_KM, distKm(p, to)) / (0.6 + 0.18 * infra)) * (strait ? 2.2 : 1);
      const ncap = hcap / (1 + (nd / range) ** 2);
      if (ncap > best[to] && ncap > 0.3) push(ncap, to, hub, nd);
    }
  }
  for (let p = 0; p < N; p++) if (net.hub[p] >= 0) net.through[p] = throughputOf(s, n, p);
  hk = hp = hh = hd = [];
  return net;
}

export function getNet(s: GameState, n: Nation): SupplyNet {
  if (netsState !== s || netsDay !== s.day) { nets = new Map(); netsDay = s.day; netsState = s; }
  let net = nets.get(n.id);
  if (!net) { net = computeNet(s, n); nets.set(n.id, net); }
  return net;
}

export interface SupplyReport {
  demand: number; delivered: number; ratio: number; stockDays: number; hubName: string; hubKind: string; distKm: number;
  causes: string[]; solutions: string[];
}

/** Daily supply for all armies of a nation. Mutates army.supply, lastSupplyRatio, lastSupplyCause. */
export function supplyDaily(s: GameState, n: Nation, armies: Army[], atWarNow = true) {
  if (!armies.length) return;
  if (!atWarNow && !n.isPlayer && armies.every((a) => !a.embarked && s.provinces[a.location].controller === n.id)) {
    // peacetime garrisons on home soil are supplied by the civilian economy
    for (const a of armies) { a.supply = Math.min(MIL.ARMY_SUPPLY_DAYS, a.supply + 1); a.lastSupplyRatio = 1; a.lastSupplyCause = []; }
    return;
  }
  const net = getNet(s, n);
  for (const h of net.hubs.values()) h.load = 0;
  // demand per province and per hub
  const provDemand = new Map<number, number>();
  const dem = new Map<number, number>();
  for (const a of armies) {
    if (a.embarked) continue;
    const g = a.generalId != null ? s.generals[a.generalId] : null;
    const w = WEATHER[provinceWeather(s, a.location)].supply;
    const act = a.battleId != null ? 2.4 : a.path.length ? 1.25 : 1;
    const d = armySupplyDemand(a) * w * act * (g?.trait === 'logistician' ? 0.8 : 1) * (1 - 0.04 * ((g?.logistics ?? 1) - 1));
    dem.set(a.id, d);
    provDemand.set(a.location, (provDemand.get(a.location) || 0) + d);
    const hub = net.hub[a.location];
    if (hub >= 0) net.hubs.get(hub)!.load += d;
  }
  for (const a of armies) {
    if (a.embarked) { a.supply = Math.max(0, a.supply - armySupplyDemand(a) / Math.max(1, armySupplyDemand(a))); a.lastSupplyCause = ['At sea — consuming carried supplies']; continue; }
    const d = dem.get(a.id) || 0;
    const p = a.location;
    const causes: string[] = [];
    let avail = 0;
    const hub = net.hub[p];
    if (hub < 0) {
      causes.push('Cut off: no friendly route to any supply hub');
    } else {
      const share = d / Math.max(1e-6, provDemand.get(p) || d);
      const reach = net.cap[p];
      const through = net.through[p];
      const h = net.hubs.get(hub)!;
      const hubRatio = h.load > 0 ? Math.min(1, h.cap / h.load) : 1;
      avail = Math.min(reach, through) * share * hubRatio;
      // diagnostics
      if (net.dist[p] > RANGE_KM * n.techMods.supplyRange * 0.6) causes.push(`Long supply line: ${Math.round(net.dist[p])} km (infrastructure-adjusted) from ${PROV[hub].name} (${h.kind})`);
      if (through < (provDemand.get(p) || 0)) causes.push(`Infrastructure ${s.provinces[p].infra} in ${PROV[p].name} limits throughput to ${through.toFixed(0)}/day (demand ${(provDemand.get(p) || 0).toFixed(0)})`);
      if (hubRatio < 0.95) causes.push(`${PROV[hub].name} hub overloaded: ${h.load.toFixed(0)}/day demanded vs ${h.cap.toFixed(0)} capacity`);
      if (s.provinces[p].damage > 0.3) causes.push(`War damage in ${PROV[p].name} (${Math.round(s.provinces[p].damage * 100)}%) disrupts transport`);
    }
    // national fuel shortage hits the fuel share of demand
    const fuelShare = armyFuelShare(a);
    if (n.shortages.oil > 0.05 && fuelShare > 0) { avail *= 1 - n.shortages.oil * fuelShare; causes.push(`National oil shortage (${Math.round(n.shortages.oil * 100)}% unmet) — vehicles short of fuel`); }
    const w = provinceWeather(s, p);
    if (WEATHER[w].supply > 1.1) causes.push(`${WEATHER[w].label} raises consumption by ${Math.round((WEATHER[w].supply - 1) * 100)}%`);
    const maxStock = MIL.ARMY_SUPPLY_DAYS;
    const base = Math.max(1e-6, armySupplyDemand(a));
    // stock in days of base demand
    const deliveredDays = (avail * 1.25) / base; // 25% headroom lets stocks refill when the line is healthy
    const usedDays = d / base;
    a.supply = Math.max(0, Math.min(maxStock, a.supply + deliveredDays - usedDays));
    const flowRatio = Math.min(1, avail / Math.max(1e-6, d));
    a.lastSupplyRatio = a.supply > 0.5 ? Math.max(flowRatio, Math.min(1, 0.6 + a.supply / maxStock)) : flowRatio;
    const floor = n.isPlayer ? playerHelp(s).supply : 0; // (difficulty)
    if (a.lastSupplyRatio < floor) { a.lastSupplyRatio = floor; causes.push(`Difficulty: your armies always get at least ${Math.round(floor * 100)}% of their supply`); }
    a.lastSupplyCause = causes;
  }
}

export function supplyReport(s: GameState, a: Army): SupplyReport {
  const n = s.nations[a.owner];
  const net = getNet(s, n);
  const p = a.location;
  const hub = net.hub[p];
  const demand = armySupplyDemand(a);
  const avail = hub >= 0 ? Math.min(net.cap[p], net.through[p]) : 0;
  const solutions: string[] = [];
  const causes = a.lastSupplyCause.length ? a.lastSupplyCause : [];
  if (hub < 0) solutions.push('Reopen a land corridor to friendly territory, or capture a port');
  if (causes.some((c) => c.startsWith('Long supply'))) {
    solutions.push(`Build a Supply Depot in a controlled province near ${PROV[p].name}`);
    solutions.push('Research Motorised Supply Columns / Forward Field Depots');
    const ports = [...net.hubs.entries()].filter(([, h]) => h.kind.includes('port'));
    if (!ports.length) solutions.push('Capture or build a port near the front for sea supply');
  }
  if (causes.some((c) => c.startsWith('Infrastructure'))) solutions.push(`Build roads/railways in ${PROV[p].name}, or split the army across provinces`);
  if (causes.some((c) => c.includes('overloaded'))) solutions.push('Add depots elsewhere, or reduce the number of formations drawing on this hub');
  if (causes.some((c) => c.includes('oil'))) solutions.push('Secure oil: build Extraction Sites, sign trade agreements or keep a port open for imports');
  if (causes.some((c) => c.includes('War damage'))) solutions.push('Repair the province once it is secure');
  return {
    demand, delivered: avail, ratio: a.lastSupplyRatio, stockDays: a.supply,
    hubName: hub >= 0 ? PROV[hub].name : '—', hubKind: hub >= 0 ? net.hubs.get(hub)!.kind : 'none', distKm: hub >= 0 ? net.dist[p] : Infinity,
    causes, solutions,
  };
}

/** For map mode: supply capacity available at each province for nation (0..∞ supply/day). */
export function supplyMap(s: GameState, n: Nation): Float32Array {
  const net = getNet(s, n);
  const out = new Float32Array(s.provinces.length);
  for (let p = 0; p < out.length; p++) out[p] = net.hub[p] >= 0 ? Math.min(net.cap[p], net.through[p]) : -1;
  return out;
}
