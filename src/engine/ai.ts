/**
 * Nation AI. Each AI nation runs a weekly strategic pass (staggered by nation so the world stays
 * responsive) and a lighter operational pass for armies at war every few days.
 * The AI reasons with *perceived* power (imperfect intel), weighs alliances and war exhaustion,
 * and must pay for everything through the same economy as the player.
 */
import type { Army, BuildingKind, GameState, Nation, UnitType, War, PeaceTerms } from './types';
import { BUILDINGS, ECON, PERSONALITY, UNITS, MIL } from './config';
import { PROV, COUNTRY_GEO, landLinks } from './geo';
import { ownedBy, controlledBy, neighborsOf, atWar, enemiesOf, armiesIn, isAtWar, rel, peekRel, alliesOf, isFriendly } from './world';
import { buildCost, startConstruction, provinceOutput, borrow, repay } from './economy';
import { recruit, findPath, armyStrength, armyOrg, unitUpkeep, armyPower, deleteArmy, recruitCost } from './military';
import { canResearch, TECHS } from './research';
import { estimateBattle } from './battle';
import { perceivedPower, coalitionPower, declareWar, checkDeclareWar, evaluatePeace, makePeace, scoreFor, termsCost, aiWouldAccept, applyTreaty, provinceValue, ultimatum, joinWar, changeRelation } from './diplomacy';
import { supplyReport } from './supply';
import { addEvent } from './events';
import { nationIndex } from './sim';

// ---------------------------------------------------------------- weekly strategic pass
export function aiWeekly(s: GameState, n: Nation) {
  aiEconomy(s, n);
  aiMilitaryBuild(s, n);
  if (!isAtWar(s, n.id) && Math.floor(s.day / 7) % 4 === (nationIndex(n.id) + 2) % 4) aiPeacetimeDeployment(s, n);
  if (Math.floor(s.day / 7) % 4 === nationIndex(n.id) % 4) aiDiplomacy(s, n); // monthly-ish
  aiPeace(s, n);
}

// ---------------------------------------------------------------- economy
function aiEconomy(s: GameState, n: Nation) {
  const out = Math.max(1, n.budget.output);
  const pers = PERSONALITY[n.personality];
  const war = isAtWar(s, n.id);
  // taxes
  const targetTax = pers.tax + (war ? 0.04 : 0) + (n.budget.net < 0 ? 0.03 : 0) - (n.stability < 45 ? 0.03 : 0);
  n.taxRate += Math.sign(targetTax - n.taxRate) * Math.min(0.01, Math.abs(targetTax - n.taxRate));
  n.taxRate = Math.max(ECON.MIN_TAX, Math.min(ECON.MAX_TAX - 0.05, n.taxRate));
  // debt management
  if (n.debt > 0 && n.treasury > out * 0.5 && n.budget.net > 0) repay(s, n, Math.min(n.debt, n.treasury - out * 0.35));
  if (war && n.treasury < out * 0.05 && n.debt < out * 0.6) borrow(s, n, Math.max(5, out * 0.1));
  // fiscal emergency: austerity before anything else
  if (n.bankrupt || n.debt > out * 0.8 || (n.treasury < 0 && n.budget.net < 0)) {
    n.taxRate = Math.min(ECON.MAX_TAX - 0.08, n.taxRate + 0.02);
    if (!war) {
      const armies = Object.values(s.armies).filter((a) => a.owner === n.id && !a.battleId);
      let cut = Math.ceil(armies.reduce((t, a) => t + a.units.length, 0) * 0.08);
      for (const a of armies) while (cut > 0 && a.units.length > 1) { const u = a.units.pop()!; n.manpower += u.strength * 0.8; cut--; }
    }
    n.researchFunding = Math.round(out * 0.003 * 10) / 10;
    return;
  }
  // research
  if (!n.research.current) {
    const avail = TECHS.filter((t) => canResearch(n, t.id)).sort((a, b) => a.cost - b.cost);
    const pref = n.personality === 'industrial' ? avail.find((t) => t.branch === 'Civilian Industry' || t.branch === 'Administration') : n.personality === 'expansionist' ? avail.find((t) => t.branch === 'Military Production' || t.branch === 'Logistics') : undefined;
    const t = pref ?? avail[0];
    if (t) { n.research.current = t.id; n.research.progress = 0; }
  }
  n.researchFunding = Math.round(out * (n.personality === 'industrial' ? 0.012 : 0.007) * 10) / 10;
  // mobilisation
  const threatened = enemiesOf(s, n.id).length > 0 || neighborsOf(s, n.id).some((nb) => isAtWar(s, nb) && perceivedPower(s, n.id, nb) > perceivedPower(s, n.id, n.id) * 1.5);
  n.mobilize = threatened && n.treasury > -out * 0.3;
  // construction
  if (n.bankrupt) return;
  const reserve = out * (war ? 0.12 : 0.3);
  let budget = n.treasury - reserve;
  if (budget <= 0 || n.construction.length >= 3 + Math.floor(out / 800)) return;
  const owned = ownedBy(s, n.id).filter((p) => s.provinces[p].controller === n.id);
  const choices: { p: number; kind: BuildingKind | 'repair' | 'integrate' | 'develop'; score: number }[] = [];
  const borderSet = new Set<number>();
  for (const p of owned) for (const nb of PROV[p].neighbors) if (s.provinces[nb].owner !== n.id) borderSet.add(p);
  for (const p of owned) {
    const st = s.provinces[p];
    const o = provinceOutput(s, st, n);
    if (st.damage > 0.15) choices.push({ p, kind: 'repair', score: 5 + st.damage * 10 });
    if (st.status === 'occupied') choices.push({ p, kind: 'integrate', score: 6 + o / 20 });
    choices.push({ p, kind: 'factory', score: (1 + o / 60) * pers.build * (n.personality === 'industrial' ? 1.5 : 1) - st.buildings.factory * 0.6 });
    if (n.resourceNet.food < 0) choices.push({ p, kind: 'farm', score: 3 + PROV[p].resources.food });
    if ((n.resourceNet.steel < 0 && PROV[p].resources.steel) || (n.resourceNet.oil < 0 && PROV[p].resources.oil)) choices.push({ p, kind: 'mine', score: 4 });
    if (st.infra < 3) choices.push({ p, kind: 'road', score: 2 + (borderSet.has(p) ? 1 : 0) });
    if (borderSet.has(p) && (n.personality === 'defensive' || n.personality === 'isolationist' || war)) choices.push({ p, kind: 'fort', score: 2.5 - st.buildings.fort * 0.5 });
    if (o > 80 && st.buildings.railway < 2) choices.push({ p, kind: 'railway', score: 2 + o / 200 });
    if (o > 150 && st.buildings.power < 2) choices.push({ p, kind: 'power', score: 2 + o / 150 });
    choices.push({ p, kind: 'develop', score: 0.8 + o / 200 });
  }
  choices.sort((a, b) => b.score - a.score);
  let started = 0;
  for (const c of choices) {
    if (started >= 2) break;
    const chk = buildCost(s, n, c.p, c.kind);
    if (!chk.ok || chk.cost > budget) continue;
    const r = startConstruction(s, n, c.p, c.kind);
    if (r.ok) { budget -= r.cost; started++; }
  }
}

// ---------------------------------------------------------------- recruitment
function aiMilitaryBuild(s: GameState, n: Nation) {
  const out = Math.max(1, n.budget.output);
  const pers = PERSONALITY[n.personality];
  const war = isAtWar(s, n.id);
  const mil = n.budget.expenses.find((l) => l.key === 'military')?.amount ?? 0;
  // threat-driven target force (as share of output)
  const myP = perceivedPower(s, n.id, n.id) + 1;
  let maxThreat = 0;
  for (const nb of neighborsOf(s, n.id)) {
    if (isFriendly(s, n.id, nb)) continue;
    const t = perceivedPower(s, n.id, nb) * (atWar(s, n.id, nb) ? 1.5 : (rel(s, n.id, nb).value < -30 ? 0.8 : 0.4));
    maxThreat = Math.max(maxThreat, t);
  }
  let share = 0.05 * pers.military * (war ? 1.7 : 1) * (0.8 + Math.min(1.2, (maxThreat / myP) * 0.5));
  if (n.budget.net < -out * 0.04 && !war) share *= 0.8;
  const target = out * share;
  if (mil < target * 0.92 && n.treasury > out * 0.08 && !n.bankrupt) {
    const mix: UnitType[] = COUNTRY_GEO[n.id].income.startsWith('1')
      ? ['infantry', 'mechanized', 'artillery', 'armored', 'infantry', 'recon', 'air', 'engineers']
      : ['infantry', 'infantry', 'artillery', 'infantry', 'recon', 'mechanized', 'infantry', 'engineers'];
    let budget = Math.min(n.treasury - out * 0.05, target - mil + 5);
    let k = 0;
    const where = recruitLocation(s, n);
    if (where == null) return;
    while (budget > 0 && k < 6) {
      const t = mix[(n.training.length + k + Math.floor(s.day / 7)) % mix.length];
      if (n.manpower < UNITS[t].personnel) break;
      const up = unitUpkeep(t, n);
      if (recruitCost(t, n) > n.treasury - out * 0.03) break;
      const r = recruit(s, n, t, where);
      if (!r.ok) break;
      budget -= up + r.cost * 0.2;
      k++;
    }
  } else if (!war && mil > target * 1.4 && n.budget.net < 0) {
    // demobilise the weakest formation to save money
    const armies = Object.values(s.armies).filter((a) => a.owner === n.id && !a.battleId && !a.path.length);
    const a = armies.sort((x, y) => armyStrength(x) - armyStrength(y))[0];
    if (a && a.units.length) {
      const u = a.units.pop()!;
      n.manpower += u.strength * 0.8;
      if (!a.units.length) deleteArmy(s, a.id);
    }
  }
}
function recruitLocation(s: GameState, n: Nation): number | null {
  const cap = s.provinces[n.capital];
  if (cap && cap.owner === n.id && cap.controller === n.id) return n.capital;
  return ownedBy(s, n.id).find((p) => s.provinces[p].controller === n.id && s.provinces[p].status === 'core') ?? null;
}

// ---------------------------------------------------------------- deployment
/** Peacetime: station armies on threatened borders, merge tiny armies, keep a reserve at the capital. */
function aiPeacetimeDeployment(s: GameState, n: Nation) {
  const armies = Object.values(s.armies).filter((a) => a.owner === n.id && !a.battleId && !a.embarked);
  if (!armies.length) return;
  mergeSmallArmies(s, armies);
  const live = armies.filter((a) => s.armies[a.id]);
  const owned = controlledBy(s, n.id);
  const threat = new Map<number, number>();
  for (const p of owned) {
    let t = 0;
    for (const l of landLinks(p)) {
      const c = s.provinces[l.to].controller;
      if (c === n.id || isFriendly(s, n.id, c)) continue;
      const r = peekRel(s, n.id, c)?.value ?? 0;
      t += (1 + Math.max(0, -r) / 30) * (1 + perceivedPower(s, n.id, c) / 200);
    }
    if (t > 0) threat.set(p, t);
  }
  const fronts = [...threat.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  if (!fronts.length) return;
  live.sort((a, b) => armyStrength(b) - armyStrength(a));
  live.forEach((a, i) => {
    if (a.path.length) return;
    const target = i === live.length - 1 && live.length > 2 ? n.capital : fronts[i % fronts.length];
    if (a.location === target) return;
    const path = findPath(s, a, target);
    if (path && path.length <= 12 && path.every((p) => s.provinces[p].controller === n.id || isFriendly(s, n.id, s.provinces[p].controller))) a.path = path;
  });
}
function mergeSmallArmies(s: GameState, armies: Army[]) {
  const byLoc = new Map<number, Army[]>();
  for (const a of armies) if (!a.path.length) (byLoc.get(a.location) || byLoc.set(a.location, []).get(a.location)!).push(a);
  for (const [, list] of byLoc) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.units.length - a.units.length);
    const main = list[0];
    for (const o of list.slice(1)) {
      if (main.units.length + o.units.length > MIL.MAX_ARMY_UNITS) continue;
      main.units.push(...o.units);
      if (main.generalId == null && o.generalId != null) { main.generalId = o.generalId; s.generals[o.generalId].armyId = main.id; o.generalId = null; }
      deleteArmy(s, o.id);
    }
  }
}

// ---------------------------------------------------------------- operations at war (every 2 days per army)
export function aiArmiesDaily(s: GameState) {
  for (const a of Object.values(s.armies)) {
    const n = s.nations[a.owner];
    if (!n || n.isPlayer) continue;
    if ((a.id + s.day) % 2 !== 0) continue;
    if (!isAtWar(s, n.id)) continue;
    armyAutomation(s, a, true);
  }
}

/**
 * Operational logic shared by AI armies and player armies with an automated stance.
 * `full` = AI: may attack, defend and redeploy; otherwise follows the army's stance.
 */
export function armyAutomation(s: GameState, a: Army, full = false) {
  if (a.battleId != null || a.embarked || a.path.length) return;
  const n = s.nations[a.owner];
  const stance = full ? 'advance' : a.stance;
  const enemies = enemiesOf(s, n.id);
  const org = armyOrg(a);
  // withdraw: return to supplied home territory
  if (stance === 'withdraw' || (full && (a.lastSupplyRatio < 0.3 || org < 0.25) && s.provinces[a.location].controller !== n.id)) {
    if (s.provinces[a.location].owner === n.id && s.provinces[a.location].controller === n.id && a.lastSupplyRatio > 0.6) return;
    const home = nearestOwn(s, a);
    if (home != null) { const p = findPath(s, a, home); if (p) a.path = p; }
    return;
  }
  if (!enemies.length) return;
  if (stance === 'hold') return;
  // defend: reinforce an adjacent friendly province under attack
  for (const l of landLinks(a.location)) {
    const b = s.activeBattles.map((id) => s.battles[id]).find((x) => x && x.province === l.to && x.result == null && (x.defender.nation === n.id || isFriendly(s, x.defender.nation, n.id)));
    if (b && (stance === 'defend' || full)) { a.path = [l.to]; return; }
  }
  if (stance === 'defend') return;
  if (org < 0.45 || a.lastSupplyRatio < 0.5 || armyStrength(a) < 1500) return; // recover first
  // advance: attack the best adjacent target with favourable odds
  const pers = PERSONALITY[n.personality];
  const threshold = full ? 0.62 - (pers.aggression - 0.6) * 0.12 : 0.55;
  let best: { p: number; score: number } | null = null;
  for (const l of landLinks(a.location)) {
    const st = s.provinces[l.to];
    if (!atWar(s, n.id, st.controller)) continue;
    const defenders = armiesIn(s, l.to).filter((x) => atWar(s, x.owner, n.id));
    const others = armiesIn(s, a.location).filter((x) => x.owner === n.id && x.id !== a.id && !x.battleId && !x.path.length && armyOrg(x) > 0.5);
    const est = estimateBattle(s, [a, ...others], l.to, a.location, defenders, full ? 0.15 : 0);
    if (est.odds < threshold) continue;
    let score = est.odds * 2 + provinceValue(s, l.to) * 0.05 + (st.owner === n.id ? 3 : 0) + (PROV[l.to].capital ? 2 : 0) + (defenders.length ? 0 : 1.5);
    if (st.buildings.port > 0) score += 0.5;
    if (!best || score > best.score) best = { p: l.to, score };
  }
  if (best) {
    a.path = [best.p];
    // coordinated attack: idle healthy armies in the same province join
    if (full) for (const o of armiesIn(s, a.location)) if (o.owner === n.id && o.id !== a.id && !o.battleId && !o.path.length && armyOrg(o) > 0.5 && o.lastSupplyRatio > 0.5) o.path = [best.p];
    return;
  }
  if (!full && stance !== 'advance') return;
  // otherwise move toward the most valuable reachable front within a few hops
  const front = frontTarget(s, a, n);
  if (front != null) {
    const p = findPath(s, a, front);
    if (p && p.length <= 8) {
      // advance up to (not into) any province held by hostile armies — attacks are only made with favourable odds above
      const stop = p.findIndex((q) => armiesIn(s, q).some((x) => atWar(s, x.owner, n.id)));
      const safe = stop >= 0 ? p.slice(0, stop) : p;
      if (safe.length) a.path = safe;
    }
  }
}

function nearestOwn(s: GameState, a: Army): number | null {
  const n = s.nations[a.owner];
  // BFS through passable provinces to the nearest own, supplied province
  const seen = new Set([a.location]);
  const q = [a.location];
  while (q.length) {
    const p = q.shift()!;
    const st = s.provinces[p];
    if (p !== a.location && st.owner === n.id && st.controller === n.id) return p;
    for (const l of landLinks(p)) {
      if (seen.has(l.to)) continue;
      const c = s.provinces[l.to].controller;
      if (c === n.id || isFriendly(s, n.id, c)) { seen.add(l.to); q.push(l.to); }
    }
  }
  return null;
}

function frontTarget(s: GameState, a: Army, n: Nation): number | null {
  // own provinces bordering the enemy, preferring those with enemy armies nearby and few of our own
  let best: number | null = null, bs = -Infinity;
  for (const p of controlledBy(s, n.id)) {
    let enemyAdj = 0, enemyPow = 0;
    for (const l of landLinks(p)) {
      if (!atWar(s, n.id, s.provinces[l.to].controller)) continue;
      enemyAdj++;
      for (const x of armiesIn(s, l.to)) if (atWar(s, x.owner, n.id)) enemyPow += armyPower(s, x);
    }
    if (!enemyAdj) continue;
    const own = armiesIn(s, p).filter((x) => x.owner === n.id).reduce((t, x) => t + armyPower(s, x), 0);
    const d = Math.hypot(PROV[p].x - PROV[a.location].x, PROV[p].y - PROV[a.location].y);
    const sc = enemyAdj * 2 + enemyPow * 0.05 - own * 0.04 - d * 0.02 + (s.provinces[p].owner !== n.id ? 1 : 0);
    if (sc > bs) { bs = sc; best = p; }
  }
  // occupied own provinces deserve liberation
  for (const p of ownedBy(s, n.id)) {
    if (s.provinces[p].controller === n.id) continue;
    const d = Math.hypot(PROV[p].x - PROV[a.location].x, PROV[p].y - PROV[a.location].y);
    const sc = 6 - d * 0.02;
    if (sc > bs) { bs = sc; best = p; }
  }
  return best === a.location ? null : best;
}

// ---------------------------------------------------------------- diplomacy & war planning
function aiDiplomacy(s: GameState, n: Nation) {
  const pers = PERSONALITY[n.personality];
  const neighbors = neighborsOf(s, n.id);
  const myP = perceivedPower(s, n.id, n.id) + 1;
  // treaties with neighbours and friends
  for (const nb of neighbors) {
    const o = s.nations[nb];
    if (!o?.alive || atWar(s, n.id, nb)) continue;
    const r = rel(s, n.id, nb);
    if (o.isPlayer) {
      // AI may propose treaties to the player
      if (!r.trade && r.value > 10 && !s.proposals.some((p) => p.from === n.id && p.kind === 'trade') && nationIndex(n.id) === (s.day / 7) % 3) {
        s.proposals.push({ id: s.nextId++, from: n.id, to: nb, kind: 'trade', day: s.day });
        addEvent(s, 'diplomacy', `${n.name} proposes a trade agreement.`, [n.id, nb]);
      }
      if (!r.alliance && r.value > 55 && !s.proposals.some((p) => p.from === n.id && p.kind === 'alliance')) {
        s.proposals.push({ id: s.nextId++, from: n.id, to: nb, kind: 'alliance', day: s.day });
        addEvent(s, 'diplomacy', `${n.name} proposes a defensive alliance.`, [n.id, nb], { important: true });
      }
      continue;
    }
    if (!r.trade && aiWouldAccept(s, o, n, 'trade').ok && aiWouldAccept(s, n, o, 'trade').ok && pers.diplomacy > 0.6) applyTreaty(s, n.id, nb, 'trade');
    const theirP = perceivedPower(s, n.id, nb) + 1;
    if (r.nap < s.day && theirP > myP * 1.6 && pers.aggression < 1 && aiWouldAccept(s, o, n, 'nap').ok) applyTreaty(s, n.id, nb, 'nap');
  }
  // alliances against a common threat
  if (alliesOf(s, n.id).length < 2 && pers.diplomacy > 0.8) {
    let threat: string | null = null, tp = 0;
    for (const nb of neighbors) { const p = perceivedPower(s, n.id, nb); if (p > myP * 1.5 && p > tp && (rel(s, n.id, nb).value < 0 || s.nations[nb].infamy > 25)) { tp = p; threat = nb; } }
    if (threat) {
      const cands = neighborsOf(s, threat).filter((c) => c !== n.id && !s.nations[c].isPlayer && !atWar(s, c, n.id) && !peekRel(s, c, n.id)?.alliance && !peekRel(s, c, threat!)?.alliance);
      for (const c of cands.slice(0, 3)) {
        if (aiWouldAccept(s, s.nations[c], n, 'alliance').ok) { applyTreaty(s, n.id, c, 'alliance'); break; }
        changeRelation(s, n.id, c, 3);
      }
    }
  }
  // war declaration
  aiConsiderWar(s, n, myP, neighbors);
}

function aiConsiderWar(s: GameState, n: Nation, myP: number, neighbors: string[]) {
  if (isAtWar(s, n.id) || n.overlord) return;
  const pers = PERSONALITY[n.personality];
  const aggr = pers.aggression * s.settings.aiAggression;
  if (aggr < 0.3) return;
  if (n.stability < 45 || n.warExhaustion > 15 || n.infamy > 35 || n.treasury < n.budget.output * 0.1 || n.bankrupt) return;
  if (s.day - n.lastWarDay < 365 * (2.5 - aggr)) return;
  if (s.day < 60) return; // grace period at campaign start
  const activeWars = s.wars.length;
  const worldDamp = activeWars > 8 ? 0.3 : activeWars > 5 ? 0.6 : 1;
  let best: { id: string; score: number } | null = null;
  for (const t of neighbors) {
    const o = s.nations[t];
    if (!o?.alive || isFriendly(s, n.id, t)) continue;
    const chk = checkDeclareWar(s, n, t);
    if (!chk.ok) continue;
    if (chk.breaksNap && n.personality !== 'opportunistic' && n.personality !== 'expansionist') continue;
    const theirP = coalitionPower(s, n.id, t) + 1;
    const ratio = myP / theirP;
    const distracted = isAtWar(s, t) ? 0.6 : 0;
    const need = 2.2 - aggr * 0.6 - distracted;
    if (ratio < need) continue;
    const r = rel(s, n.id, t).value;
    // the player is a juicy target only if weak; avoid AI dog-piling
    const pile = s.wars.filter((w) => w.defenders.includes(t)).length;
    // grace period before the AI may attack the player: tutorial 2y, standard 1y, hard 4 months
    const grace = { tutorial: 730, standard: 365, hard: 120 }[s.settings.difficulty];
    if (o.isPlayer && s.day < grace) continue;
    const score = (ratio - need) * 2 - r / 40 + (n.claims[t] ? 1.5 : 0) + distracted * 2 - pile * 1.5 - (o.isPlayer ? 0.5 : 0);
    if (!best || score > best.score) best = { id: t, score };
  }
  if (!best || best.score <= 0) return;
  // deterministic chance
  const roll = ((s.day * 2654435761 + nationIndex(n.id) * 97 + best.id.charCodeAt(0)) >>> 0) % 1000 / 1000;
  if (roll > 0.18 * aggr * worldDamp) return;
  // diplomats try an ultimatum first to secure a claim
  if (!n.claims[best.id] && (n.personality === 'diplomatic' || n.personality === 'opportunistic' || roll < 0.05)) {
    const border = controlledBy(s, best.id).filter((p) => PROV[p].neighbors.some((x) => s.provinces[x].controller === n.id)).slice(0, 1);
    if (border.length && !s.nations[best.id].isPlayer) { ultimatum(s, n, best.id, border); return; }
  }
  declareWar(s, n, best.id);
  n.aiMemory.targetId = best.id;
}

// ---------------------------------------------------------------- peace
function aiPeace(s: GameState, n: Nation) {
  for (const w of [...s.wars]) {
    if (w.leaderA !== n.id && w.leaderD !== n.id) continue;
    const enemy = w.leaderA === n.id ? w.leaderD : w.leaderA;
    const e = s.nations[enemy];
    if (!e) continue;
    const score = scoreFor(w, n.id);
    const years = (s.day - w.startDay) / 365;
    if (s.day - w.startDay < 45) continue;
    let terms: PeaceTerms | null = null;
    if (score > 12) {
      // demand what we hold, best value first, within our score (plus enemy war-weariness)
      const held = (w.attackers.includes(n.id) ? w.occupiedByA : w.occupiedByD).filter((p) => s.provinces[p].controller === n.id || isFriendly(s, n.id, s.provinces[p].controller));
      held.sort((a, b) => provinceValue(s, b) - provinceValue(s, a));
      const pick: number[] = [];
      const budget = score + e.warExhaustion * 0.3;
      for (const p of held) {
        const t: PeaceTerms = { provinces: [...pick, p], taker: n.id, reparations: 0, vassalize: false, annex: false, white: false };
        if (termsCost(s, w, n.id, t) <= budget) pick.push(p);
      }
      const all = (w.attackers.includes(n.id) ? w.defenders : w.attackers).flatMap((x) => ownedBy(s, x));
      if (pick.length && pick.length >= all.length) terms = { provinces: all, taker: n.id, reparations: 0, vassalize: false, annex: true, white: false };
      else if (pick.length) terms = { provinces: pick, taker: n.id, reparations: 0, vassalize: false, annex: false, white: false };
      else if (score > 25) terms = { provinces: [], taker: n.id, reparations: Math.round(e.budget.output * 0.05), vassalize: false, annex: false, white: false };
    } else if (n.warExhaustion > 45 || years > 3 || (score < -25 && n.warExhaustion > 25)) {
      terms = { provinces: [], taker: null, reparations: 0, vassalize: false, annex: false, white: true };
    }
    if (!terms) continue;
    if (e.isPlayer) {
      if (!s.peaceOffers.some((o) => o.warId === w.id && s.day - o.day < 90)) {
        s.peaceOffers.push({ id: s.nextId++, from: n.id, to: enemy, warId: w.id, day: s.day, terms });
        addEvent(s, 'peace', `${n.name} offers peace: ${describeTerms(s, terms)}.`, [n.id, enemy], { important: true });
      }
      continue;
    }
    const ev = evaluatePeace(s, w, n.id, terms);
    if (ev.accept) makePeace(s, w, terms.white ? n.id : n.id, terms);
    else if (terms.white && score < -30) {
      // losing badly: concede the provinces the enemy holds
      const held = (w.attackers.includes(enemy) ? w.occupiedByA : w.occupiedByD).slice(0, 4);
      if (held.length) makePeace(s, w, enemy, { provinces: held, taker: enemy, reparations: 0, vassalize: false, annex: false, white: false });
    }
  }
  // endless-war breaker: after 5 years AI wars are settled on the current line of control
  for (const w of [...s.wars]) {
    if (s.day - w.startDay < 365 * 5 || s.nations[w.leaderA]?.isPlayer || s.nations[w.leaderD]?.isPlayer) continue;
    if (Math.abs(w.scoreA) < 15) { makePeace(s, w, w.leaderA, { provinces: [], taker: null, reparations: 0, vassalize: false, annex: false, white: true }); continue; }
    const winner = w.scoreA > 0 ? w.leaderA : w.leaderD;
    const held = (w.scoreA > 0 ? w.occupiedByA : w.occupiedByD).slice(0, 6);
    makePeace(s, w, winner, { provinces: held, taker: winner, reparations: 0, vassalize: false, annex: false, white: !held.length });
  }
}

export function describeTerms(s: GameState, t: PeaceTerms) {
  if (t.white) return 'white peace (status quo)';
  const parts: string[] = [];
  if (t.annex) parts.push('full annexation');
  else if (t.provinces.length) parts.push(`cession of ${t.provinces.slice(0, 4).map((p) => PROV[p].name).join(', ')}${t.provinces.length > 4 ? ` and ${t.provinces.length - 4} more` : ''}`);
  if (t.reparations) parts.push(`reparations of ${t.reparations.toFixed(1)} M IC/yr`);
  if (t.vassalize) parts.push('subject status');
  return parts.join(', ') || 'no terms';
}

export { joinWar, supplyReport, BUILDINGS };
export type { War };
