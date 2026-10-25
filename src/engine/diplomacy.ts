import type { GameState, Nation, PeaceTerms, War } from './types';
import { DIPLO, ECON } from './config';
import { invalidateDiplo, rel, peekRel, warBetween, atWar, alliesOf, enemiesOf, ownedBy, controlledBy, neighborsOf, isAtWar, playerEdge, playerHelp } from './world';
import { addEvent } from './events';
import { provinceOutput, fmt } from './economy';
import { armyPower } from './military';
import { transferProvince, checkNationAlive } from './territory';
import { hashNoise } from './rng';
import { PROV } from './geo';

// ---------------------------------------------------------------- power estimates (imperfect intel)
let powerCache: { s: GameState | null; day: number; map: Map<string, number> } = { s: null, day: -1, map: new Map() };
export function truePower(s: GameState, id: string): number {
  if (powerCache.s !== s || powerCache.day !== s.day) {
    const map = new Map<string, number>();
    for (const a of Object.values(s.armies)) map.set(a.owner, (map.get(a.owner) || 0) + armyPower(s, a));
    for (const n of Object.values(s.nations)) map.set(n.id, ((map.get(n.id) || 0) + n.training.length * 4) * playerEdge(s, n.id));
    powerCache = { s, day: s.day, map };
  }
  return powerCache.map.get(id) || 0;
}
export function invalidatePower() { powerCache.day = -1; }
/** What `observer` believes `target`'s military power to be. Error shrinks with intel and proximity. */
export function perceivedPower(s: GameState, observer: string, target: string): number {
  if (observer === target) return truePower(s, target);
  const o = s.nations[observer];
  const near = neighborsOf(s, observer).includes(target);
  const err = (1 - (o?.intel ?? 0.5) * (o?.techMods.recon ?? 1) * 0.7) * (near ? 0.35 : 0.7);
  const noise = hashNoise(s.seed, observer.charCodeAt(0) * 31 + observer.charCodeAt(1), target.charCodeAt(0) * 17 + target.charCodeAt(2), Math.floor(s.day / 60));
  return truePower(s, target) * (1 + err * (noise * 2 - 1));
}
/** Power of a nation including allies that would defend it. */
export function coalitionPower(s: GameState, observer: string, target: string) {
  let p = perceivedPower(s, observer, target);
  for (const a of alliesOf(s, target)) if (a !== observer) p += perceivedPower(s, observer, a) * 0.6;
  for (const sub of Object.values(s.nations)) if (sub.alive && sub.overlord === target) p += perceivedPower(s, observer, sub.id) * 0.8;
  return p;
}

// ---------------------------------------------------------------- relations helpers
export function changeRelation(s: GameState, a: string, b: string, delta: number) {
  const r = rel(s, a, b);
  r.value = Math.max(-100, Math.min(100, r.value + delta));
}

export interface WarCheck { ok: boolean; reason?: string; justified: boolean; breaksNap: boolean; stabilityCost: number; infamy: number; joiners: string[]; }
export function checkDeclareWar(s: GameState, a: Nation, targetId: string): WarCheck {
  const t = s.nations[targetId];
  const r = peekRel(s, a.id, targetId);
  const res: WarCheck = { ok: true, justified: (a.claims[targetId] ?? 0) > s.day, breaksNap: (r?.nap ?? 0) > s.day, stabilityCost: 0, infamy: 0, joiners: [] };
  if (!t?.alive) return { ...res, ok: false, reason: 'Target does not exist.' };
  if (targetId === a.id) return { ...res, ok: false, reason: 'Cannot declare war on yourself.' };
  if (atWar(s, a.id, targetId)) return { ...res, ok: false, reason: 'Already at war.' };
  if (r?.alliance) return { ...res, ok: false, reason: 'Break the alliance first.' };
  if (t.overlord === a.id || a.overlord === targetId) return { ...res, ok: false, reason: 'Cannot attack your overlord or subject.' };
  if (a.overlord) return { ...res, ok: false, reason: 'Subjects cannot declare wars independently.' };
  if ((r?.truceUntil ?? 0) > s.day) return { ...res, ok: false, reason: `Truce in force until day ${r!.truceUntil} (peace treaty).` };
  res.stabilityCost = res.justified ? DIPLO.WAR_STABILITY_JUSTIFIED : DIPLO.WAR_STABILITY_UNJUSTIFIED;
  res.infamy = (res.justified ? DIPLO.WAR_INFAMY_JUSTIFIED : DIPLO.WAR_INFAMY_UNJUSTIFIED) + (res.breaksNap ? DIPLO.NAP_BREAK_INFAMY : 0);
  res.joiners = alliesOf(s, targetId).filter((x) => x !== a.id && nearFight(s, a, targetId, x));
  for (const sub of Object.values(s.nations)) if (sub.alive && sub.overlord === targetId) res.joiners.push(sub.id);
  return res;
}
/** Does ally `x` come to the defence? Against a player (below Hard) only if it borders one side. */
function nearFight(s: GameState, a: Nation, targetId: string, x: string) {
  if (!a.isPlayer || playerHelp(s).farAllies) return true;
  const nb = neighborsOf(s, x);
  return nb.includes(targetId) || nb.includes(a.id);
}

export function declareWar(s: GameState, a: Nation, targetId: string): WarCheck {
  const c = checkDeclareWar(s, a, targetId);
  if (!c.ok) return c;
  const t = s.nations[targetId];
  const war: War = {
    id: s.nextId++, attackers: [a.id], defenders: [targetId], leaderA: a.id, leaderD: targetId, startDay: s.day,
    name: `${a.name}–${t.name} War`, justified: c.justified, scoreA: 0, casualtiesA: 0, casualtiesD: 0, battles: 0, occupiedByA: [], occupiedByD: [],
  };
  s.wars.push(war);
  s.stats.wars++;
  a.stability = Math.max(0, a.stability - c.stabilityCost);
  a.infamy = Math.min(100, a.infamy + c.infamy);
  a.lastWarDay = s.day;
  const r = rel(s, a.id, targetId);
  r.nap = 0; r.trade = false;
  invalidateDiplo();
  changeRelation(s, a.id, targetId, -60);
  // world reaction: neighbours of the target and everyone worried by infamy
  for (const n of Object.values(s.nations)) {
    if (!n.alive || n.id === a.id || n.id === targetId) continue;
    const worry = neighborsOf(s, n.id).includes(a.id) ? 2 : 1;
    changeRelation(s, n.id, a.id, -(c.justified ? 3 : 7) * worry - a.infamy * 0.05);
  }
  addEvent(s, 'war', `${a.name} declared war on ${t.name}${c.justified ? ' (with a casus belli)' : ''}${c.breaksNap ? ', breaking their non-aggression pact' : ''}!`, [a.id, targetId], { important: true });
  // defenders' allies & subjects join
  for (const j of c.joiners) {
    const jn = s.nations[j];
    if (!jn?.alive || atWar(s, j, a.id) || peekRel(s, j, a.id)?.alliance) continue;
    if (jn.isPlayer) {
      // the player is asked rather than dragged in
      s.proposals.push({ id: s.nextId++, from: targetId, to: j, kind: 'callToArms', day: s.day, warId: war.id });
      addEvent(s, 'diplomacy', `${t.name} calls on you to honour your alliance against ${a.name}.`, [j, targetId], { important: true });
      continue;
    }
    joinWar(s, war, j, 'defenders');
  }
  // nations that guaranteed the target's independence
  for (const g of Object.values(s.nations)) {
    if (!g.alive || g.id === a.id || !g.gov?.guarantees.includes(targetId) || atWar(s, g.id, a.id) || !nearFight(s, a, targetId, g.id)) continue;
    if (g.isPlayer) {
      s.proposals.push({ id: s.nextId++, from: targetId, to: g.id, kind: 'callToArms', day: s.day, warId: war.id });
      addEvent(s, 'diplomacy', `${a.name} attacked ${t.name}, whose independence you guaranteed. Honour the guarantee?`, [g.id, targetId], { important: true });
    } else joinWar(s, war, g.id, 'defenders');
  }
  // attacker's allies may join if eager
  for (const j of alliesOf(s, a.id)) {
    const jn = s.nations[j];
    if (!jn?.alive || jn.isPlayer || atWar(s, j, targetId) || peekRel(s, j, targetId)?.alliance) continue;
    if (rel(s, j, a.id).value > 50 && rel(s, j, targetId).value < 0) joinWar(s, war, j, 'attackers');
  }
  // both sides mobilise (players can stand down in the Military panel)
  for (const x of [a, t]) mobiliseForWar(s, x);
  return c;
}

/** Going to war mobilises the nation: armies reach full organisation (only 55% unmobilised). */
function mobiliseForWar(s: GameState, n: Nation) {
  if (n.mobilize) return;
  n.mobilize = true;
  if (n.isPlayer) addEvent(s, 'military', `${n.name} mobilises for war: your armies reach full organisation over ${ECON.MOBILIZATION_DAYS} days (unmobilised armies fight at no more than 55%). You can stand down in the Military panel.`, [n.id], { important: true });
}

export function joinWar(s: GameState, war: War, nation: string, side: 'attackers' | 'defenders') {
  if (war.attackers.includes(nation) || war.defenders.includes(nation)) return;
  war[side].push(nation);
  const n = s.nations[nation];
  n.lastWarDay = s.day;
  mobiliseForWar(s, n);
  const enemyLeader = side === 'attackers' ? war.leaderD : war.leaderA;
  changeRelation(s, nation, enemyLeader, -40);
  addEvent(s, 'war', `${n.name} joins the ${war.name} on the side of ${s.nations[side === 'attackers' ? war.leaderA : war.leaderD].name}.`, [nation, war.leaderA, war.leaderD], { important: true });
}

export function answerCallToArms(s: GameState, proposalId: number, accept: boolean) {
  const p = s.proposals.find((x) => x.id === proposalId);
  if (!p) return;
  s.proposals = s.proposals.filter((x) => x.id !== proposalId);
  const war = s.wars.find((w) => w.id === p.warId);
  if (!war) return;
  if (accept) joinWar(s, war, p.to, war.defenders.includes(p.from) ? 'defenders' : 'attackers');
  else {
    const r = rel(s, p.to, p.from);
    r.alliance = false;
    invalidateDiplo();
    changeRelation(s, p.to, p.from, -40);
    s.nations[p.to].infamy = Math.min(100, s.nations[p.to].infamy + 5);
    addEvent(s, 'diplomacy', `You refused the call to arms. The alliance with ${s.nations[p.from].name} is dissolved.`, [p.to, p.from]);
  }
}

// ---------------------------------------------------------------- war score
export function provinceValue(s: GameState, p: number) {
  const st = s.provinces[p];
  return 1 + provinceOutput(s, { ...st, controller: st.owner, damage: 0 }) * 0.2 + (PROV[p].capital ? 6 : 0);
}
function sideValue(s: GameState, side: string[]) {
  let v = 0;
  for (const n of side) for (const p of ownedBy(s, n)) v += provinceValue(s, p);
  return Math.max(1, v);
}
export function updateWarScore(s: GameState, w: War) {
  const occA = w.occupiedByA.filter((p) => w.defenders.includes(s.provinces[p].owner) && w.attackers.includes(s.provinces[p].controller));
  const occD = w.occupiedByD.filter((p) => w.attackers.includes(s.provinces[p].owner) && w.defenders.includes(s.provinces[p].controller));
  w.occupiedByA = occA; w.occupiedByD = occD;
  const vA = occA.reduce((t, p) => t + provinceValue(s, p), 0) / sideValue(s, w.defenders);
  const vD = occD.reduce((t, p) => t + provinceValue(s, p), 0) / sideValue(s, w.attackers);
  const cas = (w.casualtiesD - w.casualtiesA) / Math.max(5000, w.casualtiesA + w.casualtiesD);
  w.scoreA = Math.max(-100, Math.min(100, 100 * vA - 100 * vD + 20 * cas));
}
/** Score from the perspective of nation `n` (positive = winning). */
export function scoreFor(w: War, n: string) { return w.attackers.includes(n) ? w.scoreA : -w.scoreA; }

/** War-score cost of a set of peace terms demanded by `taker` from the losing side. */
export function termsCost(s: GameState, w: War, taker: string, t: PeaceTerms): number {
  const loserSide = w.attackers.includes(taker) ? w.defenders : w.attackers;
  if (t.white) return 0;
  const total = sideValue(s, loserSide);
  let c = 0;
  for (const p of t.provinces) c += (100 * provinceValue(s, p)) / total;
  if (t.annex) c = Math.max(c, 100);
  if (t.vassalize) c += 55;
  if (t.reparations > 0) {
    const loserLeader = s.nations[w.attackers.includes(taker) ? w.leaderD : w.leaderA];
    c += (t.reparations / Math.max(1, loserLeader.budget.output)) * 250;
  }
  return c;
}

export interface PeaceEval { accept: boolean; reason: string; cost: number; score: number; }
/** Would the AI leader receiving these terms accept them? `from` proposes; taker = from's side gains. */
export function evaluatePeace(s: GameState, w: War, from: string, t: PeaceTerms): PeaceEval {
  const to = w.attackers.includes(from) ? w.leaderD : w.leaderA;
  const target = s.nations[to];
  const score = scoreFor(w, from);
  const cost = termsCost(s, w, from, t);
  const yearsAtWar = (s.day - w.startDay) / 365;
  // the receiver's willingness: exhaustion, hopelessness and time make them accept more
  const help = s.nations[from]?.isPlayer && !target?.isPlayer ? playerHelp(s).peace : 0; // (difficulty)
  const give = (target?.warExhaustion ?? 0) * 0.35 + Math.max(0, yearsAtWar - 1) * 6 + (target && controlledBy(s, to).length === 0 ? 100 : 0) + help;
  if (t.white) {
    const myScore = scoreFor(w, to);
    if (myScore > 25 + help && (target?.warExhaustion ?? 0) < 50) return { accept: false, reason: `${target.name} believes it is winning (war score ${myScore.toFixed(0)}).`, cost, score };
    return { accept: true, reason: 'Both sides are ready to end the war.', cost, score };
  }
  if (cost <= score + give + 2) return { accept: true, reason: `Terms cost ${cost.toFixed(0)} vs war score ${score.toFixed(0)}${give > 1 ? ` + ${give.toFixed(0)} war-weariness` : ''}.`, cost, score };
  return { accept: false, reason: `Terms cost ${cost.toFixed(0)} war score, but your war score is only ${score.toFixed(0)}${give > 1 ? ` (+${give.toFixed(0)} from enemy war-weariness)` : ''}.`, cost, score };
}

/**
 * The most a war leader can take right now: every enemy province their side holds that the enemy
 * will cede (most valuable first), annexation if they accept that, else a white peace if both
 * sides are ready; null if the enemy refuses everything (or is a human player, who must answer).
 */
export function bestPeaceTerms(s: GameState, w: War, from: string): PeaceTerms | null {
  const mine = w.attackers.includes(from) ? w.attackers : w.defenders;
  const theirs = w.attackers.includes(from) ? w.defenders : w.attackers;
  const base: PeaceTerms = { provinces: [], taker: from, reparations: 0, vassalize: false, annex: false, white: false };
  const enemy = s.nations[w.attackers.includes(from) ? w.leaderD : w.leaderA];
  if (enemy?.isPlayer) {
    const held = s.provinces.filter((p) => theirs.includes(p.owner) && mine.includes(p.controller)).map((p) => p.id);
    return held.length ? { ...base, provinces: held } : { ...base, white: true, taker: null };
  }
  if (evaluatePeace(s, w, from, { ...base, annex: true }).accept && theirs.length === 1) return { ...base, annex: true };
  const held = s.provinces.filter((p) => theirs.includes(p.owner) && mine.includes(p.controller)).map((p) => p.id).sort((a, b) => provinceValue(s, b) - provinceValue(s, a));
  const take: number[] = [];
  for (const p of held) if (evaluatePeace(s, w, from, { ...base, provinces: [...take, p] }).accept) take.push(p);
  if (take.length) return { ...base, provinces: take };
  if (evaluatePeace(s, w, from, { ...base, white: true, taker: null }).accept) return { ...base, white: true, taker: null };
  return null;
}

/** Apply a peace settlement. `taker` is the side that receives gains. */
export function makePeace(s: GameState, w: War, taker: string, t: PeaceTerms) {
  const winners = w.attackers.includes(taker) ? w.attackers : w.defenders;
  const losers = w.attackers.includes(taker) ? w.defenders : w.attackers;
  const loserLeader = w.attackers.includes(taker) ? w.leaderD : w.leaderA;
  const parts: string[] = [];
  // return occupied territory not ceded
  const ceded = new Set(t.annex ? losers.flatMap((l) => ownedBy(s, l)) : t.provinces);
  for (const st of s.provinces) {
    const involved = (winners.includes(st.controller) && losers.includes(st.owner)) || (losers.includes(st.controller) && winners.includes(st.owner));
    if (!involved) continue;
    if (ceded.has(st.id) && winners.includes(st.controller)) continue;
    st.controller = st.owner;
  }
  // war participants' armies in now-foreign territory are expelled home
  if (!t.white) {
    for (const p of ceded) {
      const to = winners.includes(s.provinces[p].controller) ? s.provinces[p].controller : taker;
      transferProvince(s, p, to, 'occupied');
    }
    if (ceded.size) parts.push(`${ceded.size} province${ceded.size > 1 ? 's' : ''} ceded`);
    if (t.reparations > 0) {
      s.nations[loserLeader].reparations.push({ to: taker, amount: t.reparations, until: s.day + DIPLO.REPARATION_YEARS * 365 });
      parts.push(`reparations of ${fmt(t.reparations)}/yr for ${DIPLO.REPARATION_YEARS} years`);
    }
    if (t.vassalize && s.nations[loserLeader].alive) {
      s.nations[loserLeader].overlord = taker;
      invalidateDiplo();
      s.nations[loserLeader].subjectSince = s.day;
      parts.push(`${s.nations[loserLeader].name} becomes a subject of ${s.nations[taker].name}`);
    }
  }
  expelArmies(s, [...winners, ...losers]);
  s.wars = s.wars.filter((x) => x.id !== w.id);
  s.peaceOffers = s.peaceOffers.filter((o) => o.warId !== w.id);
  s.proposals = s.proposals.filter((o) => o.warId !== w.id);
  s.stats.peaceDeals++;
  for (const a of winners) for (const b of losers) {
    const r = rel(s, a, b);
    r.truceUntil = s.day + DIPLO.TRUCE_DAYS;
    changeRelation(s, a, b, 15);
  }
  for (const n of [...winners, ...losers]) {
    const nn = s.nations[n];
    if (!nn || !nn.mobilize || isAtWar(s, n)) continue;
    nn.mobilize = false; // (like mobilisation on entering a war, standing down is automatic)
    if (nn.isPlayer) addEvent(s, 'military', `${nn.name} stands down: with no war left, the armies demobilise to save upkeep. You can mobilise again in the Military panel.`, [n]);
  }
  addEvent(s, 'peace', `Peace: the ${w.name} ends${t.white ? ' in a white peace' : ''}. ${parts.length ? parts.join('; ') + '.' : ''}`, [...winners, ...losers], { important: true });
  for (const l of losers) checkNationAlive(s, l);
}

/** After peace, armies standing in territory that is no longer accessible return to the nearest own province. */
export function expelArmies(s: GameState, nations: string[]) {
  for (const a of Object.values(s.armies)) {
    if (!nations.includes(a.owner) || a.embarked) continue;
    const c = s.provinces[a.location].controller;
    if (c === a.owner || peekRel(s, a.owner, c)?.alliance || s.nations[c]?.overlord === a.owner || atWar(s, a.owner, c)) continue;
    const own = controlledBy(s, a.owner);
    if (!own.length) { delete s.armies[a.id]; continue; }
    let best = own[0], bd = Infinity;
    for (const p of own) { const d = Math.hypot(PROV[p].x - PROV[a.location].x, PROV[p].y - PROV[a.location].y); if (d < bd) { bd = d; best = p; } }
    a.location = best; a.path = []; a.moveProgress = 0; a.battleId = null;
  }
}

/** Nation with no controlled provinces left capitulates: occupied land is ceded to occupiers. */
export function checkCapitulation(s: GameState) {
  surrenderToPlayers(s);
  for (const w of [...s.wars]) {
    for (const side of ['attackers', 'defenders'] as const) {
      for (const n of [...w[side]]) {
        const own = ownedBy(s, n);
        const held = own.filter((p) => s.provinces[p].controller === n).length;
        if (own.length && held > 0) continue;
        const leader = side === 'attackers' ? w.leaderA : w.leaderD;
        const otherLeader = side === 'attackers' ? w.leaderD : w.leaderA;
        if (n === leader) {
          const nat = s.nations[n];
          if (nat?.isPlayer) {
            // a defeated player keeps the capital region: defeat is harsh but recoverable
            const keep = nat.capital;
            makePeace(s, w, otherLeader, { provinces: own.filter((p) => p !== keep), taker: otherLeader, reparations: Math.round(nat.budget.output * 0.05), vassalize: false, annex: false, white: false });
            addEvent(s, 'war', `${nat.name} capitulated. Your government survives in ${PROV[keep].name} — rebuild and try again.`, [n], { important: true });
          } else {
            makePeace(s, w, otherLeader, { provinces: own, taker: otherLeader, reparations: 0, vassalize: false, annex: true, white: false });
          }
          break;
        } else {
          // minor participant capitulates: occupiers keep what they hold
          w[side] = w[side].filter((x) => x !== n);
          for (const p of own) { const c = s.provinces[p].controller; if (c !== n) transferProvince(s, p, c, 'occupied'); }
          addEvent(s, 'war', `${s.nations[n].name} has capitulated.`, [n], { important: true });
        }
      }
    }
  }
}

/**
 * An AI war leader losing to a human player (below Hard) surrenders before it has lost everything:
 * once it keeps less than `surrender` of its provinces, or has lost its capital and keeps under
 * half. The winners keep what they hold.
 */
function surrenderToPlayers(s: GameState) {
  const share = playerHelp(s).surrender;
  if (!share) return;
  for (const w of [...s.wars]) {
    for (const [leader, other] of [[w.leaderA, w.leaderD], [w.leaderD, w.leaderA]]) {
      const n = s.nations[leader], winner = s.nations[other];
      if (!n?.alive || n.isPlayer || !winner?.isPlayer) continue;
      const own = ownedBy(s, leader);
      const held = own.filter((p) => s.provinces[p].controller === leader).length;
      if (!own.length || !held) continue; // (losing everything is handled as a capitulation)
      const capitalLost = s.provinces[n.capital]?.controller !== leader;
      if (held / own.length >= share && !(capitalLost && held / own.length < 0.5)) continue;
      const side = w.attackers.includes(other) ? w.attackers : w.defenders;
      const taken = own.filter((p) => side.includes(s.provinces[p].controller));
      if (!taken.length) continue;
      makePeace(s, w, other, { provinces: taken, taker: other, reparations: 0, vassalize: false, annex: false, white: false });
      addEvent(s, 'war', `${n.name} surrenders to ${winner.name} and gives up the ${taken.length} province${taken.length > 1 ? 's' : ''} it lost.`, [leader, other], { important: true });
      break;
    }
  }
}

// ---------------------------------------------------------------- treaties
export interface DiploResult { ok: boolean; reason: string; }
export function proposeTreaty(s: GameState, from: Nation, toId: string, kind: 'alliance' | 'trade' | 'nap'): DiploResult {
  const to = s.nations[toId];
  if (!to?.alive) return { ok: false, reason: 'Nation does not exist.' };
  if (atWar(s, from.id, toId)) return { ok: false, reason: 'You are at war.' };
  if (from.embargoUntil > s.day || to.embargoUntil > s.day) return { ok: false, reason: 'No nation will sign anything with a state under the nuclear embargo.' };
  const r = rel(s, from.id, toId);
  if (kind === 'alliance' && r.alliance) return { ok: false, reason: 'Already allied.' };
  if (kind === 'trade' && r.trade) return { ok: false, reason: 'Trade agreement already in place.' };
  if (kind === 'nap' && r.nap > s.day) return { ok: false, reason: 'Pact already in force.' };
  if (to.isPlayer) {
    // another human player decides for themselves
    if (s.proposals.some((p) => p.from === from.id && p.to === toId && p.kind === kind)) return { ok: false, reason: 'A proposal is already waiting for their answer.' };
    s.proposals.push({ id: s.nextId++, from: from.id, to: toId, kind, day: s.day });
    addEvent(s, 'diplomacy', `${from.name} proposes ${{ alliance: 'a defensive alliance', trade: 'a trade agreement', nap: 'a non-aggression pact' }[kind]} to ${to.name}.`, [from.id, toId], { important: true });
    return { ok: true, reason: `Proposal sent to ${to.name}. They will answer in their Diplomacy panel.` };
  }
  const accept: DiploResult = aiWouldAccept(s, to, from, kind);
  if (!accept.ok) {
    changeRelation(s, from.id, toId, -2);
    return accept;
  }
  applyTreaty(s, from.id, toId, kind);
  return { ok: true, reason: accept.reason };
}
export function applyTreaty(s: GameState, a: string, b: string, kind: 'alliance' | 'trade' | 'nap') {
  const r = rel(s, a, b);
  invalidateDiplo();
  if (kind === 'alliance') { r.alliance = true; r.nap = Math.max(r.nap, s.day + DIPLO.NAP_DAYS); changeRelation(s, a, b, 20); }
  if (kind === 'trade') { r.trade = true; changeRelation(s, a, b, 10); }
  if (kind === 'nap') { r.nap = s.day + DIPLO.NAP_DAYS; changeRelation(s, a, b, 8); }
  const label = { alliance: 'a defensive alliance', trade: 'a trade agreement', nap: 'a non-aggression pact' }[kind];
  addEvent(s, 'diplomacy', `${s.nations[a].name} and ${s.nations[b].name} signed ${label}.`, [a, b], { important: kind === 'alliance' && (s.nations[a].budget.output > 2000 || s.nations[b].budget.output > 2000) });
}
export function aiWouldAccept(s: GameState, ai: Nation, other: Nation, kind: 'alliance' | 'trade' | 'nap'): DiploResult {
  const r = rel(s, ai.id, other.id);
  const myP = perceivedPower(s, ai.id, ai.id) + 1;
  const theirP = perceivedPower(s, ai.id, other.id) + 1;
  const pers = { defensive: 10, expansionist: -15, industrial: 5, diplomatic: 20, opportunistic: -5, isolationist: -30 }[ai.personality];
  if (kind === 'trade') {
    const v = r.value + 25 + pers * 0.5 - other.infamy * 0.3;
    return v > 0 ? { ok: true, reason: `${ai.name} welcomes the trade agreement.` } : { ok: false, reason: `${ai.name} declines: relations too poor (${r.value.toFixed(0)}).` };
  }
  if (kind === 'nap') {
    const fear = theirP / myP;
    const v = r.value + 10 + pers + (fear > 1.5 ? 25 : 0) - other.infamy * 0.4;
    return v > 0 ? { ok: true, reason: `${ai.name} agrees to a non-aggression pact.` } : { ok: false, reason: `${ai.name} refuses to bind itself (relations ${r.value.toFixed(0)}, your infamy ${other.infamy.toFixed(0)}).` };
  }
  // alliance: needs good relations and a shared threat or mutual benefit
  const myEnemies = new Set(enemiesOf(s, ai.id));
  const otherEnemies = enemiesOf(s, other.id);
  if (otherEnemies.length && !otherEnemies.some((e) => myEnemies.has(e))) {
    return { ok: false, reason: `${ai.name} will not ally with a nation currently at war.` };
  }
  let threat = 0;
  for (const nb of neighborsOf(s, ai.id)) if (nb !== other.id) threat = Math.max(threat, perceivedPower(s, ai.id, nb) / myP);
  const v = r.value - 30 + pers + Math.min(30, threat * 10) + Math.min(20, (theirP / myP) * 8) - other.infamy * 0.5 - alliesOf(s, ai.id).length * 8;
  return v > 0 ? { ok: true, reason: `${ai.name} accepts the alliance.` } : { ok: false, reason: `${ai.name} declines the alliance (relations ${r.value.toFixed(0)}; needs warmer ties or a common threat).` };
}
export function cancelTreaty(s: GameState, a: string, b: string, kind: 'alliance' | 'trade') {
  const r = rel(s, a, b);
  invalidateDiplo();
  if (kind === 'alliance') { r.alliance = false; changeRelation(s, a, b, -25); }
  if (kind === 'trade') { r.trade = false; changeRelation(s, a, b, -10); }
  addEvent(s, 'diplomacy', `${s.nations[a].name} ended its ${kind === 'alliance' ? 'alliance' : 'trade agreement'} with ${s.nations[b].name}.`, [a, b]);
}
export function diplomaticMission(s: GameState, a: Nation, b: string): DiploResult {
  const cost = 2 * a.priceIndex;
  if (a.treasury < cost) return { ok: false, reason: 'Insufficient funds.' };
  a.treasury -= cost;
  a.ledgerMonth.expense += cost;
  changeRelation(s, a.id, b, 8);
  return { ok: true, reason: `Relations with ${s.nations[b].name} improved by 8 (cost ${fmt(cost)}).` };
}

/** Ultimatum: demand provinces. Acceptance depends on the balance of power; refusal grants a casus belli. */
export function ultimatum(s: GameState, a: Nation, targetId: string, provinces: number[], vassal = false): DiploResult {
  const t = s.nations[targetId];
  if (!t?.alive || atWar(s, a.id, targetId)) return { ok: false, reason: 'Not possible now.' };
  if (!vassal && !provinces.length) return { ok: false, reason: 'Select at least one province.' };
  if (!vassal && provinces.some((p) => s.provinces[p].owner !== targetId)) return { ok: false, reason: 'They do not own all those provinces.' };
  const myP = coalitionPower(s, targetId, a.id) + 1;
  const theirP = coalitionPower(s, targetId, targetId) + 1;
  const share = vassal ? 1 : provinces.reduce((x, p) => x + provinceValue(s, p), 0) / ownedBy(s, targetId).reduce((x, p) => x + provinceValue(s, p), 0);
  const ratio = myP / theirP;
  const need = vassal ? 6 : 2 + share * 6;
  changeRelation(s, a.id, targetId, DIPLO.ULTIMATUM_RELATION);
  a.infamy = Math.min(100, a.infamy + (vassal ? 6 : 3));
  if (!t.isPlayer && ratio >= need && t.personality !== 'isolationist') {
    if (vassal) { t.overlord = a.id; t.subjectSince = s.day; invalidateDiplo(); }
    else for (const p of provinces) transferProvince(s, p, a.id, 'occupied');
    addEvent(s, 'diplomacy', `${t.name} yielded to ${a.name}'s ultimatum${vassal ? ' and became its subject' : ` and ceded ${provinces.map((p) => PROV[p].name).join(', ')}`}.`, [a.id, targetId], { important: true });
    return { ok: true, reason: `${t.name} capitulated to your demands (power ratio ${ratio.toFixed(1)}:1).` };
  }
  a.claims[targetId] = s.day + 365;
  addEvent(s, 'diplomacy', `${t.name} rejected ${a.name}'s ultimatum.`, [a.id, targetId]);
  return { ok: false, reason: `${t.name} rejected the ultimatum (they estimate the balance of power at ${ratio.toFixed(1)}:1; need ~${need.toFixed(1)}:1). You now have a casus belli for one year.` };
}

/** Annex a long-standing subject peacefully. */
export function annexSubject(s: GameState, a: Nation, subjectId: string): DiploResult {
  const sub = s.nations[subjectId];
  if (!sub || sub.overlord !== a.id) return { ok: false, reason: 'Not your subject.' };
  const years = (s.day - (sub.subjectSince ?? s.day)) / 365;
  if (years < 3) return { ok: false, reason: `Subjects can be annexed after 3 years (${years.toFixed(1)} so far).` };
  const provs = ownedBy(s, subjectId);
  const cost = provs.reduce((t, p) => t + provinceOutput(s, s.provinces[p]) * 0.4, 0) * a.priceIndex;
  if (a.treasury < cost) return { ok: false, reason: `Annexation costs ${fmt(cost)}.` };
  a.treasury -= cost;
  for (const p of provs) transferProvince(s, p, a.id, 'integrating');
  for (const p of provs) { s.provinces[p].status = 'occupied'; }
  addEvent(s, 'territory', `${a.name} annexed its subject ${sub.name}.`, [a.id, subjectId], { important: true });
  return { ok: true, reason: `${sub.name} annexed for ${fmt(cost)}. Integrate its provinces to make them core.` };
}

/** Weekly relation drift toward a baseline shaped by borders, alliances, infamy and wars. */
export function relationsWeekly(s: GameState) {
  for (const k in s.relations) {
    const r = s.relations[k];
    const [a, b] = k.split('|');
    const na = s.nations[a], nb = s.nations[b];
    if (!na?.alive || !nb?.alive) continue;
    let base = 0;
    if (r.alliance) base += 40;
    if (r.trade) base += 15;
    if (r.nap > s.day) base += 8;
    if (atWar(s, a, b)) base -= 80;
    base -= (na.infamy + nb.infamy) * 0.2;
    r.value += (base - r.value) * DIPLO.RELATION_DECAY;
    if (r.value > -0.5 && r.value < 0.5 && !r.alliance && !r.trade && r.nap < s.day && r.truceUntil < s.day) delete s.relations[k];
  }
  for (const n of Object.values(s.nations)) for (const t in n.claims) if (n.claims[t] < s.day) delete n.claims[t];
}

export { warBetween };
