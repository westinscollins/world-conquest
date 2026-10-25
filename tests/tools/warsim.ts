// A player at war with a neighbour, playing simply: every army on "Attack" (MODE=campaign: every army
// ordered to invade, as the invasion planner does), peace asked for each month.
//   [MODE=campaign] npx tsx tests/tools/warsim.ts [days] [pairs as JSON]
import { newGame } from '../../src/engine/setup';
import { runDays } from '../../src/engine/sim';
import { runCommand } from '../../src/engine/commands';
import { evaluatePeace, scoreFor } from '../../src/engine/diplomacy';
import { ownedBy, controlledBy } from '../../src/engine/world';
import { armyStrength, militaryStrength } from '../../src/engine/military';
const days = +(process.argv[2] || 360);
const PAIRS = process.argv[3] ? JSON.parse(process.argv[3]) : [['SRB', 'HRV'], ['SRB', 'HUN'], ['POL', 'DEU'], ['FRA', 'BEL'], ['CHN', 'VNM'], ['VNM', 'THA'], ['ARM', 'AZE'], ['GRC', 'TUR'], ['KOR', 'JPN'], ['MEX', 'USA'], ['DEU', 'FRA'], ['EGY', 'ISR']];
for (const [me, them] of PAIRS) {
  for (const seed of [3, 7]) {
    const s = newGame('sandbox', { seed, nation: me });
    if (!s.nations[them]) { console.log('no', them); continue; }
    const strength0 = [militaryStrength(s, me), militaryStrength(s, them)];
    const campaign = process.env.MODE === 'campaign';
    const r = campaign ? runCommand(s, me, 'doInvade', [them, Object.values(s.armies).filter((a) => a.owner === me).map((a) => a.id)]) : runCommand(s, me, 'doDeclareWar', [them]);
    if (!r.ok) { console.log(me, them, r.message); continue; }
    const w0 = s.wars.find((w) => w.attackers.includes(me))!;
    const joiners = w0.defenders.filter((x) => x !== them);
    const mine = () => Object.values(s.armies).filter((a) => a.owner === me);
    if (!campaign) for (const a of mine()) a.stance = 'advance';
    let peace = '', d = 0;
    const provs0 = ownedBy(s, them).length;
    for (d = 30; d <= days && !peace; d += 30) {
      runDays(s, 30);
      if (!campaign) for (const a of mine()) a.stance = 'advance';
      const w = s.wars.find((x) => x.id === w0.id);
      if (!w) { peace = `war ended (by them/capitulation) day ${d}`; break; }
      const occ = w.occupiedByA.filter((p) => s.provinces[p].controller === me || w.attackers.includes(s.provinces[p].controller));
      // ask for everything we hold, then the half most valuable, then white peace if losing
      for (const terms of [occ, occ.slice(0, Math.ceil(occ.length / 2)), occ.slice(0, 1)]) {
        if (!terms.length) break;
        const t = { provinces: terms, taker: me, reparations: 0, vassalize: false, annex: false, white: false };
        const ev = evaluatePeace(s, w, me, t);
        if (ev.accept) { peace = `day ${d}: peace for ${terms.length} provinces (score ${scoreFor(w, me).toFixed(0)})`; runCommand(s, me, 'proposePeace', [w.id, t]); break; }
      }
    }
    const w = s.wars.find((x) => x.id === w0.id);
    const won = s.nations[me].stats.battlesWon, lost = s.nations[me].stats.battlesLost;
    console.log(`${me} v ${them} s${seed}: strength ${strength0[0]} v ${strength0[1]}${joiners.length ? ` +allies ${joiners.join(',')}` : ''} | battles ${won}W/${lost}L | ${w ? `still at war, score ${scoreFor(w, me).toFixed(0)}, occupied ${w.occupiedByA.length}/${provs0}, lost ${w.occupiedByD.length}` : ''} ${peace} | army ${Math.round(mine().reduce((t, a) => t + armyStrength(a), 0) / 1000)}k`);
  }
}
