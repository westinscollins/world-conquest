/**
 * Government: spending levels, national policies, decrees, the sovereign wealth fund, regional
 * focus, espionage, aid / sanctions / guarantees and national decision events.
 * Everything here is deterministic and changed only through player commands (or the AI).
 */
import type { GameState, Government, Nation, PolicyArea, ProvinceFocus } from './types';
import type { GovEffect } from './config';
import { POLICY_AREAS, POLICY_COOLDOWN, POLICY_CHANGE_STABILITY, SERVICES_RANGE, DECREES, FOCUS_CHANGE_COST, SPY, ECON } from './config';
import { PROV } from './geo';
import { addEvent } from './events';
import { hashNoise } from './rng';
import { isAtWar, ownedBy, controlledBy, rel, livingNations, neighborsOf, invalidateDiplo, peekRel } from './world';
import { infraOf } from './economy';
import { invalidateArmies } from './world';
import { regimeEffect } from './regime';

/** Effects other nations inflict (stored like decrees, with an expiry day). */
export const HOSTILE: Record<string, GovEffect> = { cyberHit: { output: 0.97, construction: 1.15 } };

export type { GovEffect };

export function newGov(): Government {
  const policies = {} as Record<PolicyArea, string>;
  for (const k in POLICY_AREAS) policies[k as PolicyArea] = POLICY_AREAS[k as PolicyArea].default;
  return { services: 1, policies, policyChanged: {}, decrees: {}, cooldowns: {}, fund: 0, spies: {}, sanctions: [], guarantees: [], event: null, nextEvent: 150 };
}

// ---------------------------------------------------------------- combined modifiers
export interface Mods { growth: number; stability: number; warSupport: number; output: number; services: number; admin: number; taxEff: number; trade: number; tariff: number; imports: number; manpower: number; morale: number; upkeep: number; recruit: number; research: number; construction: number; ops: number; popGrowth: number }
const MULT: (keyof Mods)[] = ['output', 'services', 'admin', 'taxEff', 'trade', 'imports', 'manpower', 'upkeep', 'recruit', 'research', 'construction', 'ops'];
const NEUTRAL: Mods = { growth: 0, stability: 0, warSupport: 0, output: 1, services: 1, admin: 1, taxEff: 1, trade: 1, tariff: 0, imports: 1, manpower: 1, morale: 0, upkeep: 1, recruit: 1, research: 1, construction: 1, ops: 1, popGrowth: 0 };

let cache = new WeakMap<Government, { day: number; v: number; mods: Mods }>();
let version = 0;
/** Call after any change to a government. */
export function touchGov() { version++; }

/** All policy and decree effects for a nation, combined. */
export function govMods(s: GameState, n: Nation): Mods {
  const g = n.gov;
  if (!g) return NEUTRAL;
  const c = cache.get(g);
  if (c && c.day === s.day && c.v === version) return c.mods;
  const m: Mods = { ...NEUTRAL };
  const apply = (e: GovEffect | undefined) => {
    if (!e) return;
    for (const k in e) {
      const key = k as keyof Mods;
      const v = e[key as keyof GovEffect]!;
      if (MULT.includes(key)) m[key] *= v; else m[key] += v;
    }
  };
  for (const a in g.policies) apply(POLICY_AREAS[a as PolicyArea].options[g.policies[a as PolicyArea]]?.effect);
  for (const d in g.decrees) if (g.decrees[d] > s.day) apply(DECREES[d]?.effect ?? HOSTILE[d]);
  for (const e of regimeEffect(s, n)) apply(e);
  // public-services spending level
  const L = g.services;
  m.services *= L;
  m.stability += (L - 1) * 20;
  m.growth += (L - 1) * 0.006;
  m.popGrowth += (L - 1) * 0.002;
  cache.set(g, { day: s.day, v: version, mods: m });
  return m;
}

// ---------------------------------------------------------------- player-facing changes
export function setServices(s: GameState, n: Nation, level: number): string | null {
  void s;
  const v = Math.round(Math.max(SERVICES_RANGE[0], Math.min(SERVICES_RANGE[1], level)) * 20) / 20;
  n.gov.services = v;
  touchGov();
  return null;
}
export function policyReadyIn(s: GameState, n: Nation, area: PolicyArea) {
  const last = n.gov.policyChanged[area];
  return last == null ? 0 : Math.max(0, last + POLICY_COOLDOWN - s.day);
}
export function setPolicy(s: GameState, n: Nation, area: PolicyArea, option: string): string | null {
  const spec = POLICY_AREAS[area];
  if (!spec || !spec.options[option]) return 'Unknown policy.';
  if (n.gov.policies[area] === option) return 'Already in force.';
  const wait = policyReadyIn(s, n, area);
  if (wait > 0) return `Too soon: this policy area can change again in ${wait} days.`;
  n.gov.policies[area] = option;
  n.gov.policyChanged[area] = s.day;
  n.stability = Math.max(0, n.stability - POLICY_CHANGE_STABILITY);
  touchGov();
  if (n.isPlayer) addEvent(s, 'economy', `${spec.label}: ${spec.options[option].label} adopted.`, [n.id]);
  return null;
}
export function decreeState(s: GameState, n: Nation, id: string): { active: number; cooldown: number; cost: number; blocked?: string } {
  const d = DECREES[id];
  const active = Math.max(0, (n.gov.decrees[id] ?? 0) - s.day);
  const cooldown = Math.max(0, (n.gov.cooldowns[id] ?? 0) - s.day);
  const cost = d.cost * Math.max(1, n.budget.output) * n.priceIndex;
  let blocked: string | undefined;
  if (active) blocked = `In force for ${active} more days.`;
  else if (cooldown) blocked = `Available again in ${cooldown} days.`;
  else if (d.warOnly && !isAtWar(s, n.id)) blocked = 'Only in wartime.';
  else if (cost > 0 && n.treasury < cost) blocked = 'Insufficient funds.';
  return { active, cooldown, cost, blocked };
}
export function issueDecree(s: GameState, n: Nation, id: string): string | null {
  const d = DECREES[id];
  if (!d) return 'Unknown decree.';
  const st = decreeState(s, n, id);
  if (st.blocked) return st.blocked;
  const out = Math.max(1, n.budget.output);
  n.treasury -= st.cost; n.ledgerMonth.expense += st.cost;
  if (d.instant?.treasury) n.treasury += d.instant.treasury * out;
  if (d.instant?.prices) n.priceIndex += d.instant.prices;
  if (d.instant?.stability) n.stability = Math.max(0, Math.min(100, n.stability + d.instant.stability));
  if (d.instant?.debtAt) {
    const amt = d.instant.debtAt * out;
    n.interestRate = (n.interestRate * n.debt + 0.02 * amt) / (n.debt + amt);
    n.debt += amt; n.treasury += amt;
  }
  if (d.days > 0) n.gov.decrees[id] = s.day + d.days;
  n.gov.cooldowns[id] = s.day + d.cooldown;
  touchGov();
  if (n.isPlayer) addEvent(s, 'economy', `Decree: ${d.label}.`, [n.id]);
  return null;
}

// ---------------------------------------------------------------- sovereign wealth fund
export const FUND_RETURN = 0.045, FUND_FEE = 0.02;
export function investFund(s: GameState, n: Nation, amount: number): string | null {
  void s;
  if (amount <= 0) return 'Invalid amount.';
  if (n.treasury < amount) return 'Insufficient treasury.';
  n.treasury -= amount; n.gov.fund += amount;
  return null;
}
export function withdrawFund(s: GameState, n: Nation, amount: number): string | null {
  void s;
  amount = Math.min(amount, n.gov.fund);
  if (amount <= 0) return 'The fund is empty.';
  n.gov.fund -= amount;
  n.treasury += amount * (1 - FUND_FEE);
  return null;
}

// ---------------------------------------------------------------- regional focus
export function setFocus(s: GameState, n: Nation, p: number, focus: ProvinceFocus | null): string | null {
  const st = s.provinces[p];
  if (!st || st.owner !== n.id || st.controller !== n.id) return 'You must own and control the province.';
  if (st.status !== 'core') return 'Only core provinces can be given a focus.';
  if ((st.focus ?? null) === focus) return null;
  const cost = FOCUS_CHANGE_COST * n.priceIndex;
  if (n.treasury < cost) return 'Insufficient funds.';
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  if (focus) st.focus = focus; else delete st.focus;
  return null;
}
/** Focus applies only to core provinces of their owner. */
export const focusOf = (p: { focus?: ProvinceFocus; status: string; owner: string; controller: string }) => (p.status === 'core' && p.owner === p.controller ? p.focus : undefined);

// ---------------------------------------------------------------- diplomacy extras
export function sendAid(s: GameState, n: Nation, to: string, amount: number): string | null {
  const t = s.nations[to];
  if (!t?.alive || to === n.id) return 'Invalid recipient.';
  if (n.treasury < amount) return 'Insufficient treasury.';
  n.treasury -= amount; n.ledgerMonth.expense += amount;
  t.treasury += amount;
  const gain = Math.min(30, (amount / Math.max(5, t.budget.output)) * 120 + 3);
  const r = rel(s, n.id, to);
  r.value = Math.min(100, r.value + gain);
  invalidateDiplo();
  addEvent(s, 'diplomacy', `${n.name} sent ${amount} M IC of aid to ${t.name} (relations +${gain.toFixed(0)}).`, [n.id, to]);
  return null;
}
export function toggleSanction(s: GameState, n: Nation, to: string): string | null {
  const t = s.nations[to];
  if (!t?.alive || to === n.id) return 'Invalid target.';
  const list = n.gov.sanctions;
  if (list.includes(to)) { n.gov.sanctions = list.filter((x) => x !== to); addEvent(s, 'diplomacy', `${n.name} lifted its sanctions on ${t.name}.`, [n.id, to]); return null; }
  list.push(to);
  const r = rel(s, n.id, to);
  r.value = Math.max(-100, r.value - 30);
  r.trade = false;
  invalidateDiplo();
  addEvent(s, 'diplomacy', `${n.name} imposed economic sanctions on ${t.name}.`, [n.id, to], { important: n.isPlayer || t.isPlayer });
  return null;
}
/** Share of trade and export income a nation loses to sanctions against it (0..0.6). */
export function sanctionLoss(s: GameState, id: string): number {
  let loss = 0;
  for (const o of Object.values(s.nations)) if (o.alive && o.gov?.sanctions.includes(id)) loss += Math.min(0.25, 0.05 + o.budget.output / 20000);
  return Math.min(0.6, loss);
}
export function toggleGuarantee(s: GameState, n: Nation, to: string): string | null {
  const t = s.nations[to];
  if (!t?.alive || to === n.id) return 'Invalid nation.';
  if (n.gov.guarantees.includes(to)) { n.gov.guarantees = n.gov.guarantees.filter((x) => x !== to); rel(s, n.id, to).value -= 15; return null; }
  n.gov.guarantees.push(to);
  rel(s, n.id, to).value = Math.min(100, rel(s, n.id, to).value + 15);
  invalidateDiplo();
  addEvent(s, 'diplomacy', `${n.name} guarantees the independence of ${t.name}: an attack on it means war with ${n.name}.`, [n.id, to], { important: true });
  return null;
}

// ---------------------------------------------------------------- espionage
export function buildSpyNetwork(s: GameState, n: Nation, to: string): string | null {
  if (!s.nations[to]?.alive || to === n.id) return 'Invalid target.';
  const cost = SPY.NETWORK_COST * n.priceIndex;
  if (n.treasury < cost) return 'Insufficient funds.';
  const cur = n.gov.spies[to] ?? 0;
  if (cur >= 1) return 'Your network there is already at full strength.';
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  n.gov.spies[to] = Math.min(1, cur + SPY.NETWORK_GAIN);
  return null;
}
export function spyOp(s: GameState, n: Nation, to: string, op: string): { ok: boolean; message: string } {
  const spec = SPY.OPS[op];
  const t = s.nations[to];
  if (!spec || !t?.alive) return { ok: false, message: 'Invalid operation.' };
  const net = n.gov.spies[to] ?? 0;
  if (net < spec.need) return { ok: false, message: `Needs a spy network of ${Math.round(spec.need * 100)}% (you have ${Math.round(net * 100)}%).` };
  const cost = spec.cost * n.priceIndex;
  if (n.treasury < cost) return { ok: false, message: 'Insufficient funds.' };
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  const chance = Math.min(0.9, 0.25 + net * 0.6 - (t.intel - 0.5) * 0.3);
  const roll = hashNoise(s.seed, s.day, to.charCodeAt(0) * 7 + to.charCodeAt(1), op.length * 131 + Math.round(net * 100));
  if (roll > chance) {
    n.gov.spies[to] = Math.max(0, net - 0.4);
    const r = rel(s, n.id, to); r.value = Math.max(-100, r.value - 20);
    invalidateDiplo();
    addEvent(s, 'diplomacy', `${t.name} uncovered a ${n.name} spy ring (${spec.label.toLowerCase()} failed). Relations −20.`, [n.id, to], { important: n.isPlayer || t.isPlayer });
    return { ok: false, message: `The operation failed and your agents were exposed (chance was ${Math.round(chance * 100)}%). Relations −20, network weakened.` };
  }
  n.gov.spies[to] = Math.max(0, net - 0.1);
  let msg = '';
  if (op === 'steal') {
    if (!n.research.current) return { ok: true, message: 'Agents report success, but you have no research project to apply it to. Pick one first next time.' };
    n.research.progress += 0.25 * techCost(n);
    msg = 'Stolen research gives +25% progress on your current technology.';
  } else if (op === 'sabotage') {
    const provs = controlledBy(s, to).filter((p) => s.provinces[p].buildings.factory + s.provinces[p].buildings.power + s.provinces[p].buildings.depot > 0);
    if (!provs.length) return { ok: true, message: 'Your saboteurs found nothing worth destroying.' };
    const p = provs[Math.floor(roll * 997) % provs.length];
    const st = s.provinces[p];
    const k = st.buildings.power > 0 ? 'power' : st.buildings.factory > 0 ? 'factory' : 'depot';
    st.buildings[k]--; st.infra = infraOf(st); st.damage = Math.min(0.9, st.damage + 0.05);
    msg = `Saboteurs destroyed a ${k === 'power' ? 'power plant' : k === 'depot' ? 'supply depot' : 'factory'} in ${PROV[p].name}.`;
    invalidateArmies();
  } else if (op === 'unrest') {
    t.stability = Math.max(0, t.stability - 6);
    for (const p of ownedBy(s, to)) if (s.provinces[p].status !== 'core') s.provinces[p].resistance = Math.min(100, s.provinces[p].resistance + 15);
    msg = `Dissidents funded: ${t.name} stability −6.`;
  } else if (op === 'cyber') {
    t.gov.decrees.cyberHit = s.day + 60;
    touchGov();
    msg = `Cyber attack succeeded: ${t.name}'s power grid and logistics are crippled for 60 days.`;
    addEvent(s, 'war', `${t.name} suffers a massive cyber attack on its infrastructure.`, [to, n.id], { important: t.isPlayer });
  } else if (op === 'coup') {
    t.stability = Math.max(0, t.stability - 20);
    if (t.regime) { t.regime.opposition = Math.min(100, t.regime.opposition + 25); t.regime.legitimacy = Math.max(0, t.regime.legitimacy - 20); }
    for (const a of Object.values(s.armies)) if (a.owner === to) for (const u of a.units) u.org *= 0.6;
    msg = `Coup attempt in ${t.name}: the government survives, badly shaken.`;
    addEvent(s, 'unrest', `Coup attempt in ${t.name}! Rebel officers seized the radio station before loyal troops restored order.`, [to], { important: true });
  } else if (op === 'intel') {
    n.intel = Math.min(0.95, n.intel + 0.04);
    msg = 'Military mapped: your intelligence estimates are more accurate.';
  }
  return { ok: true, message: msg };
}
let techCostFn: (n: Nation) => number = () => 20;
/** research.ts registers the cost of the current tech (avoids an import cycle). */
export function registerTechCost(fn: (n: Nation) => number) { techCostFn = fn; }
const techCost = (n: Nation) => techCostFn(n);

// ---------------------------------------------------------------- monthly upkeep of government state
export function govMonthly(s: GameState, n: Nation) {
  const g = n.gov;
  if (!g) return;
  if (g.fund > 0) {
    // returns vary with the world economy (deterministic noise around 4.5%/yr)
    const r = FUND_RETURN + (hashNoise(s.seed, Math.floor(s.day / 30), 4242) - 0.5) * 0.12;
    g.fund = Math.max(0, g.fund * (1 + r / 12));
  }
  for (const k in g.spies) { g.spies[k] = Math.max(0, g.spies[k] - SPY.DECAY_PER_MONTH); if (g.spies[k] <= 0) delete g.spies[k]; }
  for (const k in g.decrees) if (g.decrees[k] <= s.day) delete g.decrees[k];
  g.sanctions = g.sanctions.filter((x) => s.nations[x]?.alive);
  g.guarantees = g.guarantees.filter((x) => s.nations[x]?.alive);
}

// ---------------------------------------------------------------- national decision events (players)
export interface EventOption { label: string; desc: string; run: (s: GameState, n: Nation, e: NonNullable<Government['event']>) => void }
export interface EventSpec { title: string; text: (s: GameState, n: Nation, e: NonNullable<Government['event']>) => string; when: (s: GameState, n: Nation) => boolean; options: EventOption[]; pick?: (s: GameState, n: Nation, r: number) => { province?: number; other?: string } | null }
const out = (n: Nation) => Math.max(1, n.budget.output);
const pay = (n: Nation, share: number) => { const c = share * out(n); n.treasury -= c; n.ledgerMonth.expense += c; };
const gain = (n: Nation, share: number) => { n.treasury += share * out(n); };
const stab = (n: Nation, d: number) => { n.stability = Math.max(0, Math.min(100, n.stability + d)); };
const fmtShare = (n: Nation, share: number) => `${(share * out(n)).toFixed(1)} M IC`;

export const EVENTS: Record<string, EventSpec> = {
  strike: {
    title: 'General strike', when: () => true,
    text: () => 'Unions have called a general strike over wages. Factories and ports are idle.',
    options: [
      { label: 'Meet their demands', desc: 'Pay 2% of output; +3 stability.', run: (s, n) => { pay(n, 0.02); stab(n, 3); } },
      { label: 'Break the strike', desc: '−7 stability, no cost.', run: (s, n) => stab(n, -7) },
    ],
  },
  breakthrough: {
    title: 'Scientific breakthrough', when: (s, n) => !!n.research.current,
    text: () => 'A university team is close to a breakthrough relevant to our current research and asks for funding.',
    options: [
      { label: 'Fund the team', desc: 'Pay 1.5% of output; +30% research progress.', run: (s, n) => { pay(n, 0.015); n.research.progress += 0.3 * techCost(n); } },
      { label: 'Decline', desc: 'No effect.', run: () => {} },
    ],
  },
  disaster: {
    title: 'Natural disaster', when: () => true,
    pick: (s, n, r) => { const own = ownedBy(s, n.id); return own.length ? { province: own[Math.floor(r * 991) % own.length] } : null; },
    text: (s, n, e) => `Floods and landslides have devastated ${PROV[e.province!].name}.`,
    options: [
      { label: 'National relief effort', desc: 'Pay 2% of output; +4 stability.', run: (s, n) => { pay(n, 0.02); stab(n, 4); } },
      { label: 'Let the region cope', desc: '+20% war damage there, −5 stability.', run: (s, n, e) => { const st = s.provinces[e.province!]; st.damage = Math.min(0.9, st.damage + 0.2); stab(n, -5); } },
    ],
  },
  investors: {
    title: 'Foreign investors', when: (s, n) => n.embargoUntil <= s.day,
    text: () => 'A foreign consortium offers to buy stakes in our national champions.',
    options: [
      { label: 'Accept the deal', desc: '+4% of output in cash; −3 stability (sovereignty concerns).', run: (s, n) => { gain(n, 0.04); stab(n, -3); } },
      { label: 'Refuse', desc: '+2 stability.', run: (s, n) => stab(n, 2) },
    ],
  },
  scandal: {
    title: 'Corruption scandal', when: () => true,
    text: () => 'Journalists expose ministers taking bribes from contractors.',
    options: [
      { label: 'Purge the guilty', desc: '−4 stability; starts a free anti-corruption campaign (+6% taxes for 6 months).', run: (s, n) => { stab(n, -4); n.gov.decrees.anticorruption = Math.max(n.gov.decrees.anticorruption ?? 0, s.day + 180); touchGov(); } },
      { label: 'Cover it up', desc: 'Prices +2% (graft), −1 stability.', run: (s, n) => { n.priceIndex += 0.02; stab(n, -1); } },
    ],
  },
  coup: {
    title: 'Coup rumours', when: (s, n) => n.stability < 40,
    text: () => 'Intelligence reports that senior officers are plotting against the government.',
    options: [
      { label: 'Purge the officer corps', desc: '+8 stability, but every army loses 30% organisation.', run: (s, n) => { stab(n, 8); for (const a of Object.values(s.armies)) if (a.owner === n.id) for (const u of a.units) u.org *= 0.7; } },
      { label: 'Buy their loyalty', desc: 'Pay 3% of output; +5 stability.', run: (s, n) => { pay(n, 0.03); stab(n, 5); } },
    ],
  },
  refugees: {
    title: 'Refugee crisis', when: (s, n) => neighborsOf(s, n.id).some((x) => isAtWar(s, x)),
    pick: (s, n) => { const x = neighborsOf(s, n.id).find((y) => isAtWar(s, y)); return x ? { other: x } : null; },
    text: (s, n, e) => `Tens of thousands flee the fighting in ${s.nations[e.other!]?.name} and gather at our border.`,
    options: [
      { label: 'Open the border', desc: '+manpower (0.3% of population), −3 stability, better relations with them.', run: (s, n, e) => { const pop = ownedBy(s, n.id).reduce((t, p) => t + s.provinces[p].pop, 0); n.manpower += pop * 0.003; stab(n, -3); if (e.other) rel(s, n.id, e.other).value += 10; } },
      { label: 'Close the border', desc: '+1 stability.', run: (s, n) => stab(n, 1) },
    ],
  },
  harvest: {
    title: 'Bumper harvest', when: (s, n) => n.resourceNet.food > 0,
    text: () => 'Farmers report the best harvest in a generation.',
    options: [
      { label: 'Export the surplus', desc: '+2% of output in cash.', run: (s, n) => gain(n, 0.02) },
      { label: 'Feed the people', desc: '+4 stability.', run: (s, n) => stab(n, 4) },
    ],
  },
  oil: {
    title: 'Mineral discovery', when: () => true,
    pick: (s, n, r) => { const own = ownedBy(s, n.id).filter((p) => s.provinces[p].status === 'core'); return own.length ? { province: own[Math.floor(r * 613) % own.length] } : null; },
    text: (s, n, e) => `Geologists have found rich deposits near ${PROV[e.province!].name}.`,
    options: [
      { label: 'Develop a state mine', desc: 'Pay 3% of output; the province gets a free mine level.', run: (s, n, e) => { pay(n, 0.03); const st = s.provinces[e.province!]; if (st.buildings.mine < 3) st.buildings.mine++; } },
      { label: 'Sell the rights', desc: '+3% of output in cash.', run: (s, n) => gain(n, 0.03) },
    ],
  },
  militaryCoup: {
    title: 'Military coup!', when: () => false,
    text: () => 'Tanks surround the presidential palace. Disloyal generals demand that the government resign.',
    options: [
      { label: 'Crush the plotters', desc: 'Loyal units fight it out: every army −40% organisation, officers +20 (the purge), stability −8.', run: (s, n) => { for (const a of Object.values(s.armies)) if (a.owner === n.id) for (const u of a.units) u.org *= 0.6; if (n.regime) n.regime.groups.military = Math.min(100, n.regime.groups.military + 20); stab(n, -8); } },
      { label: 'Negotiate with the generals', desc: 'Raise the military budget: pay 4% of output, officers +25, legitimacy −10.', run: (s, n) => { pay(n, 0.04); if (n.regime) { n.regime.groups.military = Math.min(100, n.regime.groups.military + 25); n.regime.legitimacy = Math.max(0, n.regime.legitimacy - 10); } } },
    ],
  },
  protests: {
    title: 'Mass protests', when: (s, n) => (n.regime?.opposition ?? 0) > 35,
    text: () => 'Hundreds of thousands march on the capital square demanding change.',
    options: [
      { label: 'Send in the riot police', desc: 'Opposition −10, youth −12, workers −6, infamy +2.', run: (s, n) => { if (n.regime) { n.regime.opposition = Math.max(0, n.regime.opposition - 10); n.regime.groups.youth = Math.max(0, n.regime.groups.youth - 12); n.regime.groups.workers = Math.max(0, n.regime.groups.workers - 6); } n.infamy = Math.min(100, n.infamy + 2); } },
      { label: 'Address the crowds', desc: 'Promise reforms: pay 1% of output, opposition −4, legitimacy −4.', run: (s, n) => { pay(n, 0.01); if (n.regime) { n.regime.opposition = Math.max(0, n.regime.opposition - 4); n.regime.legitimacy = Math.max(0, n.regime.legitimacy - 4); } } },
      { label: 'Ignore them', desc: 'Opposition +6.', run: (s, n) => { if (n.regime) n.regime.opposition = Math.min(100, n.regime.opposition + 6); } },
    ],
  },
  dissident: {
    title: 'Famous dissident', when: (s, n) => (n.regime?.opposition ?? 0) > 20,
    text: () => 'A celebrated writer has published a scathing attack on the government. Foreign media love it.',
    options: [
      { label: 'Arrest the writer', desc: 'Opposition −5 now, youth −8, middle class −5, infamy +1.', run: (s, n) => { if (n.regime) { n.regime.opposition = Math.max(0, n.regime.opposition - 5); n.regime.groups.youth = Math.max(0, n.regime.groups.youth - 8); n.regime.groups.middle = Math.max(0, n.regime.groups.middle - 5); } n.infamy = Math.min(100, n.infamy + 1); } },
      { label: 'Let them speak', desc: 'Opposition +3, legitimacy +2 (tolerance looks confident).', run: (s, n) => { if (n.regime) { n.regime.opposition = Math.min(100, n.regime.opposition + 3); n.regime.legitimacy = Math.min(100, n.regime.legitimacy + 2); } } },
    ],
  },
  victoryParade: {
    title: 'Victory parade', when: (s, n) => n.stats.battlesWon > 2 && isAtWar(s, n.id),
    text: () => 'Our armies have won great victories. The ministry proposes a parade through the capital.',
    options: [
      { label: 'Hold the parade', desc: 'Pay 1% of output: legitimacy +6, officers +6, war support +8.', run: (s, n) => { pay(n, 0.01); if (n.regime) { n.regime.legitimacy = Math.min(100, n.regime.legitimacy + 6); n.regime.groups.military = Math.min(100, n.regime.groups.military + 6); } n.warSupport = Math.min(100, n.warSupport + 8); } },
      { label: 'No time for celebrations', desc: 'No effect.', run: () => {} },
    ],
  },
  election: {
    title: 'Election year', when: (s) => Math.floor(s.day / 365) % 4 === 3,
    text: () => 'The governing coalition faces voters. Its advisers want a spending spree.',
    options: [
      { label: 'Campaign promises', desc: 'Pay 3% of output; +8 stability.', run: (s, n) => { pay(n, 0.03); stab(n, 8); } },
      { label: 'Run on the record', desc: '−3 stability, no cost.', run: (s, n) => stab(n, -3) },
    ],
  },
};
const EVENT_IDS = Object.keys(EVENTS);
export const EVENT_DAYS = 30; // time to decide before the first option is taken

/** Daily for human nations: start events, and resolve them if the deadline passes. */
export function eventsDaily(s: GameState, n: Nation) {
  const g = n.gov;
  if (!g || !n.isPlayer || (s.tutorial && !s.tutorial.done)) return;
  if (g.event) {
    if (s.day >= g.event.deadline) resolveEvent(s, n, 0, true);
    return;
  }
  if (s.day < g.nextEvent) return;
  const salt = n.id.charCodeAt(0) * 37 + n.id.charCodeAt(1) * 11 + n.id.charCodeAt(2);
  const r = hashNoise(s.seed, s.day, salt, 77);
  g.nextEvent = s.day + 110 + Math.floor(hashNoise(s.seed, s.day, salt, 78) * 120);
  const choices = EVENT_IDS.filter((k) => EVENTS[k].when(s, n));
  if (!choices.length) return;
  const kind = choices[Math.floor(r * choices.length) % choices.length];
  const extra = EVENTS[kind].pick?.(s, n, hashNoise(s.seed, s.day, salt, 79));
  if (EVENTS[kind].pick && !extra) return;
  g.event = { kind, day: s.day, deadline: s.day + EVENT_DAYS, ...(extra ?? {}) };
  addEvent(s, 'info', `National event: ${EVENTS[kind].title}. A decision is needed within ${EVENT_DAYS} days.`, [n.id], { important: true });
}
export function resolveEvent(s: GameState, n: Nation, option: number, timedOut = false): string | null {
  const e = n.gov.event;
  if (!e) return 'No decision is pending.';
  const spec = EVENTS[e.kind];
  const opt = spec?.options[option];
  if (!opt) return 'Invalid choice.';
  opt.run(s, n, e);
  n.gov.event = null;
  addEvent(s, 'info', `${spec.title}: ${opt.label}${timedOut ? ' (no decision was taken in time)' : ''}.`, [n.id]);
  return null;
}

// ---------------------------------------------------------------- AI use (light touch)
/** AI: trim services when deep in deficit, restore them when comfortable. Monthly. */
export function aiGovernment(s: GameState, n: Nation) {
  const g = n.gov;
  if (!g || n.isPlayer) return;
  const ratio = n.budget.net / out(n);
  if (ratio < -0.04 && g.services > 0.85) { g.services = Math.round((g.services - 0.05) * 20) / 20; touchGov(); }
  else if (ratio > 0.02 && g.services < 1) { g.services = Math.round((g.services + 0.05) * 20) / 20; touchGov(); }
  void ECON; void livingNations; void peekRel;
}
