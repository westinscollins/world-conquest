import type { Army, Fleet, GameState, Nation, ShipType } from './types';
import { MIL, SHIPS } from './config';
import { PROV, WORLD, seaRoute, isCoastal } from './geo';
import { atWar, isFriendly, armiesIn, invalidateArmies } from './world';
import { addEvent } from './events';
import { fleetPower, armyStrength, setArmyLocation, deleteArmy } from './military';
import { setController } from './territory';
import { startBattle } from './battle';
import { fmt } from './economy';

export function nationTransportCapacity(s: GameState, n: Nation) {
  let cap = 4; // chartered merchant shipping
  for (const f of Object.values(s.fleets)) if (f.owner === n.id) cap += f.ships.transport * SHIPS.transport.capacity;
  let used = 0;
  for (const a of Object.values(s.armies)) if (a.owner === n.id && a.embarked) used += a.units.length;
  return { cap, used };
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
  if (used + a.units.length > cap) return fail(`Not enough transport capacity (${cap - used} brigades free; build Transport Flotillas).`);
  const amphib = n.techMods.amphibious;
  const cost = MIL.TRANSPORT_COST_PER_ZONE * a.units.length * route.length * (1 - 0.3 * amphib) * n.priceIndex;
  if (n.treasury < cost) return fail(`Transport costs ${fmt(cost)}.`);
  let risk = 0;
  for (const z of route) risk = Math.max(risk, seaControl(s, a.owner, z).hostileShare);
  return { ok: true, route, days: route.length * MIL.TRANSPORT_DAYS_PER_ZONE, cost, risk };
}

export function seaControl(s: GameState, nation: string, zone: number) {
  let own = 0, hostile = 0;
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

export function orderShip(s: GameState, n: Nation, type: ShipType, port: number): string | null {
  const st = s.provinces[port];
  if (st.owner !== n.id || st.controller !== n.id || st.buildings.port <= 0) return 'Ships are built in your own ports.';
  const spec = SHIPS[type];
  if (n.stockpile.ships < spec.cost) return `Requires ${spec.cost} M IC of naval materiel in the stockpile (assign factories to Naval production). Have ${n.stockpile.ships.toFixed(1)}.`;
  const crew = spec.personnel * MIL.RECRUIT_PER_SOLDIER * n.priceIndex;
  if (n.treasury < crew) return 'Insufficient funds for crew training.';
  if (n.manpower < spec.personnel) return 'Insufficient manpower.';
  n.stockpile.ships -= spec.cost;
  n.treasury -= crew;
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
