import { store, useGame } from '../store';
import { Section, Btn, Bar, Stat } from '../common';
import { num, neg } from '../format';
import { PROV, distKm } from '../../engine/geo';
import { atWar, controlledBy, isFriendly, ownedBy } from '../../engine/world';
import { scoreFor } from '../../engine/diplomacy';
import { armyStrength, armyOrg, militaryStrength } from '../../engine/military';
import { POSTURES } from '../../engine/config';
import { fmtDate } from '../../engine/events';
import type { Battle, Posture, Stance, War } from '../../engine/types';
import { focusProvince } from '../commands';
import { live } from '../live';
import { audio } from '../../audio/music';

const ORDERS: [Stance, string, string][] = [
  ['advance', 'Attack', 'Armies advance to the front and attack enemy provinces they can win'],
  ['defend', 'Defend', 'Armies stay put and rush to help neighbouring provinces under attack'],
  ['hold', 'Hold', 'Armies only move when you order them'],
  ['withdraw', 'Withdraw', 'Armies pull back into your own supplied territory'],
];
const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');

/** War Room: one screen to run your wars — live losses, every battle, and orders for all armies. */
export function WarPanel() {
  const g = useGame();
  const me = g.player;
  const armies = Object.values(g.armies).filter((a) => a.owner === me);
  const wars = g.wars.filter((w) => w.attackers.includes(me) || w.defenders.includes(me));
  const battles = g.activeBattles.map((id) => g.battles[id]).filter((b): b is Battle => !!b && b.result == null && (b.attacker.nation === me || b.defender.nation === me));
  const [lost7, killed7] = live.recent(g, 7);
  const count = (st: Stance) => armies.filter((a) => a.stance === st).length;
  return (
    <div className="panel-body">
      <div className="grid3">
        <Stat label="Military strength" value={militaryStrength(g, me).toLocaleString()} tip="Fixed points per formation and warship (incl. units in training). Changes only when you raise, disband or lose units." />
        <Stat label="Soldiers" value={num(armies.reduce((t, a) => t + armyStrength(a), 0))} />
        <Stat label="Battles now" value={battles.length} tone={battles.length ? 'bad' : undefined} />
      </div>

      <Section title="Orders for all armies" icon="sword">
        <div className="orders">
          {ORDERS.map(([st, label, tip]) => (
            <button key={st} className="btn" title={tip} onClick={() => { audio.sfx('click'); say(store.cmd('setAllStances', [st])); }}>
              {label}<small>{count(st)} armies</small>
            </button>
          ))}
        </div>
        <p className="small muted">Set one army's orders in its panel. Select an army, then shift-click others to move them together. Right-click a province to send them there.</p>
      </Section>

      {!wars.length && <p className="muted">You are at peace. Declare war from Diplomacy → select a nation. Your armies' orders apply the moment a war starts.</p>}
      {wars.map((w) => <WarSummary key={w.id} w={w} />)}
      {wars.length > 0 && (
        <p className="small muted">Last 7 days: <b className="bad">{num(lost7)}</b> of your soldiers lost · <b>{num(killed7)}</b> enemy soldiers lost.</p>
      )}

      {battles.length > 0 && (
        <Section title={`Battles in progress (${battles.length})`} icon="sword">
          {battles.map((b) => <BattleRow key={b.id} b={b} />)}
        </Section>
      )}
    </div>
  );
}

function WarSummary({ w }: { w: War }) {
  const g = useGame();
  const me = g.player;
  const score = scoreFor(w, me);
  const mySide = w.attackers.includes(me) ? 'A' : 'D';
  // add the running totals of battles still being fought
  let myCas = mySide === 'A' ? w.casualtiesA : w.casualtiesD;
  let theirCas = mySide === 'A' ? w.casualtiesD : w.casualtiesA;
  for (const id of g.activeBattles) {
    const b = g.battles[id];
    if (!b || b.warId !== w.id) continue;
    const a = b.attacker.losses.killed + b.attacker.losses.wounded, d = b.defender.losses.killed + b.defender.losses.wounded;
    const atkMine = mySide === 'A' ? w.attackers.includes(b.attacker.nation) : w.defenders.includes(b.attacker.nation);
    if (atkMine) { myCas += a; theirCas += d; } else { myCas += d; theirCas += a; }
  }
  const enemies = mySide === 'A' ? w.defenders : w.attackers;
  const taken = enemies.flatMap((e) => ownedBy(g, e)).filter((p) => g.provinces[p].controller === me || isFriendly(g, me, g.provinces[p].controller));
  const lost = ownedBy(g, me).filter((p) => atWar(g, me, g.provinces[p].controller));
  const leader = w.leaderA === me || w.leaderD === me;
  return (
    <div className="war-card">
      <h4>{w.name}<span className="small muted">since {fmtDate(g, w.startDay)}</span></h4>
      <div className="score-bar"><div className="sb-neg" style={{ width: `${Math.max(0, -score) / 2}%` }} /><div className="sb-mid" /><div className="sb-pos" style={{ width: `${Math.max(0, score) / 2}%` }} /></div>
      <div className="vs">
        <b>You {mySide === 'A' ? w.attackers.length > 1 ? '& allies' : '' : w.defenders.length > 1 ? '& allies' : ''}</b><span className="c">war score {score.toFixed(0)}</span><b className="r">{enemies.map((x) => g.nations[x]?.name).join(', ')}</b>
        <span className="big-num bad">{neg(myCas)}</span><span className="c">soldiers lost</span><span className="big-num r">{neg(theirCas)}</span>
        <span className="big-num good">{taken.length}</span><span className="c">provinces taken</span><span className="big-num r bad">{lost.length}</span>
      </div>
      {lost.length > 0 && <p className="small">Held by the enemy: {lost.slice(0, 8).map((p) => <a key={p} className="link" onClick={() => { focusProvince(p); store.setUI({ selectedProvince: p }); }}>{PROV[p].name} </a>)}{lost.length > 8 ? `+${lost.length - 8} more` : ''}</p>}
      <div className="row gap">
        {leader ? <Btn small kind="primary" onClick={() => store.setUI({ panel: 'diplomacy', peaceWar: w.id })}>Negotiate peace…</Btn> : <span className="small muted">Peace is negotiated by the war leaders.</span>}
        <Btn small onClick={() => { const f = lost[0] ?? taken[0] ?? controlledBy(g, me)[0]; if (f != null) focusProvince(f); store.setUI({ mapMode: 'military' }); }}>Show the front</Btn>
      </div>
    </div>
  );
}

function BattleRow({ b }: { b: Battle }) {
  const g = useGame();
  const me = g.player;
  const attacking = b.attacker.nation === me;
  const ours = attacking ? b.attacker : b.defender, theirs = attacking ? b.defender : b.attacker;
  const lost = (x: typeof ours) => x.losses.killed + x.losses.wounded;
  const myArmies = ours.armyIds.map((id) => g.armies[id]).filter((a) => a && a.battleId === b.id);
  const posture = attacking ? b.attackerPosture : b.defenderPosture;
  const enemy = g.nations[theirs.nation];
  // idle armies that could march to help, nearest first
  const helpers = Object.values(g.armies)
    .filter((a) => a.owner === me && a.battleId == null && !a.embarked && !a.path.length && a.location !== b.province)
    .map((a) => ({ a, d: distKm(a.location, b.province) }))
    .sort((x, y) => x.d - y.d).slice(0, 6);
  const myOrg = myArmies.length ? myArmies.reduce((t, a) => t + armyOrg(a!), 0) / myArmies.length : 0;
  return (
    <div className="battle-row">
      <div className="row gap">
        <b className="link" onClick={() => { focusProvince(b.province); store.setUI({ selectedProvince: b.province }); }}>{attacking ? '⚔ Attacking' : '🛡 Defending'} {PROV[b.province].name}</b>
        <span className="small muted">vs {enemy?.name} · day {b.timeline.length}</span>
        <div style={{ flex: 1 }} />
        <Btn small onClick={() => store.setUI({ battleReport: b.id })}>Details</Btn>
      </div>
      <div className="vs">
        <span>You: {num(ours.strength)} soldiers</span><span className="c">losses</span><span className="r">{enemy?.name}: {num(theirs.strength)}</span>
        <span className="big-num bad">{neg(lost(ours))}</span><span /><span className="big-num r">{neg(lost(theirs))}</span>
        <Bar value={myOrg} h={5} title="Your organisation: at 0 your troops break" /><span className="c">order</span><Bar value={theirs.org} h={5} title="Enemy organisation" />
      </div>
      {myArmies.length > 0 && (
        <div className="row gap wrap" style={{ marginTop: 6 }}>
          <select value={posture} title="Battle posture: applies from tomorrow" onChange={(e) => say(store.cmd('setPosture', [myArmies[0]!.id, e.target.value as Posture]))}>
            {(Object.keys(POSTURES) as Posture[]).map((p) => <option key={p} value={p}>{POSTURES[p].label}</option>)}
          </select>
          <Btn small kind="danger" onClick={() => myArmies.forEach((a) => say(store.cmd('retreatArmy', [a!.id])))}>{attacking ? 'Call off attack' : 'Retreat'}</Btn>
          {helpers.length > 0 && (
            <select value="" onChange={(e) => { if (e.target.value) say(store.cmd('moveArmy', [+e.target.value, b.province])); }}>
              <option value="">Send reinforcements…</option>
              {helpers.map(({ a, d }) => <option key={a.id} value={a.id}>{a.name} ({num(armyStrength(a))}, {Math.round(d)} km)</option>)}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
