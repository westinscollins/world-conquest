/**
 * World simulation clock. One call to `tick` advances the world one day:
 *   daily   – mobilisation, training, construction, research, production, movement, battles,
 *             supply, reinforcement, naval transport, budgets → treasury
 *   weekly  – relations drift, AI decisions (staggered across nations)
 *   monthly – growth, stability, inflation, manpower, markets, resistance, war scores
 */
import type { Army, GameState, Nation } from './types';
import { MIL, TERRAIN, UNITS, ECON } from './config';
import { PROV, distKm, isStrait } from './geo';
import { aggregate, applyDailyBudget, computeBudget, buildDayIndex, constructionDaily, monthlyEconomy, updateMarket } from './economy';
import { trainingDaily, reinforceDaily, armySpeedKm, canEnter, setArmyLocation } from './military';
import { researchDaily } from './research';
import { supplyDaily } from './supply';
import { battleDaily, startBattle, joinBattle } from './battle';
import { armiesIn, atWar, isAtWar, invalidateArmies, isFriendly } from './world';
import { setController, resistanceMonthly } from './territory';
import { relationsWeekly, updateWarScore, checkCapitulation } from './diplomacy';
import { seaTransportDaily, fleetsDaily, shipyardDaily } from './naval';
import { strategicDaily } from './strikes';
import { eventsDaily } from './policy';
import { aiWeekly, aiArmiesDaily, armyAutomation } from './ai';
import { dateOf, addEvent } from './events';
import { checkVictory, checkAchievements } from './victory';
import { tutorialCheck } from './tutorial';

export function nationIndex(id: string) { return (id.charCodeAt(0) * 7 + id.charCodeAt(1) * 3 + id.charCodeAt(2)) % 7; }

export function tick(s: GameState) {
  if (s.outcome && !s.outcome.won && s.outcome.reason !== 'continue') { /* defeated games may continue as observer */ }
  s.day += 1;
  const date = dateOf(s, s.day);
  const newMonth = date.getUTCDate() === 1;

  const armiesBy = new Map<string, number[]>();
  for (const a of Object.values(s.armies)) (armiesBy.get(a.owner) || armiesBy.set(a.owner, []).get(a.owner)!).push(a.id);
  const fleetsBy = new Map<string, number[]>();
  for (const f of Object.values(s.fleets)) (fleetsBy.get(f.owner) || fleetsBy.set(f.owner, []).get(f.owner)!).push(f.id);

  const nations = Object.values(s.nations).filter((n) => n.alive);
  // ---- nation internals
  for (const n of nations) {
    const target = n.mobilize ? 1 : 0;
    if (n.mobilization !== target) n.mobilization = Math.max(0, Math.min(1, n.mobilization + (target > n.mobilization ? 1 : -1) / ECON.MOBILIZATION_DAYS));
    trainingDaily(s, n);
    shipyardDaily(s, n);
    strategicDaily(s, n);
    eventsDaily(s, n);
    constructionDaily(s, n);
    researchDaily(s, n);
  }

  // ---- movement
  for (const a of Object.values(s.armies)) moveArmy(s, a);
  // ---- battles
  for (const id of [...s.activeBattles]) { const b = s.battles[id]; if (b && b.result == null) battleDaily(s, b); }
  // ---- naval
  seaTransportDaily(s);
  fleetsDaily(s);

  // ---- supply, reinforcement, attrition
  const armiesBy2 = new Map<string, Army[]>();
  for (const a of Object.values(s.armies)) (armiesBy2.get(a.owner) || armiesBy2.set(a.owner, []).get(a.owner)!).push(a);
  for (const n of nations) {
    const list = armiesBy2.get(n.id) || [];
    supplyDaily(s, n, list, isAtWar(s, n.id));
    for (const a of list) { reinforceDaily(s, a, n); attrition(s, a, n); entrench(s, a); }
  }

  // ---- budgets: player & belligerents daily, others staggered weekly
  const idx = buildDayIndex(s);
  for (const n of nations) {
    const due = n.isPlayer || idx.enemies.has(n.id) || nationIndex(n.id) === s.day % 7 || newMonth;
    if (due) {
      const agg = aggregate(s, n, armiesBy, fleetsBy);
      n.budget = computeBudget(s, n, agg, idx);
      if (newMonth) monthlyEconomy(s, n, agg);
      n.lastFactories = agg.factories;
    }
    applyDailyBudget(s, n);
  }
  if (newMonth) {
    updateMarket(s);
    resistanceMonthly(s);
  }
  for (const w of s.wars) updateWarScore(s, w);
  checkCapitulation(s);

  // ---- AI & automation
  aiArmiesDaily(s);
  for (const a of Object.values(s.armies)) if (s.nations[a.owner]?.isPlayer && a.stance !== 'hold') armyAutomation(s, a);
  if (s.day % 7 === 0) relationsWeekly(s);
  for (const n of nations) if (!n.isPlayer && n.alive && nationIndex(n.id) === s.day % 7) aiWeekly(s, n);
  // stale offers expire
  s.peaceOffers = s.peaceOffers.filter((o) => s.day - o.day < 60 && s.wars.some((w) => w.id === o.warId));
  s.proposals = s.proposals.filter((o) => s.day - o.day < 60);

  checkAchievements(s);
  checkVictory(s);
  if (s.tutorial && !s.tutorial.done) tutorialCheck(s);
  // trim old finished battles (keep the last 150 for reports)
  if (s.day % 30 === 0) {
    const done = Object.values(s.battles).filter((b) => b.result != null).sort((a, b) => b.id - a.id);
    for (const b of done.slice(150)) delete s.battles[b.id];
  }
}

function moveArmy(s: GameState, a: Army) {
  if (!a.path.length || a.battleId != null || a.embarked) { if (!a.path.length && !a.battleId) a.fatigue = Math.max(0, a.fatigue - 0.04); return; }
  const next = a.path[0];
  if (!canEnter(s, a.owner, next)) {
    a.path = []; a.moveProgress = 0;
    if (s.nations[a.owner]?.isPlayer) addEvent(s, 'military', `${a.name}: route into ${PROV[next].name} is blocked (no military access).`, [a.owner], { province: next });
    return;
  }
  const dist = distKm(a.location, next) + (isStrait(a.location, next) ? MIL.STRAIT_DAYS * 25 : 0);
  const hostile = armiesIn(s, next).filter((x) => atWar(s, x.owner, a.owner) && !x.embarked);
  const speed = armySpeedKm(s, a, next);
  a.moveProgress += speed;
  a.fatigue = Math.min(1, a.fatigue + 0.015);
  a.entrench = 0;
  if (hostile.length) {
    // contact at the halfway point: attack (or join an attack already under way)
    if (a.moveProgress >= dist * 0.5) {
      const existing = s.activeBattles.map((id) => s.battles[id]).find((b) => b && b.province === next && b.result == null && (b.attacker.nation === a.owner || isFriendly(s, b.attacker.nation, a.owner)));
      if (existing) joinBattle(s, existing, a, true);
      else startBattle(s, [a], next, a.location);
      a.moveProgress = dist * 0.5;
    }
    return;
  }
  if (a.moveProgress >= dist) {
    a.path.shift();
    a.moveProgress = 0;
    setArmyLocation(s, a, next);
    const st = s.provinces[next];
    if (atWar(s, st.controller, a.owner)) setController(s, next, a.owner);
    else if (st.owner === a.owner && st.controller !== a.owner && !atWar(s, st.controller, a.owner)) setController(s, next, a.owner);
    // arriving into a province with a friendly battle under way: reinforce defenders
    const b = s.activeBattles.map((id) => s.battles[id]).find((x) => x && x.province === next && x.result == null);
    if (b && (b.defender.nation === a.owner || isFriendly(s, b.defender.nation, a.owner))) joinBattle(s, b, a, false);
    if (!a.path.length && s.nations[a.owner]?.isPlayer) addEvent(s, 'military', `${a.name} arrived in ${PROV[next].name}.`, [a.owner], { province: next });
  }
}

function attrition(s: GameState, a: Army, n: Nation) {
  if (a.embarked) return;
  const t = TERRAIN[PROV[a.location].terrain];
  const sup = a.lastSupplyRatio;
  let loss = t.attrition * (1.2 - sup);
  if (sup < 0.35) loss += MIL.ATTRITION_NO_SUPPLY * (1 - sup / 0.35);
  if (n.bankrupt) loss += 0.001;
  if (loss <= 0) return;
  for (const u of a.units) {
    u.strength *= 1 - loss;
    if (sup < 0.35) { u.equipment = Math.max(0, u.equipment - 0.003); u.morale = Math.max(0.05, u.morale - 0.004); u.org = Math.max(0, u.org - 0.01); }
  }
  a.units = a.units.filter((u) => u.strength > UNITS[u.type].personnel * 0.05);
  if (!a.units.length) { delete s.armies[a.id]; invalidateArmies(); }
}

function entrench(s: GameState, a: Army) {
  if (a.path.length || a.battleId != null || a.embarked) return;
  const g = a.generalId != null ? s.generals[a.generalId] : null;
  const eng = a.units.some((u) => u.type === 'engineers') ? 1.5 : 1;
  const rate = MIL.ENTRENCH_RATE * (a.posture === 'defensive' ? 2 : 1) * eng * (g?.trait === 'entrencher' ? 2 : 1);
  a.entrench = Math.min(1, a.entrench + rate);
}

/** Advance several days (used by tests and fast-forward). */
export function runDays(s: GameState, days: number) {
  for (let i = 0; i < days; i++) tick(s);
}

export { setArmyLocation };
