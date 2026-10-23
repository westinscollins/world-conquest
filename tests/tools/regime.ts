import { newGame } from '../../src/engine/setup';
import { runDays } from '../../src/engine/sim';
import { avgApproval, stageOf } from '../../src/engine/regime';
const s = newGame('sandbox', { seed: 4, nation: 'SRB' });
for (let y = 1; y <= 8; y++) {
  runDays(s, 365);
  const ns = Object.values(s.nations).filter((n) => n.alive);
  const stages = [0, 0, 0, 0, 0, 0];
  for (const n of ns) stages[stageOf(n.regime.opposition).index]++;
  const appr = ns.map((n) => avgApproval(n)).sort((a, b) => a - b);
  const revolts = s.provinces.filter((p) => p.status === 'core' && p.resistance >= 70).length;
  const revs = s.events.filter((e) => e.text.startsWith('REVOLUTION')).length;
  const stab = ns.map((n) => n.stability).sort((a, b) => a - b);
  const me = s.nations.SRB;
  console.log(`y${y} stages ${stages.join('/')} appr p10 ${appr[Math.floor(appr.length * 0.1)].toFixed(0)} med ${appr[appr.length >> 1].toFixed(0)} p90 ${appr[Math.floor(appr.length * 0.9)].toFixed(0)} | stab med ${stab[stab.length >> 1].toFixed(0)} p10 ${stab[Math.floor(stab.length * 0.1)].toFixed(0)} | revolt provs ${revolts} revolutions ${revs} | SRB opp ${me.regime.opposition.toFixed(0)} legit ${me.regime.legitimacy.toFixed(0)} appr ${avgApproval(me).toFixed(0)} stab ${me.stability.toFixed(0)} groups ${Object.entries(me.regime.groups).map(([k, v]) => k[0] + Math.round(v)).join(' ')}`);
}
