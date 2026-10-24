/**
 * The regime: how the population feels about its rulers, and what the rulers do about it.
 * Six social groups have an approval rating; together with the ruler's legitimacy they drive
 * stability and the growth of an opposition movement, which escalates from dissent through
 * protests and strikes to insurgency and revolution. Propaganda, police, concessions and
 * repression push back — each with its own price.
 */
import type { GameState, GroupId, Nation, Regime } from './types';
import { GROUPS, PROPAGANDA, PROPAGANDA_MEDIA, PROPAGANDA_SATURATION, SECURITY, INTERIOR, STAGES, REVOLT_AT, WAR_ECONOMY, ROE, AIR_MISSIONS, SAM_COST, SAM_MAX, ECON, POLICY_AREAS, UNITS, type GovEffect } from './config';
import { PROV, distKm } from './geo';
import { wingsOf, setMission, checkMission } from './air';
import { addEvent } from './events';
import { isAtWar, ownedBy, armiesIn, enemiesOf, atWar, controlledBy } from './world';
import { scoreFor } from './diplomacy';
import { hashNoise } from './rng';
import { touchGov } from './policy';

export const GROUP_IDS = Object.keys(GROUPS) as GroupId[];

export function newRegime(): Regime {
  const groups = {} as Record<GroupId, number>;
  for (const g of GROUP_IDS) groups[g] = 55;
  return { groups, legitimacy: 55, opposition: 5, oppositionPeak: 0, security: 0, propaganda: [], cooldowns: {}, banUntil: 0, rigged: 0, warEconomy: 'peace', roe: 'standard', air: { mission: 'none', target: null }, sam: 0, recon: {}, last: { won: 0, lost: 0, provinces: 0 } };
}

export function avgApproval(n: Nation): number {
  const r = n.regime;
  if (!r) return 55;
  let t = 0;
  for (const g of GROUP_IDS) t += r.groups[g] * GROUPS[g].weight;
  return t;
}
export function stageOf(opp: number) {
  let i = 0;
  for (let k = 0; k < STAGES.length; k++) if (opp >= STAGES[k].at) i = k;
  return { index: i, ...STAGES[i] };
}
/** Regime type from how the state is run. */
export function regimeType(n: Nation): { label: string; score: number } {
  const r = n.regime;
  const press = n.gov?.policies.press === 'state' ? 2 : n.gov?.policies.press === 'regulated' ? 1 : 0;
  const score = press + (r?.security ?? 0) + (r && r.banUntil > 0 ? 1 : 0) + Math.min(2, r?.rigged ?? 0) + ((r?.propaganda.includes('cult')) ? 1 : 0);
  const label = score <= 0 ? 'Liberal democracy' : score <= 2 ? 'Democracy' : score <= 3 ? 'Hybrid regime' : score <= 5 ? 'Authoritarian state' : score <= 7 ? 'Dictatorship' : 'Totalitarian state';
  return { label, score };
}

/** Propaganda effectiveness for this nation (media policy and saturation). */
export function propagandaPower(n: Nation) {
  const media = PROPAGANDA_MEDIA[n.gov?.policies.press ?? 'regulated'] ?? 1;
  const k = n.regime?.propaganda.length ?? 0;
  return media * (k > PROPAGANDA_SATURATION ? Math.pow(0.8, k - PROPAGANDA_SATURATION) : 1);
}

/** Effects of the regime on the economy (folded into govMods). */
export function regimeEffect(s: GameState, n: Nation): GovEffect[] {
  const r = n.regime;
  if (!r) return [];
  const out: GovEffect[] = [WAR_ECONOMY[r.warEconomy].effect];
  const st = stageOf(r.opposition).index;
  if (st >= 2) out.push({ output: st >= 3 ? 0.96 : 0.99, taxEff: st >= 3 ? 0.95 : 1 });
  // stability from the people and the ruler
  out.push({ stability: (avgApproval(n) - 55) * 0.4 + (r.legitimacy - 50) * 0.12 });
  if (r.propaganda.includes('gates') || r.propaganda.includes('army')) {
    let ws = 0;
    for (const c of r.propaganda) ws += PROPAGANDA[c]?.warSupport ?? 0;
    out.push({ warSupport: ws * propagandaPower(n) * 0.5 });
  }
  void s;
  return out;
}

/** Monthly cost lines: internal security and the propaganda ministry (M IC per year). */
export function regimeCosts(n: Nation, output: number): { security: number; propaganda: number } {
  const r = n.regime;
  if (!r) return { security: 0, propaganda: 0 };
  let p = 0;
  for (const c of r.propaganda) p += PROPAGANDA[c]?.cost ?? 0;
  return { security: (SECURITY[r.security]?.cost ?? 0) * output * n.priceIndex, propaganda: p * output * n.priceIndex };
}

/** What each group would settle at, given current conditions (with the reasons). */
export function groupTargets(s: GameState, n: Nation): Record<GroupId, { value: number; why: string[] }> {
  const r = n.regime;
  const res = {} as Record<GroupId, { value: number; why: string[] }>;
  const add = (g: GroupId, v: number, why: string) => { if (Math.abs(v) < 0.5) return; res[g].value += v; res[g].why.push(`${why} ${v > 0 ? '+' : ''}${v.toFixed(0)}`); };
  for (const g of GROUP_IDS) res[g] = { value: 55, why: [] };
  const tax = (ECON.BASE_TAX - n.taxRate) * 100;
  add('workers', tax * 0.8, 'Taxes'); add('middle', tax * 1.0, 'Taxes'); add('business', tax * 1.3, 'Taxes');
  const L = n.gov?.services ?? 1;
  add('workers', (L - 1) * 30, 'Public services'); add('middle', (L - 1) * 18, 'Public services'); add('youth', (L - 1) * 12, 'Public services'); add('business', -(L - 1) * 6, 'Public services');
  const pol = (n.gov?.policies ?? {}) as Record<string, string>;
  const P: Record<string, Partial<Record<GroupId, number>>> = {
    'economy:market': { business: 12, workers: -8, middle: 3 }, 'economy:planned': { workers: 6, business: -12, military: 3 },
    'trade:free': { business: 6, workers: -3 }, 'trade:protectionist': { workers: 4, business: -4 },
    'labour:long': { workers: -15, business: 10 }, 'labour:welfare': { workers: 12, middle: 5, business: -6 },
    'conscription:volunteer': { military: 5, youth: 6 }, 'conscription:universal': { youth: -12, military: 8, workers: -3 },
    'press:free': { youth: 10, middle: 6, military: -3, clergy: -3 }, 'press:state': { youth: -10, middle: -5, clergy: 3 },
  };
  for (const a in pol) { const e = P[`${a}:${pol[a]}`]; if (e) for (const g in e) add(g as GroupId, e[g as GroupId]!, POLICY_AREAS[a as keyof typeof POLICY_AREAS]?.options[pol[a]]?.label ?? a); }
  if (r) {
    const sec = r.security;
    if (sec) { add('youth', -6 * sec, 'Police'); add('middle', -4 * sec, 'Police'); add('workers', -2 * sec, 'Police'); add('clergy', 1.5 * sec, 'Order'); }
    const pw = propagandaPower(n);
    for (const c of r.propaganda) { const spec = PROPAGANDA[c]; if (!spec) continue; for (const g in spec.groups) add(g as GroupId, spec.groups[g as GroupId]! * pw, spec.label); }
    add('workers', (r.legitimacy - 50) * 0.12, 'Legitimacy'); add('middle', (r.legitimacy - 50) * 0.12, 'Legitimacy'); add('clergy', (r.legitimacy - 50) * 0.15, 'Legitimacy');
    if (r.warEconomy === 'total') { add('workers', -10, 'Total war economy'); add('military', 6, 'Total war economy'); add('business', 4, 'War contracts'); }
    if (r.warEconomy === 'partial') { add('workers', -4, 'Partial mobilisation'); add('military', 3, 'Partial mobilisation'); }
    if (r.roe === 'ruthless') { add('youth', -6, 'Ruthless warfare'); add('middle', -3, 'Ruthless warfare'); add('military', 3, 'Ruthless warfare'); }
    if (r.roe === 'restrained') { add('youth', 3, 'Restrained warfare'); add('middle', 2, 'Restrained warfare'); add('military', -2, 'Restrained warfare'); }
    if (r.rigged) { add('youth', -4 * Math.min(3, r.rigged), 'Rigged elections'); add('middle', -3 * Math.min(3, r.rigged), 'Rigged elections'); }
  }
  // war
  const wars = s.wars.filter((w) => w.attackers.includes(n.id) || w.defenders.includes(n.id));
  if (wars.length) {
    const sc = wars.reduce((t, w) => t + scoreFor(w, n.id), 0) / wars.length;
    add('military', sc > 5 ? 6 : sc < -5 ? -8 : 0, sc > 0 ? 'Winning the war' : 'Losing the war');
    add('workers', -n.warExhaustion * 0.2, 'War weariness'); add('youth', -n.warExhaustion * 0.25, 'War weariness'); add('middle', -n.warExhaustion * 0.15, 'War weariness');
  }
  // economy
  const infl = Math.max(0, n.priceIndex - 1);
  add('middle', -infl * 70, 'Inflation'); add('workers', -infl * 45, 'Inflation'); add('business', -infl * 30, 'Inflation');
  add('workers', -(n.shortages?.food ?? 0) * 35, 'Food shortages');
  if (n.budget.output > 0) {
    const mil = (n.budget.expenses.find((l) => l.key === 'military')?.amount ?? 0) / n.budget.output;
    add('military', Math.max(-15, Math.min(15, (mil - 0.06) * 250)), 'Military budget');
  }
  if (n.embargoUntil > s.day) { add('business', -20, 'World embargo'); add('middle', -10, 'World embargo'); }
  for (const g of GROUP_IDS) res[g].value = Math.max(0, Math.min(100, res[g].value));
  return res;
}

// ---------------------------------------------------------------- monthly dynamics
export function regimeMonthly(s: GameState, n: Nation) {
  const r = n.regime;
  if (!r) return;
  const targets = groupTargets(s, n);
  for (const g of GROUP_IDS) r.groups[g] += (targets[g].value - r.groups[g]) * 0.15;
  const pw = propagandaPower(n);
  // legitimacy: propaganda, victories, territory, money
  let dl = -(r.legitimacy - 50) * 0.03;
  if (r.propaganda.includes('cult')) dl += (PROPAGANDA.cult.legitimacy ?? 0) * pw;
  const won = n.stats.battlesWon - r.last.won, lost = n.stats.battlesLost - r.last.lost;
  dl += Math.max(-6, Math.min(6, won * 0.6 - lost * 0.8));
  const provs = ownedBy(s, n.id).length;
  if (r.last.provinces) dl += Math.max(-9, Math.min(4, (provs - r.last.provinces) * (provs < r.last.provinces ? 3 : 1)));
  if (n.budget.net < -0.05 * Math.max(1, n.budget.output)) dl -= 1.5;
  if (n.bankrupt) dl -= 5;
  r.legitimacy = Math.max(0, Math.min(100, r.legitimacy + dl));
  r.last = { won: n.stats.battlesWon, lost: n.stats.battlesLost, provinces: provs };
  // opposition
  const appr = avgApproval(n);
  let grow = (52 - appr) * 0.09 + (50 - r.legitimacy) * 0.04 + n.warExhaustion * 0.025 + (n.gov?.policies.press === 'free' ? 0.25 : 0);
  if (r.banUntil > s.day) grow = grow > 0 ? grow * 1.5 : grow * 0.5;
  grow -= SECURITY[r.security]?.opposition ?? 0;
  for (const c of r.propaganda) grow += (PROPAGANDA[c]?.opposition ?? 0) * pw;
  if (appr > 62) grow -= 0.6;
  r.opposition = Math.max(0, Math.min(100, r.opposition + grow));
  // revolution
  if (r.opposition >= 90) r.oppositionPeak++; else r.oppositionPeak = 0;
  if (r.oppositionPeak >= 2) governmentFalls(s, n);
  // emigration when people despair
  if (appr < 35) for (const p of ownedBy(s, n.id)) s.provinces[p].pop *= 1 - 0.002 / 12 * (35 - appr);
  // war conduct
  if (isAtWar(s, n.id)) {
    if (r.roe === 'ruthless') n.infamy = Math.min(100, n.infamy + 0.4);
    if (r.roe === 'restrained') n.infamy = Math.max(0, n.infamy - 0.3);
  }
  for (const p in r.recon) if (r.recon[p] <= s.day) delete r.recon[p];
  // coup risk: a disloyal officer corps
  if (r.groups.military < 25 && r.legitimacy < 45 && hashNoise(s.seed, s.day, n.id.charCodeAt(0), 311) < 0.25) {
    if (n.isPlayer && n.gov && !n.gov.event) n.gov.event = { kind: 'militaryCoup', day: s.day, deadline: s.day + 20 };
    else if (!n.isPlayer) { n.stability = Math.max(0, n.stability - 15); r.groups.military = 50; r.legitimacy = 35; }
  }
  if (!n.isPlayer) aiRegime(s, n);
}

/** The opposition takes power: a new government with a clean slate and a weakened state. */
function governmentFalls(s: GameState, n: Nation) {
  const r = n.regime;
  r.opposition = 30; r.oppositionPeak = 0; r.legitimacy = 35; r.security = 0; r.propaganda = []; r.banUntil = 0;
  for (const g of GROUP_IDS) r.groups[g] = 50;
  n.stability = Math.min(n.stability, 25);
  n.treasury -= Math.max(0, n.treasury) * 0.2;
  if (n.gov) { n.gov.decrees = {}; touchGov(); }
  addEvent(s, 'unrest', `REVOLUTION in ${n.name}! Crowds storm the government buildings; a new government takes over. Treasury looted, police and propaganda dismantled.`, [n.id], { important: true, province: n.capital });
}

/** Province unrest in core provinces (stored in `resistance`). Called monthly from territory. */
export function coreUnrestTarget(s: GameState, p: number): number {
  const st = s.provinces[p];
  const n = s.nations[st.owner];
  const r = n?.regime;
  if (!r) return 0;
  const garrison = armiesIn(s, p).filter((a) => a.owner === st.owner).reduce((t, a) => t + a.units.length, 0);
  let t = Math.max(0, r.opposition - 20) * 1.3 + st.damage * 30 + (n.shortages?.food ?? 0) * 25 + (PROV[p].capital ? 5 : 0);
  t -= garrison * 3 + (SECURITY[r.security]?.unrest ?? 0) + (st.martialLaw ? 40 : 0);
  return Math.max(0, Math.min(100, t));
}
/** Monthly: provinces in open revolt fight their garrisons and wreck the economy. */
export function revoltsMonthly(s: GameState) {
  for (const st of s.provinces) {
    if (st.status !== 'core' || st.controller !== st.owner || st.resistance < REVOLT_AT) continue;
    const n = s.nations[st.owner];
    st.damage = Math.min(0.9, st.damage + 0.03);
    for (const a of armiesIn(s, st.id)) if (a.owner === st.owner) for (const u of a.units) { u.strength *= 0.97; u.org *= 0.9; }
    if (n?.isPlayer && s.day % 90 < 31) addEvent(s, 'unrest', `${PROV[st.id].name} is in open revolt (unrest ${Math.round(st.resistance)}). Garrison troops, martial law or police can restore order.`, [n.id], { province: st.id, important: true });
  }
}

// ---------------------------------------------------------------- player actions
export function setSecurity(s: GameState, n: Nation, level: number): string | null {
  if (level < 0 || level >= SECURITY.length) return 'Invalid level.';
  n.regime.security = level;
  touchGov();
  if (n.isPlayer) addEvent(s, 'unrest', `Internal security: ${SECURITY[level].label}.`, [n.id]);
  return null;
}
export function toggleCampaign(s: GameState, n: Nation, id: string): string | null {
  const spec = PROPAGANDA[id];
  if (!spec) return 'Unknown campaign.';
  const r = n.regime;
  if (r.propaganda.includes(id)) { r.propaganda = r.propaganda.filter((x) => x !== id); touchGov(); return null; }
  if (spec.warOnly && !isAtWar(s, n.id)) return 'This campaign needs a war.';
  r.propaganda.push(id);
  touchGov();
  return null;
}
export function interiorState(s: GameState, n: Nation, id: string): { cooldown: number; cost: number; blocked?: string } {
  const spec = INTERIOR[id];
  const cooldown = Math.max(0, (n.regime.cooldowns[id] ?? 0) - s.day);
  const cost = spec.cost * Math.max(1, n.budget.output) * n.priceIndex;
  let blocked: string | undefined;
  if (cooldown) blocked = `Available again in ${cooldown} days.`;
  else if (spec.needSecurity && n.regime.security < spec.needSecurity) blocked = `Needs ${SECURITY[spec.needSecurity].label.toLowerCase()} or stronger.`;
  else if (spec.needMedia && n.gov?.policies.press !== spec.needMedia) blocked = 'Needs state media (Economy → Government → Media).';
  else if (cost > 0 && n.treasury < cost) blocked = 'Insufficient funds.';
  return { cooldown, cost, blocked };
}
export function interiorAction(s: GameState, n: Nation, id: string): string | null {
  const spec = INTERIOR[id];
  if (!spec) return 'Unknown action.';
  const st = interiorState(s, n, id);
  if (st.blocked) return st.blocked;
  const r = n.regime;
  n.treasury -= st.cost; n.ledgerMonth.expense += st.cost;
  r.cooldowns[id] = s.day + spec.cooldown;
  const G = r.groups;
  const bump = (g: GroupId, v: number) => { G[g] = Math.max(0, Math.min(100, G[g] + v)); };
  const opp = (v: number) => { r.opposition = Math.max(0, Math.min(100, r.opposition + v)); };
  let msg = spec.label;
  switch (id) {
    case 'crackdown':
      opp(-15); bump('workers', -10); bump('youth', -10); n.infamy = Math.min(100, n.infamy + 2);
      for (const p of ownedBy(s, n.id)) { const q = s.provinces[p]; if (q.status === 'core' && q.resistance >= REVOLT_AT - 20) q.resistance = Math.max(0, q.resistance - 25); }
      break;
    case 'arrests': opp(-25); bump('middle', -15); bump('youth', -15); break;
    case 'concessions': opp(-10); bump('workers', 8); bump('middle', 5); r.legitimacy = Math.max(0, r.legitimacy - 3); break;
    case 'amnesty': opp(3); bump('youth', 10); bump('middle', 6); r.legitimacy = Math.min(100, r.legitimacy + 2); break;
    case 'ban': opp(-30); r.banUntil = s.day + 730; r.legitimacy = Math.max(0, r.legitimacy - 5); break;
    case 'referendum': {
      const rigged = n.gov?.policies.press === 'state' ? 8 : 0;
      const win = avgApproval(n) + rigged > 55 || r.legitimacy > 60;
      if (win) { r.legitimacy = Math.min(100, r.legitimacy + 20); msg = 'Referendum won: the people endorse the government (legitimacy +20).'; }
      else { r.legitimacy = Math.max(0, r.legitimacy - 15); opp(10); msg = 'Referendum LOST: a humiliating defeat (legitimacy −15, opposition +10).'; }
      break;
    }
    case 'rig': r.legitimacy = Math.min(100, r.legitimacy + 10); bump('youth', -10); bump('middle', -8); n.infamy = Math.min(100, n.infamy + 3); r.rigged++; break;
    case 'purge':
      bump('military', -20);
      for (const a of Object.values(s.armies)) if (a.owner === n.id) for (const u of a.units) u.org *= 0.7;
      r.legitimacy = Math.min(100, r.legitimacy + 3);
      break;
    case 'draft': {
      const pop = ownedBy(s, n.id).reduce((t, p) => t + (s.provinces[p].status === 'core' ? s.provinces[p].pop : 0), 0);
      n.manpower += pop * 0.01; bump('workers', -8); bump('youth', -12); n.stability = Math.max(0, n.stability - 4);
      break;
    }
    case 'subsidies': bump('workers', 12); opp(-5); break;
  }
  touchGov();
  if (n.isPlayer) addEvent(s, 'unrest', msg.endsWith('.') ? msg : `${msg}.`, [n.id]);
  return msg === spec.label ? null : `#${msg}`;
}
export function toggleMartialLaw(s: GameState, n: Nation, p: number): string | null {
  const st = s.provinces[p];
  if (!st || st.owner !== n.id || st.controller !== n.id) return 'You must own and control the province.';
  if (st.martialLaw) delete st.martialLaw; else st.martialLaw = true;
  return null;
}
export function setWarEconomy(s: GameState, n: Nation, level: 'peace' | 'partial' | 'total'): string | null {
  if (!WAR_ECONOMY[level]) return 'Invalid.';
  n.regime.warEconomy = level; touchGov();
  if (n.isPlayer) addEvent(s, 'economy', `Economy: ${WAR_ECONOMY[level].label}.`, [n.id]);
  return null;
}
export function setRoe(s: GameState, n: Nation, roe: 'restrained' | 'standard' | 'ruthless'): string | null {
  void s;
  if (!ROE[roe]) return 'Invalid.';
  n.regime.roe = roe; touchGov();
  return null;
}
/** War Room shortcut: every air wing gets the same kind of mission. */
export function setAirMission(s: GameState, n: Nation, mission: 'none' | 'cas' | 'bombing' | 'defense', target: string | null): string | null {
  if (!AIR_MISSIONS[mission]) return 'Invalid mission.';
  if (mission === 'bombing' && (!target || !atWar(s, n.id, target))) return 'Choose an enemy you are at war with to bomb.';
  const wings = wingsOf(s, n.id);
  if (!wings.length) return 'You have no air wings. Build fighter or bomber squadrons first.';
  // bombing: each bomber wing takes the nearest province of that enemy with something worth bombing
  // (planned first, so a refusal changes nothing)
  const raids = new Map<number, number>();
  if (mission === 'bombing') {
    const goals = controlledBy(s, target!).filter((p) => { const b = s.provinces[p].buildings; return b.factory + b.power + b.railway + b.depot > 0 || armiesIn(s, p).some((a) => a.owner === target); });
    for (const w of wings) {
      if (!w.units.some((u) => u.type === 'bomber')) continue;
      const best = goals.filter((p) => !checkMission(s, w, 'bombing', p)).sort((a, b) => distKm(w.base, a) - distKm(w.base, b))[0];
      if (best != null) raids.set(w.id, best);
    }
    if (!raids.size) return 'None of your bomber wings can reach that enemy. Rebase them closer.';
  }
  n.regime.air = { mission, target: mission === 'bombing' ? target : null };
  for (const w of wings) {
    const p = raids.get(w.id);
    if (p != null && !setMission(s, w, 'bombing', p)) continue;
    setMission(s, w, mission === 'none' ? 'idle' : mission === 'defense' ? 'defense' : 'support');
  }
  return null;
}
export function buySam(s: GameState, n: Nation): string | null {
  void s;
  if (n.regime.sam >= SAM_MAX) return `At most ${SAM_MAX} batteries.`;
  const cost = SAM_COST * n.priceIndex;
  if (n.treasury < cost) return 'Insufficient funds.';
  n.treasury -= cost; n.ledgerMonth.expense += cost;
  n.regime.sam++;
  return null;
}
/** Squadrons the nation fields (by strength). */
export function airWings(s: GameState, id: string) {
  let w = 0;
  for (const x of wingsOf(s, id)) for (const u of x.units) w += u.strength / UNITS[u.type].personnel;
  return w;
}

/** AI: keep the population in check without overspending. Monthly. */
function aiRegime(s: GameState, n: Nation) {
  const r = n.regime;
  const atWarNow = enemiesOf(s, n.id).length > 0;
  if (r.opposition > 55 && r.security < 2) { r.security++; touchGov(); }
  else if (r.opposition < 15 && r.security > 0) { r.security--; touchGov(); }
  const want = r.opposition > 35 ? ['pride'] : [];
  if (atWarNow && n.personality === 'expansionist') want.push('army');
  if (want.join() !== r.propaganda.join()) { r.propaganda = want; touchGov(); }
  if (r.opposition > 70 && (r.cooldowns.crackdown ?? 0) <= s.day) interiorAction(s, n, 'crackdown');
  if (atWarNow && r.warEconomy === 'peace' && n.personality === 'expansionist') { r.warEconomy = 'partial'; touchGov(); }
  if (!atWarNow && r.warEconomy !== 'peace') { r.warEconomy = 'peace'; touchGov(); }
}
