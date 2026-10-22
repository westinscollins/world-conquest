import { newGame } from '../../src/engine/setup';
import { battleDaily, startBattle } from '../../src/engine/battle';
import { createArmy, newUnit } from '../../src/engine/military';
import { declareWar } from '../../src/engine/diplomacy';
import { invalidateArmies } from '../../src/engine/world';
import { PROV } from '../../src/engine/geo';
import type { UnitType } from '../../src/engine/types';
function duel(atk: UnitType[], def: UnitType[], seed: number, sup = 1, ent = 0.3) {
  const s = newGame('serbia', { seed }); s.armies = {}; invalidateArmies();
  const prov = s.nations.SRB.capital; const from = PROV[prov].neighbors[0];
  const atkN = s.provinces[from].owner; declareWar(s, s.nations[atkN], 'SRB');
  const mk = (o: string, l: number, ts: UnitType[]) => createArmy(s, o, l, ts.map(t => { const u = newUnit(s, t, 1, .2); u.org = .8; u.morale = .7; return u; }));
  const A = mk(atkN, from, atk), D = mk('SRB', prov, def); A.lastSupplyRatio = sup; D.entrench = ent;
  const b = startBattle(s, [A], prov, from)!;
  for (let i = 0; i < 40 && b.result == null; i++) { A.lastSupplyRatio = sup; battleDaily(s, b); s.day++; }
  return b;
}
const I = 'infantry' as UnitType, R = 'artillery' as UnitType, T = 'armored' as UnitType;
const cases: [string, UnitType[], UnitType[], number, number][] = [
  ['3v3 inf', [I,I,I], [I,I,I], 1, .3], ['5v3 inf', [I,I,I,I,I], [I,I,I], 1, 0], ['5v3 inf ent1', [I,I,I,I,I], [I,I,I], 1, 1],
  ['5v3 nosupply ent1', [I,I,I,I,I], [I,I,I], .05, 1], ['4i2a v 3i', [I,I,I,I,R,R], [I,I,I], 1, .3], ['3i2t1a v 4i', [I,I,I,T,T,R], [I,I,I,I], 1, .3], ['8v3', [I,I,I,I,I,I,I,I], [I,I,I], 1, .3],
];
for (const [n, a, d, sup, ent] of cases) {
  let w = 0, days = 0, la = 0, ld = 0;
  for (let seed = 1; seed <= 6; seed++) { const b = duel(a, d, seed, sup, ent); if (b.result === 'attacker') w++; days += b.timeline.length; la += b.attacker.losses.killed + b.attacker.losses.wounded; ld += b.defender.losses.killed + b.defender.losses.wounded; }
  console.log(n.padEnd(20), 'atk wins', w, '/6 days', (days/6).toFixed(1), 'loss A', Math.round(la/6), 'D', Math.round(ld/6));
}
