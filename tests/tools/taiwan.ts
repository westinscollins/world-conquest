// China vs Taiwan: what each side has, and what happens when China invades.
//   npx tsx tests/tools/taiwan.ts [seed]
import { newGame } from '../../src/engine/setup';
import { runDays } from '../../src/engine/sim';
import { declareWar } from '../../src/engine/diplomacy';
import { militaryStrength, armyStrength, fleetPower } from '../../src/engine/military';
import { ownedBy, controlledBy } from '../../src/engine/world';
import { PROV, COUNTRY_GEO, WORLD, distKm } from '../../src/engine/geo';
import { checkSeaMove, embark, nationTransportCapacity, orderInvasion } from '../../src/engine/naval';
const seed = +(process.argv[2] || 3);
const s = newGame('sandbox', { seed, nation: 'CHN' });
import { wingsOf, wingPlanes, setMission, rebaseWing } from '../../src/engine/air';
const show = (id: string) => {
  const n = s.nations[id]; const arm = Object.values(s.armies).filter((a) => a.owner === id);
  const wings = wingsOf(s, id);
  const types: Record<string, number> = {};
  for (const a of arm) for (const u of a.units) types[u.type] = (types[u.type] ?? 0) + 1;
  const fl = Object.values(s.fleets).filter((f) => f.owner === id);
  return `${id} air ${wings.length} wings ${wings.reduce((x, w) => x + wingPlanes(w), 0)} planes (${wings.map((w) => w.units.map((u) => u.type[0]).join('')).join(' ')}) | str ${militaryStrength(s, id)} soldiers ${Math.round(arm.reduce((t, a) => t + armyStrength(a), 0) / 1000)}k in ${arm.length} armies ${JSON.stringify(types)} fleets ${fl.map((f) => `${JSON.stringify(f.ships)} pow ${fleetPower(f, n).toFixed(0)} @${WORLD.seas[f.sea].name}`).join('; ')} out ${Math.round(n.budget.output)} T ${Math.round(n.treasury)} mp ${Math.round(n.manpower / 1000)}k`;
};
console.log(show('CHN')); console.log(show('TWN'));
const twn = COUNTRY_GEO.TWN.provinces;
console.log('Taiwan provinces:', twn.map((p) => `${PROV[p].name}(${PROV[p].terrain}, port ${s.provinces[p].buildings.port}, fort ${s.provinces[p].buildings.fort}, seas ${PROV[p].seas}, straits ${PROV[p].straits.map((x) => PROV[x].name + '/' + PROV[x].country)})`).join('; '));
const chnCoast = COUNTRY_GEO.CHN.provinces.filter((p) => PROV[p].seas.some((z) => twn.some((t) => PROV[t].seas.includes(z))));
console.log('Chinese provinces sharing a sea with Taiwan:', chnCoast.map((p) => `${PROV[p].name}(port ${s.provinces[p].buildings.port})`).join(', '));
console.log('transport capacity', nationTransportCapacity(s, s.nations.CHN));

// ---- the invasion, as a player would do it
import { moveFleet } from '../../src/engine/naval';
import { createArmy } from '../../src/engine/military';
import { armiesIn } from '../../src/engine/world';
const C = s.nations.CHN;
declareWar(s, C, 'TWN');
const fuzhou = COUNTRY_GEO.CHN.provinces.find((p) => PROV[p].name === 'Fuzhou')!;
const taipei = twn.find((p) => PROV[p].name === 'Taipei')!;
// the navy goes to Taiwan's waters first (if the player thinks of it)
const navy = process.argv.includes('--navy');
if (navy) for (const f of Object.values(s.fleets).filter((f) => f.owner === 'CHN')) moveFleet(s, f, PROV[taipei].seas[0]);
// the air force moves to Fujian and flies support over the landing
if (process.argv.includes('--air')) for (const w of wingsOf(s, 'CHN')) { rebaseWing(s, w, COUNTRY_GEO.CHN.provinces.find((p) => PROV[p].name === 'Fuzhou')!); }
let inv: { id: number };
if (process.argv.includes('--player')) {
  // a sensible player: prepare for a month, then invade with the three armies nearest the coast
  runDays(s, 30);
  if (process.argv.includes('--air')) for (const w of wingsOf(s, 'CHN')) setMission(s, w, 'support');
  const armies = Object.values(s.armies).filter((a) => a.owner === 'CHN' && !a.battleId).sort((a, b) => distKm(a.location, fuzhou) - distKm(b.location, fuzhou));
  const group: typeof armies = []; let brig = 0;
  for (const a of armies) { if (brig + a.units.length > nationTransportCapacity(s, C).cap) continue; group.push(a); brig += a.units.length; if (group.length === 3) break; }
  const r = orderInvasion(s, group, taipei);
  console.log('invasion order', JSON.stringify(r), group.map((a) => `${a.name} ${a.units.length} brigades at ${PROV[a.location].name}`).join('; '));
  console.log('after preparation:', show('CHN')); console.log('                  ', show('TWN'));
  inv = group[0];
} else {
  // gather 20 good brigades at Fuzhou (teleported for the test)
  const pool = Object.values(s.armies).filter((a) => a.owner === 'CHN').flatMap((a) => a.units.map((u) => ({ a, u })));
  const pick = pool.filter((x) => x.u.type !== 'air').slice(0, 20);
  for (const x of pick) x.a.units = x.a.units.filter((u) => u !== x.u);
  const one = createArmy(s, 'CHN', fuzhou, pick.map((x) => x.u), 'Invasion Army');
  runDays(s, navy || process.argv.includes('--air') ? 12 : 1);
  if (process.argv.includes('--air')) for (const w of wingsOf(s, 'CHN')) setMission(s, w, 'support');
  console.log('after preparation:', show('CHN')); console.log('                  ', show('TWN'));
  console.log('sea check', JSON.stringify(checkSeaMove(s, one, taipei)));
  const r = embark(s, one, taipei);
  console.log('embark', r.ok, r.reason ?? '', 'days', r.days, 'risk', r.risk.toFixed(2));
  inv = one;
}
for (let d = 0; d < 120; d++) {
  runDays(s, 1);
  const b = Object.values(s.battles).filter((b) => b.province === taipei && b.attacker.nation === 'CHN').pop();
  if (d % 10 === 9 || (b && b.result)) {
    const cn = Object.values(s.armies).filter((a) => a.owner === 'CHN' && (a.seaDest != null || a.embarked || a.location === taipei || a.battleId === b?.id));
    console.log(`day ${d + 1}: invasion force ${Math.round(cn.reduce((t, a) => t + armyStrength(a), 0) / 1000)}k (${cn.map((a) => `${PROV[a.location].name}${a.embarked ? '@sea' : ''}${a.seaDest != null ? '→port' : ''}`).join(',')}) | Taipei defenders ${Math.round(armiesIn(s, taipei).filter((a) => a.owner === 'TWN').reduce((t, a) => t + armyStrength(a), 0) / 1000)}k | battle ${b ? `${b.result ?? 'ongoing'} day ${b.timeline.length} ${Math.round(b.attacker.strength / 1000)}k v ${Math.round(b.defender.strength / 1000)}k` : '-'} | Taipei ${s.provinces[taipei].controller} Kaohsiung ${s.provinces[twn.find((p) => PROV[p].name === 'Kaohsiung')!].controller}`);
    if (b?.result) { console.log('  factors:', b.factors.slice(0, 9).map((f) => `${f.label}(${f.side[0]}) ${f.value > 0 ? '+' : ''}${(f.value * 100).toFixed(0)}%`).join(', ')); console.log('  ', b.summary); if (b.result === 'attacker' || d > 100) break; }
  }
}
void inv;
{
  const b = Object.values(s.battles).filter((b) => b.province === taipei).pop();
  if (b) for (const d of b.timeline) console.log(`  d${d.day} ${d.phase}: A ${d.aStrength} org ${d.aOrg} mor ${d.aMorale} dmgTo ${d.aDamage} | D ${d.dStrength} org ${d.dOrg} mor ${d.dMorale} dmgTo ${d.dDamage} | ${d.events.join(' / ')}`);
}
