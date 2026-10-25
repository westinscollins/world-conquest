import type { Budget, GameState, LedgerLine, Nation, ProvinceState, ResourceKind, BuildingKind, ConstructionOrder } from './types';
import { BUILDINGS, ECON, RESOURCE, RESOURCE_DEMAND, DIPLO, DEVELOP, INTEGRATE, REPAIR_COST_PER_DAMAGE, MIL, UNITS, SECURITY } from './config';
import { PROV, isCoastal } from './geo';
import { ownedBy, peekRel, isAtWar, enemiesOf, alliesOf, diploVersionNow } from './world';
import { unitUpkeep, shipUpkeep, unitOpsCostPerDay, GENERAL_SALARY, totalFactories, armySupplyDemand } from './military';
import { addEvent, fmtDate } from './events';
import { govMods, focusOf, sanctionLoss, govMonthly, aiGovernment } from './policy';
import { regimeCosts, regimeMonthly } from './regime';

export const RES_KINDS: ResourceKind[] = ['food', 'steel', 'oil', 'rare'];

/** Annual output of a province in $B. */
export function provinceOutput(s: GameState, p: ProvinceState, n?: Nation): number {
  const b = p.buildings;
  let flat = 0;
  for (const k in BUILDINGS) flat += BUILDINGS[k as BuildingKind].output * b[k as BuildingKind];
  const focus = focusOf(p);
  if (focus === 'industry') flat += BUILDINGS.factory.output * b.factory * 0.3;
  const base = (p.pop / 1e6) * p.dev * (1 + 0.12 * b.power);
  const statusMult = ECON.STATUS_OUTPUT[p.status] ?? 1;
  const resist = 1 - p.resistance / 250;
  const ctrl = p.controller === p.owner ? 1 : 0.1; // enemy-held provinces produce almost nothing for the owner
  const stab = n ? 0.85 + 0.15 * (n.stability / 100) : 1;
  const mob = n ? 1 - (1 - ECON.MOBILIZED_OUTPUT) * n.mobilization : 1;
  const gov = n ? govMods(s, n).output : 1;
  return (base + flat) * (1 - 0.75 * p.damage) * statusMult * resist * ctrl * stab * mob * gov * (focus === 'commerce' ? 1.06 : 1) * (p.martialLaw ? 0.7 : 1);
}

export function infraOf(p: ProvinceState) {
  return 1 + p.buildings.road + p.buildings.railway * 2 + (p.buildings.port ? 1 : 0);
}

export function resourceYield(p: ProvinceState, kind: ResourceKind): number {
  const g = PROV[p.id];
  let lvl = g.resources[kind];
  if (kind === 'food') lvl += p.buildings.farm;
  if (lvl <= 0) return 0;
  const f = focusOf(p);
  const mineBoost = (kind === 'food' ? 1 : 1 + 0.5 * p.buildings.mine) * (f === 'agriculture' && kind === 'food' ? 1.5 : f === 'industry' && kind === 'steel' ? 1.3 : 1);
  const area = Math.sqrt(Math.max(0.05, g.areaKm / 100000));
  return lvl * RESOURCE[kind].perLevel * area * mineBoost * (1 - 0.6 * p.damage) * (p.controller === p.owner ? 1 : 0) * (ECON.STATUS_OUTPUT[p.status] ?? 1);
}

/** Has access to world markets (a port, or a land neighbour not at war). */
function hasTradeOutlet(s: GameState, n: Nation, owned: number[], enemies: Set<string>) {
  for (const id of owned) if (s.provinces[id].buildings.port > 0 && s.provinces[id].controller === n.id) return true;
  for (const id of owned) for (const nb of PROV[id].neighbors) {
    const c = s.provinces[nb].controller;
    if (c !== n.id && !enemies.has(c)) return true;
  }
  return false;
}

/** Per-day lookups shared by all budget computations (avoids O(n²) scans). */
export interface DayIndex { trade: Map<string, string[]>; tribute: Map<string, number>; repIn: Map<string, number>; enemies: Map<string, Set<string>>; }
let tradeCache: { s: GameState | null; v: number; day: number; map: Map<string, string[]> } = { s: null, v: -1, day: -1, map: new Map() };
export function buildDayIndex(s: GameState): DayIndex {
  // trade partners only change with treaties: rebuild weekly or when diplomacy changes
  if (tradeCache.s !== s || tradeCache.v !== diploVersionNow() || Math.floor(tradeCache.day / 7) !== Math.floor(s.day / 7)) {
    const map = new Map<string, string[]>();
    for (const k in s.relations) {
      if (!s.relations[k].trade) continue;
      const [a, b] = k.split('|');
      (map.get(a) || map.set(a, []).get(a)!).push(b);
      (map.get(b) || map.set(b, []).get(b)!).push(a);
    }
    tradeCache = { s, v: diploVersionNow(), day: s.day, map };
  }
  const trade = tradeCache.map;
  const tribute = new Map<string, number>();
  const repIn = new Map<string, number>();
  for (const o of Object.values(s.nations)) {
    if (!o.alive) continue;
    if (o.overlord) tribute.set(o.overlord, (tribute.get(o.overlord) || 0) + (o.budget.income.find((l) => l.key === 'tax')?.amount ?? 0) * 0.15);
    for (const r of o.reparations) if (r.until > s.day) repIn.set(r.to, (repIn.get(r.to) || 0) + r.amount);
  }
  const enemies = new Map<string, Set<string>>();
  for (const w of s.wars) {
    for (const a of w.attackers) for (const d of w.defenders) {
      (enemies.get(a) || enemies.set(a, new Set()).get(a)!).add(d);
      (enemies.get(d) || enemies.set(d, new Set()).get(d)!).add(a);
    }
  }
  return { trade, tribute, repIn, enemies };
}

let genCache: { s: GameState | null; day: number; map: Map<string, number> } = { s: null, day: -1, map: new Map() };
function generalsOf(s: GameState, id: string) {
  if (genCache.s !== s || genCache.day !== s.day) {
    const map = new Map<string, number>();
    for (const g of Object.values(s.generals)) if (!g.available) map.set(g.owner, (map.get(g.owner) || 0) + 1);
    genCache = { s, day: s.day, map };
  }
  return genCache.map.get(id) || 0;
}

export interface NationAgg {
  owned: number[];
  output: number;
  taxBase: number; // output weighted by status tax factor
  nonCore: number; nonCoreOutput: number; autonomousOutput: number;
  buildingUpkeep: number;
  factories: number;
  production: Record<ResourceKind, number>;
  units: number; personnel: number; upkeepUnits: number; opsDaily: number; navalUpkeep: number; fuelDemand: number;
  generals: number;
}

export function aggregate(s: GameState, n: Nation, armiesByOwner: Map<string, number[]>, fleetsByOwner: Map<string, number[]>): NationAgg {
  const owned = ownedBy(s, n.id);
  const agg: NationAgg = { owned, output: 0, taxBase: 0, nonCore: 0, nonCoreOutput: 0, autonomousOutput: 0, buildingUpkeep: 0, factories: 0, production: { food: 0, steel: 0, oil: 0, rare: 0 }, units: 0, personnel: 0, upkeepUnits: 0, opsDaily: 0, navalUpkeep: 0, fuelDemand: 0, generals: 0 };
  for (const id of owned) {
    const p = s.provinces[id];
    const out = provinceOutput(s, p, n);
    agg.output += out;
    agg.taxBase += out * (ECON.STATUS_TAX[p.status] ?? 1) * (focusOf(p) === 'commerce' ? 1.1 : 1);
    if (p.status !== 'core') { agg.nonCore++; agg.nonCoreOutput += out; }
    if (p.status === 'autonomous') agg.autonomousOutput += out;
    for (const k in BUILDINGS) agg.buildingUpkeep += BUILDINGS[k as BuildingKind].upkeep * p.buildings[k as BuildingKind];
    for (const r of RES_KINDS) agg.production[r] += resourceYield(p, r);
  }
  agg.factories = totalFactories(s, n, owned);
  for (const aid of armiesByOwner.get(n.id) || []) {
    const a = s.armies[aid];
    if (!a) continue;
    const active = a.path.length > 0 || a.battleId != null || s.provinces[a.location].owner !== n.id || !!a.embarked;
    for (const u of a.units) {
      agg.units++;
      agg.personnel += u.strength;
      agg.upkeepUnits += unitUpkeep(u.type, n) * (0.5 + 0.5 * u.strength / UNITS[u.type].personnel);
      agg.fuelDemand += UNITS[u.type].fuel * (active ? 2 : 1);
      if (active) agg.opsDaily += unitOpsCostPerDay(u.type, n) * (a.battleId != null ? 2 : 1);
    }
  }
  // air force: squadrons cost upkeep; flying missions in wartime burns fuel and munitions
  for (const w of Object.values(s.airWings ?? {})) {
    if (w.owner !== n.id) continue;
    const active = w.mission !== 'idle' && !w.rebase && w.last.sorties > 0;
    for (const u of w.units) {
      agg.units++;
      agg.personnel += u.strength;
      agg.upkeepUnits += unitUpkeep(u.type, n) * (0.5 + 0.5 * u.strength / UNITS[u.type].personnel);
      agg.fuelDemand += UNITS[u.type].fuel * (active ? 2 : 1);
      if (active) agg.opsDaily += unitOpsCostPerDay(u.type, n);
    }
  }
  for (const t of n.training) agg.upkeepUnits += unitUpkeep(t.type, n) * 0.5;
  for (const fid of fleetsByOwner.get(n.id) || []) {
    const f = s.fleets[fid];
    if (!f) continue;
    for (const k in f.ships) agg.navalUpkeep += shipUpkeep(k as never, n) * f.ships[k as keyof typeof f.ships];
  }
  agg.navalUpkeep *= 1 + (ECON.MOBILIZED_UPKEEP - 1) * n.mobilization;
  const gm = govMods(s, n);
  agg.upkeepUnits *= (1 + (ECON.MOBILIZED_UPKEEP - 1) * n.mobilization) * gm.upkeep;
  agg.opsDaily *= gm.ops;
  agg.generals = generalsOf(s, n.id);
  return agg;
}

export function collectionEfficiency(n: Nation) {
  return (0.88 + 0.15 * (n.stability / 100)) * n.techMods.taxEff;
}

/** Full annualised budget with a transparent breakdown. Also updates resource balances on the nation. */
export function computeBudget(s: GameState, n: Nation, agg: NationAgg, idx: DayIndex = buildDayIndex(s)): Budget {
  const income: LedgerLine[] = [];
  const expenses: LedgerLine[] = [];
  const pi = n.priceIndex;
  const gm = govMods(s, n);
  const eff = collectionEfficiency(n) * gm.taxEff;
  const tax = agg.taxBase * n.taxRate * eff;
  income.push({ key: 'tax', label: 'Tax revenue', amount: tax, detail: `${fmt(agg.taxBase)} taxable output × ${(n.taxRate * 100).toFixed(0)}% rate × ${(eff * 100).toFixed(0)}% collection efficiency` });

  // trade agreements
  let trade = 0;
  const enemies = idx.enemies.get(n.id) ?? new Set<string>();
  const atWarNow = enemies.size > 0;
  for (const pid of idx.trade.get(n.id) ?? []) {
    const other = s.nations[pid];
    if (!other?.alive) continue;
    trade += Math.min(ECON.TRADE_SHARE * Math.min(agg.output, other.budget.output || agg.output), ECON.TRADE_MAX_PARTNER * agg.output);
  }
  if (atWarNow) trade *= ECON.WAR_TRADE_PENALTY;
  const sanc = sanctionLoss(s, n.id);
  trade *= gm.trade * (1 - sanc);
  if (trade > 0) income.push({ key: 'trade', label: 'Trade agreements', amount: trade, detail: `${atWarNow ? 'Halved by wartime disruption' : 'Bilateral trade with partners'}${gm.trade !== 1 ? ` · trade policy ×${gm.trade}` : ''}${sanc ? ` · −${Math.round(sanc * 100)}% from sanctions` : ''}` });
  if (gm.tariff > 0) income.push({ key: 'tariffs', label: 'Customs tariffs', amount: gm.tariff * agg.output, detail: 'Protectionist trade policy' });

  // resources
  const demand: Record<ResourceKind, number> = {
    food: (agg.owned.reduce((t, id) => t + s.provinces[id].pop, 0) / 1e6) * RESOURCE_DEMAND.foodPerMillionPop,
    steel: agg.factories * RESOURCE_DEMAND.steelPerFactory,
    oil: agg.fuelDemand * RESOURCE_DEMAND.oilPerFuel + agg.output * RESOURCE_DEMAND.oilPerOutput,
    rare: 0, // rare metals are an export commodity
  };
  const embargo = n.embargoUntil > s.day;
  const outlet = !embargo && hasTradeOutlet(s, n, agg.owned, enemies);
  let exports = 0, imports = 0;
  for (const r of RES_KINDS) {
    const net = agg.production[r] - demand[r];
    n.resourceNet[r] = net;
    const price = s.market[r].price;
    if (net >= 0) {
      n.shortages[r] = 0;
      if (outlet) exports += net * price * 0.8;
    } else if (outlet && n.treasury > 0 && !n.bankrupt) {
      imports += -net * price * 1.1 * pi * gm.imports;
      n.shortages[r] = 0;
    } else {
      n.shortages[r] = Math.min(1, -net / Math.max(1, demand[r]));
    }
  }
  if (embargo) expenses.push({ key: 'embargo', label: 'Global embargo (nuclear use)', amount: agg.output * 0.12 * pi, detail: `Lost commerce, frozen assets and capital flight until ${fmtDate(s, n.embargoUntil)}. No trade, imports or treaties.` });
  exports *= 1 - sanc;
  if (exports > 0) income.push({ key: 'exports', label: 'Resource exports', amount: exports, detail: 'Surplus food, steel, oil and rare metals sold at 80% of world price' });

  // subjects / reparations
  const tribute = idx.tribute.get(n.id) ?? 0;
  if (tribute > 0) income.push({ key: 'tribute', label: 'Tribute from subjects', amount: tribute, detail: '15% of subject tax revenue' });
  const repIn = idx.repIn.get(n.id) ?? 0;
  let repOut = 0;
  for (const r of n.reparations) if (r.until > s.day) repOut += r.amount;
  if (repIn > 0) income.push({ key: 'repIn', label: 'War reparations received', amount: repIn });

  // ---- expenses
  const services = ECON.SERVICES_SHARE * agg.output * pi * gm.services;
  expenses.push({ key: 'services', label: 'Civilian services', amount: services, detail: `${(ECON.SERVICES_SHARE * 100).toFixed(0)}% of output: health, education, policing · spending level ${Math.round(n.gov.services * 100)}%${Math.abs(gm.services / n.gov.services - 1) > 0.001 ? ` · policies ×${(gm.services / n.gov.services).toFixed(2)}` : ''}` });
  const nprov = Math.max(1, agg.owned.length);
  const sizeF = Math.pow(1 + nprov / 25, ECON.ADMIN_EXP);
  const admin = ECON.ADMIN_SHARE * agg.output * sizeF * n.techMods.adminCost * pi * gm.admin;
  expenses.push({ key: 'admin', label: 'Administration', amount: admin, detail: `${(ECON.ADMIN_SHARE * 100).toFixed(1)}% of output × realm-size factor ${sizeF.toFixed(2)} (${nprov} provinces)` });
  if (agg.nonCore > 0) {
    const occ = (agg.nonCore * ECON.OCCUPATION_FLAT + (agg.nonCoreOutput - agg.autonomousOutput) * ECON.OCCUPATION_SHARE + agg.autonomousOutput * ECON.AUTONOMY_SHARE) * pi;
    expenses.push({ key: 'occupation', label: 'Occupation & integration admin', amount: occ, detail: `${agg.nonCore} non-core provinces` });
  }
  if (agg.buildingUpkeep > 0) expenses.push({ key: 'buildings', label: 'Infrastructure upkeep', amount: agg.buildingUpkeep * pi });
  expenses.push({ key: 'military', label: 'Military wages & maintenance', amount: agg.upkeepUnits, detail: `${agg.units} formations, ${Math.round(agg.personnel).toLocaleString()} personnel${n.mobilization > 0.05 ? `, mobilisation ${Math.round(n.mobilization * 100)}%` : ''}` });
  if (agg.navalUpkeep > 0) expenses.push({ key: 'naval', label: 'Naval upkeep', amount: agg.navalUpkeep });
  if (agg.opsDaily > 0) expenses.push({ key: 'ops', label: 'Field operations (fuel, ammunition)', amount: agg.opsDaily * 365, detail: 'Armies on campaign, moving or in battle' });
  const rc = regimeCosts(n, agg.output);
  if (rc.security > 0) expenses.push({ key: 'security', label: 'Internal security', amount: rc.security, detail: SECURITY[n.regime.security]?.label });
  if (rc.propaganda > 0) expenses.push({ key: 'propaganda', label: 'Propaganda ministry', amount: rc.propaganda, detail: `${n.regime.propaganda.length} campaign${n.regime.propaganda.length > 1 ? 's' : ''}` });
  if (agg.generals > 0) expenses.push({ key: 'generals', label: 'General staff', amount: agg.generals * GENERAL_SALARY * pi });
  if (n.researchFunding > 0) expenses.push({ key: 'research', label: 'Research funding', amount: n.researchFunding });
  if (n.debt > 0) expenses.push({ key: 'interest', label: 'Debt interest', amount: n.debt * n.interestRate, detail: `${fmt(n.debt)} at ${(n.interestRate * 100).toFixed(1)}%` });
  if (imports > 0) expenses.push({ key: 'imports', label: 'Resource imports', amount: imports, detail: 'Shortfalls bought on the world market at 110% of price' });
  if (repOut > 0) expenses.push({ key: 'repOut', label: 'War reparations paid', amount: repOut });

  const totalIncome = income.reduce((t, l) => t + l.amount, 0);
  const totalExpense = expenses.reduce((t, l) => t + l.amount, 0);
  return { income, expenses, totalIncome, totalExpense, net: totalIncome - totalExpense, output: agg.output };
}

export function fmt(v: number, digits = 1) {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(2)}T`;
  if (a > 0 && a < 1) return `${sign}$${Math.round(a * 1000)}M`;
  return `${sign}$${a.toFixed(a < 10 ? digits : 0)}B`;
}

// ---------------------------------------------------------------- daily & monthly economy
/** Apply one day of the annual budget to the treasury; handles automatic emergency borrowing. */
export function applyDailyBudget(s: GameState, n: Nation) {
  const b = n.budget;
  const dIn = b.totalIncome / 365, dOut = b.totalExpense / 365;
  n.treasury += dIn - dOut;
  n.ledgerMonth.income += dIn;
  n.ledgerMonth.expense += dOut;
  if (n.treasury < 0) {
    const cap = maxDebt(n);
    const need = -n.treasury + 5;
    if (n.debt + need <= cap) {
      n.debt += need;
      n.treasury += need;
      n.interestRate = interestFor(n, true);
      if (n.isPlayer && s.day % 30 === 0) addEvent(s, 'economy', `Treasury empty — the finance ministry issued emergency bonds (${fmt(need)}). Debt now ${fmt(n.debt)}.`, [n.id], { important: true });
      n.bankrupt = false;
    } else if (!n.bankrupt) {
      n.bankrupt = true;
      addEvent(s, 'economy', `${n.name} has defaulted on its debts! Production halted, stability collapsing.`, [n.id], { important: true });
    }
  } else if (n.bankrupt && n.treasury > 0) {
    n.bankrupt = false;
  }
}

export const maxDebt = (n: Nation) => Math.max(20, n.budget.output * ECON.MAX_DEBT_RATIO);
export function interestFor(n: Nation, emergency = false) {
  const ratio = n.debt / Math.max(1, n.budget.output);
  return ECON.BASE_INTEREST + ratio * 0.04 + (n.warExhaustion / 100) * 0.02 + (emergency ? ECON.EMERGENCY_PREMIUM : 0) + (n.stability < 30 ? 0.02 : 0);
}
export function borrow(s: GameState, n: Nation, amount: number): string | null {
  if (amount <= 0) return 'Invalid amount.';
  if (n.debt + amount > maxDebt(n)) return `Lenders refuse: debt ceiling is ${fmt(maxDebt(n))} (150% of annual output).`;
  n.debt += amount;
  n.treasury += amount;
  n.interestRate = (n.interestRate * (n.debt - amount) + interestFor(n) * amount) / n.debt;
  if (n.isPlayer) addEvent(s, 'economy', `Borrowed ${fmt(amount)} at ${(interestFor(n) * 100).toFixed(1)}%.`, [n.id]);
  return null;
}
export function repay(s: GameState, n: Nation, amount: number): string | null {
  amount = Math.min(amount, n.debt);
  if (amount <= 0) return 'No debt to repay.';
  if (n.treasury < amount) return 'Insufficient treasury.';
  n.debt -= amount;
  n.treasury -= amount;
  if (n.debt < 0.01) { n.debt = 0; n.interestRate = ECON.BASE_INTEREST; }
  if (n.isPlayer) addEvent(s, 'economy', `Repaid ${fmt(amount)} of national debt.`, [n.id]);
  return null;
}

/** Monthly: growth, stability, inflation, manpower, history snapshots. */
export function monthlyEconomy(s: GameState, n: Nation, agg: NationAgg) {
  const atWarNow = isAtWar(s, n.id);
  // productivity growth with ceiling (no infinite growth)
  const gm = govMods(s, n);
  const growth = ECON.BASE_GROWTH + gm.growth + n.techMods.growth - ECON.TAX_GROWTH_PENALTY * (n.taxRate - ECON.BASE_TAX) + (n.stability - 55) / 3000 - (atWarNow ? 0.006 : 0) - (n.bankrupt ? 0.03 : 0);
  for (const id of agg.owned) {
    const p = s.provinces[id];
    const cap = p.dev0 * (ECON.DEV_CAP_BASE + ECON.DEV_CAP_PER_INFRA * p.infra);
    const g = growth - p.damage * 0.04 - (p.status === 'core' ? 0 : 0.01);
    p.dev = Math.max(p.dev0 * 0.5, Math.min(cap, p.dev * (1 + g / 12)));
    p.pop *= 1 + (ECON.POP_GROWTH + gm.popGrowth - (n.shortages.food > 0.2 ? 0.01 : 0)) / 12;
    // slow natural recovery of damage
    p.damage = Math.max(0, p.damage - 0.004);
  }
  // stability
  const foodBonus = n.resourceNet.food > 0 ? Math.min(4, n.resourceNet.food / 20) : -n.shortages.food * 25;
  const deficit = n.budget.net < 0 ? Math.min(15, (-n.budget.net / Math.max(1, n.budget.output)) * 150) : 0;
  const farms = Math.min(5, agg.owned.filter((id) => focusOf(s.provinces[id]) === 'agriculture').length * 0.5);
  const target = 72 + gm.stability + farms - (n.taxRate - ECON.BASE_TAX) * 130 - n.warExhaustion * 0.35 + foodBonus - deficit - n.infamy * 0.08 - (n.bankrupt ? 30 : 0) - (agg.nonCore / Math.max(1, agg.owned.length)) * 12 - Math.max(0, n.priceIndex - 1.1) * 40;
  n.stability += (Math.max(0, Math.min(100, target)) - n.stability) * 0.12;
  n.stability -= Math.min(5, agg.owned.filter((id) => s.provinces[id].martialLaw).length);
  n.stability = Math.max(0, Math.min(100, n.stability));
  // war support
  const wsTarget = (atWarNow ? 70 - n.warExhaustion * 0.6 : 55) + gm.warSupport;
  n.warSupport += (wsTarget - n.warSupport) * 0.1;
  // war exhaustion decays in peace
  if (!atWarNow) n.warExhaustion = Math.max(0, n.warExhaustion - 2.5);
  else n.warExhaustion = Math.min(100, n.warExhaustion + 0.5);
  n.infamy = Math.max(0, n.infamy - DIPLO.INFAMY_DECAY / 12);
  // inflation
  const out = Math.max(1, n.budget.output);
  const defRatio = n.budget.net < 0 ? -n.budget.net / out : 0;
  if (defRatio > ECON.INFLATION_THRESHOLD || n.debt / out > 1.0) n.priceIndex += (ECON.INFLATION_RATE * Math.max(0, defRatio - ECON.INFLATION_THRESHOLD) + Math.max(0, n.debt / out - 1) * 0.02) / 12;
  else n.priceIndex = Math.max(1, n.priceIndex - (ECON.DEFLATION_RATE / 12) * (n.priceIndex - 1) - 0.0005);
  // manpower
  const pop = agg.owned.reduce((t, id) => { const q = s.provinces[id]; return t + (q.status === 'core' ? q.pop : q.pop * 0.25) * (focusOf(q) === 'military' ? 2 : 1); }, 0) * gm.manpower;
  const cap = pop * (ECON.MANPOWER_SHARE + (ECON.MOBILIZED_MANPOWER_SHARE - ECON.MANPOWER_SHARE) * n.mobilization);
  n.manpower = Math.min(cap, n.manpower + (pop * ECON.MANPOWER_REGEN) / 12);
  govMonthly(s, n);
  regimeMonthly(s, n);
  if (!n.isPlayer) aiGovernment(s, n);
  if (n.bankrupt) n.stability = Math.max(0, n.stability - 4);
  // stats & history
  n.stats.peakProvinces = Math.max(n.stats.peakProvinces, agg.owned.length);
  n.stats.peakOutput = Math.max(n.stats.peakOutput, agg.output);
  if (n.isPlayer || s.day % 90 < 31) {
    n.history.push({ day: s.day, treasury: Math.round(n.treasury), output: Math.round(agg.output), provinces: agg.owned.length, army: Math.round(agg.personnel) });
    if (n.history.length > 240) n.history.splice(0, n.history.length - 240);
  }
  n.ledgerMonth = { income: 0, expense: 0 };
  n.interestRate = n.debt > 0 ? (n.interestRate * 11 + interestFor(n)) / 12 : ECON.BASE_INTEREST;
}

/** Monthly world market price update from aggregate supply/demand. */
export function updateMarket(s: GameState) {
  for (const r of RES_KINDS) {
    let sup = 0, dem = 0;
    for (const n of Object.values(s.nations)) {
      if (!n.alive) continue;
      const net = n.resourceNet[r];
      if (net > 0) sup += net; else dem += -net;
    }
    const ratio = (dem + 10) / (sup + 10);
    const target = RESOURCE[r].basePrice * Math.max(0.6, Math.min(2.2, Math.sqrt(ratio)));
    const m = s.market[r];
    m.price += (target - m.price) * 0.2;
    m.supply = sup; m.demand = dem;
  }
}

// ---------------------------------------------------------------- construction
export interface BuildCheck { ok: boolean; reason?: string; cost: number; days: number; upkeep: number; effect: string; }
export function buildCost(s: GameState, n: Nation, province: number, kind: ConstructionOrder['kind']): BuildCheck {
  const p = s.provinces[province];
  const pi = n.priceIndex;
  if (kind === 'repair') {
    const out = provinceOutput(s, { ...p, damage: 0 }, n);
    const cost = Math.max(2, p.damage * (REPAIR_COST_PER_DAMAGE * 0.2 + out * 0.4)) * pi;
    return { ok: p.damage > 0.02, reason: p.damage > 0.02 ? undefined : 'No significant damage.', cost, days: Math.round(60 + p.damage * 200), upkeep: 0, effect: `Repair ${Math.round(p.damage * 100)}% war damage` };
  }
  if (kind === 'develop') {
    const cost = (DEVELOP.cost + (p.pop / 1e6) * p.dev * 0.04) * pi * govMods(s, n).construction;
    const capped = p.dev >= p.dev0 * (ECON.DEV_CAP_BASE + ECON.DEV_CAP_PER_INFRA * p.infra) * 0.98;
    return { ok: !capped, reason: capped ? 'Productivity at ceiling for current infrastructure.' : undefined, cost, days: DEVELOP.days, upkeep: 0, effect: `+${DEVELOP.boost * 100}% productivity (+${fmt((p.pop / 1e6) * p.dev * DEVELOP.boost)}/yr output)` };
  }
  if (kind === 'integrate') {
    const out = provinceOutput(s, { ...p, status: 'core', resistance: 0 }, n);
    const cost = Math.max(INTEGRATE.minCost, out * INTEGRATE.costPerOutput) * pi;
    const days = Math.round(INTEGRATE.days / n.techMods.integrationSpeed);
    return { ok: p.status === 'occupied' || p.status === 'autonomous', reason: p.status === 'core' ? 'Already integrated.' : p.status === 'integrating' ? 'Integration in progress.' : undefined, cost, days, upkeep: 0, effect: 'Becomes a core province with full output, taxes and recruitment' };
  }
  const spec = BUILDINGS[kind];
  const lvl = p.buildings[kind];
  const queued = n.construction.filter((c) => c.province === province && c.kind === kind).length;
  let reason: string | undefined;
  if (lvl + queued >= spec.max) reason = `Maximum level (${spec.max}) reached.`;
  if (spec.needsCoast && !isCoastal(province)) reason = 'Requires a coastline.';
  if (kind === 'mine' && PROV[province].resources.steel + PROV[province].resources.oil + PROV[province].resources.rare === 0) reason = 'No extractable resources here.';
  if (kind === 'factory' && lvl + queued >= Math.max(2, Math.round(p.pop / 1.5e6) + 1) && lvl + queued >= 2) reason = reason || `Population too small for more factories (needs ${(((lvl + queued) * 1.5)).toFixed(1)}M).`;
  const cost = spec.cost * (1 + 0.15 * lvl) * pi * govMods(s, n).construction;
  return { ok: !reason, reason, cost, days: spec.days, upkeep: spec.upkeep, effect: spec.desc };
}

export function startConstruction(s: GameState, n: Nation, province: number, kind: ConstructionOrder['kind']): BuildCheck {
  const c = buildCost(s, n, province, kind);
  const p = s.provinces[province];
  if (p.owner !== n.id || p.controller !== n.id) return { ...c, ok: false, reason: 'You must own and control this province.' };
  if (!c.ok) return c;
  if (n.treasury < c.cost) return { ...c, ok: false, reason: 'Insufficient funds.' };
  if (n.bankrupt) return { ...c, ok: false, reason: 'The state is bankrupt.' };
  if ((kind === 'repair' || kind === 'develop' || kind === 'integrate') && n.construction.some((o) => o.province === province && o.kind === kind)) return { ...c, ok: false, reason: 'Already in progress.' };
  n.treasury -= c.cost;
  n.ledgerMonth.expense += c.cost;
  n.construction.push({ id: s.nextId++, province, kind, daysLeft: c.days, totalDays: c.days, cost: c.cost });
  if (kind === 'integrate') p.status = 'integrating';
  return c;
}

export function constructionDaily(s: GameState, n: Nation) {
  if (!n.construction.length || n.bankrupt) return;
  const finished: ConstructionOrder[] = [];
  for (const o of n.construction) {
    const p = s.provinces[o.province];
    if (p.owner !== n.id) { o.daysLeft = -999; continue; } // lost province: order cancelled
    if (p.controller !== n.id) continue; // paused while occupied by enemy
    o.daysLeft -= 1;
    if (o.kind === 'integrate') p.integration = 1 - o.daysLeft / o.totalDays;
    if (o.daysLeft <= 0) finished.push(o);
  }
  n.construction = n.construction.filter((o) => o.daysLeft > 0);
  for (const o of finished) {
    const p = s.provinces[o.province];
    if (p.owner !== n.id) continue;
    if (o.kind === 'repair') p.damage = 0;
    else if (o.kind === 'develop') p.dev *= 1 + DEVELOP.boost;
    else if (o.kind === 'integrate') { p.status = 'core'; p.integration = 1; p.resistance = Math.max(0, p.resistance - 40); }
    else p.buildings[o.kind] += 1;
    p.infra = infraOf(p);
    if (n.isPlayer) addEvent(s, 'construction', `${o.kind === 'repair' ? 'Repairs' : o.kind === 'develop' ? 'Development programme' : o.kind === 'integrate' ? 'Integration' : BUILDINGS[o.kind].label} completed in ${PROV[o.province].name}.`, [n.id], { province: o.province });
  }
}

export function cancelConstruction(s: GameState, n: Nation, id: number) {
  const o = n.construction.find((c) => c.id === id);
  if (!o) return;
  // 50% refund of remaining share
  const refund = o.cost * 0.5 * (o.daysLeft / o.totalDays);
  n.treasury += refund;
  n.construction = n.construction.filter((c) => c.id !== id);
  if (o.kind === 'integrate') { const p = s.provinces[o.province]; p.status = 'occupied'; p.integration = 0; }
}

export function supplyNeedsSummary(s: GameState, n: Nation) {
  let d = 0;
  for (const a of Object.values(s.armies)) if (a.owner === n.id) d += armySupplyDemand(a);
  return d;
}

export { fmtDate, alliesOf, peekRel };
