import { newGame } from '../../src/engine/setup';
import { runDays } from '../../src/engine/sim';
import { declareWar } from '../../src/engine/diplomacy';
import { militaryStrength, armyStrength } from '../../src/engine/military';
import { ownedBy, controlledBy } from '../../src/engine/world';
const s = newGame('sandbox', { seed: 4, nation: 'SRB' });
const show = (id: string) => { const n = s.nations[id]; const arm = Object.values(s.armies).filter(a => a.owner === id); return `${id} str ${militaryStrength(s, id)} soldiers ${Math.round(arm.reduce((t, a) => t + armyStrength(a), 0) / 1000)}k armies ${arm.length} out ${Math.round(n.budget.output)} owned ${ownedBy(s, id).length} ctrl ${controlledBy(s, id).length} mp ${Math.round(n.manpower/1000)}k T ${Math.round(n.treasury)} net ${n.budget.net.toFixed(0)} mob ${n.mobilization.toFixed(2)}`; };
for (const id of ['CHN', 'KHM', 'TJK']) console.log(show(id));
declareWar(s, s.nations.TJK, 'CHN'); declareWar(s, s.nations.KHM, 'CHN');
for (let m = 0; m < 8; m++) {
  runDays(s, 30);
  const w = s.wars.find(w => w.attackers.includes('TJK'));
  console.log('m' + (m + 1), w ? `score ${w.scoreA.toFixed(0)} occA ${w.occupiedByA.length} occD ${w.occupiedByD.length} casA ${Math.round(w.casualtiesA)} casD ${Math.round(w.casualtiesD)} att ${w.attackers} def ${w.defenders}` : 'no war', '|', show('CHN'), '|', show('TJK'));
  if (!w) break;
}
import { PROV } from '../../src/engine/geo';
const byLoc = new Map<number, { n: number; str: number; sup: number[] }>();
for (const a of Object.values(s.armies).filter(a => a.owner === 'CHN')) { const e = byLoc.get(a.location) ?? { n: 0, str: 0, sup: [] }; e.n++; e.str += armyStrength(a); e.sup.push(+a.lastSupplyRatio.toFixed(2)); byLoc.set(a.location, e); }
for (const [p, e] of byLoc) console.log(PROV[p].name, PROV[p].country, PROV[p].terrain, e.n, Math.round(e.str / 1000) + 'k', e.sup.join(','));
console.log(Object.values(s.battles).filter(b => b.attacker.nation === 'CHN' || b.defender.nation === 'CHN').map(b => `${b.attacker.nation}>${b.defender.nation} ${PROV[b.province].name} ${b.result} ${Math.round(b.attacker.startStrength)} v ${Math.round(b.defender.startStrength)}`).join('\n'));
