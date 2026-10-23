import { newGame } from '../../src/engine/setup';
import { tick } from '../../src/engine/sim';
import { recruit, armyPower } from '../../src/engine/military';
import { truePower } from '../../src/engine/diplomacy';
const s = newGame('serbia', { seed: 3 });
const n = s.nations.SRB;
n.treasury = 400; n.manpower = 200000;
const show = (lbl: string) => {
  const armies = Object.values(s.armies).filter(a => a.owner === 'SRB');
  const units = armies.flatMap(a => a.units);
  const arm = units.filter(u => u.type === 'armored');
  console.log(lbl.padEnd(14), 'power', truePower(s, 'SRB').toFixed(0), '| training', n.training.length, '| armored deployed', arm.length,
    arm.length ? `equip ${(arm.reduce((t,u)=>t+u.equipment,0)/arm.length*100).toFixed(0)}% org ${(arm.reduce((t,u)=>t+u.org,0)/arm.length*100).toFixed(0)}%` : '',
    '| supply', armies.map(a => (a.lastSupplyRatio*100).toFixed(0)+'%').join(','), '| net', n.budget.net.toFixed(1), 'T', n.treasury.toFixed(0), 'oil short', (n.shortages.oil*100).toFixed(0)+'%', 'armor stock', n.stockpile.armor.toFixed(1));
};
show('before');
for (let i = 0; i < 30; i++) recruit(s, n, 'armored', n.capital);
s.day++; tick(s); show('recruited');
for (let d = 0; d < 130; d++) tick(s);
show('day 130');
for (let d = 0; d < 120; d++) tick(s);
show('day 250');
