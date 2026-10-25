/**
 * Player command layer: validates and executes player orders, returning a result the UI can show.
 * UI components call these instead of mutating game state directly.
 */
import type { PolicyArea, ProvinceFocus } from './types';
import type { GameState, Posture, Stance, UnitType, BuildingKind, EquipKind, PeaceTerms, ShipType, Army, AirMission } from './types';
import { setMission, rebaseWing } from './air';
import { recruit, findPath, assignGeneral, createArmy, deleteArmy, pathDays, armyStrength } from './military';
import { startConstruction, cancelConstruction, borrow, repay, fmt } from './economy';
import { declareWar, proposeTreaty, cancelTreaty, diplomaticMission, ultimatum, evaluatePeace, makePeace, annexSubject, answerCallToArms, applyTreaty } from './diplomacy';
import { setProvinceStatus, releaseSubject } from './territory';
import { embark, moveFleet, orderShip, orderInvasion } from './naval';
import { PROV, WORLD } from './geo';
import { addEvent } from './events';
import { ECON, UNITS, SHIPS, MIL, STRIKES, NUKE, POLICY_AREAS, POLICY_CHANGE_STABILITY, DECREES, FOCUS, SECURITY, PROPAGANDA, INTERIOR, WAR_ECONOMY, ROE, AIR_MISSIONS, AIR_MISSION_INFO } from './config';
import { canResearch } from './research';
import { setSecurity, toggleCampaign, interiorAction, toggleMartialLaw, setWarEconomy, setRoe, setAirMission, buySam } from './regime';
import { createOperation, cancelOperation, attackNearest, digIn, scorchedEarth, fundPartisans, fortifyBorder, hireMercenaries, licenseTech } from './warplans';
import { setServices, setPolicy, issueDecree, investFund, withdrawFund, setFocus, sendAid, toggleSanction, toggleGuarantee, buildSpyNetwork, spyOp, resolveEvent } from './policy';
import { buyMunitions, launchStrike, startNuclearProgram, buildWarhead, type StrikeKind } from './strikes';
import { invalidateArmies, warBetween } from './world';

export interface Result { ok: boolean; message: string; }
const ok = (message: string): Result => ({ ok: true, message });
const fail = (message: string): Result => ({ ok: false, message });
const P = (s: GameState) => s.nations[s.player];
const flag = (s: GameState, f: string) => { if (s.tutorial) s.tutorial.flags[f] = true; };

export function setTax(s: GameState, rate: number): Result {
  P(s).taxRate = Math.max(ECON.MIN_TAX, Math.min(ECON.MAX_TAX, Math.round(rate * 100) / 100));
  return ok(`Tax rate set to ${Math.round(P(s).taxRate * 100)}%.`);
}
export function setResearchFunding(s: GameState, amount: number): Result {
  P(s).researchFunding = Math.max(0, Math.round(amount * 10) / 10);
  return ok(`Research funding set to ${fmt(P(s).researchFunding)}/yr.`);
}
export function chooseResearch(s: GameState, id: string): Result {
  const n = P(s);
  if (!canResearch(n, id)) return fail('Prerequisites not met.');
  if (n.research.current && n.research.current !== id) { n.research.queue = n.research.queue.filter((q) => q !== id); n.research.queue.unshift(n.research.current); }
  n.research.current = id; n.research.progress = n.research.current === id ? n.research.progress : 0;
  return ok('Research started.');
}
export function queueResearch(s: GameState, id: string): Result {
  const n = P(s);
  if (n.research.done.includes(id) || n.research.queue.includes(id)) return fail('Already queued or done.');
  n.research.queue.push(id);
  return ok('Queued.');
}
export function setMobilization(s: GameState, on: boolean): Result {
  P(s).mobilize = on;
  return ok(on ? `Mobilisation ordered: readiness and manpower rise over ${ECON.MOBILIZATION_DAYS} days; upkeep +${Math.round((ECON.MOBILIZED_UPKEEP - 1) * 100)}%, output −${Math.round((1 - ECON.MOBILIZED_OUTPUT) * 100)}%.` : 'Demobilisation ordered.');
}
export function doRecruit(s: GameState, type: UnitType, province: number, armyId: number | null = null): Result {
  const r = recruit(s, P(s), type, province, armyId);
  return r.ok ? ok(`${UNITS[type].label} recruited (${fmt(r.cost)}); training ${r.days} days in ${PROV[province].name}.`) : fail(r.reason ?? 'Cannot recruit.');
}
export function cancelTraining(s: GameState, id: number): Result {
  const n = P(s);
  const t = n.training.find((x) => x.id === id);
  if (!t) return fail('Not found.');
  n.training = n.training.filter((x) => x.id !== id);
  n.manpower += UNITS[t.type].personnel;
  return ok('Training cancelled; recruits returned to the manpower pool (fees are not refunded).');
}
export function setProduction(s: GameState, kind: EquipKind, factories: number): Result {
  const n = P(s);
  let line = n.production.find((l) => l.kind === kind);
  if (!line) { line = { id: s.nextId++, kind, factories: 0 }; n.production.push(line); }
  line.factories = Math.max(0, Math.round(factories));
  return ok('Production updated.');
}
export function build(s: GameState, province: number, kind: BuildingKind | 'repair' | 'develop' | 'integrate'): Result {
  const r = startConstruction(s, P(s), province, kind);
  return r.ok ? ok(`Started for ${fmt(r.cost)}; ${r.days} days.`) : fail(r.reason ?? 'Cannot build.');
}
export function cancelBuild(s: GameState, id: number): Result { cancelConstruction(s, P(s), id); return ok('Cancelled (50% of the remaining value refunded).'); }
export function takeLoan(s: GameState, amount: number): Result { const e = borrow(s, P(s), amount); return e ? fail(e) : ok(`Borrowed ${fmt(amount)}.`); }
export function repayLoan(s: GameState, amount: number): Result { const e = repay(s, P(s), amount); return e ? fail(e) : ok(`Repaid ${fmt(amount)}.`); }

export function moveArmy(s: GameState, armyId: number, to: number): Result & { days?: number } {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  if (a.battleId != null) return fail('Army is engaged in battle.');
  if (a.embarked) return fail('Army is at sea.');
  if (to === a.location) { a.path = []; a.moveProgress = 0; a.seaDest = null; return ok('Halted.'); }
  const path = findPath(s, a, to);
  if (!path) {
    // overseas: march to the best port and sail
    const r = orderInvasion(s, [a], to);
    if (!r.ok) return fail(`No land route to ${PROV[to].name}, and no naval transport: ${r.reason}`);
    flag(s, 'moved');
    return { ...ok(r.port === a.location ? `${a.name} boarding ships at ${PROV[a.location].name} for ${PROV[to].name} (~${r.days} days).` : `${a.name} marching to ${PROV[r.port!].name} to sail for ${PROV[to].name} (~${r.days} days in all).`), days: r.days };
  }
  a.path = path; a.moveProgress = 0; a.seaDest = null;
  flag(s, 'moved');
  const days = pathDays(s, a, path);
  return { ...ok(`${a.name} marching to ${PROV[to].name} (~${Math.ceil(days)} days).`), days };
}
export function seaMove(s: GameState, armyId: number, to: number): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  const r = embark(s, a, to);
  return r.ok ? ok(`Embarked for ${PROV[to].name}: ${r.days} days at sea, cost ${fmt(r.cost)}${r.risk > 0.3 ? ' — WARNING: enemy naval superiority on route' : ''}.`) : fail(r.reason ?? 'Cannot embark.');
}
/** Set an army's posture; in battle it takes effect from the next day of fighting. */
export function setPosture(s: GameState, armyId: number, p: Posture): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  a.posture = p;
  const b = a.battleId != null ? s.battles[a.battleId] : undefined;
  if (b && b.result == null) {
    if (b.attacker.nation === a.owner && b.attacker.armyIds.includes(a.id)) b.attackerPosture = p;
    else if (b.defender.armyIds.includes(a.id)) b.defenderPosture = p;
    return ok(`Battle posture changed to ${p}: it applies from tomorrow's fighting.`);
  }
  return ok('Posture set.');
}
export function setStance(s: GameState, armyId: number, st: Stance): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  a.stance = st;
  return ok('Orders set.');
}
/** Give the same standing orders to every army (optionally only those at war's front). */
export function setAllStances(s: GameState, st: Stance): Result {
  let k = 0;
  for (const a of Object.values(s.armies)) if (a.owner === s.player) { a.stance = st; k++; }
  return ok(`${k} armies ordered to ${STANCE_TEXT[st]}.`);
}
const STANCE_TEXT: Record<Stance, string> = { hold: 'hold position', defend: 'defend the border', advance: 'advance and attack', withdraw: 'withdraw to home territory' };
/** Pull an army out of a battle: attackers break off, defenders fall back under rear-guard cover. */
export function retreatArmy(s: GameState, armyId: number): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  const b = a.battleId != null ? s.battles[a.battleId] : undefined;
  if (!b || b.result != null) return fail('This army is not in a battle.');
  if (b.attacker.armyIds.includes(a.id) && b.attacker.nation === a.owner) {
    a.battleId = null; a.path = []; a.moveProgress = 0; a.stance = 'hold'; a.seaDest = null;
    for (const u of a.units) u.org *= 0.85;
    invalidateArmies();
    return ok(`${a.name} breaks off the attack on ${PROV[b.province].name}.`);
  }
  b.defenderPosture = 'withdrawal';
  for (const id of b.defender.armyIds) { const d = s.armies[id]; if (d && d.owner === a.owner) d.posture = 'withdrawal'; }
  return ok(`Defenders of ${PROV[b.province].name} will withdraw after tomorrow's rear-guard action.`);
}
/** Order several armies to the same province (each finds its own route). */
export function moveArmies(s: GameState, armyIds: number[], to: number): Result {
  const moved: string[] = [], failed: string[] = [];
  // overseas: the whole group marches to one port and sails together
  const mine = armyIds.map((id) => s.armies[id]).filter((a): a is Army => !!a && a.owner === s.player && !a.battleId && !a.embarked);
  const overseas = mine.filter((a) => !findPath(s, a, to));
  if (overseas.length) {
    const r = orderInvasion(s, overseas, to);
    if (r.ok) moved.push(...overseas.map((a) => a.name)); else failed.push(...overseas.map((a) => a.name));
    if (!r.ok && overseas.length === mine.length) return fail(`Naval invasion of ${PROV[to].name} not possible: ${r.reason}`);
    armyIds = armyIds.filter((id) => !overseas.some((a) => a.id === id));
    if (r.ok && !armyIds.length) return ok(`${overseas.length} ${overseas.length === 1 ? 'army' : 'armies'} will sail together from ${PROV[r.port!].name} for ${PROV[to].name} (~${r.days} days in all).`);
  }
  for (const id of armyIds) {
    const a = s.armies[id];
    if (!a || a.owner !== s.player) continue;
    const r = moveArmy(s, id, to);
    (r.ok ? moved : failed).push(a.name);
  }
  if (!moved.length) return fail(failed.length ? `None of the selected armies can reach ${PROV[to].name} (in battle, at sea or no route).` : 'No armies selected.');
  return ok(`${moved.length} ${moved.length === 1 ? 'army' : 'armies'} marching to ${PROV[to].name}${failed.length ? ` (${failed.length} could not move)` : ''}.`);
}
export function renameArmy(s: GameState, armyId: number, name: string): Result { const a = s.armies[armyId]; if (a && name.trim()) a.name = name.trim().slice(0, 40); return ok('Renamed.'); }
export function splitArmy(s: GameState, armyId: number, unitIds: number[]): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player || a.battleId || a.path.length) return fail('Army must be idle to reorganise.');
  const moving = a.units.filter((u) => unitIds.includes(u.id));
  if (!moving.length || moving.length === a.units.length) return fail('Select some (not all) formations.');
  a.units = a.units.filter((u) => !unitIds.includes(u.id));
  const b = createArmy(s, a.owner, a.location, moving);
  b.supply = a.supply; b.posture = a.posture; b.entrench = a.entrench;
  return ok(`Formed ${b.name}.`);
}
export function mergeArmies(s: GameState, intoId: number, fromId: number): Result {
  const a = s.armies[intoId], b = s.armies[fromId];
  if (!a || !b || a.owner !== s.player || b.owner !== s.player) return fail('Invalid armies.');
  if (a.location !== b.location || a.battleId || b.battleId || a.embarked || b.embarked) return fail('Armies must be idle in the same province.');
  if (a.units.length + b.units.length > MIL.MAX_ARMY_UNITS) return fail(`An army can hold at most ${MIL.MAX_ARMY_UNITS} formations.`);
  a.units.push(...b.units);
  a.supply = Math.min(a.supply, b.supply);
  if (a.generalId == null && b.generalId != null) assignGeneral(s, b.generalId, a.id);
  deleteArmy(s, b.id);
  return ok('Armies merged.');
}
export function disbandUnit(s: GameState, armyId: number, unitId: number): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player || a.battleId) return fail('Cannot disband now.');
  const u = a.units.find((x) => x.id === unitId);
  if (!u) return fail('Not found.');
  a.units = a.units.filter((x) => x.id !== unitId);
  P(s).manpower += u.strength * 0.9;
  if (!a.units.length) deleteArmy(s, a.id);
  invalidateArmies();
  return ok(`${UNITS[u.type].label} disbanded; personnel returned to the reserve. Its equipment is scrapped.`);
}
/** Disband several formations of one army at once (all of them dissolves the army). */
export function disbandUnits(s: GameState, armyId: number, unitIds: number[]): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  if (a.battleId != null) return fail(`${a.name} is in battle: retreat first.`);
  if (a.embarked) return fail(`${a.name} is at sea.`);
  const drop = new Set(unitIds);
  const gone = a.units.filter((u) => drop.has(u.id));
  if (!gone.length) return fail('Tick the formations to disband.');
  const men = gone.reduce((t, u) => t + u.strength, 0);
  P(s).manpower += men * 0.9;
  a.units = a.units.filter((u) => !drop.has(u.id));
  const all = !a.units.length;
  if (all) deleteArmy(s, a.id);
  invalidateArmies();
  return ok(`${all ? `${a.name} disbanded` : `${gone.length} formation${gone.length > 1 ? 's' : ''} of ${a.name} disbanded`}: ${Math.round(men * 0.9).toLocaleString()} soldiers returned to the reserve; the equipment is scrapped.`);
}
/** Disband whole armies at once (not those in battle or at sea). */
export function disbandArmies(s: GameState, armyIds: number[]): Result {
  let k = 0, formations = 0, men = 0, busy = 0;
  for (const id of armyIds) {
    const a = s.armies[id];
    if (!a || a.owner !== s.player) continue;
    if (a.battleId != null || a.embarked) { busy++; continue; }
    formations += a.units.length;
    men += a.units.reduce((t, u) => t + u.strength, 0);
    deleteArmy(s, a.id);
    k++;
  }
  P(s).manpower += men * 0.9;
  invalidateArmies();
  if (!k) return fail(busy ? 'Armies in battle or at sea cannot be disbanded.' : 'Select armies to disband.');
  return ok(`${k} ${k === 1 ? 'army' : 'armies'} disbanded (${formations} formations): ${Math.round(men * 0.9).toLocaleString()} soldiers returned to the reserve; the equipment is scrapped.${busy ? ` ${busy} in battle or at sea ${busy === 1 ? 'was' : 'were'} not.` : ''}`);
}
export function hireGeneral(s: GameState, generalId: number): Result {
  const g = s.generals[generalId];
  const n = P(s);
  if (!g || g.owner !== s.player || !g.available) return fail('Not available.');
  if (n.treasury < g.hireCost) return fail('Insufficient funds.');
  n.treasury -= g.hireCost;
  g.available = false;
  return ok(`${g.name} appointed for ${fmt(g.hireCost)} (salary $0.25M/yr).`);
}
export function doAssignGeneral(s: GameState, generalId: number, armyId: number | null): Result {
  const g = s.generals[generalId];
  if (!g || g.owner !== s.player || g.available) return fail('Hire the general first.');
  assignGeneral(s, generalId, armyId);
  return ok(armyId != null ? `${g.name} takes command of ${s.armies[armyId]?.name}.` : `${g.name} placed in reserve.`);
}

export function doDeclareWar(s: GameState, target: string): Result {
  const r = declareWar(s, P(s), target);
  return r.ok ? ok(`War declared on ${s.nations[target].name}. Stability −${r.stabilityCost}, infamy +${r.infamy}.`) : fail(r.reason ?? 'Cannot declare war.');
}
export function doTreaty(s: GameState, target: string, kind: 'alliance' | 'trade' | 'nap'): Result { const r = proposeTreaty(s, P(s), target, kind); return { ok: r.ok, message: r.reason }; }
export function doCancelTreaty(s: GameState, target: string, kind: 'alliance' | 'trade'): Result { cancelTreaty(s, s.player, target, kind); return ok('Treaty cancelled.'); }
export function doMission(s: GameState, target: string): Result { const r = diplomaticMission(s, P(s), target); return { ok: r.ok, message: r.reason }; }
export function doUltimatum(s: GameState, target: string, provinces: number[], vassal = false): Result { const r = ultimatum(s, P(s), target, provinces, vassal); return { ok: r.ok, message: r.reason }; }
export function doAnnexSubject(s: GameState, target: string): Result { const r = annexSubject(s, P(s), target); return { ok: r.ok, message: r.reason }; }
export function doRelease(s: GameState, target: string): Result { const e = releaseSubject(s, P(s), target); return e ? fail(e) : ok('Subject state released.'); }
export function doProvinceStatus(s: GameState, p: number, st: 'occupied' | 'autonomous'): Result { const e = setProvinceStatus(s, P(s), p, st); return e ? fail(e) : ok(st === 'autonomous' ? 'Autonomy granted: lower resistance and costs, reduced taxes, cannot recruit.' : 'Placed under direct military administration.'); }

export function proposePeace(s: GameState, warId: number, terms: PeaceTerms): Result {
  const w = s.wars.find((x) => x.id === warId);
  if (!w) return fail('War not found.');
  if (w.leaderA !== s.player && w.leaderD !== s.player) return fail('Only war leaders can negotiate.');
  const enemy = w.leaderA === s.player ? w.leaderD : w.leaderA;
  if (s.nations[enemy]?.isPlayer) return offerToHuman(s, w.id, enemy, { ...terms, taker: terms.white ? null : s.player });
  if (terms.white) {
    const ev = evaluatePeace(s, w, s.player, terms);
    if (!ev.accept) return fail(ev.reason);
    makePeace(s, w, s.player, terms);
    return ok('White peace signed.');
  }
  const ev = evaluatePeace(s, w, s.player, { ...terms, taker: s.player });
  if (!ev.accept) return fail(`${s.nations[enemy].name} refuses: ${ev.reason}`);
  makePeace(s, w, s.player, { ...terms, taker: s.player });
  return ok('Peace treaty signed.');
}
/** Concede to the enemy: give them provinces/reparations to end the war. */
export function concedePeace(s: GameState, warId: number, terms: PeaceTerms): Result {
  const w = s.wars.find((x) => x.id === warId);
  if (!w) return fail('War not found.');
  const enemy = w.leaderA === s.player ? w.leaderD : w.leaderA;
  if (s.nations[enemy]?.isPlayer) return offerToHuman(s, w.id, enemy, { ...terms, taker: enemy });
  const ev = evaluatePeace(s, w, enemy, { ...terms, taker: enemy });
  // AI accepts concessions that are at least what it thinks it earned (it cannot refuse a generous offer)
  const demand = Math.max(0, ev.score - (s.nations[enemy].warExhaustion * 0.35));
  if (ev.cost + 3 < demand * 0.8) return fail(`${s.nations[enemy].name} wants more (they feel entitled to ~${demand.toFixed(0)} war score of terms; offered ${ev.cost.toFixed(0)}).`);
  makePeace(s, w, enemy, { ...terms, taker: enemy });
  return ok('Peace signed on their terms.');
}
/** Peace terms between two human players need the other side's consent. */
function offerToHuman(s: GameState, warId: number, enemy: string, terms: PeaceTerms): Result {
  s.peaceOffers = s.peaceOffers.filter((o) => !(o.warId === warId && o.from === s.player));
  s.peaceOffers.push({ id: s.nextId++, from: s.player, to: enemy, warId, day: s.day, terms });
  addEvent(s, 'peace', `${s.nations[s.player].name} offers peace to ${s.nations[enemy].name}.`, [s.player, enemy], { important: true });
  return ok(`Offer sent to ${s.nations[enemy].name}. They will answer in their Diplomacy panel.`);
}
export function answerPeaceOffer(s: GameState, offerId: number, accept: boolean): Result {
  const o = s.peaceOffers.find((x) => x.id === offerId);
  if (!o) return fail('Offer expired.');
  if (o.to !== s.player) return fail('That offer was not made to you.');
  s.peaceOffers = s.peaceOffers.filter((x) => x.id !== offerId);
  if (!accept) { addEvent(s, 'peace', `You rejected ${s.nations[o.from].name}'s peace offer.`, [s.player, o.from]); return ok('Rejected.'); }
  const w = s.wars.find((x) => x.id === o.warId);
  if (!w) return fail('The war has already ended.');
  makePeace(s, w, o.terms.white ? o.from : o.terms.taker ?? o.from, o.terms);
  return ok('Peace accepted.');
}
export function answerProposal(s: GameState, id: number, accept: boolean): Result {
  const p = s.proposals.find((x) => x.id === id);
  if (!p) return fail('Expired.');
  if (p.to !== s.player) return fail('That proposal was not made to you.');
  if (p.kind === 'callToArms') { answerCallToArms(s, id, accept); return ok(accept ? 'You have joined the war.' : 'You declined.'); }
  s.proposals = s.proposals.filter((x) => x.id !== id);
  if (accept) applyTreaty(s, p.from, p.to, p.kind);
  return ok(accept ? 'Treaty signed.' : 'Declined.');
}
export function doMoveFleet(s: GameState, fleetId: number, zone: number): Result {
  const f = s.fleets[fleetId];
  if (!f || f.owner !== s.player) return fail('Not your fleet.');
  const e = moveFleet(s, f, zone);
  return e ? fail(e) : ok(`${f.name} sailing.`);
}
export function doOrderShip(s: GameState, type: ShipType, port: number): Result { const e = orderShip(s, P(s), type, port); return e ? fail(e) : ok('Keel laid down.'); }

// ---------------------------------------------------------------- air force
const myWing = (s: GameState, id: number) => { const w = s.airWings?.[id]; return w && w.owner === s.player ? w : null; };
/** Give an air wing a mission (bombing: an enemy province; naval strike: a sea zone). */
export function doWingMission(s: GameState, wingId: number, mission: AirMission, target: number | null = null): Result {
  const w = myWing(s, wingId);
  if (!w) return fail('Not your air wing.');
  if (!AIR_MISSION_INFO[mission]) return fail('Unknown mission.');
  const e = setMission(s, w, mission, target);
  if (e) return fail(e);
  const where = mission === 'bombing' && target != null ? ` ${PROV[target].name}` : mission === 'naval' && target != null ? ` in the ${WORLD.seas[target].name}` : '';
  return ok(`${w.name}: ${AIR_MISSION_INFO[mission].label.toLowerCase()}${where}.`);
}
/** Move an air wing to another airbase (a province you hold). */
export function doRebaseWing(s: GameState, wingId: number, province: number): Result {
  const w = myWing(s, wingId);
  if (!w) return fail('Not your air wing.');
  const e = rebaseWing(s, w, province);
  return e ? fail(e) : ok(province === w.base ? `${w.name} stays at ${PROV[province].name}.` : `${w.name} relocating to ${PROV[province].name} (${w.rebase?.days ?? 1} days).`);
}
export function doRenameWing(s: GameState, wingId: number, name: string): Result {
  const w = myWing(s, wingId);
  if (!w) return fail('Not your air wing.');
  w.name = String(name).slice(0, 40).trim() || w.name;
  return ok('Renamed.');
}
/** Retire a whole air wing at once. */
export function doDisbandWing(s: GameState, wingId: number): Result {
  const w = myWing(s, wingId);
  if (!w) return fail('Not your air wing.');
  const crews = w.units.reduce((t, u) => t + u.strength, 0);
  P(s).manpower += crews * 0.9;
  delete s.airWings[w.id];
  return ok(`${w.name} retired (${w.units.length} squadron${w.units.length === 1 ? '' : 's'}): the crews return to the reserve and the aircraft are scrapped.`);
}
/** Decommission a fleet: the sailors return to the manpower pool, the ships are scrapped. */
export function doDecommissionFleet(s: GameState, fleetId: number): Result {
  const f = s.fleets[fleetId];
  if (!f || f.owner !== s.player) return fail('Not your fleet.');
  let crews = 0;
  for (const k in f.ships) crews += SHIPS[k as ShipType].personnel * f.ships[k as ShipType];
  P(s).manpower += crews * 0.9;
  delete s.fleets[f.id];
  return ok(`${f.name} decommissioned: ${Math.round(crews * 0.9).toLocaleString()} sailors return to the reserve.`);
}
/** Retire one squadron: its crews return to the manpower pool. */
export function doDisbandSquadron(s: GameState, wingId: number, unitId: number): Result {
  const w = myWing(s, wingId);
  if (!w) return fail('Not your air wing.');
  const u = w.units.find((x) => x.id === unitId);
  if (!u) return fail('No such squadron.');
  w.units = w.units.filter((x) => x !== u);
  P(s).manpower += u.strength * 0.9;
  if (!w.units.length) delete s.airWings[w.id];
  return ok(`${UNITS[u.type].label} retired.`);
}
export function markTutorial(s: GameState, f: string) { flag(s, f); }
export function haltArmy(s: GameState, armyId: number): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  if (a.battleId != null) return fail('The army is engaged in battle.');
  a.path = []; a.moveProgress = 0; a.seaDest = null;
  return ok(`${a.name} halted.`);
}
export function pauseProduction(s: GameState): Result {
  for (const l of P(s).production) l.factories = 0;
  return ok('All production lines paused.');
}
/** Host only: hand a disconnected human's nation to the AI (or take it back). */
export function setHumanControl(s: GameState, nation: string, human: boolean): Result {
  const n = s.nations[nation];
  if (!n) return fail('Unknown nation.');
  if (nation === s.player) return fail('You cannot hand over your own nation.');
  n.isPlayer = human;
  s.players = human ? [...new Set([...s.players, nation])] : s.players.filter((x) => x !== nation);
  addEvent(s, 'info', `${n.name} is now controlled by ${human ? 'a human player' : 'the AI'}.`, [nation], { important: true });
  return ok(`${n.name} is now ${human ? 'human' : 'AI'}-controlled.`);
}

export function doBuyMunitions(s: GameState, kind: 'drone' | 'missile' | 'ballistic' | 'recon', count: number): Result {
  const e = buyMunitions(s, P(s), kind, count);
  return e ? fail(e) : ok(`Bought ${count} ${STRIKES[kind].plural}. Launch them from the War Room or an enemy province's panel.`);
}
export function doStrike(s: GameState, kind: StrikeKind, province: number, count: number): Result {
  const r = launchStrike(s, P(s), kind, province, count);
  return { ok: r.ok, message: r.message };
}
export function doNuclearProgram(s: GameState): Result {
  const e = startNuclearProgram(s, P(s));
  return e ? fail(e) : ok(`Nuclear programme started: about ${Math.round(NUKE.programDays / 365 * 10) / 10} years to the first weapon.`);
}
export function doBuildWarhead(s: GameState): Result {
  const e = buildWarhead(s, P(s));
  return e ? fail(e) : ok(`ICBM ordered: ready in ${NUKE.warheadDays} days.`);
}
/** Send every idle army next to (or in) a province into it at once. */
export function attackWithAll(s: GameState, province: number): Result {
  const ids = Object.values(s.armies).filter((a) => a.owner === s.player && a.battleId == null && !a.embarked && (PROV[province].neighbors.includes(a.location) || PROV[province].straits.includes(a.location))).map((a) => a.id);
  if (!ids.length) return fail(`None of your armies are next to ${PROV[province].name}.`);
  return moveArmies(s, ids, province);
}
/** Add a destination after the army's current route (waypoints). */
export function queueMove(s: GameState, armyId: number, to: number): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  if (!a.path.length || a.battleId != null) return moveArmy(s, armyId, to);
  const from = a.path[a.path.length - 1];
  const leg = findPath(s, { ...a, location: from }, to);
  if (!leg) return fail(`No route from ${PROV[from].name} to ${PROV[to].name}.`);
  a.path.push(...leg);
  return ok(`${a.name}: waypoint added — then on to ${PROV[to].name}.`);
}
/** Split an army into two halves (by formations). */
export function splitHalf(s: GameState, armyId: number): Result {
  const a = s.armies[armyId];
  if (!a || a.owner !== s.player) return fail('Not your army.');
  if (a.units.length < 2) return fail('Needs at least two formations.');
  return splitArmy(s, armyId, a.units.filter((_, i) => i % 2 === 1).map((u) => u.id));
}

// ---------------------------------------------------------------- government
const r0 = (e: string | null, msg: string): Result => (e ? fail(e) : ok(msg));
export function doSetServices(s: GameState, level: number): Result { return r0(setServices(s, P(s), level), `Public services set to ${Math.round(P(s).gov.services * 100)}%.`); }
export function doSetPolicy(s: GameState, area: PolicyArea, option: string): Result { return r0(setPolicy(s, P(s), area, option), `${POLICY_AREAS[area]?.label}: ${POLICY_AREAS[area]?.options[option]?.label} adopted (−${POLICY_CHANGE_STABILITY} stability during the transition).`); }
export function doDecree(s: GameState, id: string): Result { return r0(issueDecree(s, P(s), id), `${DECREES[id]?.label} decreed.`); }
export function doInvestFund(s: GameState, amount: number): Result { return r0(investFund(s, P(s), amount), `Invested ${fmt(amount)} in the sovereign wealth fund.`); }
export function doWithdrawFund(s: GameState, amount: number): Result { return r0(withdrawFund(s, P(s), amount), `Withdrew from the sovereign wealth fund (2% fee).`); }
export function doSetFocus(s: GameState, p: number, focus: ProvinceFocus | null): Result { return r0(setFocus(s, P(s), p, focus), focus ? `${PROV[p].name} now focuses on ${FOCUS[focus].label.toLowerCase()}.` : `${PROV[p].name} has no special focus.`); }
export function doSendAid(s: GameState, to: string, amount: number): Result { return r0(sendAid(s, P(s), to, amount), `Aid sent to ${s.nations[to]?.name}.`); }
export function doSanction(s: GameState, to: string): Result { const on = !P(s).gov.sanctions.includes(to); return r0(toggleSanction(s, P(s), to), on ? `Sanctions imposed on ${s.nations[to]?.name}.` : `Sanctions on ${s.nations[to]?.name} lifted.`); }
export function doGuarantee(s: GameState, to: string): Result { const on = !P(s).gov.guarantees.includes(to); return r0(toggleGuarantee(s, P(s), to), on ? `You now guarantee ${s.nations[to]?.name}'s independence.` : 'Guarantee withdrawn.'); }
export function doSpyNetwork(s: GameState, to: string): Result { return r0(buildSpyNetwork(s, P(s), to), `Spy network in ${s.nations[to]?.name} expanded to ${Math.round((P(s).gov.spies[to] ?? 0) * 100)}%.`); }
export function doSpyOp(s: GameState, to: string, op: string): Result { return spyOp(s, P(s), to, op); }
export function doAnswerEvent(s: GameState, option: number): Result { return r0(resolveEvent(s, P(s), option), 'Decision taken.'); }

// ---------------------------------------------------------------- regime & interior
const rr = (r: string | null, msg: string): Result => (r == null ? ok(msg) : r.startsWith('#') ? ok(r.slice(1)) : fail(r));
export function doSetSecurity(s: GameState, level: number): Result { return rr(setSecurity(s, P(s), level), `Internal security: ${SECURITY[level]?.label}.`); }
export function doToggleCampaign(s: GameState, id: string): Result { const on = !P(s).regime.propaganda.includes(id); return rr(toggleCampaign(s, P(s), id), `${PROPAGANDA[id]?.label} ${on ? 'launched' : 'ended'}.`); }
export function doInterior(s: GameState, id: string): Result { return rr(interiorAction(s, P(s), id), `${INTERIOR[id]?.label}: done.`); }
export function doMartialLaw(s: GameState, p: number): Result { return rr(toggleMartialLaw(s, P(s), p), s.provinces[p]?.martialLaw ? `Martial law declared in ${PROV[p].name}.` : `Martial law lifted in ${PROV[p].name}.`); }
export function doWarEconomy(s: GameState, level: 'peace' | 'partial' | 'total'): Result { return rr(setWarEconomy(s, P(s), level), `${WAR_ECONOMY[level]?.label}.`); }
export function doRoe(s: GameState, roe: 'restrained' | 'standard' | 'ruthless'): Result { return rr(setRoe(s, P(s), roe), `Rules of engagement: ${ROE[roe]?.label}.`); }
export function doAirMission(s: GameState, mission: 'none' | 'cas' | 'bombing' | 'defense', target: string | null): Result { return rr(setAirMission(s, P(s), mission, target), `Air force: ${AIR_MISSIONS[mission]?.label}${target ? ` against ${s.nations[target]?.name}` : ''}.`); }
export function doBuySam(s: GameState): Result { return rr(buySam(s, P(s)), `Air-defence battery deployed (${P(s).regime.sam} total).`); }
// ---------------------------------------------------------------- war planning
export function doOperation(s: GameState, armyIds: number[], target: number): Result { return createOperation(s, P(s), armyIds, target); }
export function doCancelOperation(s: GameState, id: number): Result { return rr(cancelOperation(s, P(s), id), 'Operation cancelled.'); }
export function doAttackNearest(s: GameState, armyIds: number[]): Result { return attackNearest(s, P(s), armyIds); }
export function doDigIn(s: GameState, armyIds: number[]): Result { return digIn(s, P(s), armyIds); }
export function doScorched(s: GameState, p: number): Result { return rr(scorchedEarth(s, P(s), p), `${PROV[p].name} burned.`); }
export function doPartisans(s: GameState, p: number): Result { return rr(fundPartisans(s, P(s), p), `Partisans funded in ${PROV[p].name} for 120 days.`); }
export function doFortifyBorder(s: GameState): Result { return fortifyBorder(s, P(s)); }
export function doMercenaries(s: GameState, type: UnitType, p: number): Result { return rr(hireMercenaries(s, P(s), type, p), 'Mercenaries hired.'); }
export function doLicenseTech(s: GameState, tech: string): Result { return rr(licenseTech(s, P(s), tech), 'Technology licensed.'); }
/** Bulk orders for many armies at once. */
export function doStances(s: GameState, ids: number[], st: Stance): Result { let k = 0; for (const id of ids) { const a = s.armies[id]; if (a && a.owner === s.player) { a.stance = st; k++; } } return ok(`${k} armies: ${STANCE_TEXT[st]}.`); }
export function doHaltMany(s: GameState, ids: number[]): Result { let k = 0; for (const id of ids) { const a = s.armies[id]; if (a && a.owner === s.player && a.battleId == null) { a.path = []; a.moveProgress = 0; a.seaDest = null; k++; } } return ok(`${k} armies halted.`); }
export function doRetreatMany(s: GameState, ids: number[]): Result {
  let k = 0;
  for (const id of ids) {
    const a = s.armies[id];
    if (!a || a.owner !== s.player) continue;
    if (a.battleId != null) { if (retreatArmy(s, id).ok) k++; continue; }
    a.stance = 'withdraw'; a.path = []; a.seaDest = null; k++;
  }
  return ok(`${k} armies falling back to home territory.`);
}
export function doPostureMany(s: GameState, ids: number[], p: Posture): Result { let k = 0; for (const id of ids) if (s.armies[id]?.owner === s.player) { setPosture(s, id, p); k++; } return ok(`${k} armies: ${p} posture.`); }
export function doMergeMany(s: GameState, ids: number[]): Result {
  const byLoc = new Map<number, Army[]>();
  for (const id of ids) { const a = s.armies[id]; if (a && a.owner === s.player && a.battleId == null && !a.path.length && !a.embarked) (byLoc.get(a.location) || byLoc.set(a.location, []).get(a.location)!).push(a); }
  let k = 0;
  for (const list of byLoc.values()) for (const o of list.slice(1)) if (mergeArmies(s, list[0].id, o.id).ok) k++;
  return k ? ok(`${k} armies merged.`) : fail('Merging needs two or more selected armies halted in the same province.');
}

export function peaceTermsFor(s: GameState, warId: number): { war: ReturnType<typeof warBetween> } { return { war: s.wars.find((w) => w.id === warId) }; }
export type { Army };
export { armyStrength };
