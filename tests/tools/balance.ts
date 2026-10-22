import { newGame } from '../../src/engine/setup';
import { runDays } from '../../src/engine/sim';
import { ownedBy } from '../../src/engine/world';
const camp = process.argv[2] || 'serbia', seed = +(process.argv[3] || 5), years = +(process.argv[4] || 15);
const s = newGame(camp, { seed });
const out0: Record<string, number> = Object.fromEntries(Object.values(s.nations).map(n => [n.id, n.budget.output]));
const t0 = Date.now();
for (let y = 1; y <= years; y++) {
  runDays(s, 365);
  const alive = Object.values(s.nations).filter(n => n.alive);
  const top = alive.map(n => [n.name, ownedBy(s, n.id).length] as const).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const g = alive.map(n => n.budget.output / out0[n.id]).sort((a, b) => a - b);
  const p = s.nations[s.player];
  const longest = s.wars.reduce((m, w) => Math.max(m, s.day - w.startDay), 0);
  console.log(`y${y} alive ${alive.length} wars ${s.wars.length} (total ${s.stats.wars}, longest ${(longest/365).toFixed(1)}y) peace ${s.stats.peaceDeals} annex ${s.stats.annexations} | top ${top.map(t=>t.join(':')).join(' ')} | growth med ${g[g.length>>1].toFixed(2)} p90 ${g[Math.floor(g.length*.9)].toFixed(2)} | bankrupt ${alive.filter(n=>n.bankrupt).length} debt>out ${alive.filter(n=>n.debt>n.budget.output).length} | player ${p.alive ? ownedBy(s, p.id).length : 'DEAD'} T ${p.treasury.toFixed(0)} | ${((Date.now()-t0)/1000).toFixed(0)}s`);
}
