// Military: one place to run the armed forces — wars and battles (Command), every army, wing and
// fleet (Forces), everything you can buy (Build), and generals.
import { useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Bar, Stat, Tabs, Tip } from '../common';
import { num, neg, money, pct, cls } from '../format';
import { PROV } from '../../engine/geo';
import { atWar, controlledBy, isFriendly, ownedBy, neighborsOf } from '../../engine/world';
import { scoreFor, truePower, bestPeaceTerms } from '../../engine/diplomacy';
import { armyStrength, armyOrg, militaryStrength, TRAITS } from '../../engine/military';
import { ECON, WAR_ECONOMY, ROE, TACTICS } from '../../engine/config';
import { ensureCmd, commandSide } from '../../engine/battle';
import { fmtDate } from '../../engine/events';
import type { Battle, GameState, Stance, War } from '../../engine/types';
import { focusProvince } from '../commands';
import { live } from '../live';
import { audio } from '../../audio/music';
import { openBattle } from '../BattleView';
import { planInvasion } from '../InvasionPlanner';
import { ArmyRoster, AirForce, Navy } from './MilitaryForces';
import { BuildTab } from './MilitaryBuild';

const ORDERS: [Stance, string, string][] = [
  ['advance', 'Attack', 'Armies advance to the front and attack enemy provinces they can win'],
  ['defend', 'Defend', 'Armies stay put and rush to help neighbouring provinces under attack'],
  ['hold', 'Hold', 'Armies only move when you order them'],
  ['withdraw', 'Withdraw', 'Armies pull back into your own supplied territory'],
];
const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');
type Tab = 'command' | 'forces' | 'build' | 'generals';

export function MilitaryPanel() {
  const g = useGame();
  const me = g.player;
  const n = g.nations[me];
  const [tab, setTab] = useState<Tab>('command');
  const armies = Object.values(g.armies).filter((a) => a.owner === me);
  const battles = myBattles(g);
  const upkeep = n.budget.expenses.find((l) => l.key === 'military')?.amount ?? 0;
  return (
    <div className="panel-body">
      <div className="grid4">
        <Stat label="Military strength" value={militaryStrength(g, me).toLocaleString()} tip="Fixed points per formation (infantry 10, mechanized 18, armored 30, artillery 12), squadron and warship, including units in training. Changes only when you raise, disband or lose units." />
        <Stat label="Soldiers" value={num(armies.reduce((t, a) => t + armyStrength(a), 0))} tip={`${armies.reduce((t, a) => t + a.units.length, 0)} formations in ${armies.length} armies`} />
        <Stat label="Battles now" value={battles.length} tone={battles.length ? 'bad' : undefined} />
        <Stat label="Upkeep" value={`${money(upkeep)}/yr`} tip="Wages, equipment maintenance, garrison supply and standby fuel." />
      </div>
      <Briefing />
      <Tabs tabs={[['command', `Command${battles.length ? ` (${battles.length}⚔)` : ''}`], ['forces', `Forces (${armies.length})`], ['build', `Build${n.training.length + n.shipyard.length ? ` (${n.training.length + n.shipyard.length})` : ''}`], ['generals', 'Generals']]} value={tab} onChange={setTab} />
      {tab === 'command' && <CommandTab />}
      {tab === 'forces' && <><ArmyRoster /><AirForce /><Navy /></>}
      {tab === 'build' && <BuildTab />}
      {tab === 'generals' && <GeneralsTab />}
    </div>
  );
}

const myBattles = (g: GameState) => g.activeBattles.map((id) => g.battles[id]).filter((b): b is Battle => !!b && b.result == null && commandSide(g, b, g.player) != null);

// ---------------------------------------------------------------- advisor
interface Advice { text: string; act?: [string, () => void]; tone?: 'bad' | 'good' }
/** The chief of staff's three most useful suggestions right now. */
function advice(g: GameState): Advice[] {
  const me = g.player;
  const out: Advice[] = [];
  const armies = Object.values(g.armies).filter((a) => a.owner === me);
  const wars = g.wars.filter((w) => w.attackers.includes(me) || w.defenders.includes(me));
  const battles = myBattles(g);
  if (battles.length) {
    const b = battles[0];
    out.push({ text: `You are fighting ${battles.length === 1 ? 'a battle' : `${battles.length} battles`}${battles.length === 1 ? ` at ${PROV[b.province].name}` : ''}. Open it and pick each day's move: outguessing the enemy is the biggest edge you control.`, act: ['Command the battle', () => openBattle(b.id)], tone: 'bad' });
  }
  for (const w of wars) {
    const leader = w.leaderA === me || w.leaderD === me;
    const score = scoreFor(w, me);
    const t = leader && score > 15 ? bestPeaceTerms(g, w, me) : null;
    if (t && !t.white && (t.annex || t.provinces.length)) out.push({ text: `You are winning the ${w.name} (war score ${score.toFixed(0)}). They would accept peace now and give up ${t.annex ? 'everything' : `${t.provinces.length} province${t.provinces.length === 1 ? '' : 's'}`}.`, act: ['Make peace now', () => askBestPeace(g, w)], tone: 'good' });
  }
  if (wars.length) {
    const enemy = wars[0].attackers.includes(me) ? wars[0].leaderD : wars[0].leaderA;
    const idle = armies.filter((a) => !a.campaign && a.battleId == null && !a.path.length && !a.embarked && a.stance !== 'advance');
    if (idle.length >= 2) out.push({ text: `${idle.length} of your armies are sitting still. Send them to invade ${g.nations[enemy]?.name}: they take its provinces one by one on their own.`, act: ['Plan the invasion', () => planInvasion(enemy)] });
  } else {
    const nb = neighborsOf(g, me).filter((x) => g.nations[x]?.alive && !isFriendly(g, me, x) && g.nations[x].overlord !== me);
    // the biggest neighbour you can still clearly beat
    const weakest = nb.filter((x) => truePower(g, x) < truePower(g, me) * 0.8).sort((a, b) => ownedBy(g, b).length - ownedBy(g, a).length || truePower(g, b) - truePower(g, a))[0];
    if (weakest) out.push({ text: `At peace. ${g.nations[weakest].name} next door is weaker than you. To conquer a country, open the invasion planner: it shows both sides and declares war and invades in one go.`, act: [`Plan an invasion of ${g.nations[weakest].name}`, () => planInvasion(weakest)] });
    else out.push({ text: 'At peace. Grow your economy and army first; when you are ready, select any foreign province and press “Plan an invasion”.' });
  }
  const hungry = armies.filter((a) => a.lastSupplyRatio < 0.5 && !a.embarked);
  if (hungry.length) out.push({ text: `${hungry.length} ${hungry.length === 1 ? 'army is' : 'armies are'} short of supply and fight far worse. Pull them back, or build depots and railways behind the front.`, tone: 'bad' });
  if (wars.length && !armies.some((a) => a.units.some((u) => u.type === 'artillery'))) out.push({ text: 'You have no artillery, so you cannot call barrages in battle. Recruit a few Artillery Regiments (Build tab).' });
  return out.slice(0, 3);
}
function Briefing() {
  const g = useGame();
  const [open, setOpen] = useState(true);
  const list = advice(g);
  if (!list.length) return null;
  return (
    <div className={cls('briefing', !open && 'closed')}>
      <div className="row gap" onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}><b>🎖 Chief of staff</b><span className="small muted">{open ? 'hide' : `${list.length} suggestion${list.length === 1 ? '' : 's'}`}</span></div>
      {open && list.map((a, i) => (
        <div key={i} className={cls('advice', a.tone)}>
          <span>{a.text}</span>
          {a.act && <Btn small kind="primary" onClick={() => { audio.sfx('click'); a.act![1](); }}>{a.act[0]}</Btn>}
        </div>
      ))}
    </div>
  );
}
function askBestPeace(g: GameState, w: War) {
  const t = bestPeaceTerms(g, w, g.player);
  if (!t) { store.toast('The enemy refuses any peace right now.', 'bad'); return; }
  const what = t.white ? 'a white peace (nobody gains anything)' : t.annex ? 'annexing them completely' : `${t.provinces.length} province${t.provinces.length === 1 ? '' : 's'}: ${t.provinces.slice(0, 12).map((p) => PROV[p].name).join(', ')}${t.provinces.length > 12 ? '…' : ''}`;
  store.setUI({ confirm: { title: `End the ${w.name}?`, body: `The best terms they accept today: ${what}.\n\nYou can also keep fighting to take more, or negotiate other terms in Diplomacy.`, okLabel: 'Sign the peace', onOk: () => say(store.cmd('doBestPeace', [w.id])) } });
}

// ---------------------------------------------------------------- command
function CommandTab() {
  const g = useGame();
  const me = g.player;
  const n = g.nations[me];
  const armies = Object.values(g.armies).filter((a) => a.owner === me);
  const wars = g.wars.filter((w) => w.attackers.includes(me) || w.defenders.includes(me));
  const battles = myBattles(g);
  const [lost7, killed7] = live.recent(g, 7);
  const count = (st: Stance) => armies.filter((a) => a.stance === st && !a.campaign).length;
  const campaigning = armies.filter((a) => a.campaign).length;
  return (
    <>
      {battles.length > 0 && (
        <Section title={`Battles now (${battles.length})`} icon="sword">
          {battles.map((b) => <BattleRow key={b.id} b={b} />)}
        </Section>
      )}
      {wars.map((w) => <WarSummary key={w.id} w={w} />)}
      {wars.length > 0 && <p className="small muted">Last 7 days: <b className="bad">{num(lost7)}</b> of your soldiers lost · <b>{num(killed7)}</b> enemy soldiers lost.</p>}
      {!wars.length && <PeaceTargets />}
      <Section title="Standing orders for all armies" icon="sword" right={campaigning ? <span className="small muted">{campaigning} invading</span> : undefined}>
        <div className="orders">
          {ORDERS.map(([st, label, tip]) => (
            <button key={st} className="btn" title={tip} onClick={() => { audio.sfx('click'); say(store.cmd('setAllStances', [st])); }}>
              {label}<small>{count(st)} armies</small>
            </button>
          ))}
        </div>
        <p className="small muted">Standing orders replace any invasion orders. To pick armies one by one, use the Forces tab.</p>
      </Section>
      <Section title="War footing" icon="factory">
        <div className="mob">
          <Tip wide tip={`Mobilisation (${ECON.MOBILIZATION_DAYS} days to full): raises the organisation cap of all formations from 55% to 100% and more than doubles available manpower; costs +${Math.round((ECON.MOBILIZED_UPKEEP - 1) * 100)}% military upkeep and −${Math.round((1 - ECON.MOBILIZED_OUTPUT) * 100)}% output. Wars start it automatically.`}>
            <label className="check"><input type="checkbox" checked={n.mobilize} onChange={(e) => say(store.cmd('setMobilization', [e.target.checked]))} /> Mobilised</label>
          </Tip>
          <Bar value={n.mobilization} h={6} />
          <span className="small">{pct(n.mobilization)}</span>
        </div>
        <div className="policy-opts">
          {(Object.keys(WAR_ECONOMY) as (keyof typeof WAR_ECONOMY)[]).map((k) => (
            <button key={k} className={cls('posture', n.regime.warEconomy === k && 'on')} title={WAR_ECONOMY[k].desc} onClick={() => n.regime.warEconomy !== k && say(store.cmd('doWarEconomy', [k]))}>{WAR_ECONOMY[k].label}<span>{WAR_ECONOMY[k].desc}</span></button>
          ))}
        </div>
        <div className="row gap small" style={{ marginTop: 6 }}>
          <span>Rules of engagement</span>
          <select value={n.regime.roe} onChange={(e) => say(store.cmd('doRoe', [e.target.value]))} title={ROE[n.regime.roe].desc}>
            {(Object.keys(ROE) as (keyof typeof ROE)[]).map((k) => <option key={k} value={k}>{ROE[k].label}</option>)}
          </select>
          <span className="muted">{ROE[n.regime.roe].desc}</span>
        </div>
      </Section>
    </>
  );
}

/** At peace: the neighbours you could take on, weakest first. */
function PeaceTargets() {
  const g = useGame();
  const me = g.player;
  const mine = truePower(g, me);
  const nb = neighborsOf(g, me).filter((x) => g.nations[x]?.alive && !isFriendly(g, me, x) && g.nations[x].overlord !== me).sort((a, b) => truePower(g, a) - truePower(g, b)).slice(0, 6);
  return (
    <Section title="You are at peace" icon="crown">
      <p className="small">To conquer a country, plan an invasion: you see both sides and their allies, choose the armies, and they declare war and take it province by province. Any country works — select one of its provinces on the map. Your neighbours:</p>
      <div className="targets">
        {nb.map((x) => {
          const r = mine / Math.max(1, truePower(g, x));
          return (
            <div key={x} className="target">
              <span className="swatch" style={{ background: g.nations[x].color }} /><b>{g.nations[x].name}</b>
              <span className={cls('small', r > 1.5 ? 'good' : r < 0.8 ? 'bad' : 'warn')}>{r > 1.5 ? 'weaker' : r < 0.8 ? 'stronger' : 'similar'}</span>
              <Btn small onClick={() => planInvasion(x)}>Invade…</Btn>
            </div>
          );
        })}
        {!nb.length && <span className="small muted">No hostile neighbours: select any foreign province to plan an invasion overseas.</span>}
      </div>
    </Section>
  );
}

function WarSummary({ w }: { w: War }) {
  const g = useGame();
  const me = g.player;
  const score = scoreFor(w, me);
  const mySide = w.attackers.includes(me) ? 'A' : 'D';
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
  const enemyLeader = mySide === 'A' ? w.leaderD : w.leaderA;
  const taken = enemies.flatMap((e) => ownedBy(g, e)).filter((p) => g.provinces[p].controller === me || isFriendly(g, me, g.provinces[p].controller));
  const lost = ownedBy(g, me).filter((p) => atWar(g, me, g.provinces[p].controller));
  const leader = w.leaderA === me || w.leaderD === me;
  const invading = Object.values(g.armies).filter((a) => a.owner === me && a.campaign && enemies.includes(a.campaign)).length;
  return (
    <div className="war-card">
      <h4>{w.name}<span className="small muted">since {fmtDate(g, w.startDay)}</span></h4>
      <div className="score-bar"><div className="sb-neg" style={{ width: `${Math.max(0, -score) / 2}%` }} /><div className="sb-mid" /><div className="sb-pos" style={{ width: `${Math.max(0, score) / 2}%` }} /></div>
      <div className="vs">
        <b>You{(mySide === 'A' ? w.attackers : w.defenders).length > 1 ? ' & allies' : ''}</b><span className="c">war score {score.toFixed(0)}</span><b className="r">{enemies.map((x) => g.nations[x]?.name).join(', ')}</b>
        <span className="big-num bad">{neg(myCas)}</span><span className="c">soldiers lost</span><span className="big-num r">{neg(theirCas)}</span>
        <span className="big-num good">{taken.length}</span><span className="c">provinces taken</span><span className="big-num r bad">{lost.length}</span>
      </div>
      {lost.length > 0 && <p className="small">Held by the enemy: {lost.slice(0, 8).map((p) => <a key={p} className="link" onClick={() => { focusProvince(p); store.setUI({ selectedProvince: p }); }}>{PROV[p].name} </a>)}{lost.length > 8 ? `+${lost.length - 8} more` : ''}</p>}
      <div className="row gap wrap">
        <Btn small kind="primary" onClick={() => planInvasion(enemyLeader)}>{invading ? `Invading with ${invading} armies — add more…` : `Invade ${g.nations[enemyLeader]?.name}…`}</Btn>
        {leader ? <>
          <Btn small onClick={() => askBestPeace(g, w)}>Make peace now…</Btn>
          <Btn small onClick={() => store.setUI({ panel: 'diplomacy', peaceWar: w.id })}>Other terms…</Btn>
        </> : <span className="small muted">Peace is negotiated by the war leaders.</span>}
        <Btn small onClick={() => { const f = lost[0] ?? taken[0] ?? controlledBy(g, me)[0]; if (f != null) focusProvince(f); store.setUI({ mapMode: 'military' }); }}>Show the front</Btn>
      </div>
    </div>
  );
}

function BattleRow({ b }: { b: Battle }) {
  const g = useGame();
  const side = commandSide(g, b, g.player)!;
  const attacking = side === 'a';
  const ours = attacking ? b.attacker : b.defender, theirs = attacking ? b.defender : b.attacker;
  const lost = (x: typeof ours) => x.losses.killed + x.losses.wounded;
  const myArmies = ours.armyIds.map((id) => g.armies[id]).filter((a) => a && a.battleId === b.id);
  const enemy = g.nations[theirs.nation];
  const c = ensureCmd(b)[side];
  const myOrg = myArmies.length ? myArmies.reduce((t, a) => t + armyOrg(a!), 0) / myArmies.length : 0;
  const last = b.timeline[b.timeline.length - 1];
  const res = last?.edge == null ? null : last.edge === side ? 'won' : 'lost';
  return (
    <div className="battle-row">
      <div className="row gap">
        <b className="link" onClick={() => openBattle(b.id)}>{attacking ? '⚔ Attacking' : '🛡 Defending'} {PROV[b.province].name}</b>
        <span className="small muted">vs {enemy?.name} · day {b.timeline.length}{res ? ` · yesterday ${res === 'won' ? 'you won the day' : 'they won the day'}` : ''}</span>
        <div style={{ flex: 1 }} />
        <Btn small kind="primary" onClick={() => openBattle(b.id)}>Command ▸</Btn>
      </div>
      <div className="vs">
        <span>You: {num(ours.strength)}</span><span className="c">losses</span><span className="r">{enemy?.name}: {num(theirs.strength)}</span>
        <span className="big-num bad">{neg(lost(ours))}</span><span /><span className="big-num r">{neg(lost(theirs))}</span>
        <Bar value={myOrg} h={5} title="Your organisation: at 0 your troops break" /><span className="c">order</span><Bar value={theirs.org} h={5} title="Enemy organisation" />
      </div>
      <div className="small muted">Tomorrow: {TACTICS[c.plan].icon} {TACTICS[c.plan].label}{c.order === 'auto' ? ' (general decides)' : ''}{c.hint ? ` · scouts: enemy will ${TACTICS[c.hint].label.toLowerCase()} (${Math.round(c.hintSure * 100)}%)` : ''}</div>
    </div>
  );
}

// ---------------------------------------------------------------- generals
function GeneralsTab() {
  const g = useGame();
  const n = g.nations[g.player];
  const armies = Object.values(g.armies).filter((a) => a.owner === g.player);
  return (
    <>
      <Section title="Your generals" icon="star">
        {Object.values(g.generals).filter((x) => x.owner === g.player && !x.available).map((x) => (
          <div key={x.id} className="general-row">
            <div><b>{x.name}</b> <span className="chip">{TRAITS[x.trait].label}</span><div className="small muted">Atk {x.attack} · Def {x.defense} · Log {x.logistics} — {TRAITS[x.trait].desc}</div></div>
            <select value={x.armyId ?? ''} onChange={(e) => store.cmd('doAssignGeneral', [x.id, e.target.value === '' ? null : +e.target.value])}>
              <option value="">Reserve</option>
              {armies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        ))}
      </Section>
      <Section title="Available for appointment" icon="people">
        {Object.values(g.generals).filter((x) => x.owner === g.player && x.available).map((x) => (
          <div key={x.id} className="general-row">
            <div><b>{x.name}</b> <span className="chip">{TRAITS[x.trait].label}</span><div className="small muted">Atk {x.attack} · Def {x.defense} · Log {x.logistics} — {TRAITS[x.trait].desc}</div></div>
            <Btn small kind="primary" disabled={n.treasury < x.hireCost} onClick={() => { const r = store.cmd('hireGeneral', [x.id]); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Hire {money(x.hireCost)}</Btn>
          </div>
        ))}
        <p className="small muted">Generals cost a one-time appointment fee and $250M/yr salary. They gain experience in battle and improve their skills. A general in a battle also picks its manoeuvres when you leave it to him; aggressive ones like to assault, cautious ones to hold.</p>
      </Section>
    </>
  );
}

