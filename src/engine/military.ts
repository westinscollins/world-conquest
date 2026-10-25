import type { Army, AirWing, EquipKind, GameState, Nation, ShipType, Unit, UnitType, Fleet, General, GeneralTrait } from './types';
import { MIL, UNITS, SHIPS, SHIP_UPKEEP_SHARE, TERRAIN, WEATHER, ECON, RESOURCE, WAR_ECONOMY, REVOLT_AT, AIR } from './config';
import { PROV, distKm, isStrait, landLinks } from './geo';
import { atWar, isFriendly, invalidateArmies, armiesIn, playerHelp } from './world';
import { addEvent } from './events';
import { provinceWeather } from './weather';
import { govMods, focusOf } from './policy';

// ---------------------------------------------------------------- unit economics (all derived from config)
export function equipValue(type: UnitType): number {
  return Object.values(UNITS[type].equip).reduce((a, b) => a + (b || 0), 0);
}
/** Military-industry bonus from factories: cheaper equipment and faster training (0..1 shares). */
export function industryBonus(n?: Nation) {
  const f = n?.lastFactories ?? 0;
  return { discount: Math.min(MIL.FACTORY_DISCOUNT_MAX, f * MIL.FACTORY_DISCOUNT), speed: Math.min(MIL.FACTORY_SPEED_MAX, f * MIL.FACTORY_SPEED) };
}
/** Price of a unit's full equipment set ($M), after tech and factory discounts. */
export function unitEquipCost(type: UnitType, n?: Nation): number {
  let c = 0;
  for (const k in UNITS[type].equip) c += UNITS[type].equip[k as EquipKind]! * (n?.techMods.equipCost[k as EquipKind] ?? 1);
  return c * (1 - industryBonus(n).discount) * (n?.priceIndex ?? 1);
}
/** One-time cost to raise a formation ($M): induction, training and its full equipment. */
export function recruitCost(type: UnitType, n?: Nation): number {
  return UNITS[type].personnel * MIL.RECRUIT_PER_SOLDIER * (n?.priceIndex ?? 1) + unitEquipCost(type, n);
}
/** Annual peacetime upkeep: wages + equipment maintenance + garrison supply + standby fuel. */
export function unitUpkeepBreakdown(type: UnitType, n?: Nation) {
  const u = UNITS[type];
  const pi = n?.priceIndex ?? 1;
  const wages = u.personnel * MIL.SOLDIER_WAGE * pi;
  const maint = equipValue(type) * MIL.EQUIP_MAINT * pi;
  const supply = u.supply * 365 * MIL.SUPPLY_PRICE * MIL.PEACE_SUPPLY_FACTOR * pi;
  const fuel = u.fuel * 365 * MIL.FUEL_PRICE_PER_OIL * MIL.PEACE_SUPPLY_FACTOR * pi;
  return { wages, maint, supply, fuel, total: wages + maint + supply + fuel };
}
export const unitUpkeep = (type: UnitType, n?: Nation) => unitUpkeepBreakdown(type, n).total;
/** Extra cost per active (campaigning) day beyond the peacetime baseline. */
export function unitOpsCostPerDay(type: UnitType, n?: Nation) {
  const u = UNITS[type];
  return (u.supply * MIL.SUPPLY_PRICE + u.fuel * MIL.FUEL_PRICE_PER_OIL) * (1 - MIL.PEACE_SUPPLY_FACTOR) * MIL.OPS_COST_SHARE * (n?.priceIndex ?? 1);
}
export function shipUpkeep(t: ShipType, n?: Nation) {
  return (SHIPS[t].personnel * MIL.SOLDIER_WAGE + SHIPS[t].cost * SHIP_UPKEEP_SHARE) * (n?.priceIndex ?? 1);
}
export function equipmentCost(kind: EquipKind, amount: number, n: Nation) {
  return amount * n.techMods.equipCost[kind] * n.priceIndex;
}

// ---------------------------------------------------------------- unit construction
export function newUnit(s: GameState, type: UnitType, equipment = 1, experience = 0.1): Unit {
  return { id: s.nextId++, type, strength: UNITS[type].personnel, equipment, experience, org: 0.6, morale: 0.7 };
}
export function createArmy(s: GameState, owner: string, location: number, units: Unit[], name?: string): Army {
  const n = s.nations[owner];
  const count = Object.values(s.armies).filter((a) => a.owner === owner).length;
  const a: Army = {
    id: s.nextId++, owner, name: name || `${ordinal(count + 1)} Army`, location, units, generalId: null,
    posture: 'balanced', stance: 'hold', path: [], moveProgress: 0, supply: MIL.ARMY_SUPPLY_DAYS, entrench: 0.3, fatigue: 0,
    battleId: null, embarked: null, lastSupplyRatio: 1, lastSupplyCause: [],
  };
  void n;
  s.armies[a.id] = a;
  invalidateArmies();
  return a;
}
export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
export function deleteArmy(s: GameState, id: number) {
  const a = s.armies[id];
  if (!a) return;
  if (a.generalId != null && s.generals[a.generalId]) s.generals[a.generalId].armyId = null;
  delete s.armies[id];
  invalidateArmies();
}
export function setArmyLocation(s: GameState, a: Army, p: number) {
  a.location = p;
  invalidateArmies();
}

/** A new, empty air wing at an airbase (here rather than in air.ts, which builds on this module). */
export function newWing(s: GameState, owner: string, base: number): AirWing {
  s.airWings ??= {};
  const count = Object.values(s.airWings).filter((w) => w.owner === owner).length;
  const w: AirWing = { id: s.nextId++, owner, name: `${ordinal(count + 1)} Air Wing`, base, units: [], mission: 'support', target: null, rebase: null, bombAcc: 0, last: { sorties: 0, lost: 0, kills: 0 } };
  s.airWings[w.id] = w;
  return w;
}

// ---------------------------------------------------------------- army aggregates
export function armyStrength(a: Army) { return a.units.reduce((t, u) => t + u.strength, 0); }
export function armyMaxStrength(a: Army) { return a.units.reduce((t, u) => t + UNITS[u.type].personnel, 0); }
export function armyOrg(a: Army) {
  const w = a.units.reduce((t, u) => t + u.strength, 0) || 1;
  return a.units.reduce((t, u) => t + u.org * u.strength, 0) / w;
}
export function armyMorale(a: Army) {
  const w = a.units.reduce((t, u) => t + u.strength, 0) || 1;
  return a.units.reduce((t, u) => t + u.morale * u.strength, 0) / w;
}
export function armyEquip(a: Army) {
  const w = a.units.length || 1;
  return a.units.reduce((t, u) => t + u.equipment, 0) / w;
}
/** Supply demand per day (supply units) including fuel. */
export function armySupplyDemand(a: Army) {
  return a.units.reduce((t, u) => t + (UNITS[u.type].supply + UNITS[u.type].fuel * 0.6) * (u.strength / UNITS[u.type].personnel), 0);
}
export function armyFuelShare(a: Army) {
  const tot = a.units.reduce((t, u) => t + UNITS[u.type].supply + UNITS[u.type].fuel, 0) || 1;
  return a.units.reduce((t, u) => t + UNITS[u.type].fuel, 0) / tot;
}
/** Rough combat power for AI and map display (not used by the battle engine). */
export function armyPower(s: GameState, a: Army): number {
  const n = s.nations[a.owner];
  let p = 0;
  for (const u of a.units) {
    const sp = UNITS[u.type];
    const q = n ? qualityOf(n, u.type) : 1;
    p += (sp.soft * 0.6 + sp.hard * 0.4 + sp.defense * 0.5 + sp.breakthrough * 0.3 + sp.air * 0.4) * (u.strength / sp.personnel) * (0.4 + 0.6 * u.equipment) * q * (0.5 + 0.5 * u.org);
  }
  return p * (0.6 + 0.4 * Math.min(1, a.lastSupplyRatio));
}
/**
 * Military strength rating: a fixed number of points per formation and warship (plus units in
 * training). It only changes when forces are raised, disbanded or destroyed — never day to day.
 */
export function militaryStrength(s: GameState, id: string): number {
  let p = 0;
  for (const a of Object.values(s.armies)) if (a.owner === id) for (const u of a.units) p += UNITS[u.type].points;
  for (const f of Object.values(s.fleets)) if (f.owner === id) for (const k in f.ships) p += SHIPS[k as ShipType].points * f.ships[k as ShipType];
  for (const w of Object.values(s.airWings ?? {})) if (w.owner === id) for (const u of w.units) p += UNITS[u.type].points;
  const n = s.nations[id];
  if (n) { for (const t of n.training) p += UNITS[t.type].points; for (const o of n.shipyard) p += SHIPS[o.type].points; }
  return p;
}
export function qualityOf(n: Nation, type: UnitType) {
  const eq = UNITS[type].equip;
  let tot = 0, w = 0;
  for (const k in eq) { const v = eq[k as EquipKind]!; tot += v * n.techMods.quality[k as EquipKind]; w += v; }
  return w ? tot / w : 1;
}
export function armySpeedKm(s: GameState, a: Army, to: number) {
  let base = Infinity;
  for (const u of a.units) if (UNITS[u.type].speed < base && u.type !== 'air') base = UNITS[u.type].speed;
  if (!isFinite(base)) base = 30;
  const g = PROV[to];
  const pst = s.provinces[to];
  const w = provinceWeather(s, to);
  const infra = 1 + 0.05 * pst.infra;
  const supplyF = a.lastSupplyRatio < 0.5 ? 0.6 + 0.8 * a.lastSupplyRatio * armyFuelShare(a) + 0.4 * (1 - armyFuelShare(a)) : 1;
  const general = a.generalId != null ? s.generals[a.generalId] : null;
  const trait = general?.trait === 'mountaineer' && (g.terrain === 'mountains' || g.terrain === 'hills') ? 1.3 : 1;
  return Math.max(3, base * TERRAIN[g.terrain].move * WEATHER[w].move * infra * supplyF * trait * (1 - 0.3 * a.fatigue));
}

// ---------------------------------------------------------------- movement rules
/** Can an army of `owner` enter province p? */
export function canEnter(s: GameState, owner: string, p: number): boolean {
  const ctrl = s.provinces[p].controller;
  if (ctrl === owner) return true;
  if (isFriendly(s, owner, ctrl)) return true;
  if (atWar(s, owner, ctrl)) return true;
  // liberating own legal territory held by an enemy is covered by atWar above
  return false;
}

/** Dijkstra over land + strait links, cost = estimated travel days. */
export function findPath(s: GameState, a: Army, to: number, opts: { avoidEnemy?: boolean } = {}): number[] | null {
  void opts;
  if (a.location === to) return [];
  const { dist, prev } = landDijkstra(s, a, to);
  return isFinite(dist[to]) ? pathFrom(prev, a.location, to) : null;
}
/** Travel days from an army to every province it can reach (or until `to` is settled). */
export function landDijkstra(s: GameState, a: Army, to = -1): { dist: Float64Array; prev: Int32Array } {
  const from = a.location;
  const N = s.provinces.length;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  dist[from] = 0;
  const open: number[] = [from];
  const visited = new Uint8Array(N);
  let baseSpeed = Infinity;
  for (const u of a.units) if (u.type !== 'air') baseSpeed = Math.min(baseSpeed, UNITS[u.type].speed);
  if (!isFinite(baseSpeed)) baseSpeed = 30;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (dist[open[i]] < dist[open[bi]]) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (visited[cur]) continue;
    visited[cur] = 1;
    if (cur === to) break;
    // cannot pass *through* a province defended by hostile armies — the army must fight there first
    if (cur !== from && armiesIn(s, cur).some((x) => atWar(s, x.owner, a.owner))) continue;
    for (const l of landLinks(cur)) {
      if (visited[l.to] || !canEnter(s, a.owner, l.to)) continue;
      const days = distKm(cur, l.to) / (baseSpeed * TERRAIN[PROV[l.to].terrain].move * (1 + 0.05 * s.provinces[l.to].infra)) + (l.strait ? MIL.STRAIT_DAYS : 0);
      const nd = dist[cur] + days;
      if (nd < dist[l.to]) { dist[l.to] = nd; prev[l.to] = cur; open.push(l.to); }
    }
  }
  return { dist, prev };
}
/** The path to `to` from a landDijkstra result. */
export function pathFrom(prev: Int32Array, from: number, to: number): number[] {
  const path: number[] = [];
  for (let c = to; c !== from && c >= 0; c = prev[c]) path.unshift(c);
  return path;
}

export function pathDays(s: GameState, a: Army, path: number[]): number {
  let t = 0, cur = a.location;
  for (const p of path) {
    t += distKm(cur, p) / armySpeedKm(s, a, p) + (isStrait(cur, p) ? MIL.STRAIT_DAYS : 0);
    cur = p;
  }
  return t;
}

// ---------------------------------------------------------------- recruitment & training
export function trainDays(type: UnitType, n?: Nation) { return Math.round(UNITS[type].trainDays * (1 - industryBonus(n).speed) * (n?.regime ? WAR_ECONOMY[n.regime.warEconomy].train : 1)); }

export interface RecruitCheck { ok: boolean; reason?: string; cost: number; manpower: number; days: number; upkeep: number; }
export function checkRecruit(s: GameState, n: Nation, type: UnitType, province: number): RecruitCheck {
  const cost = recruitCost(type, n) * (n.gov ? govMods(s, n).recruit : 1) * (focusOf(s.provinces[province]) === 'military' ? 0.85 : 1);
  const sp = UNITS[type];
  const res: RecruitCheck = { ok: true, cost, manpower: sp.personnel, days: trainDays(type, n), upkeep: unitUpkeep(type, n) };
  const p = s.provinces[province];
  if (p.owner !== n.id || p.controller !== n.id) return { ...res, ok: false, reason: 'You must own and control the province.' };
  if (p.status === 'occupied') return { ...res, ok: false, reason: 'Cannot recruit in occupied territory.' };
  if (p.resistance >= REVOLT_AT) return { ...res, ok: false, reason: 'The province is in open revolt.' };
  if (n.treasury < cost) return { ...res, ok: false, reason: 'Insufficient funds.' };
  if (n.manpower < sp.personnel) return { ...res, ok: false, reason: 'Insufficient manpower.' };
  if (n.bankrupt) return { ...res, ok: false, reason: 'The state is bankrupt.' };
  return res;
}
export function recruit(s: GameState, n: Nation, type: UnitType, province: number, armyId: number | null = null) {
  const c = checkRecruit(s, n, type, province);
  if (!c.ok) return c;
  n.treasury -= c.cost;
  n.ledgerMonth.expense += c.cost;
  n.manpower -= c.manpower;
  n.training.push({ id: s.nextId++, type, province, daysLeft: c.days, totalDays: c.days, armyId });
  return c;
}

/** Daily: progress training orders and deploy finished, fully equipped units. */
export function trainingDaily(s: GameState, n: Nation) {
  if (!n.training.length) return;
  const done: typeof n.training = [];
  for (const t of n.training) {
    t.daysLeft -= 1;
    if (t.daysLeft <= 0) done.push(t);
  }
  if (!done.length) return;
  n.training = n.training.filter((t) => t.daysLeft > 0);
  for (const t of done) {
    const u = newUnit(s, t.type, 1, 0.1);
    u.org = 0.5; u.morale = 0.65;
    if (t.type === 'air' || t.type === 'bomber') {
      // aircraft join an air wing at their airbase
      const wings = Object.values(s.airWings ?? {}).filter((w) => w.owner === n.id && w.base === t.province && !w.rebase && w.units.length < AIR.MAX_WING);
      const w = wings[0] ?? newWing(s, n.id, t.province);
      w.units.push(u);
      if (n.isPlayer) addEvent(s, 'military', `${UNITS[t.type].label} ready at ${PROV[t.province].name} (${w.name}).`, [n.id], { province: t.province });
      continue;
    }
    let army = t.armyId != null ? s.armies[t.armyId] : undefined;
    if (army && (army.owner !== n.id || army.location !== t.province || army.units.length >= MIL.MAX_ARMY_UNITS)) army = undefined;
    if (!army) army = armiesIn(s, t.province).find((a) => a.owner === n.id && !a.battleId && a.units.length < MIL.MAX_ARMY_UNITS && !a.path.length);
    if (!army) army = createArmy(s, n.id, t.province, []);
    army.units.push(u);
    if (n.isPlayer) addEvent(s, 'military', `${UNITS[t.type].label} completed training in ${PROV[t.province].name}.`, [n.id], { province: t.province });
  }
}

/** Daily reinforcement: refill personnel and equipment in supplied, non-fighting armies. */
export function reinforceDaily(s: GameState, a: Army, n: Nation) {
  if (a.battleId || a.embarked) return;
  const supplied = a.lastSupplyRatio;
  for (const u of a.units) {
    const sp = UNITS[u.type];
    // organisation & morale recovery
    const orgMax = (0.55 + 0.45 * n.mobilization) * Math.min(1, 0.4 + 0.6 * supplied) * n.techMods.organisation;
    u.org = Math.min(Math.min(1, orgMax), u.org + MIL.ORG_REGEN * (0.5 + 0.5 * supplied) * (n.isPlayer ? playerHelp(s).recovery : 1));
    if (u.org > orgMax) u.org = Math.max(orgMax, u.org - 0.02);
    const moraleTarget = 0.35 + 0.35 * (n.stability / 100) + 0.2 * supplied + 0.1 * (n.warSupport / 100) + (n.gov ? govMods(s, n).morale : 0);
    u.morale += (moraleTarget - u.morale) * 0.03;
    if (supplied < 0.5) continue;
    // personnel
    if (u.strength < sp.personnel && n.manpower > 0) {
      const add = Math.min(sp.personnel - u.strength, sp.personnel * MIL.REINFORCE_RATE, n.manpower);
      u.strength += add; n.manpower -= add;
      u.experience = Math.max(0.05, u.experience - (add / sp.personnel) * 0.3);
    }
    // equipment: replaced losses are bought as they are refitted
    if (u.equipment < 1 && n.treasury > 0 && !n.bankrupt) {
      const frac = Math.min(1 - u.equipment, MIL.REINFORCE_RATE * 1.5);
      const cost = frac * unitEquipCost(u.type, n);
      u.equipment += frac;
      n.treasury -= cost;
      n.ledgerMonth.expense += cost;
    }
  }
}

// ---------------------------------------------------------------- production
export function totalFactories(s: GameState, n: Nation, owned: number[]) {
  let f = 0;
  for (const p of owned) { const st = s.provinces[p]; if (st.controller === n.id) f += st.buildings.factory * (1 - st.damage) * (st.status === 'core' ? 1 : 0.5); }
  return f;
}

// ---------------------------------------------------------------- generals
const FIRST = ['Adrian', 'Viktor', 'Elena', 'Marcus', 'Ilya', 'Sofia', 'Darius', 'Helena', 'Tomas', 'Anya', 'Rafael', 'Katarina', 'Leon', 'Mira', 'Oskar', 'Petra', 'Stefan', 'Yara', 'Nikolai', 'Ines', 'Hugo', 'Talia', 'Bogdan', 'Lena', 'Emil', 'Zara', 'Felix', 'Nadia', 'Kenji', 'Amara', 'Ravi', 'Selim', 'Jonas', 'Lucia', 'Arjun', 'Mei'];
const LAST = ['Vance', 'Kovac', 'Marek', 'Aldana', 'Brandt', 'Sorel', 'Ivanov', 'Castell', 'Haldane', 'Novak', 'Reyes', 'Lindqvist', 'Okafor', 'Moreau', 'Petrov', 'Takeda', 'Varga', 'Draganov', 'Hale', 'Strand', 'Kaya', 'Duval', 'Rhee', 'Mendes', 'Falk', 'Orlov', 'Basso', 'Kader', 'Sato', 'Weiss', 'Nakamura', 'Quinn'];
export const TRAITS: Record<GeneralTrait, { label: string; desc: string }> = {
  logistician: { label: 'Logistician', desc: '−20% supply consumption, faster resupply.' },
  mountaineer: { label: 'Mountaineer', desc: '+25% attack and +30% speed in hills & mountains.' },
  armored: { label: 'Armored Commander', desc: '+20% to armored/mechanized attack; boosts mobile manoeuvre.' },
  entrencher: { label: 'Fortification Expert', desc: 'Entrenches 2× faster, +10% defence.' },
  aggressive: { label: 'Aggressive', desc: '+12% attack, +15% own casualties.' },
  inspiring: { label: 'Inspiring Leader', desc: '+15% morale and slower organisation loss.' },
  cautious: { label: 'Methodical', desc: '−20% own casualties, −5% attack.' },
  none: { label: 'Unremarkable', desc: 'No special trait.' },
};
export function makeGeneral(s: GameState, owner: string, quality: number, rnd: () => number, available: boolean): General {
  const skill = () => Math.max(1, Math.min(5, Math.round(1 + quality * 2.2 + rnd() * 2)));
  const traits: GeneralTrait[] = ['logistician', 'mountaineer', 'armored', 'entrencher', 'aggressive', 'inspiring', 'cautious', 'none', 'none'];
  const g: General = {
    id: s.nextId++, owner, name: `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]}`,
    attack: skill(), defense: skill(), logistics: skill(), trait: traits[Math.floor(rnd() * traits.length)], xp: 0, armyId: null, hireCost: 0, available,
  };
  g.hireCost = +(1.5 + (g.attack + g.defense + g.logistics - 3) * 0.9 + (g.trait !== 'none' ? 1.5 : 0)).toFixed(1);
  s.generals[g.id] = g;
  return g;
}
export function assignGeneral(s: GameState, generalId: number, armyId: number | null) {
  const g = s.generals[generalId];
  if (!g) return;
  if (g.armyId != null && s.armies[g.armyId]) s.armies[g.armyId].generalId = null;
  if (armyId != null) {
    const a = s.armies[armyId];
    if (!a || a.owner !== g.owner) return;
    if (a.generalId != null && s.generals[a.generalId]) s.generals[a.generalId].armyId = null;
    a.generalId = g.id;
  }
  g.armyId = armyId;
}
export const GENERAL_SALARY = 0.25; // $M / yr per hired general

// ---------------------------------------------------------------- fleets
export function fleetPower(f: Fleet, n?: Nation) {
  const q = n ? n.techMods.quality.ships : 1;
  let p = 0;
  for (const k in f.ships) p += (SHIPS[k as ShipType].attack + SHIPS[k as ShipType].defense) * f.ships[k as ShipType];
  return p * q * (0.4 + 0.6 * f.org);
}
export function fleetCapacity(f: Fleet) { return f.ships.transport * SHIPS.transport.capacity; }

export { RESOURCE };
