// The air force, naval support and invasions: squadrons at airbases with missions, air and naval
// power in land battles, invasion orders, and a China–Taiwan landing as a player would make it.
import { describe, it, expect } from 'vitest';
import { newGame } from '../src/engine/setup';
import { runDays } from '../src/engine/sim';
import { PROV, COUNTRY_GEO, distKm, seaRoute } from '../src/engine/geo';
import { createArmy, newUnit } from '../src/engine/military';
import { battleDaily, startBattle, navalSupport } from '../src/engine/battle';
import { declareWar } from '../src/engine/diplomacy';
import { setController } from '../src/engine/territory';
import { serialize, deserialize } from '../src/engine/save';
import { invalidateArmies, controlledBy } from '../src/engine/world';
import { infraOf } from '../src/engine/economy';
import { wingsOf, createWing, setMission, rebaseWing, airMissionsDaily, computeBattleAir, wingPlanes, navalAir } from '../src/engine/air';
import { orderInvasion, moveFleet, nationTransportCapacity } from '../src/engine/naval';
import { setAirMission } from '../src/engine/regime';
import { runCommand, stateHash } from '../src/engine/commands';
import { AIR, SAVE_VERSION } from '../src/engine/config';
import type { GameState, UnitType } from '../src/engine/types';

const prov = (id: string, name: string) => COUNTRY_GEO[id].provinces.find((p) => PROV[p].name === name)!;
function chinaTaiwan(war = true) {
  const s = newGame('sandbox', { seed: 3, nation: 'CHN' });
  if (war) declareWar(s, s.nations.CHN, 'TWN');
  return { s, taipei: prov('TWN', 'Taipei'), fuzhou: prov('CHN', 'Fuzhou') };
}
const squadrons = (s: GameState, types: UnitType[]) => types.map((t) => newUnit(s, t, 1, 0.2));

/** An isolated land battle; `air` gives the attacker a wing flying support from next door. */
function airDuel(air: UnitType[], days: number) {
  const s = newGame('serbia', { seed: 7 });
  s.armies = {}; s.airWings = {}; invalidateArmies();
  const at = s.nations.SRB.capital;
  const from = PROV[at].neighbors[0];
  const atkN = s.provinces[from].owner === 'SRB' ? 'HUN' : s.provinces[from].owner;
  s.provinces[from].controller = atkN;
  declareWar(s, s.nations[atkN], 'SRB');
  const mk = (t: UnitType) => { const u = newUnit(s, t, 1, 0.2); u.org = 0.8; u.morale = 0.7; return u; };
  const A = createArmy(s, atkN, from, (['infantry', 'infantry', 'infantry', 'artillery'] as UnitType[]).map(mk));
  const D = createArmy(s, 'SRB', at, (['infantry', 'infantry', 'infantry'] as UnitType[]).map(mk));
  if (air.length) createWing(s, atkN, from, squadrons(s, air));
  D.entrench = 0.3;
  const b = startBattle(s, [A], at, from)!;
  for (let i = 0; i < days && b.result == null; i++) { A.lastSupplyRatio = 1; D.lastSupplyRatio = 1; computeBattleAir(s); battleDaily(s, b); s.day++; }
  return b;
}

describe('air force', () => {
  it('starts as air wings at airbases, not inside armies', () => {
    const { s } = chinaTaiwan(false);
    for (const a of Object.values(s.armies)) for (const u of a.units) expect(['air', 'bomber']).not.toContain(u.type);
    for (const w of Object.values(s.airWings)) {
      expect(s.provinces[w.base].controller).toBe(w.owner);
      expect(w.units.length).toBeGreaterThan(0);
      expect(w.units.length).toBeLessThanOrEqual(AIR.MAX_WING);
    }
    expect(wingsOf(s, 'CHN').some((w) => w.units.some((u) => u.type === 'bomber'))).toBe(true);
    const planes = (id: string) => wingsOf(s, id).reduce((t, w) => t + wingPlanes(w), 0);
    expect(planes('CHN')).toBeGreaterThan(planes('TWN') * 3);
    expect(planes('USA')).toBeGreaterThan(planes('TWN') * 3);
  });

  it('air support turns a battle: close air support and air superiority', () => {
    const none = airDuel([], 4), air = airDuel(['air', 'air', 'air', 'bomber', 'bomber'], 4);
    const hurt = (b: typeof none) => b.defender.losses.killed + b.defender.losses.wounded;
    expect(hurt(air)).toBeGreaterThan(hurt(none) * 1.3);
    const labels = air.factors.map((f) => f.label);
    expect(labels).toContain('Close air support');
    expect(labels).toContain('Air superiority');
    expect(none.factors.map((f) => f.label)).not.toContain('Close air support');
  });

  it('bombers wreck buildings in an enemy province; targets must be enemy-held and in range', () => {
    const { s, taipei, fuzhou } = chinaTaiwan();
    const w = createWing(s, 'CHN', fuzhou, squadrons(s, ['bomber', 'bomber', 'bomber', 'bomber', 'air', 'air']));
    expect(setMission(s, w, 'bombing', prov('JPN', 'Tokyo'))).toMatch(/not held by an enemy/);
    const far = createWing(s, 'CHN', prov('CHN', 'Urumqi') ?? COUNTRY_GEO.CHN.provinces.reduce((a, b) => (distKm(a, taipei) > distKm(b, taipei) ? a : b)), squadrons(s, ['air']));
    expect(setMission(s, far, 'bombing', taipei)).toMatch(/out of range/);
    expect(setMission(s, w, 'bombing', taipei)).toBeNull();
    const st = s.provinces[taipei];
    const count = () => st.buildings.power + st.buildings.railway + st.buildings.factory + st.buildings.depot + st.buildings.port;
    const before = count();
    expect(st.buildings.port).toBeGreaterThan(0);
    for (let d = 0; d < 30; d++) { airMissionsDaily(s); s.day++; }
    expect(count()).toBeLessThan(before);
    expect(st.damage).toBeGreaterThan(0);
    expect(st.infra).toBe(infraOf(st)); // (what a reloaded copy computes: no multiplayer desync)
    // once everything is flattened, bombs fall on rubble instead of piling up for whatever is rebuilt
    for (let d = 0; d < 120; d++) { airMissionsDaily(s); s.day++; }
    expect(count()).toBe(0);
    expect(w.bombAcc).toBeLessThan(AIR.BOMB_BUILDING);
  });

  it('naval strike wings sink enemy ships and count toward sea control', () => {
    const { s, fuzhou } = chinaTaiwan();
    const f = Object.values(s.fleets).find((x) => x.owner === 'TWN')!;
    expect(f).toBeTruthy();
    const ships = () => Object.values(f.ships).reduce((t, v) => t + v, 0);
    const w = createWing(s, 'CHN', fuzhou, squadrons(s, ['bomber', 'bomber', 'bomber', 'air']));
    expect(navalAir(s, 'CHN', f.sea)).toBe(0);
    expect(setMission(s, w, 'naval', f.sea)).toBeNull();
    expect(navalAir(s, 'CHN', f.sea)).toBeGreaterThan(0);
    const before = ships();
    for (let d = 0; d < 10; d++) { airMissionsDaily(s); s.day++; }
    expect(ships()).toBeLessThan(before * 0.9);
  });

  it('three wings sink no more than one wing with the same aircraft', () => {
    const sunk = (split: boolean) => {
      const { s, fuzhou } = chinaTaiwan();
      const f = Object.values(s.fleets).find((x) => x.owner === 'TWN')!;
      const bombers = squadrons(s, ['bomber', 'bomber', 'bomber']);
      for (const g of split ? bombers.map((u) => [u]) : [bombers]) setMission(s, createWing(s, 'CHN', fuzhou, g), 'naval', f.sea);
      const total = () => Object.values(f.ships).reduce((t, v) => t + v, 0);
      const before = total();
      airMissionsDaily(s);
      return 1 - total() / before;
    };
    expect(sunk(true) / sunk(false)).toBeGreaterThan(0.95); // (the strikes compound, so not exactly equal)
    expect(sunk(true) / sunk(false)).toBeLessThan(1.05);
  });

  it('wings rebase only to held territory, and fly home when their airbase falls', () => {
    const { s, taipei, fuzhou } = chinaTaiwan();
    const w = wingsOf(s, 'CHN').find((x) => x.base !== fuzhou)!;
    expect(rebaseWing(s, w, taipei)).toMatch(/can't host an airbase/);
    expect(rebaseWing(s, w, fuzhou)).toBeNull();
    for (let d = w.rebase!.days; d > 0; d--) airMissionsDaily(s);
    expect(w.base).toBe(fuzhou);
    expect(w.rebase).toBeNull();
    setController(s, fuzhou, 'TWN');
    const order = controlledBy(s, 'CHN').slice();
    airMissionsDaily(s);
    expect(controlledBy(s, 'CHN')).toEqual(order); // (a shared cache: reordering it would desync a reloaded copy)
    expect(w.rebase).not.toBeNull();
    expect(s.provinces[w.rebase!.to].controller).toBe('CHN');
  });

  it('wing orders go through the command system and change the state hash', () => {
    const { s } = chinaTaiwan(false);
    const w = wingsOf(s, 'CHN')[0];
    const h = stateHash(s);
    expect(runCommand(s, 'CHN', 'doWingMission', [w.id, 'idle', null]).ok).toBe(true);
    expect(w.mission).toBe('idle');
    expect(stateHash(s)).not.toBe(h);
    expect(runCommand(s, 'TWN', 'doWingMission', [w.id, 'support', null]).ok).toBe(false);
    expect(w.mission).toBe('idle');
  });

  it('a refused War Room bombing order changes nothing', () => {
    const { s } = chinaTaiwan(false);
    declareWar(s, s.nations.CHN, 'BRA');
    const before = wingsOf(s, 'CHN').map((w) => `${w.mission}:${w.target}`);
    const air = JSON.stringify(s.nations.CHN.regime.air);
    expect(setAirMission(s, s.nations.CHN, 'bombing', 'BRA')).toMatch(/can reach/);
    expect(wingsOf(s, 'CHN').map((w) => `${w.mission}:${w.target}`)).toEqual(before);
    expect(JSON.stringify(s.nations.CHN.regime.air)).toBe(air);
  });

  it('old saves: aircraft that flew inside armies become air wings', () => {
    const { s } = chinaTaiwan(false);
    const raw = JSON.parse(serialize(s));
    const planes = Object.values<any>(raw.airWings).filter((w) => w.owner === 'CHN').flatMap((w) => w.units).slice(0, 3);
    raw.version = 7;
    delete raw.airWings;
    const cn = Object.values<any>(raw.armies).filter((x) => x.owner === 'CHN');
    const a = cn[0], b = cn.find((x) => x.location !== a.location)!;
    a.units.push(planes[0], planes[1]);
    b.units = [planes[2]]; // an army of nothing but aircraft
    const t = deserialize(JSON.stringify(raw));
    expect(t.version).toBe(SAVE_VERSION);
    for (const x of Object.values(t.armies)) for (const u of x.units) expect(u.type).not.toBe('air');
    expect(t.armies[b.id]).toBeUndefined();
    const wings = wingsOf(t, 'CHN');
    expect(wings.find((w) => w.base === a.location)!.units.map((u) => u.id)).toEqual([planes[0].id, planes[1].id]);
    expect(wings.find((w) => w.base === b.location)!.units.map((u) => u.id)).toContain(planes[2].id);
  });
});

describe('war at sea and invasions', () => {
  it('declaring war mobilises both sides', () => {
    const { s } = chinaTaiwan(false);
    expect(s.nations.CHN.mobilize).toBeFalsy();
    declareWar(s, s.nations.CHN, 'TWN');
    expect(s.nations.CHN.mobilize).toBe(true);
    expect(s.nations.TWN.mobilize).toBe(true);
  });

  it('warships off the coast give gunfire support and control of the landing waters', () => {
    const { s, taipei } = chinaTaiwan();
    const side = new Set(['CHN']), enemy = new Set(['TWN']);
    const mine = Object.values(s.fleets).filter((f) => f.owner === 'CHN');
    const away = PROV[prov('USA', 'New York') ?? COUNTRY_GEO.USA.provinces.find((p) => PROV[p].seas.length)!].seas[0];
    for (const f of mine) f.sea = away;
    expect(navalSupport(s, taipei, 'CHN', side, enemy)).toEqual({ control: 0, fire: 0 });
    for (const f of mine) f.sea = PROV[taipei].seas[0];
    const sup = navalSupport(s, taipei, 'CHN', side, enemy);
    expect(sup.control).toBeGreaterThan(0.5);
    expect(sup.fire).toBeGreaterThan(0);
  });

  it('an invasion order marches a group to one port and sails it together', () => {
    const { s, taipei, fuzhou } = chinaTaiwan();
    const near = Object.values(s.armies).filter((a) => a.owner === 'CHN').sort((a, b) => distKm(a.location, fuzhou) - distKm(b.location, fuzhou));
    const cap = nationTransportCapacity(s, s.nations.CHN).cap;
    const group = [near[0], near.slice(1).find((a) => a.location !== near[0].location && near[0].units.length + a.units.length <= cap)!];
    const r = orderInvasion(s, group, taipei);
    expect(r.ok).toBe(true);
    const sailed = new Map<number, number>();
    for (let d = 0; d < 60 && sailed.size < group.length; d++) {
      runDays(s, 1);
      for (const a of group) if (a.embarked && !sailed.has(a.id)) sailed.set(a.id, s.day);
    }
    expect(sailed.size).toBe(2);
    expect(new Set(sailed.values()).size).toBe(1); // the same day
    // too many brigades for the shipping available
    const all = Object.values(s.armies).filter((a) => a.owner === 'CHN' && !a.embarked && !a.battleId);
    expect(orderInvasion(s, all, taipei).reason).toMatch(/transport capacity/);
  });

  it('halting, retreating or rerouting an army calls off its sailing', () => {
    const { s, taipei, fuzhou } = chinaTaiwan();
    // armies standing in ports of their own (they could sail from where they are)
    const inPort = Object.values(s.armies)
      .filter((a) => a.owner === 'CHN' && s.provinces[a.location].buildings.port > 0 && seaRoute(PROV[a.location].seas, PROV[taipei].seas))
      .sort((a, b) => distKm(a.location, fuzhou) - distKm(b.location, fuzhou))
      .filter((x, i, l) => l.findIndex((y) => y.location === x.location) === i);
    const [a, b, c] = inPort;
    expect(orderInvasion(s, [a, b], taipei).ok).toBe(true); // one group: one of them marches to the other's port
    expect(orderInvasion(s, [c], taipei).ok).toBe(true);
    expect(runCommand(s, 'CHN', 'doHaltMany', [[a.id]]).ok).toBe(true);
    expect(runCommand(s, 'CHN', 'doRetreatMany', [[b.id]]).ok).toBe(true);
    c.path = [PROV[c.location].neighbors.find((q) => s.provinces[q].controller === 'CHN')!]; // new orders elsewhere (e.g. from automation)
    runDays(s, 1);
    expect(c.seaDest ?? null).toBeNull();
    runDays(s, 40);
    for (const x of [a, b, c]) {
      expect(x.seaDest ?? null).toBeNull();
      expect(x.embarked).toBeFalsy();
      expect(x.location).not.toBe(taipei);
    }
  });

  it('an invasion needs the money for the shipping', () => {
    const { s, taipei, fuzhou } = chinaTaiwan();
    const a = Object.values(s.armies).filter((x) => x.owner === 'CHN').sort((x, y) => distKm(x.location, fuzhou) - distKm(y.location, fuzhou))[0];
    s.nations.CHN.treasury = 0;
    expect(orderInvasion(s, [a], taipei).reason).toMatch(/costs/);
  });

  it('China takes Taipei when its navy and air force support the landing', () => {
    const { s, taipei, fuzhou } = chinaTaiwan();
    for (const f of Object.values(s.fleets).filter((x) => x.owner === 'CHN')) moveFleet(s, f, PROV[taipei].seas[0]);
    for (const w of wingsOf(s, 'CHN')) rebaseWing(s, w, fuzhou);
    runDays(s, 30);
    for (const w of wingsOf(s, 'CHN')) setMission(s, w, 'support');
    const cap = nationTransportCapacity(s, s.nations.CHN).cap;
    const group = [];
    let brigades = 0;
    for (const a of Object.values(s.armies).filter((x) => x.owner === 'CHN' && !x.battleId).sort((a, b) => distKm(a.location, fuzhou) - distKm(b.location, fuzhou))) {
      if (brigades + a.units.length > cap) continue;
      group.push(a); brigades += a.units.length;
      if (group.length === 3) break;
    }
    expect(orderInvasion(s, group, taipei).ok).toBe(true);
    for (let d = 0; d < 90 && s.provinces[taipei].controller !== 'CHN'; d++) runDays(s, 1);
    expect(s.provinces[taipei].controller).toBe('CHN');
  });
});
