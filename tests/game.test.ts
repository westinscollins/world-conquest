import { describe, it, expect } from 'vitest';
import { newGame, refreshAllBudgets } from '../src/engine/setup';
import { tick, runDays } from '../src/engine/sim';
import { PROV, NPROV, isAdjacent } from '../src/engine/geo';
import { recruit, recruitCost, unitUpkeep, findPath, createArmy, newUnit, armyStrength, checkRecruit, trainDays, militaryStrength } from '../src/engine/military';
import { computeBudget, aggregate, startConstruction, borrow, buildCost } from '../src/engine/economy';
import { battleDaily, startBattle } from '../src/engine/battle';
import { declareWar, makePeace, evaluatePeace, scoreFor } from '../src/engine/diplomacy';
import { setController, transferProvince } from '../src/engine/territory';
import { serialize, deserialize } from '../src/engine/save';
import { supplyDaily, supplyReport } from '../src/engine/supply';
import { ownedBy, armiesIn, atWar, invalidateArmies, neighborsOf } from '../src/engine/world';
import { moveArmy, doDeclareWar, proposePeace, build, hireGeneral, doAssignGeneral, setPosture, retreatArmy, setAllStances, moveArmies, doStrike, doBuyMunitions } from '../src/engine/actions';
import { UNITS, MIL } from '../src/engine/config';
import type { GameState, Army, UnitType } from '../src/engine/types';

const budgetOf = (s: GameState, id: string) => {
  const ab = new Map<string, number[]>(); const fb = new Map<string, number[]>();
  for (const a of Object.values(s.armies)) (ab.get(a.owner) || ab.set(a.owner, []).get(a.owner)!).push(a.id);
  for (const f of Object.values(s.fleets)) (fb.get(f.owner) || fb.set(f.owner, []).get(f.owner)!).push(f.id);
  return computeBudget(s, s.nations[id], aggregate(s, s.nations[id], ab, fb));
};

/** Two isolated armies fighting on a chosen province with controlled conditions. */
function duel(opts: { atk: UnitType[]; def: UnitType[]; terrainProv?: number; atkSupply?: number; defEntrench?: number; seed?: number }) {
  const s = newGame('serbia', { seed: opts.seed ?? 7 });
  s.settings.difficulty = 'hard'; // (the bare rules: no help for the player's side)
  // clear the world's armies to isolate the battle
  s.armies = {}; invalidateArmies();
  const prov = opts.terrainProv ?? s.nations.SRB.capital;
  const from = PROV[prov].neighbors[0];
  const atkN = s.provinces[from].owner === 'SRB' ? 'HUN' : s.provinces[from].owner;
  s.provinces[from].controller = atkN;
  declareWar(s, s.nations[atkN], s.provinces[prov].owner);
  const A = createArmy(s, atkN, from, opts.atk.map((t) => { const u = newUnit(s, t, 1, 0.2); u.org = 0.8; u.morale = 0.7; return u; }));
  const D = createArmy(s, s.provinces[prov].owner, prov, opts.def.map((t) => { const u = newUnit(s, t, 1, 0.2); u.org = 0.8; u.morale = 0.7; return u; }));
  A.lastSupplyRatio = opts.atkSupply ?? 1; D.lastSupplyRatio = 1; D.entrench = opts.defEntrench ?? 0.3;
  const b = startBattle(s, [A], prov, from)!;
  for (let i = 0; i < 40 && b.result == null; i++) { A.lastSupplyRatio = opts.atkSupply ?? 1; battleDaily(s, b); s.day++; }
  return { s, b };
}

describe('world map', () => {
  it('has provinces with valid symmetric adjacency', () => {
    expect(NPROV).toBeGreaterThan(500);
    for (const p of PROV) {
      for (const n of p.neighbors) expect(PROV[n].neighbors).toContain(p.id);
      for (const n of p.straits) expect(PROV[n].straits).toContain(p.id);
    }
  });
  it('every province is reachable by land, strait or sea', () => {
    for (const p of PROV) expect(p.neighbors.length + p.straits.length + p.seas.length).toBeGreaterThan(0);
  });
});

describe('economy', () => {
  it('starts the small-nation campaign at the calibrated budget', () => {
    const s = newGame('serbia', { seed: 3 });
    const b = s.nations.SRB.budget;
    const tax = b.income.find((l) => l.key === 'tax')!.amount;
    const civ = b.expenses.filter((l) => ['services', 'admin', 'buildings'].includes(l.key)).reduce((t, l) => t + l.amount, 0);
    const mil = b.expenses.find((l) => l.key === 'military')!.amount;
    expect(s.nations.SRB.treasury).toBe(100);
    expect(tax).toBeGreaterThan(33); expect(tax).toBeLessThan(37);
    expect(civ).toBeGreaterThan(18); expect(civ).toBeLessThan(22);
    expect(mil).toBeGreaterThan(9); expect(mil).toBeLessThan(11.5);
    expect(b.net).toBeGreaterThan(3); expect(b.net).toBeLessThan(7);
  });
  it('ledger reconciles: income − expenses = net', () => {
    const s = newGame('germany', { seed: 1 });
    for (const n of Object.values(s.nations)) {
      const b = n.budget;
      expect(Math.abs(b.income.reduce((t, l) => t + l.amount, 0) - b.totalIncome)).toBeLessThan(1e-6);
      expect(Math.abs(b.expenses.reduce((t, l) => t + l.amount, 0) - b.totalExpense)).toBeLessThan(1e-6);
      expect(Math.abs(b.totalIncome - b.totalExpense - b.net)).toBeLessThan(1e-6);
    }
  });
  it('applies daily budget exactly once per day', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    const t0 = n.treasury;
    tick(s);
    expect(n.treasury - t0).toBeCloseTo(n.budget.net / 365, 1);
  });
  it('higher taxes raise revenue', () => {
    const s = newGame('serbia', { seed: 3 });
    const before = budgetOf(s, 'SRB').income[0].amount;
    s.nations.SRB.taxRate = 0.35;
    expect(budgetOf(s, 'SRB').income[0].amount).toBeGreaterThan(before * 1.3);
  });
  it('construction charges the stated cost and completes after its time', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB; const p = n.capital;
    const c = buildCost(s, n, p, 'road');
    const t0 = n.treasury, lvl = s.provinces[p].buildings.road;
    const r = startConstruction(s, n, p, 'road');
    expect(r.ok).toBe(true);
    expect(t0 - n.treasury).toBeCloseTo(c.cost, 6);
    runDays(s, c.days + 1);
    expect(s.provinces[p].buildings.road).toBe(lvl + 1);
  });
  it('borrowing respects the debt ceiling', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    expect(borrow(s, n, 50)).toBeNull();
    expect(borrow(s, n, 10000)).not.toBeNull();
  });
});

describe('military', () => {
  it('recruitment costs money and manpower and takes training time', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    const t0 = n.treasury, m0 = n.manpower;
    const before = Object.values(s.armies).filter((a) => a.owner === 'SRB').reduce((t, a) => t + a.units.length, 0);
    const r = recruit(s, n, 'infantry', n.capital);
    expect(r.ok).toBe(true);
    expect(t0 - n.treasury).toBeCloseTo(recruitCost('infantry', n), 6);
    expect(m0 - n.manpower).toBe(UNITS.infantry.personnel);
    runDays(s, trainDays('infantry', n) - 2);
    expect(Object.values(s.armies).filter((a) => a.owner === 'SRB').reduce((t, a) => t + a.units.length, 0)).toBe(before);
    runDays(s, 3);
    expect(Object.values(s.armies).filter((a) => a.owner === 'SRB').reduce((t, a) => t + a.units.length, 0)).toBe(before + 1);
  });
  it('units deploy fully equipped, and the price includes their equipment', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    expect(recruitCost('armored', n)).toBeGreaterThan(recruitCost('infantry', n) * 2);
    recruit(s, n, 'infantry', n.capital);
    runDays(s, trainDays('infantry', n) + 1);
    const newest = Object.values(s.armies).filter((a) => a.owner === 'SRB').flatMap((a) => a.units).sort((a, b) => b.id - a.id)[0];
    expect(newest.type).toBe('infantry');
    expect(newest.equipment).toBe(1);
  });
  it('factories make units cheaper and faster to train', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    n.lastFactories = 0;
    const c0 = recruitCost('armored', n), d0 = trainDays('armored', n);
    n.lastFactories = 10;
    expect(recruitCost('armored', n)).toBeLessThan(c0 * 0.85);
    expect(trainDays('armored', n)).toBeLessThan(d0);
  });
  it('military strength is a stable number that only changes with actions', () => {
    const s = newGame('serbia', { seed: 5 });
    const n = s.nations.SRB;
    const p0 = militaryStrength(s, 'SRB');
    expect(p0).toBeGreaterThan(0);
    runDays(s, 20);
    expect(militaryStrength(s, 'SRB')).toBe(p0);
    recruit(s, n, 'armored', n.capital);
    expect(militaryStrength(s, 'SRB')).toBe(p0 + UNITS.armored.points);
  });
  it('upkeep is derived consistently from the central config', () => {
    for (const t of Object.keys(UNITS) as UnitType[]) {
      const u = UNITS[t];
      const expected = u.personnel * MIL.SOLDIER_WAGE + Object.values(u.equip).reduce((a, b) => a + (b ?? 0), 0) * MIL.EQUIP_MAINT + (u.supply * MIL.SUPPLY_PRICE + u.fuel * MIL.FUEL_PRICE_PER_OIL) * 365 * MIL.PEACE_SUPPLY_FACTOR;
      expect(unitUpkeep(t)).toBeCloseTo(expected, 9);
    }
  });
  it('cannot recruit without funds', () => {
    const s = newGame('serbia', { seed: 3 });
    s.nations.SRB.treasury = 0;
    expect(checkRecruit(s, s.nations.SRB, 'armored', s.nations.SRB.capital).ok).toBe(false);
  });
});

describe('movement and adjacency', () => {
  it('paths only traverse adjacent provinces', () => {
    const s = newGame('poland', { seed: 3 });
    const a = Object.values(s.armies).find((x) => x.owner === 'POL')!;
    const target = ownedBy(s, 'POL').find((p) => p !== a.location)!;
    const path = findPath(s, a, target)!;
    let cur = a.location;
    for (const p of path) { expect(isAdjacent(cur, p)).toBe(true); cur = p; }
  });
  it('armies cannot enter neutral nations', () => {
    const s = newGame('serbia', { seed: 3 });
    const a = Object.values(s.armies).find((x) => x.owner === 'SRB')!;
    const foreign = PROV[a.location].neighbors.find((p) => s.provinces[p].owner !== 'SRB')!;
    expect(findPath(s, a, foreign)).toBeNull();
  });
  it('an ordered army reaches its destination over time', () => {
    const s = newGame('poland', { seed: 3 });
    const a = Object.values(s.armies).find((x) => x.owner === 'POL')!;
    const target = ownedBy(s, 'POL').find((p) => p !== a.location && isAdjacent(p, a.location))!;
    expect(moveArmy(s, a.id, target).ok).toBe(true);
    runDays(s, 30);
    expect(s.armies[a.id].location).toBe(target);
  });
});

describe('battles', () => {
  it('is deterministic for identical conditions', () => {
    const r1 = duel({ atk: ['infantry', 'infantry', 'infantry', 'artillery'], def: ['infantry', 'infantry'], seed: 11 });
    const r2 = duel({ atk: ['infantry', 'infantry', 'infantry', 'artillery'], def: ['infantry', 'infantry'], seed: 11 });
    expect(r1.b.result).toBe(r2.b.result);
    expect(r1.b.timeline.length).toBe(r2.b.timeline.length);
    expect(r1.b.attacker.losses.killed).toBe(r2.b.attacker.losses.killed);
  });
  it('takes several days and reports phases, losses and factors', () => {
    const { b } = duel({ atk: ['infantry', 'infantry', 'infantry', 'artillery'], def: ['infantry', 'infantry'] });
    expect(b.result).not.toBeNull();
    expect(b.timeline.length).toBeGreaterThan(1);
    expect(b.timeline[0].phase).toBe('Initial engagement');
    expect(b.attacker.losses.killed + b.attacker.losses.wounded).toBeGreaterThan(0);
    expect(b.defender.losses.equipmentValue).toBeGreaterThan(0);
    expect(b.factors.length).toBeGreaterThan(3);
    expect(b.summary.length).toBeGreaterThan(10);
  });
  it('superior forces usually win on open ground', () => {
    let wins = 0;
    for (let seed = 1; seed <= 8; seed++) if (duel({ atk: ['infantry', 'infantry', 'infantry', 'infantry', 'artillery', 'artillery', 'armored'], def: ['infantry', 'infantry'], seed }).b.result === 'attacker') wins++;
    expect(wins).toBeGreaterThanOrEqual(6);
  });
  it('a larger army out of supply struggles against a smaller entrenched one', () => {
    let atkWins = 0, wellSuppliedWins = 0;
    for (let seed = 1; seed <= 6; seed++) {
      if (duel({ atk: ['infantry', 'infantry', 'infantry', 'infantry', 'infantry'], def: ['infantry', 'infantry', 'infantry'], atkSupply: 0.05, defEntrench: 1, seed }).b.result === 'attacker') atkWins++;
      if (duel({ atk: ['infantry', 'infantry', 'infantry', 'infantry', 'infantry'], def: ['infantry', 'infantry', 'infantry'], atkSupply: 1, defEntrench: 0, seed }).b.result === 'attacker') wellSuppliedWins++;
    }
    expect(atkWins).toBeLessThan(wellSuppliedWins);
    expect(atkWins).toBeLessThanOrEqual(2);
  });
});

describe('supply', () => {
  it('armies deep in friendly territory are supplied; cut-off armies are not', () => {
    const s = newGame('poland', { seed: 3 });
    s.settings.difficulty = 'hard'; // (the bare rules: no minimum supply for the player)
    const n = s.nations.POL;
    const a = Object.values(s.armies).find((x) => x.owner === 'POL')!;
    supplyDaily(s, n, [a], true);
    expect(a.lastSupplyRatio).toBeGreaterThan(0.9);
    // place an army in an isolated foreign province we "control" with no link to our network
    const far = PROV.find((p) => p.country === 'AUS')!.id;
    s.provinces[far].controller = 'POL';
    const b = createArmy(s, 'POL', far, [newUnit(s, 'infantry')]);
    b.supply = 0;
    for (let i = 0; i < 3; i++) { s.day++; supplyDaily(s, n, [b], true); }
    expect(b.lastSupplyRatio).toBeLessThan(0.2);
    expect(supplyReport(s, b).causes.join(' ')).toMatch(/Cut off/);
  });
});

describe('war, territory and peace', () => {
  it('occupation, war score and a territorial peace transfer ownership', () => {
    const s = newGame('serbia', { seed: 5 });
    const me = s.nations.SRB;
    const target = neighborsOf(s, 'SRB').find((x) => ownedBy(s, x).length >= 2)!;
    expect(doDeclareWar(s, target).ok).toBe(true);
    expect(atWar(s, 'SRB', target)).toBe(true);
    const prov = ownedBy(s, target).find((p) => PROV[p].neighbors.some((q) => s.provinces[q].owner === 'SRB'))!;
    for (const a of armiesIn(s, prov)) delete s.armies[a.id];
    invalidateArmies();
    setController(s, prov, 'SRB');
    const w = s.wars[s.wars.length - 1];
    s.nations[target].warExhaustion = 60;
    runDays(s, 1);
    expect(scoreFor(w, 'SRB')).toBeGreaterThan(0);
    const terms = { provinces: [prov], taker: 'SRB', reparations: 0, vassalize: false, annex: false, white: false };
    const outBefore = me.budget.output;
    const ev = evaluatePeace(s, w, 'SRB', terms);
    if (ev.accept) {
      expect(proposePeace(s, w.id, terms).ok).toBe(true);
    } else {
      makePeace(s, w, 'SRB', terms);
    }
    expect(s.provinces[prov].owner).toBe('SRB');
    expect(s.provinces[prov].status).toBe('occupied');
    expect(atWar(s, 'SRB', target)).toBe(false);
    runDays(s, 2);
    // conquered land adds some output but also occupation costs
    expect(me.budget.output).toBeGreaterThan(outBefore);
    expect(me.budget.expenses.some((l) => l.key === 'occupation')).toBe(true);
    // integration costs money and time
    const r = build(s, prov, 'integrate');
    expect(r.ok).toBe(true);
    expect(s.provinces[prov].status).toBe('integrating');
  });
  it('annexing all provinces eliminates a nation', () => {
    const s = newGame('serbia', { seed: 5 });
    const t = 'MNE';
    for (const p of ownedBy(s, t)) transferProvince(s, p, 'SRB');
    expect(s.nations[t].alive).toBe(false);
  });
});

describe('any nation is playable', () => {
  it('starts and runs as several different nations', () => {
    for (const id of ['USA', 'BRA', 'MNE', 'NGA', 'AUS']) {
      const s = newGame('sandbox', { seed: 4, nation: id });
      expect(s.player).toBe(id);
      expect(s.nations[id].isPlayer).toBe(true);
      expect(Object.values(s.nations).filter((n) => n.isPlayer).length).toBe(1);
      expect(Object.values(s.generals).some((g) => g.owner === id && g.available)).toBe(true);
      runDays(s, 60);
      expect(s.nations[id].alive).toBe(true);
      expect(Number.isFinite(s.nations[id].treasury)).toBe(true);
    }
  });
});

describe('save / load', () => {
  it('round-trips state exactly and continues deterministically', () => {
    const s = newGame('poland', { seed: 9 });
    runDays(s, 40);
    const json = serialize(s);
    const a = deserialize(json);
    expect(serialize(a)).toBe(json);
    runDays(s, 25);
    const b = deserialize(json);
    runDays(b, 25);
    expect(b.day).toBe(s.day);
    expect(b.nations.POL.treasury).toBeCloseTo(s.nations.POL.treasury, 6);
    expect(Object.keys(b.armies).length).toBe(Object.keys(s.armies).length);
    expect(b.rng).toBe(s.rng);
  });
  it('rejects corrupted saves', () => {
    expect(() => deserialize('{nope')).toThrow();
    expect(() => deserialize('{"a":1}')).toThrow();
  });
});

describe('AI & long-term world simulation', () => {
  it('runs 6 years without exceptions, with an active but not chaotic world', () => {
    const s = newGame('germany', { seed: 21 });
    const alive0 = Object.values(s.nations).filter((n) => n.alive).length;
    let warsSeen = 0;
    const outputs0 = Object.fromEntries(Object.values(s.nations).map((n) => [n.id, n.budget.output]));
    for (let y = 0; y < 6; y++) {
      runDays(s, 365);
      warsSeen = Math.max(warsSeen, s.stats.wars);
      expect(s.wars.length).toBeLessThan(25);
    }
    const alive = Object.values(s.nations).filter((n) => n.alive);
    // the world evolves: wars happen, some states fall, but the map is not consumed
    expect(warsSeen).toBeGreaterThan(3);
    expect(alive.length).toBeGreaterThan(alive0 * 0.6);
    // no runaway snowballing: largest AI under 12% of provinces
    const counts = alive.filter((n) => !n.isPlayer).map((n) => ownedBy(s, n.id).length);
    expect(Math.max(...counts)).toBeLessThan(NPROV * 0.12);
    // AIs remain active: most still have armies and recruit / build
    const withArmies = alive.filter((n) => Object.values(s.armies).some((a) => a.owner === n.id)).length;
    expect(withArmies / alive.length).toBeGreaterThan(0.8);
    // economies neither explode nor collapse en masse
    const growth = alive.map((n) => n.budget.output / Math.max(1, outputs0[n.id]));
    growth.sort((a, b) => a - b);
    expect(growth[Math.floor(growth.length / 2)]).toBeGreaterThan(0.85);
    expect(growth[Math.floor(growth.length / 2)]).toBeLessThan(1.8);
    const bankrupt = alive.filter((n) => n.bankrupt).length;
    expect(bankrupt / alive.length).toBeLessThan(0.1);
    // no war lasts forever
    for (const w of s.wars) expect(s.day - w.startDay).toBeLessThan(365 * 7);
  }, 300000);
});

describe('player campaign loop (acceptance)', () => {
  it('small nation: build, recruit, general, move, war, battle, capture, peace', () => {
    const s = newGame('serbia', { seed: 13 });
    const me = s.nations.SRB;
    // build + recruit
    expect(build(s, me.capital, 'road').ok).toBe(true);
    expect(recruit(s, me, 'infantry', me.capital).ok).toBe(true);
    const gen = Object.values(s.generals).find((g) => g.owner === 'SRB' && g.available)!;
    expect(hireGeneral(s, gen.id).ok).toBe(true);
    const army = Object.values(s.armies).find((a) => a.owner === 'SRB')!;
    expect(doAssignGeneral(s, gen.id, army.id).ok).toBe(true);
    runDays(s, 70);
    // pick weakest neighbour, mobilise and declare war
    const target = neighborsOf(s, 'SRB').sort((a, b) => ownedBy(s, a).length - ownedBy(s, b).length)[0];
    me.mobilize = true;
    runDays(s, 30);
    expect(doDeclareWar(s, target).ok).toBe(true);
    const goal = ownedBy(s, target).find((p) => PROV[p].neighbors.some((q) => s.provinces[q].owner === 'SRB'))!;
    for (const a of Object.values(s.armies).filter((x) => x.owner === 'SRB')) moveArmy(s, a.id, goal);
    let battled = false;
    for (let d = 0; d < 200; d++) {
      tick(s);
      if (Object.values(s.battles).some((b) => b.attacker.nation === 'SRB' || b.defender.nation === 'SRB')) battled = true;
      if (s.provinces[goal].controller === 'SRB') break;
      if (d % 15 === 0) for (const a of Object.values(s.armies).filter((x) => x.owner === 'SRB' && !x.path.length && !x.battleId)) moveArmy(s, a.id, goal);
    }
    expect(battled || s.provinces[goal].controller === 'SRB').toBe(true);
    const finished = Object.values(s.battles).filter((b) => b.result && (b.attacker.nation === 'SRB' || b.defender.nation === 'SRB'));
    for (const b of finished) { expect(b.timeline.length).toBeGreaterThan(0); expect(b.factors.length).toBeGreaterThan(0); }
    // the save still round-trips mid-war
    const json = serialize(s);
    expect(deserialize(json).day).toBe(s.day);
  }, 120000);
});

export {};
void armyStrength; void refreshAllBudgets; void isAdjacent; void ({} as Army);

describe('war controls', () => {
  it('posture changes apply to an ongoing battle and attackers can call off an attack', () => {
    const s = newGame('serbia', { seed: 7 });
    s.armies = {}; invalidateArmies();
    const prov = s.nations.SRB.capital;
    const from = PROV[prov].neighbors.find((p) => s.provinces[p].owner !== 'SRB') ?? PROV[prov].neighbors[0];
    const enemy = s.provinces[from].owner === 'SRB' ? 'HUN' : s.provinces[from].owner;
    s.provinces[prov].controller = enemy; s.provinces[from].controller = 'SRB';
    declareWar(s, s.nations.SRB, enemy);
    const A = createArmy(s, 'SRB', from, ['infantry', 'infantry'].map((t) => newUnit(s, t as UnitType, 1, 0.2)));
    createArmy(s, enemy, prov, ['infantry', 'infantry', 'infantry'].map((t) => newUnit(s, t as UnitType, 1, 0.2)));
    const b = startBattle(s, [A], prov, from)!;
    battleDaily(s, b);
    expect(setPosture(s, A.id, 'aggressive').ok).toBe(true);
    expect(b.attackerPosture).toBe('aggressive');
    expect(retreatArmy(s, A.id).ok).toBe(true);
    expect(A.battleId).toBeNull();
    battleDaily(s, b);
    expect(b.result).toBe('defender');
  });
  it('orders for all armies and group moves', () => {
    const s = newGame('serbia', { seed: 7 });
    expect(setAllStances(s, 'defend').ok).toBe(true);
    for (const a of Object.values(s.armies)) if (a.owner === 'SRB') expect(a.stance).toBe('defend');
    const mine = Object.values(s.armies).filter((a) => a.owner === 'SRB');
    const dest = ownedBy(s, 'SRB').find((p) => p !== mine[0].location)!;
    const r = moveArmies(s, mine.map((a) => a.id), dest);
    expect(r.ok).toBe(true);
    for (const a of mine) expect(a.path[a.path.length - 1] === dest || a.location === dest).toBe(true);
  });
});

describe('strikes and strategic weapons', () => {
  const setup = () => {
    const s = newGame('serbia', { seed: 9 });
    const me = s.nations.SRB;
    const target = PROV[me.capital].neighbors.map((p) => s.provinces[p].owner).find((o) => o !== 'SRB')!;
    declareWar(s, me, target);
    const p = ownedBy(s, target).find((q) => PROV[q].neighbors.some((x) => s.provinces[x].owner === 'SRB'))!;
    return { s, me, target, p };
  };
  it('drones cost money, kill troops and wreck buildings; range is enforced', () => {
    const { s, me, target, p } = setup();
    expect(doStrike(s, 'drone', p, 5).ok).toBe(false); // none in stock
    const t0 = me.treasury;
    expect(doBuyMunitions(s, 'drone', 10).ok).toBe(true);
    expect(me.treasury).toBeLessThan(t0);
    const army = createArmy(s, target, p, [newUnit(s, 'infantry', 1, 0.2), newUnit(s, 'infantry', 1, 0.2)]);
    const before = armyStrength(army);
    const infra0 = Object.values(s.provinces[p].buildings).reduce((t, v) => t + v, 0);
    const r = doBuyMunitions(s, 'missile', 3) && doStrike(s, 'missile', p, 3);
    expect(r.ok).toBe(true);
    expect(doStrike(s, 'drone', p, 10).ok).toBe(true);
    expect(armyStrength(s.armies[army.id] ?? army)).toBeLessThan(before);
    expect(Object.values(s.provinces[p].buildings).reduce((t, v) => t + v, 0)).toBeLessThan(infra0);
    expect(s.strikes.length).toBe(2);
    // a far-away enemy province is out of drone range
    const far = s.provinces.find((q) => q.owner !== 'SRB' && distKmP(s, q.id) > 3000)!;
    declareWar(s, me, far.controller);
    doBuyMunitions(s, 'drone', 1);
    expect(doStrike(s, 'drone', far.id, 1).ok).toBe(false);
  });
  it('nuclear use brings a world embargo, and nuclear enemies retaliate', () => {
    const s = newGame('serbia', { seed: 9 });
    const me = s.nations.SRB;
    me.arsenal.nuke = 1;
    declareWar(s, me, 'RUS');
    const p = ownedBy(s, 'RUS')[0];
    const r = doStrike(s, 'nuke', p, 1);
    expect(r.ok).toBe(true);
    expect(me.embargoUntil).toBeGreaterThan(s.day + 3000);
    expect(me.infamy).toBe(100);
    expect(s.strikes.some((x) => x.by === 'RUS' && x.kind === 'nuke')).toBe(true);
    const b = budgetOf(s, 'SRB');
    expect(b.expenses.some((l) => l.key === 'embargo')).toBe(true);
    expect(b.income.some((l) => l.key === 'trade' || l.key === 'exports')).toBe(false);
  });
});
function distKmP(s: GameState, p: number) { return Math.min(...ownedBy(s, 'SRB').map((q) => Math.hypot(PROV[q].lat - PROV[p].lat, 0) * 111)); }

describe('government', () => {
  const line = (s: GameState, k: string) => budgetOf(s, 'SRB').expenses.find((l) => l.key === k)?.amount ?? 0;
  it('the services slider and policies change the budget; changes have a cooldown', () => {
    const s = newGame('serbia', { seed: 3 });
    const base = line(s, 'services');
    expect(A.doSetServices(s, 0.7).ok).toBe(true);
    expect(line(s, 'services')).toBeCloseTo(base * 0.7, 3);
    expect(A.doSetPolicy(s, 'labour', 'welfare').ok).toBe(true);
    expect(line(s, 'services') / (base * 0.7 * 1.25)).toBeGreaterThan(0.98); // stability dip lowers output slightly
    expect(A.doSetPolicy(s, 'labour', 'long').ok).toBe(false); // cooldown
    expect(A.doSetPolicy(s, 'trade', 'protectionist').ok).toBe(true);
    expect(budgetOf(s, 'SRB').income.some((l) => l.key === 'tariffs')).toBe(true);
  });
  it('decrees apply once and then cool down', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    const t0 = n.treasury, p0 = n.priceIndex;
    expect(A.doDecree(s, 'printMoney').ok).toBe(true);
    expect(n.treasury).toBeGreaterThan(t0);
    expect(n.priceIndex).toBeGreaterThan(p0);
    expect(A.doDecree(s, 'printMoney').ok).toBe(false);
    expect(A.doDecree(s, 'warBonds').ok).toBe(false); // peace
    const adm = line(s, 'admin');
    expect(A.doDecree(s, 'austerity').ok).toBe(true);
    expect(line(s, 'admin')).toBeLessThan(adm);
  });
  it('wealth fund grows, province focus changes output, events resolve', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    expect(A.doInvestFund(s, 50).ok).toBe(true);
    runDays(s, 400);
    expect(n.gov.fund).toBeGreaterThan(50);
    const p = n.capital;
    const before = provinceOutput(s, s.provinces[p], n);
    expect(A.doSetFocus(s, p, 'commerce').ok).toBe(true);
    expect(provinceOutput(s, s.provinces[p], n)).toBeGreaterThan(before);
    s.tutorial = null;
    n.gov.nextEvent = s.day;
    for (let i = 0; i < 5 && !n.gov.event; i++) tick(s);
    expect(n.gov.event).not.toBeNull();
    expect(A.doAnswerEvent(s, 1).ok).toBe(true);
    expect(n.gov.event).toBeNull();
  });
  it('aid, sanctions and spies work through diplomacy', () => {
    const s = newGame('serbia', { seed: 3 });
    const r0 = (peekRelT(s, 'SRB', 'HUN'));
    expect(A.doSendAid(s, 'HUN', 5).ok).toBe(true);
    expect(peekRelT(s, 'SRB', 'HUN')).toBeGreaterThan(r0);
    expect(A.doSanction(s, 'HUN').ok).toBe(true);
    expect(peekRelT(s, 'SRB', 'HUN')).toBeLessThan(r0);
    expect(A.doSpyOp(s, 'HUN', 'unrest').ok).toBe(false); // no network
    for (let i = 0; i < 3; i++) A.doSpyNetwork(s, 'HUN');
    expect(s.nations.SRB.gov.spies.HUN).toBeCloseTo(0.6, 5);
  });
});
import * as A from '../src/engine/actions';
import { provinceOutput } from '../src/engine/economy';
import { rel as relOf } from '../src/engine/world';
function peekRelT(s: GameState, a: string, b: string) { return relOf(s, a, b).value; }

describe('regime and population', () => {
  it('approval, legitimacy and opposition respond to policy, propaganda and repression', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    s.tutorial = null;
    n.taxRate = 0.45; // brutal taxes
    runDays(s, 400);
    const angry = n.regime.groups.business;
    expect(angry).toBeLessThan(45);
    const opp0 = n.regime.opposition;
    expect(opp0).toBeGreaterThan(5);
    expect(A.doInterior(s, 'arrests').ok).toBe(false); // needs secret police
    expect(A.doSetSecurity(s, 2).ok).toBe(true);
    expect(A.doInterior(s, 'arrests').ok).toBe(true);
    expect(n.regime.opposition).toBeLessThan(opp0);
    expect(budgetOf(s, 'SRB').expenses.some((l) => l.key === 'security')).toBe(true);
    expect(A.doToggleCampaign(s, 'cult').ok).toBe(true);
    const leg = n.regime.legitimacy;
    runDays(s, 90);
    expect(n.regime.legitimacy).toBeGreaterThan(leg);
    expect(budgetOf(s, 'SRB').expenses.some((l) => l.key === 'propaganda')).toBe(true);
  });
  it('high opposition makes provinces revolt; martial law calms them', () => {
    const s = newGame('serbia', { seed: 3 });
    const n = s.nations.SRB;
    s.tutorial = null;
    for (const a of Object.values(s.armies)) if (a.owner === 'SRB') delete s.armies[a.id];
    invalidateArmies();
    for (let i = 0; i < 5; i++) { n.regime.opposition = 85; runDays(s, 30); }
    const p = ownedBy(s, 'SRB').sort((a, b) => s.provinces[b].resistance - s.provinces[a].resistance)[0];
    expect(s.provinces[p].resistance).toBeGreaterThan(60);
    A.doMartialLaw(s, p);
    const before = s.provinces[p].resistance;
    for (let i = 0; i < 2; i++) { n.regime.opposition = 85; runDays(s, 30); }
    expect(s.provinces[p].resistance).toBeLessThan(before);
  });
});

describe('war planning', () => {
  it('bulk orders, war economy, mercenaries and joint operations', () => {
    const s = newGame('serbia', { seed: 7 });
    const me = s.nations.SRB;
    const before = Object.values(s.armies).filter((a) => a.owner === 'SRB').length;
    expect(A.doMercenaries(s, 'infantry', me.capital).ok).toBe(true);
    const mine = Object.values(s.armies).filter((a) => a.owner === 'SRB');
    expect(mine.reduce((t, a) => t + a.units.length, 0)).toBeGreaterThan(0);
    expect(mine.length).toBeGreaterThanOrEqual(before);
    expect(A.doStances(s, mine.map((a) => a.id), 'defend').ok).toBe(true);
    for (const a of mine) expect(a.stance).toBe('defend');
    const t0 = trainDays('armored', me);
    expect(A.doWarEconomy(s, 'total').ok).toBe(true);
    expect(trainDays('armored', me)).toBeLessThan(t0);
    const enemy = PROV[me.capital].neighbors.map((p) => s.provinces[p].owner).find((o) => o !== 'SRB')!;
    declareWar(s, me, enemy);
    const target = ownedBy(s, enemy).find((q) => PROV[q].neighbors.some((x) => s.provinces[x].owner === 'SRB'))!;
    const r = A.doOperation(s, mine.map((a) => a.id), target);
    expect(r.ok).toBe(true);
    expect(s.operations.length).toBe(1);
    runDays(s, 40);
    expect(s.operations.length === 0 || s.operations[0].state === 'attacking').toBe(true);
  });
});
