/**
 * Command registry. Every change a player makes goes through `runCommand`, so it can be sent
 * over the network and replayed identically on every computer in a multiplayer game.
 */
import type { GameState, Nation } from './types';
import * as A from './actions';
import { aggregate, computeBudget } from './economy';
import { invalidateArmies } from './world';

export const COMMANDS = {
  setTax: A.setTax, setResearchFunding: A.setResearchFunding, chooseResearch: A.chooseResearch, queueResearch: A.queueResearch,
  setMobilization: A.setMobilization, doRecruit: A.doRecruit, cancelTraining: A.cancelTraining, setProduction: A.setProduction,
  pauseProduction: A.pauseProduction, build: A.build, cancelBuild: A.cancelBuild, takeLoan: A.takeLoan, repayLoan: A.repayLoan,
  moveArmy: A.moveArmy, seaMove: A.seaMove, haltArmy: A.haltArmy, setPosture: A.setPosture, setStance: A.setStance,
  renameArmy: A.renameArmy, splitArmy: A.splitArmy, mergeArmies: A.mergeArmies, disbandUnit: A.disbandUnit,
  hireGeneral: A.hireGeneral, doAssignGeneral: A.doAssignGeneral, doDeclareWar: A.doDeclareWar, doTreaty: A.doTreaty,
  doCancelTreaty: A.doCancelTreaty, doMission: A.doMission, doUltimatum: A.doUltimatum, doAnnexSubject: A.doAnnexSubject,
  doRelease: A.doRelease, doProvinceStatus: A.doProvinceStatus, proposePeace: A.proposePeace, concedePeace: A.concedePeace,
  answerPeaceOffer: A.answerPeaceOffer, answerProposal: A.answerProposal, doMoveFleet: A.doMoveFleet, doOrderShip: A.doOrderShip,
  setHumanControl: A.setHumanControl, setAllStances: A.setAllStances, retreatArmy: A.retreatArmy, moveArmies: A.moveArmies,
  doBuyMunitions: A.doBuyMunitions, doStrike: A.doStrike, doNuclearProgram: A.doNuclearProgram, doBuildWarhead: A.doBuildWarhead,
  attackWithAll: A.attackWithAll, queueMove: A.queueMove, splitHalf: A.splitHalf,
  doSetServices: A.doSetServices, doSetPolicy: A.doSetPolicy, doDecree: A.doDecree, doInvestFund: A.doInvestFund, doWithdrawFund: A.doWithdrawFund,
  doSetFocus: A.doSetFocus, doSendAid: A.doSendAid, doSanction: A.doSanction, doGuarantee: A.doGuarantee, doSpyNetwork: A.doSpyNetwork,
  doSpyOp: A.doSpyOp, doAnswerEvent: A.doAnswerEvent,
  doSetSecurity: A.doSetSecurity, doToggleCampaign: A.doToggleCampaign, doInterior: A.doInterior, doMartialLaw: A.doMartialLaw,
  doWarEconomy: A.doWarEconomy, doRoe: A.doRoe, doAirMission: A.doAirMission, doBuySam: A.doBuySam,
  doOperation: A.doOperation, doCancelOperation: A.doCancelOperation, doAttackNearest: A.doAttackNearest, doDigIn: A.doDigIn,
  doScorched: A.doScorched, doPartisans: A.doPartisans, doFortifyBorder: A.doFortifyBorder, doMercenaries: A.doMercenaries,
  doLicenseTech: A.doLicenseTech, doStances: A.doStances, doHaltMany: A.doHaltMany, doRetreatMany: A.doRetreatMany,
  doPostureMany: A.doPostureMany, doMergeMany: A.doMergeMany,
} as const;
export type CommandName = keyof typeof COMMANDS;
export const isCommand = (n: string): n is CommandName => Object.prototype.hasOwnProperty.call(COMMANDS, n);

/** Execute `name` on behalf of `nation`. Deterministic: same state + same command = same result everywhere. */
export function runCommand(s: GameState, nation: string, name: string, args: unknown[]): A.Result {
  if (!isCommand(name)) return { ok: false, message: 'Unknown command.' };
  if (!s.nations[nation]?.alive) return { ok: false, message: 'That nation no longer exists.' };
  const prev = s.player;
  s.player = nation;
  let r: A.Result | void;
  try {
    r = (COMMANDS[name] as (s: GameState, ...a: unknown[]) => A.Result | void)(s, ...(Array.isArray(args) ? args : []));
  } catch (e) {
    r = { ok: false, message: `Order failed: ${(e as Error).message}` };
  } finally {
    s.player = prev;
  }
  invalidateArmies();
  refreshBudget(s, s.nations[nation]);
  return r ?? { ok: true, message: '' };
}

/** Recompute one nation's budget so the UI reflects an order at once (identical on every client). */
export function refreshBudget(s: GameState, n: Nation | undefined) {
  if (!n) return;
  const ab = new Map<string, number[]>(); const fb = new Map<string, number[]>();
  for (const a of Object.values(s.armies)) if (a.owner === n.id) (ab.get(n.id) || ab.set(n.id, []).get(n.id)!).push(a.id);
  for (const f of Object.values(s.fleets)) if (f.owner === n.id) (fb.get(n.id) || fb.set(n.id, []).get(n.id)!).push(f.id);
  n.budget = computeBudget(s, n, aggregate(s, n, ab, fb));
}

/** Checksum of the simulation-relevant state (excludes logs, achievements and other per-viewer data). */
export function stateHash(s: GameState): string {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => { h ^= v | 0; h = Math.imul(h, 16777619) >>> 0; };
  const num = (x: number) => mix(Math.round(x * 1000));
  mix(s.day); mix(s.rng); mix(s.nextId);
  for (const id of Object.keys(s.nations).sort()) {
    const n = s.nations[id];
    if (!n.alive) continue;
    num(n.treasury); num(n.debt); num(n.stability); num(n.manpower / 100);
  }
  for (const p of s.provinces) { mix(p.owner.charCodeAt(0) * 31 + p.owner.charCodeAt(2)); mix(p.controller.charCodeAt(1)); num(p.damage); }
  for (const a of Object.values(s.armies)) { mix(a.id); mix(a.location); num(a.units.reduce((t, u) => t + u.strength, 0) / 10); }
  mix(s.wars.length); mix(s.activeBattles.length);
  return (h >>> 0).toString(36);
}
