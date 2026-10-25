// Battle command (daily manoeuvres, scouting, support), invasion orders and best peace, and submarines.
import { describe, it, expect } from 'vitest';
import { newGame } from '../src/engine/setup';
import { runDays } from '../src/engine/sim';
import { PROV, WORLD } from '../src/engine/geo';
import { createArmy, newUnit } from '../src/engine/military';
import { battleDaily, startBattle, ensureCmd } from '../src/engine/battle';
import { declareWar, bestPeaceTerms } from '../src/engine/diplomacy';
import { invalidateArmies, atWar, controlledBy, ownedBy, warBetween } from '../src/engine/world';
import { fleetsDaily, raidCommerce, seaTransportDaily } from '../src/engine/naval';
import { runCommand } from '../src/engine/commands';
import { serialize, deserialize } from '../src/engine/save';
import { TACTICS } from '../src/engine/config';
import type { Battle, Fleet, GameState, Tactic, UnitType } from '../src/engine/types';

const counter = (t: Tactic) => (Object.keys(TACTICS) as Tactic[]).find((x) => TACTICS[x].beats === t)!;

/** Two equal armies fight; `pick` chooses the attacker's manoeuvre each day (null: its general decides). */
function duel(seed: number, days: number, pick: ((b: Battle) => Tactic) | null, units: UnitType[] = ['infantry', 'infantry', 'infantry', 'infantry']) {
  const s = newGame('serbia', { seed });
  s.settings.difficulty = 'hard';
  s.armies = {}; s.airWings = {}; invalidateArmies();
  const at = s.nations.SRB.capital;
  const from = PROV[at].neighbors[0];
  const atkN = s.provinces[from].owner === 'SRB' ? 'HUN' : s.provinces[from].owner;
  s.provinces[from].controller = atkN;
  declareWar(s, s.nations[atkN], 'SRB');
  const mk = (t: UnitType) => { const u = newUnit(s, t, 1, 0.2); u.org = 0.9; u.morale = 0.8; return u; };
  const A = createArmy(s, atkN, from, units.map(mk));
  const D = createArmy(s, 'SRB', at, units.map(mk));
  const b = startBattle(s, [A], at, from)!;
  let dealt = 0, taken = 0;
  for (let i = 0; i < days && b.result == null; i++) {
    A.lastSupplyRatio = 1; D.lastSupplyRatio = 1;
    if (pick) { const c = ensureCmd(b).a; c.order = pick(b); c.plan = c.order; }
    battleDaily(s, b);
    const d = b.timeline[b.timeline.length - 1];
    dealt += d.dDamage; taken += d.aDamage;
    s.day++;
  }
  return { s, b, A, D, dealt, taken };
}

describe('battle command', () => {
  it('each day has a manoeuvre per side; the winning matchup deals more and takes less', () => {
    const { b } = duel(11, 8, null);
    const days = b.timeline.filter((d) => d.aTactic && d.dTactic);
    expect(days.length).toBeGreaterThan(3);
    for (const d of days) {
      const e = TACTICS[d.aTactic!].beats === d.dTactic ? 'a' : TACTICS[d.dTactic!].beats === d.aTactic ? 'd' : null;
      expect(d.edge).toBe(e);
    }
    expect(b.factors.length).toBeGreaterThan(0);
  });

  it('a commander who reads the enemy beats one who does not', () => {
    let read = 0, blind = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      // perfect knowledge of the enemy's plan vs always walking into it
      const r = duel(seed, 6, (b) => counter(ensureCmd(b).d.plan));
      const w = duel(seed, 6, (b) => TACTICS[ensureCmd(b).d.plan].beats);
      read += r.dealt / Math.max(1, r.taken);
      blind += w.dealt / Math.max(1, w.taken);
    }
    expect(read / blind).toBeGreaterThan(2);
  });

  it('following the scouts beats leaving it to the general, on average', () => {
    let scouts = 0, auto = 0;
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const h = duel(seed, 8, (b) => { const c = ensureCmd(b).a; return c.hint ? counter(c.hint) : 'assault'; });
      const a = duel(seed, 8, null);
      scouts += h.dealt / Math.max(1, h.taken);
      auto += a.dealt / Math.max(1, a.taken);
    }
    expect(scouts).toBeGreaterThan(auto * 1.1);
  });

  it('support goes through the command system: paid, once per cooldown, rally once per battle', () => {
    const { s, b } = duel(5, 1, null);
    const pl = 'SRB';
    s.nations[pl].treasury = 50;
    // the defender has no artillery: no barrage
    expect(runCommand(s, pl, 'useBattleSupport', [b.id, 'barrage']).ok).toBe(false);
    const r = runCommand(s, pl, 'useBattleSupport', [b.id, 'rally']);
    expect(r.ok).toBe(true);
    expect(ensureCmd(b).d.queued).toContain('rally');
    expect(runCommand(s, pl, 'useBattleSupport', [b.id, 'rally']).ok).toBe(false);
    // a drone strike uses the arsenal and makes tomorrow's scouting certain
    s.nations[pl].arsenal.drone = 1;
    expect(runCommand(s, pl, 'useBattleSupport', [b.id, 'drone']).ok).toBe(true);
    expect(s.nations[pl].arsenal.drone).toBe(0);
    s.day++;
    battleDaily(s, b);
    const last = b.timeline[b.timeline.length - 1];
    expect(last.support?.map((u) => u.kind).sort()).toEqual(expect.arrayContaining(['drone', 'rally']));
    expect(ensureCmd(b).d.hintSure).toBe(1);
    expect(ensureCmd(b).d.hint).toBe(ensureCmd(b).a.plan);
    // rally is spent for the rest of the battle
    s.day += 5;
    expect(runCommand(s, pl, 'useBattleSupport', [b.id, 'rally']).ok).toBe(false);
    // tactics
    expect(runCommand(s, pl, 'setBattleTactic', [b.id, 'flank']).ok).toBe(true);
    expect(ensureCmd(b).d.plan).toBe('flank');
    expect(runCommand(s, pl, 'setBattleTactic', [b.id, 'auto']).ok).toBe(true);
    expect(ensureCmd(b).d.order).toBe('auto');
  });

  it('battles from older saves get a command state on first use', () => {
    const { s, b } = duel(9, 1, null);
    delete b.cmd;
    const s2 = deserialize(serialize(s));
    const b2 = s2.battles[b.id];
    battleDaily(s2, b2);
    expect(b2.cmd).toBeTruthy();
  });
});

describe('invasions and peace', () => {
  it('"Declare war & invade": the armies take the target province by province, then peace on the best terms', () => {
    const s = newGame('sandbox', { seed: 3, nation: 'FRA' });
    const ids = Object.values(s.armies).filter((a) => a.owner === 'FRA' && PROV[a.location].country === 'FRA').map((a) => a.id);
    const r = runCommand(s, 'FRA', 'doInvade', ['BEL', ids]);
    expect(r.ok).toBe(true);
    expect(atWar(s, 'FRA', 'BEL')).toBe(true);
    expect(ids.every((id) => s.armies[id].campaign === 'BEL')).toBe(true);
    const belgian = ownedBy(s, 'BEL').slice();
    let taken = 0;
    for (let i = 0; i < 40 && !taken; i++) { runDays(s, 3); taken = belgian.filter((p) => s.provinces[p].controller === 'FRA').length; }
    expect(taken).toBeGreaterThanOrEqual(1);
    const w = warBetween(s, 'FRA', 'BEL');
    expect(w).toBeTruthy();
    if (w) {
      const t = bestPeaceTerms(s, w, 'FRA');
      expect(t).toBeTruthy();
      const before = ownedBy(s, 'FRA').length;
      const pr = runCommand(s, 'FRA', 'doBestPeace', [w.id]);
      expect(pr.ok).toBe(true);
      expect(atWar(s, 'FRA', 'BEL')).toBe(false);
      if (!t!.white) expect(ownedBy(s, 'FRA').length).toBeGreaterThan(before);
    }
  });

  it('a campaign ends when the war does; new standing orders cancel it', () => {
    const s = newGame('sandbox', { seed: 3, nation: 'FRA' });
    const a = Object.values(s.armies).find((x) => x.owner === 'FRA')!;
    expect(runCommand(s, 'FRA', 'doCampaign', [[a.id], 'BEL']).ok).toBe(false); // not at war
    runCommand(s, 'FRA', 'doInvade', ['BEL', [a.id]]);
    expect(a.campaign).toBe('BEL');
    runCommand(s, 'FRA', 'setStance', [a.id, 'hold']);
    expect(a.campaign).toBeNull();
  });
});

describe('submarines', () => {
  const zoneWithEnemyPorts = (s: GameState, enemy: string) => WORLD.seas.find((z) => PROV.some((p) => p.seas.includes(z.id) && s.provinces[p.id].controller === enemy && s.provinces[p.id].buildings.port > 0))!.id;
  const fleet = (s: GameState, owner: string, sea: number, ships: Partial<Fleet['ships']>): Fleet => {
    const f: Fleet = { id: s.nextId++, owner, name: `${owner} test`, sea, ships: { destroyer: 0, cruiser: 0, battlegroup: 0, submarine: 0, transport: 0, ...ships }, path: [], moveProgress: 0, org: 1, homePort: s.nations[owner].capital, mission: 'patrol' };
    s.fleets[f.id] = f;
    return f;
  };
  const setup = () => {
    const s = newGame('sandbox', { seed: 4, nation: 'FRA' });
    s.fleets = {};
    declareWar(s, s.nations.FRA, 'GBR');
    return s;
  };

  it('start in big navies and slip away from fleets without destroyers', () => {
    const s0 = newGame('sandbox', { seed: 4, nation: 'FRA' });
    expect(Object.values(s0.fleets).some((f) => f.owner === 'USA' && f.ships.submarine > 0)).toBe(true);
    const lossVs = (hunters: boolean) => {
      const s = setup();
      const z = zoneWithEnemyPorts(s, 'GBR');
      const subs = fleet(s, 'FRA', z, { submarine: 4 });
      fleet(s, 'GBR', z, hunters ? { destroyer: 6 } : { cruiser: 3 });
      fleetsDaily(s);
      return 4 - (s.fleets[subs.id]?.ships.submarine ?? 0);
    };
    expect(lossVs(true)).toBeGreaterThan(lossVs(false) * 1.5);
  });

  it('sink troopships and drain the treasury of enemy ports along their waters', () => {
    const s = setup();
    const z = zoneWithEnemyPorts(s, 'GBR');
    const subs = fleet(s, 'FRA', z, { submarine: 3 });
    const t0 = s.nations.GBR.treasury;
    raidCommerce(s, subs);
    expect(s.nations.GBR.treasury).toBeLessThan(t0);
    // a British army at sea in those waters takes losses although nobody controls the sea
    const port = PROV.find((p) => p.seas.includes(z) && s.provinces[p.id].controller === 'GBR')!.id;
    const a = createArmy(s, 'GBR', port, [newUnit(s, 'infantry', 1, 0.2)]);
    a.embarked = { route: [z, z, z], dest: port, progress: 0, from: port };
    const before = a.units[0].strength;
    seaTransportDaily(s);
    expect(a.units[0].strength).toBeLessThan(before);
  });

  it('old saves get an empty submarine count', () => {
    const s = newGame('sandbox', { seed: 4, nation: 'FRA' });
    const raw = JSON.parse(serialize(s));
    raw.version = 8;
    for (const f of Object.values<any>(raw.fleets)) delete f.ships.submarine;
    const s2 = deserialize(JSON.stringify(raw));
    for (const f of Object.values(s2.fleets)) expect(f.ships.submarine).toBe(0);
  });
});
