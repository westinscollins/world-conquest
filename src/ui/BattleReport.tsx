import { useEffect, useState } from 'react';
import { store, useStore } from './store';
import { Modal, Btn, Bar } from './common';
import { PROV } from '../engine/geo';
import { POSTURES, TERRAIN, WEATHER } from '../engine/config';
import { fmtDate } from '../engine/events';
import { num, pct, money } from './format';
import { focusProvince } from './commands';
import type { Battle, BattleSide } from '../engine/types';

export function BattleReport() {
  const { g, ui } = useStore();
  const [day, setDay] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const b: Battle | undefined = g && ui.battleReport != null ? g.battles[ui.battleReport] : undefined;
  const total = b?.timeline.length ?? 0;
  useEffect(() => { setDay(null); setPlaying(false); }, [ui.battleReport]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setDay((d) => { const nd = (d ?? 0) + 1; if (nd >= total) { setPlaying(false); return total; } return nd; }), 650);
    return () => clearInterval(t);
  }, [playing, total]);
  if (!g || !b) return null;
  const close = () => store.setUI({ battleReport: null });
  const shown = day == null ? total : Math.max(1, day);
  const cur = b.timeline[shown - 1];
  const aN = g.nations[b.attacker.nation], dN = g.nations[b.defender.nation];
  const geo = PROV[b.province];
  const result = b.result == null ? 'In progress' : b.result === 'stalemate' ? 'Stalemate' : `${b.result === 'attacker' ? aN?.name : dN?.name} victory`;
  const playerWon = (b.result === 'attacker' && b.attacker.nation === g.player) || (b.result === 'defender' && b.defender.nation === g.player);
  const maxStr = Math.max(b.attacker.startStrength, b.defender.startStrength, 1);
  return (
    <Modal title={<>Battle of {geo.name}</>} onClose={close} wide className="battle-modal">
      <div className={`br-banner ${b.result == null ? 'live' : playerWon ? 'won' : (b.attacker.nation === g.player || b.defender.nation === g.player) ? 'lost' : ''}`}>
        <div className="br-result">{result}</div>
        <div className="br-meta">{fmtDate(g, b.startDay)}{b.endDay != null ? ` – ${fmtDate(g, b.endDay)}` : ''} · {total} day{total !== 1 ? 's' : ''} · {TERRAIN[b.terrain].label}{b.river ? ', river' : ''}{b.strait ? ', strait crossing' : ''}{b.amphibious ? ', amphibious landing' : ''} · {WEATHER[b.weather].label}{b.fort ? ` · fortifications ${b.fort}` : ''}</div>
        <a className="small" onClick={() => { focusProvince(b.province); close(); }}>Show on map</a>
      </div>
      <div className="br-sides">
        <SideCard side={b.attacker} role="Attacker" posture={POSTURES[b.attackerPosture].label} color={aN?.color} name={aN?.name} cur={cur ? { str: cur.aStrength, org: cur.aOrg, mor: cur.aMorale } : null} max={maxStr} />
        <div className="vs">VS</div>
        <SideCard side={b.defender} role="Defender" posture={POSTURES[b.defenderPosture].label} color={dN?.color} name={dN?.name} cur={cur ? { str: cur.dStrength, org: cur.dOrg, mor: cur.dMorale } : null} max={maxStr} />
      </div>
      {b.summary && <p className="br-summary">{b.summary}</p>}
      <div className="br-grid">
        <div>
          <h4>Phase-by-phase timeline</h4>
          <div className="replay-ctl">
            <Btn small onClick={() => { setDay(1); setPlaying(true); }}>▶ Replay</Btn>
            <Btn small onClick={() => setPlaying(!playing)} disabled={day == null}>{playing ? 'Pause' : 'Resume'}</Btn>
            <input type="range" min={1} max={Math.max(1, total)} value={shown} onChange={(e) => { setPlaying(false); setDay(+e.target.value); }} />
            <span className="small">Day {shown}/{total}</span>
          </div>
          <TimelineChart b={b} upto={shown} />
          <div className="br-days">
            {b.timeline.slice(0, shown).slice().reverse().map((d) => (
              <div key={d.day} className="br-day">
                <div className="br-day-h"><b>Day {d.day}</b> <span className="chip">{d.phase}</span><span className="muted small"> org {pct(d.aOrg)} vs {pct(d.dOrg)} · morale {pct(d.aMorale)} vs {pct(d.dMorale)}</span></div>
                <ul>{d.events.map((e, i) => <li key={i}>{e}</li>)}<li className="muted">Morale & organisation check: attacker {d.aOrg < POSTURES[b.attackerPosture].retreatAt + 0.08 ? 'wavering' : 'holding'}, defender {d.dOrg < 0.2 ? 'wavering' : 'holding'}.</li></ul>
              </div>
            ))}
            {b.result && (
              <div className="br-day final">
                <div className="br-day-h"><b>Resolution</b> <span className="chip">{b.result === 'attacker' ? 'Advance' : b.result === 'defender' ? 'Repulsed' : 'Stalemate'}</span></div>
                <ul><li>{b.result === 'attacker' ? `${aN?.name} advanced and took control of ${geo.name}.` : b.result === 'defender' ? `${dN?.name} held ${geo.name}.` : 'Front unchanged.'}</li></ul>
              </div>
            )}
          </div>
        </div>
        <div>
          <h4>Why this result?</h4>
          <p className="small muted">Modifiers applied (positive helps the listed side). Largest first.</p>
          <table className="tbl factors">
            <tbody>
              {b.factors.slice(0, 16).map((f, i) => (
                <tr key={i}>
                  <td><span className="swatch" style={{ background: f.side === 'attacker' ? aN?.color : dN?.color }} /></td>
                  <td>{f.label}<div className="muted small">{f.detail}</div></td>
                  <td className={`right ${f.value >= 0 ? 'good' : 'bad'}`}>{f.value >= 0 ? '+' : ''}{(f.value * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Lessons</h4>
          <ul className="causes good-list small">{lessons(b, g.player).map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      </div>
    </Modal>
  );
}

function SideCard({ side, role, posture, color, name, cur, max }: { side: BattleSide; role: string; posture: string; color?: string; name?: string; cur: { str: number; org: number; mor: number } | null; max: number }) {
  const lost = side.losses.killed + side.losses.wounded;
  return (
    <div className="side-card" style={{ borderColor: color }}>
      <div className="sc-h"><span className="swatch" style={{ background: color }} /><b>{name}</b><span className="muted"> · {role}</span></div>
      <div className="small muted">{side.general ? `General ${side.general}` : 'No general'} · {posture} · {side.units} formations</div>
      <div className="kv"><span>Strength</span><b>{num(side.startStrength)} → {num(cur?.str ?? side.strength)}</b></div>
      <Bar value={(cur?.str ?? side.strength) / max} color={color} h={8} />
      <div className="kv"><span>Organisation</span><b>{pct(side.startOrg)} → {pct(cur?.org ?? side.org)}</b></div>
      <div className="kv"><span>Morale</span><b>{pct(side.startMorale)} → {pct(cur?.mor ?? side.morale)}</b></div>
      <div className="kv"><span>Readiness · supply</span><b>{pct(side.startEquip)} equipped · {pct(side.startSupply)} supplied</b></div>
      <div className="kv"><span>Casualties</span><b className="bad">{num(lost)}{side.losses.wounded ? <span className="muted small"> ({num(side.losses.killed)} killed, {num(side.losses.wounded)} wounded)</span> : null}</b></div>
      <div className="kv"><span>Equipment lost</span><b className="bad">{money(side.losses.equipmentValue)} IC</b></div>
    </div>
  );
}

function TimelineChart({ b, upto }: { b: Battle; upto: number }) {
  const W = 420, H = 90;
  const days = b.timeline;
  if (!days.length) return null;
  const n = Math.max(2, days.length);
  const x = (i: number) => (i / (n - 1)) * W;
  const line = (f: (d: (typeof days)[0]) => number) => days.slice(0, upto).map((d, i) => `${x(i)},${H - f(d) * H}`).join(' ');
  const maxS = Math.max(b.attacker.startStrength, b.defender.startStrength, 1);
  return (
    <svg className="tl-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline points={line((d) => d.aOrg)} className="tl a" />
      <polyline points={line((d) => d.dOrg)} className="tl d" />
      <polyline points={line((d) => d.aStrength / maxS)} className="tl a dash" />
      <polyline points={line((d) => d.dStrength / maxS)} className="tl d dash" />
      <text x={4} y={12} className="tl-label">— organisation · - - strength (red attacker, blue defender)</text>
    </svg>
  );
}

function lessons(b: Battle, player: string): string[] {
  const out: string[] = [];
  const asAtk = b.attacker.nation === player;
  const mySide = asAtk ? 'attacker' : 'defender';
  const bad = b.factors.filter((f) => (f.side === mySide && f.value < -0.05) || (f.side !== mySide && f.value > 0.08));
  for (const f of bad.slice(0, 4)) {
    if (f.label === 'Supply') out.push('Supply shortage hurt you: build depots/railways near the front, or advance more slowly.');
    else if (f.label === 'Terrain' && asAtk) out.push('Rough terrain favoured the defender: bring artillery and engineers, or attack elsewhere.');
    else if (f.label === 'Entrenchment') out.push('The enemy was dug in: attack sooner, or use Mobile manoeuvre to reduce entrenchment.');
    else if (f.label === 'Fortifications') out.push('Fortifications: engineers reduce their effect; artillery helps.');
    else if (f.label === 'Air superiority') out.push('The enemy owned the skies: add Air Wings.');
    else if (f.label === 'Equipment') out.push('Under-equipped formations: increase factory output for the missing equipment.');
    else if (f.label === 'Leadership') out.push('Leadership gap: assign a better general.');
    else if (f.label === 'Numbers') out.push('You were outnumbered: concentrate forces before attacking.');
    else if (f.label === 'Weather') out.push('Bad weather: wait for clearer conditions.');
    else if (f.label === 'River crossing') out.push('River crossing: engineers halve the penalty.');
    else if (f.label === 'Organisation') out.push('Start battles with rested, organised troops (mobilise to raise peacetime readiness caps).');
    else if (f.label === 'Technology') out.push('The enemy had better equipment: invest in research.');
    else if (f.label === 'Armor') out.push('Armour imbalance: bring hard-attack units (armoured, artillery, air).');
  }
  if (!out.length) out.push('Well fought. Keep your formations supplied and organised.');
  return [...new Set(out)];
}
