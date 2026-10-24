import type { Army, Fleet, GameState, Nation, ShipType } from './types';
import { MIL, SHIPS } from './config';
import { PROV, WORLD, seaRoute, isCoastal } from './geo';
import { atWar, isFriendly, armiesIn, invalidateArmies } from './world';
import { addEvent } from './events';
import { fleetPower, armyStrength, setArmyLocation, deleteArmy, industryBonus, landDijkstra, pathFrom } from './military';
import { setController } from './territory';
import { startBattle, joinBattle } from './battle';
import { navalAir } from './air';
import { fmt } from './economy';

/** Brigades the merchant fleet can carry: big trading economies can charter far more shipping. */
export function merchantCapacity(n: Nation) { return Math.floor(4 + Math.min(60, Math.max(0, n.budget?.output ?? 0) / 200)); }
export function nationTransportCapacity(s: GameState, n: Nation) {
  let cap = merchantCapacity(n);
  for (const f of Object.values(s.fleets)) if (f.owner === n.id) cap += f.ships.transport * SHIPS.transport.capacity;
  cap = Math.floor(cap);
  let used = 0;
  for (const a of Object.values(s.armies)) if (a.owner === n.id && a.embarked) used += a.units.length;
  return { cap, used };
}

/** Shipping fee for carrying `brigades` across `zones` sea zones. */
export function transportFee(n: Nation, brigades: number, zones: number) {
  return MIL.TRANSPORT_COST_PER_ZONE * brigades * zones * (1 - 0.3 * n.techMods.amphibious) * n.priceIndex;
}

/**
 * Plan a naval invasion for a group of armies: the friendly port they can all reach soonest that
 * has a sea route to `dest`, each army's march there, and the day the last one arrives (they sail
 * together). Null if no such port exists.
 */
export function invasionPlan(s: GameState, armies: Army[], dest: number): { port: number; paths: Map<number, number[]>; sailIn: number; seaDays: number } | null {
  if (!armies.length || !isCoastal(dest)) return null;
  const owner = armies[0].owner;
  const dc = s.provinces[dest].controller;
  if (!(dc === owner || isFriendly(s, owner, dc) || atWar(s, owner, dc))) return null;
  const reach = armies.map((a) => ({ a, ...landDijkstra(s, a) }));
  let best: { port: number; paths: Map<number, number[]>; sailIn: number; seaDays: number; score: number } | null = null;
  for (let p = 0; p < s.provinces.length; p++) {
    const st = s.provinces[p];
    if (st.buildings.port <= 0 || !isCoastal(p) || !(st.controller === owner || isFriendly(s, owner, st.controller))) continue;
    if (reach.some((r) => !isFinite(r.dist[p]))) continue;
    const route = seaRoute(PROV[p].seas, PROV[dest].seas);
    if (!route) continue;
    const sailIn = Math.ceil(Math.max(...reach.map((r) => r.dist[p])));
    const seaDays = route.length * MIL.TRANSPORT_DAYS_PER_ZONE;
    // soonest landing; among equals, the port where most of the group already is
    const score = sailIn + seaDays + 0.05 * reach.reduce((t, r) => t + r.dist[p], 0);
    if (!best || score < best.score - 1e-9) {
      best = { port: p, paths: new Map(reach.map((r) => [r.a.id, pathFrom(r.prev, r.a.location, p)])), sailIn, seaDays, score };
    }
  }
  return best;
}

/** Order a group of armies to invade `dest` by sea; they march to the port and sail together. */
export function orderInvasion(s: GameState, armies: Army[], dest: number): { ok: boolean; reason?: string; port?: number; days?: number } {
  const free = armies.filter((a) => !a.battleId && !a.embarked);
  if (!free.length) return { ok: false, reason: 'The armies are in battle or already at sea.' };
  const plan = invasionPlan(s, free, dest);
  if (!plan) return { ok: false, reason: `No friendly port with a sea route to ${PROV[dest].name} can be reached.` };
  const n = s.nations[free[0].owner];
  const { cap, used } = nationTransportCapacity(s, n);
  const brigades = free.reduce((t, a) => t + a.units.length, 0);
  if (brigades > cap - used) return { ok: false, reason: `Not enough transport capacity: ${brigades} brigades to carry, ${Math.max(0, cap - used)} of ${cap} free. Send fewer armies or build Transport Flotillas.` };
  const fee = transportFee(n, brigades, plan.seaDays / MIL.TRANSPORT_DAYS_PER_ZONE);
  if (n.treasury < fee) return { ok: false, reason: `Shipping ${brigades} brigades costs ${fmt(fee)}; the treasury has ${fmt(Math.max(0, n.treasury))}.` };
  const sailDay = s.day + Math.ceil(plan.sailIn);
  for (const a of free) {
    a.path = plan.paths.get(a.id) ?? [];
    a.moveProgress = 0;
    a.seaDest = dest;
    a.seaPort = plan.port;
    a.sailDay = sailDay;
  }
  return { ok: true, port: plan.port, days: Math.ceil(plan.sailIn + plan.seaDays) };
}

/** Whether an army's invasion order still stands: it is heading for (or waiting in) its port. */
export function invasionOn(a: Army) {
  if (a.seaDest == null || a.embarked) return false;
  if (a.seaPort == null) return true; // (orders from before ports were recorded)
  return a.path.length ? a.path[a.path.length - 1] === a.seaPort : a.location === a.seaPort;
}
/** The army was given other orders (or could not reach the port): it no longer sails. */
export function cancelInvasion(s: GameState, a: Army) {
  const dest = a.seaDest;
  a.seaDest = null;
  if (dest != null && s.nations[a.owner]?.isPlayer) addEvent(s, 'military', `${a.name} will not sail for ${PROV[dest].name}: it is no longer heading for the port${a.seaPort != null ? ` of ${PROV[a.seaPort].name}` : ''}.`, [a.owner], { province: a.location });
}

/**
 * Daily, for an army waiting in port with invasion orders: the group (the armies given the same
 * order) sails together once all of it is in port, or a while after the sailing day without the
 * stragglers.
 */
export function sailWhenReady(s: GameState, a: Army) {
  if (!invasionOn(a) || a.path.length || a.battleId) return;
  const group = Object.values(s.armies).filter((b) => b.owner === a.owner && b.seaDest === a.seaDest && b.sailDay === a.sailDay && invasionOn(b));
  // wait (a while) for the armies still on the march, fighting on the way included
  if (group.some((b) => b.path.length) && s.day < (a.sailDay ?? 0) + MIL.INVASION_WAIT) return;
  for (const b of group) {
    if (b.path.length || b.battleId) continue;
    const dest = b.seaDest!;
    b.seaDest = null;
    const r = embark(s, b, dest);
    if (s.nations[b.owner]?.isPlayer) addEvent(s, 'military', r.ok ? `${b.name} sailed from ${PROV[b.location].name} for ${PROV[dest].name} (${r.days} days at sea).` : `${b.name} could not sail for ${PROV[dest].name}: ${r.reason}`, [b.owner], { province: b.location, important: !r.ok });
  }
}

export interface SeaMoveCheck { ok: boolean; reason?: string; route: number[]; days: number; cost: number; risk: number; }
export function checkSeaMove(s: GameState, a: Army, dest: number): SeaMoveCheck {
  const n = s.nations[a.owner];
  const from = a.location;
  const st = s.provinces[from];
  const fail = (reason: string): SeaMoveCheck => ({ ok: false, reason, route: [], days: 0, cost: 0, risk: 0 });
  if (a.battleId) return fail('Army is in battle.');
  if (!isCoastal(from)) return fail('The army must be in a coastal province.');
  if (st.buildings.port <= 0 || !(st.controller === a.owner || isFriendly(s, a.owner, st.controller))) return fail('Embarkation requires a friendly port.');
  if (!isCoastal(dest)) return fail('Destination must be coastal.');
  const dc = s.provinces[dest].controller;
  if (!(dc === a.owner || isFriendly(s, a.owner, dc) || atWar(s, a.owner, dc))) return fail('Cannot land in a neutral nation.');
  const route = seaRoute(PROV[from].seas, PROV[dest].seas);
  if (!route) return fail('No sea route.');
  const { cap, used } = nationTransportCapacity(s, n);
  if (used + a.units.length > cap) return fail(`Not enough transport capacity: ${Math.max(0, cap - used)} of ${cap} brigades free, this army has ${a.units.length}. Split the army, or build Transport Flotillas.`);
  const cost = transportFee(n, a.units.length, route.length);
  if (n.treasury < cost) return fail(`Transport costs ${fmt(cost)}.`);
  let risk = 0;
  for (const z of route) risk = Math.max(risk, seaControl(s, a.owner, z).hostileShare);
  return { ok: true, route, days: route.length * MIL.TRANSPORT_DAYS_PER_ZONE, cost, risk };
}

export function seaControl(s: GameState, nation: string, zone: number) {
  let own = navalAir(s, nation, zone), hostile = 0;
  for (const f of Object.values(s.fleets)) {
    if (f.sea !== zone) continue;
    const p = fleetPower(f, s.nations[f.owner]);
    if (f.owner === nation || isFriendly(s, f.owner, nation)) own += p; else if (atWar(s, f.owner, nation)) hostile += p;
  }
  return { own, hostile, hostileShare: hostile > 0 ? hostile / (hostile + own) : 0 };
}

export function embark(s: GameState, a: Army, dest: number): SeaMoveCheck {
  const c = checkSeaMove(s, a, dest);
  if (!c.ok) return c;
  const n = s.nations[a.owner];
  n.treasury -= c.cost;
  n.ledgerMonth.expense += c.cost;
  a.embarked = { route: c.route, dest, progress: 0, from: a.location };
  a.path = [];
  invalidateArmies();
  return c;
}

/** Daily: armies at sea progress; may be intercepted; land on arrival. */
export function seaTransportDaily(s: GameState) {
  for (const a of Object.values(s.armies)) {
    if (!a.embarked) continue;
    const e = a.embarked;
    e.progress += 1;
    const zi = Math.min(e.route.length - 1, Math.floor(e.progress / MIL.TRANSPORT_DAYS_PER_ZONE));
    const zone = e.route[zi];
    const ctl = seaControl(s, a.owner, zone);
    if (ctl.hostileShare > 0.5) {
      const loss = 0.04 * ctl.hostileShare;
      for (const u of a.units) { u.strength *= 1 - loss; u.equipment *= 1 - loss; u.org *= 0.9; }
      if (s.day % 3 === 0) addEvent(s, 'military', `${a.name} intercepted at sea in the ${WORLD.seas[zone].name}! Losing ${Math.round(loss * 100)}% per day.`, [a.owner], { important: a.owner === s.player });
    }
    if (e.progress >= e.route.length * MIL.TRANSPORT_DAYS_PER_ZONE) land(s, a);
  }
}

function land(s: GameState, a: Army) {
  const e = a.embarked!;
  const dest = e.dest;
  a.embarked = null;
  invalidateArmies();
  const hostile = armiesIn(s, dest).filter((x) => atWar(s, x.owner, a.owner));
  if (hostile.length) {
    // contested landing: amphibious assault from the sea (army technically stays at its port of origin)
    setArmyLocation(s, a, e.from);
    a.path = [dest];
    // a later wave joins the assault already under way on that beach
    const ongoing = s.activeBattles.map((id) => s.battles[id]).find((b) => b && b.result == null && b.province === dest && b.amphibious && (b.attacker.nation === a.owner || isFriendly(s, b.attacker.nation, a.owner)));
    if (ongoing) { joinBattle(s, ongoing, a, true); return; }
    const b = startBattle(s, [a], dest, e.from);
    if (b) { b.amphibious = true; b.strait = false; }
    return;
  }
  setArmyLocation(s, a, dest);
  a.entrench = 0;
  for (const u of a.units) u.org *= 0.85;
  const c = s.provinces[dest].controller;
  if (atWar(s, c, a.owner)) setController(s, dest, a.owner);
  addEvent(s, 'military', `${a.name} landed at ${PROV[dest].name}.`, [a.owner], { province: dest });
}

// ---------------------------------------------------------------- fleets
export function moveFleet(s: GameState, f: Fleet, toZone: number): string | null {
  const route = seaRoute([f.sea], [toZone]);
  if (!route) return 'No route.';
  f.path = route.slice(1);
  f.moveProgress = 0;
  return null;
}

export function fleetsDaily(s: GameState) {
  for (const f of Object.values(s.fleets)) {
    if (f.path.length) {
      let speed = Infinity;
      for (const k in f.ships) if (f.ships[k as ShipType] > 0.01) speed = Math.min(speed, SHIPS[k as ShipType].speed);
      if (!isFinite(speed)) speed = 1;
      f.moveProgress += speed / MIL.TRANSPORT_DAYS_PER_ZONE;
      if (f.moveProgress >= 1) { f.sea = f.path.shift()!; f.moveProgress = 0; }
    }
    f.org = Math.min(1, f.org + 0.03);
  }
  // naval battles: fleets of warring nations in the same zone
  const byZone = new Map<number, Fleet[]>();
  for (const f of Object.values(s.fleets)) (byZone.get(f.sea) || byZone.set(f.sea, []).get(f.sea)!).push(f);
  for (const [zone, fleets] of byZone) {
    if (fleets.length < 2) continue;
    for (let i = 0; i < fleets.length; i++) for (let j = i + 1; j < fleets.length; j++) {
      const A = fleets[i], B = fleets[j];
      if (!s.fleets[A.id] || !s.fleets[B.id] || !atWar(s, A.owner, B.owner)) continue;
      navalEngagement(s, A, B, zone);
    }
  }
}

function navalEngagement(s: GameState, A: Fleet, B: Fleet, zone: number) {
  const pa = fleetPower(A, s.nations[A.owner]), pb = fleetPower(B, s.nations[B.owner]);
  const loss = (f: Fleet, enemy: number, own: number) => {
    const frac = Math.min(0.35, (enemy / Math.max(1, own + enemy)) * 0.12);
    for (const k in f.ships) { const kk = k as ShipType; f.ships[kk] = Math.max(0, f.ships[kk] * (1 - frac * (kk === 'transport' ? 1.5 : 1))); }
    f.org = Math.max(0, f.org - frac * 2);
    return frac;
  };
  const la = loss(A, pb, pa), lb = loss(B, pa, pb);
  if (s.day % 2 === 0) addEvent(s, 'battle', `Naval engagement in the ${WORLD.seas[zone].name}: ${s.nations[A.owner].name} lost ${Math.round(la * 100)}%, ${s.nations[B.owner].name} lost ${Math.round(lb * 100)}% of their fleets.`, [A.owner, B.owner]);
  for (const f of [A, B]) {
    const total = Object.values(f.ships).reduce((t, v) => t + v, 0);
    if (total < 0.5) { delete s.fleets[f.id]; addEvent(s, 'battle', `${f.name} of ${s.nations[f.owner].name} was sunk.`, [f.owner], { important: f.owner === s.player }); }
    else if (f.org < 0.15 && f.path.length === 0) {
      // retreat to home port zone
      const home = PROV[f.homePort]?.seas[0];
      if (home != null && home !== f.sea) moveFleet(s, f, home);
    }
  }
}

/** Price of a ship (hull and crew), with tech and factory discounts. */
export function shipCost(type: ShipType, n: Nation) {
  const spec = SHIPS[type];
  return spec.cost * n.techMods.equipCost.ships * (1 - industryBonus(n).discount) * n.priceIndex + spec.personnel * MIL.RECRUIT_PER_SOLDIER * n.priceIndex;
}
export function orderShip(s: GameState, n: Nation, type: ShipType, port: number): string | null {
  const st = s.provinces[port];
  if (st.owner !== n.id || st.controller !== n.id || st.buildings.port <= 0) return 'Ships are built in your own ports.';
  const spec = SHIPS[type];
  const cost = shipCost(type, n);
  if (n.treasury < cost) return `Insufficient funds: this costs ${cost.toFixed(1)} M IC.`;
  if (n.manpower < spec.personnel) return 'Insufficient manpower.';
  n.treasury -= cost;
  n.ledgerMonth.expense += cost;
  n.manpower -= spec.personnel;
  n.shipyard.push({ id: s.nextId++, type, port, daysLeft: spec.days, totalDays: spec.days });
  return null;
}
export function shipyardDaily(s: GameState, n: Nation) {
  if (!n.shipyard.length) return;
  for (const o of n.shipyard) o.daysLeft--;
  const done = n.shipyard.filter((o) => o.daysLeft <= 0);
  n.shipyard = n.shipyard.filter((o) => o.daysLeft > 0);
  for (const o of done) {
    const zone = PROV[o.port].seas[0];
    let f = Object.values(s.fleets).find((x) => x.owner === n.id && x.sea === zone && !x.path.length);
    if (!f) {
      f = { id: s.nextId++, owner: n.id, name: `${n.name} ${['Home', 'Second', 'Third', 'Fourth', 'Fifth'][Object.values(s.fleets).filter((x) => x.owner === n.id).length] ?? 'Reserve'} Fleet`, sea: zone, ships: { destroyer: 0, cruiser: 0, battlegroup: 0, transport: 0 }, path: [], moveProgress: 0, org: 0.7, homePort: o.port, mission: 'patrol' };
      s.fleets[f.id] = f;
    }
    f.ships[o.type] += 1;
    if (n.isPlayer) addEvent(s, 'military', `${SHIPS[o.type].label} commissioned at ${PROV[o.port].name}.`, [n.id], { province: o.port });
  }
}

export { armyStrength, deleteArmy };
