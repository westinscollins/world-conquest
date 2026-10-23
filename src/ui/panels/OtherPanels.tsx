import { useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Bar, Tabs, Stat } from '../common';
import { TECHS, BRANCHES, canResearch, researchRate } from '../../engine/research';
import { chooseResearch, queueResearch } from '../../engine/actions';
import { ACHIEVEMENTS, victoryProgress } from '../../engine/victory';
import { TUTORIAL } from '../../engine/tutorial';
import { fmtDate } from '../../engine/events';
import { ownedBy, livingNations } from '../../engine/world';
import { num, pct, money } from '../format';
import { focusProvince } from '../commands';

export function ResearchPanel() {
  const g = useGame();
  const n = g.nations[g.player];
  const rate = researchRate(g, n);
  const cur = n.research.current ? TECHS.find((t) => t.id === n.research.current) : null;
  return (
    <div className="panel-body">
      <div className="grid3">
        <Stat label="Research rate" value={`${rate.toFixed(1)} RP/yr`} tip="From research funding (Economy) and Research Institutes." />
        <Stat label="Current" value={cur ? cur.name : 'none'} />
        <Stat label="ETA" value={cur ? `${Math.ceil(((cur.cost - n.research.progress) / Math.max(0.01, rate)) * 365)} days` : '—'} />
      </div>
      {cur && <Bar value={n.research.progress / cur.cost} h={8} />}
      <div className="tech-tree">
        {BRANCHES.map((b) => (
          <div key={b} className="branch">
            <h4>{b}</h4>
            {TECHS.filter((t) => t.branch === b).sort((x, y) => x.tier - y.tier).map((t) => {
              const done = n.research.done.includes(t.id);
              const avail = canResearch(n, t.id);
              const active = n.research.current === t.id;
              const queued = n.research.queue.includes(t.id);
              return (
                <div key={t.id} className={`tech${done ? ' done' : avail ? ' avail' : ' locked'}${active ? ' active' : ''}`}>
                  <div className="tech-h"><b>{t.name}</b><span className="muted small">T{t.tier} · {t.cost} RP</span></div>
                  <div className="small">{t.effect}</div>
                  {!done && (
                    <div className="row gap">
                      {avail && !active && <Btn small kind="primary" onClick={() => store.cmd('chooseResearch', [t.id])}>Research</Btn>}
                      {!active && !queued && <Btn small kind="ghost" onClick={() => store.cmd('queueResearch', [t.id])}>Queue</Btn>}
                      {queued && <span className="chip">queued</span>}
                      {active && <span className="chip good">in progress {pct(n.research.progress / t.cost)}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatsPanel() {
  const g = useGame();
  const [tab, setTab] = useState<'objectives' | 'timeline' | 'achievements' | 'world'>('objectives');
  const n = g.nations[g.player];
  const prog = victoryProgress(g);
  return (
    <div className="panel-body">
      <Tabs tabs={[['objectives', 'Objectives'], ['timeline', 'History'], ['achievements', 'Achievements'], ['world', 'World ranking']]} value={tab} onChange={setTab} />
      {tab === 'objectives' && (
        <>
          <Section title="Victory condition" icon="crown">
            {prog.map((p) => <div key={p.label} className="vp"><div className="row"><span>{p.label}</span><div style={{ flex: 1 }} /><b>{p.current < 1 && p.current > 0 && p.target < 1 ? pct(p.current, 1) : p.current.toFixed(p.current < 10 ? 1 : 0)} / {p.target < 1 ? pct(p.target) : p.target}</b></div><Bar value={p.pct} h={8} color="var(--gold)" /></div>)}
          </Section>
          <Section title="Campaign statistics" icon="chart">
            <div className="grid3">
              <Stat label="Battles won" value={n.stats.battlesWon} />
              <Stat label="Battles lost" value={n.stats.battlesLost} />
              <Stat label="Provinces" value={`${ownedBy(g, g.player).length} (peak ${n.stats.peakProvinces})`} />
              <Stat label="Casualties inflicted" value={num(n.stats.casualtiesInflicted)} />
              <Stat label="Casualties suffered" value={num(n.stats.casualtiesSuffered)} />
              <Stat label="Peak output" value={`${money(n.stats.peakOutput)} IC`} />
              <Stat label="Days elapsed" value={g.day} />
              <Stat label="World wars fought" value={g.stats.wars} />
              <Stat label="Nations annexed (world)" value={g.stats.annexations} />
            </div>
          </Section>
        </>
      )}
      {tab === 'timeline' && (
        <div className="timeline">
          {g.timeline.slice().reverse().map((e) => (
            <div key={e.id} className={`tl-ev k-${e.kind}`} onClick={() => { if (e.battleId != null && g.battles[e.battleId]) store.setUI({ battleReport: e.battleId }); else if (e.province != null) focusProvince(e.province); }}>
              <span className="tl-date">{fmtDate(g, e.day)}</span><span>{e.text}</span>
            </div>
          ))}
          {!g.timeline.length && <p className="muted">History is being written.</p>}
        </div>
      )}
      {tab === 'achievements' && (
        <div className="ach-grid">
          {ACHIEVEMENTS.map((a) => (
            <div key={a.id} className={`ach${g.achievements[a.id] != null ? ' got' : ''}`}><b>{a.name}</b><span className="small">{a.desc}</span>{g.achievements[a.id] != null && <span className="small good">{fmtDate(g, g.achievements[a.id])}</span>}</div>
          ))}
        </div>
      )}
      {tab === 'world' && (
        <table className="tbl">
          <thead><tr><th>#</th><th>Nation</th><th>Provinces</th><th>Output</th><th>Stability</th></tr></thead>
          <tbody>
            {livingNations(g).sort((a, b) => b.budget.output - a.budget.output).slice(0, 30).map((x, i) => (
              <tr key={x.id} className={x.id === g.player ? 'me' : ''}><td>{i + 1}</td><td><span className="swatch" style={{ background: x.color }} /> {x.name}</td><td>{ownedBy(g, x.id).length}</td><td>{money(x.budget.output)}</td><td>{x.stability.toFixed(0)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function HelpPanel() {
  const g = useGame();
  const t = g.tutorial;
  return (
    <div className="panel-body">
      {t && !t.done && (
        <Section title={`Tutorial — step ${t.step + 1} of ${TUTORIAL.length}`} icon="book">
          <div className="tut-step">
            <h3>{TUTORIAL[t.step].title}</h3>
            <p>{TUTORIAL[t.step].text}</p>
            <p className="hint">▶ {TUTORIAL[t.step].hint}</p>
          </div>
          <ol className="tut-list">{TUTORIAL.map((s, i) => <li key={i} className={i < t.step ? 'done' : i === t.step ? 'cur' : ''}>{s.title}</li>)}</ol>
        </Section>
      )}
      {t?.done && <p className="good">Tutorial complete — the sandbox is yours.</p>}
      <Section title="How to play" icon="info">
        <ul className="help">
          <li><b>Map:</b> drag to pan, wheel to zoom. Left-click selects provinces and armies; <b>right-click</b> orders the selected army to move or attack. Map modes (bottom-left) show terrain, resources, infrastructure, supply, military and diplomacy.</li>
          <li><b>Time:</b> Space pauses; keys 1–3 set speed. Orders can be given while paused.</li>
          <li><b>Economy:</b> taxes fund everything. Each formation, building and project has explicit costs and upkeep — check the budget before expanding. Deficits drain the treasury, then debt, then default.</li>
          <li><b>Army:</b> recruit in your provinces: one price covers training and full equipment, and the unit appears ready to fight when training ends. Factories make units cheaper and faster. Mobilise before major wars for full organisation.</li>
          <li><b>War Room</b> (top of the left bar): every war's losses and territory, every battle in progress — change posture, retreat or send reinforcements — and one-click orders for all armies (Attack, Defend, Hold, Withdraw). Shift-click armies to move several together.</li>
          <li><b>Controlling armies:</b> hover a province with an army selected to see attack odds and travel time. Shift-click or shift-drag a box to select several armies; shift+right-click adds waypoints. The army bar above the map modes lists every army. Keys: Tab next army, M move, H halt, R retreat, F attack, D defend, G hold. An enemy province's panel has “Attack with all nearby armies”.</li>
          <li><b>Strikes:</b> buy attack drones and cruise missiles in the War Room, then fire at enemy provinces in range to kill troops and destroy rail, depots, power and factories. Fleets off a coast extend range.</li>
          <li><b>Nuclear weapons</b> (nuclear powers, or after a costly programme) devastate a province — but the whole world embargoes you for 10 years, ends your alliances and gains a casus belli, and armed enemies retaliate.</li>
          <li><b>Government</b> (Economy → Government): set public-services spending, choose national policies (economic model, trade, labour, conscription, media), enact decrees (austerity, stimulus, printing money, war bonds…) and invest in a sovereign wealth fund.</li>
          <li><b>Regional focus:</b> give each core province a specialisation (industry, agriculture, commerce, military) from its panel.</li>
          <li><b>Statecraft & spies</b> (Diplomacy → a nation): send aid, impose sanctions, guarantee independence, build spy networks and run covert operations (steal technology, sabotage, incite unrest).</li>
          <li><b>National events</b> ask for a decision every few months; time keeps running, and the first option is taken if you wait 30 days.</li>
          <li><b>Military strength</b> is a fixed rating: points per formation and warship, so it only changes when you raise, disband or lose units.</li>
          <li><b>Supply:</b> armies draw supply from your capital, depots and ports through roads and railways. Long, poor routes starve armies. Use the Supply map mode and army Supply tab.</li>
          <li><b>Battles</b> last several days. Terrain, weather, entrenchment, supply, generals, recon, air, equipment and posture all matter — read the battle report's “Why this result?”.</li>
          <li><b>Peace:</b> occupy territory to raise war score, then negotiate. Conquered land must be integrated (money, time) or made autonomous; resistance grows without garrisons.</li>
          <li><b>Saving:</b> autosave every 30 days; manual saves and export in the menu.</li>
        </ul>
      </Section>
    </div>
  );
}
