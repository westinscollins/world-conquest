// The selected air wing: its squadrons, mission and orders.
import { useState } from 'react';
import { store, useStore } from './store';
import { PROV, WORLD } from '../engine/geo';
import { UNITS, AIR, AIR_MISSION_INFO } from '../engine/config';
import { planesOf, wingPlanes, wingRange } from '../engine/air';
import { recruitCost, trainDays } from '../engine/military';
import type { AirMission } from '../engine/types';
import { Btn, Bar } from './common';
import { Icon } from './icons';
import { GlyphShape } from './glyphs';
import { money, num, pct } from './format';
import { focusProvince } from './commands';
import { audio } from '../audio/music';

const MISSIONS: AirMission[] = ['support', 'defense', 'bombing', 'naval', 'idle'];

export function AirWingPanel() {
  const { g, ui } = useStore();
  const [renaming, setRenaming] = useState(false);
  if (!g || ui.selectedWing == null) return null;
  const w = g.airWings?.[ui.selectedWing];
  if (!w) return null;
  const n = g.nations[w.owner];
  const mine = w.owner === g.player;
  const close = () => store.setUI({ selectedWing: null });
  const say = (r: { ok: boolean; message: string } | undefined) => { if (r) { store.toast(r.message, r.ok ? 'info' : 'bad'); if (r.ok) audio.sfx('click'); } };
  const fighters = w.units.filter((u) => u.type === 'air'), bombers = w.units.filter((u) => u.type === 'bomber');
  if (!mine) {
    return (
      <div className="side-panel right">
        <div className="sp-head" style={{ borderColor: n?.color }}><div><div className="sp-title">{n?.name} air wing</div><div className="sp-sub">based at {PROV[w.base].name}</div></div><button className="iconbtn" onClick={close}><Icon name="close" /></button></div>
        <div className="sp-body"><p className="muted">About {Math.round(wingPlanes(w) / 5) * 5 || 5} aircraft: {fighters.length ? `${fighters.length} fighter` : ''}{fighters.length && bombers.length ? ' and ' : ''}{bombers.length ? `${bombers.length} bomber` : ''} squadron{w.units.length > 1 ? 's' : ''}.</p></div>
      </div>
    );
  }
  const target = w.mission === 'bombing' && w.target != null ? PROV[w.target].name : w.mission === 'naval' && w.target != null ? `the ${WORLD.seas[w.target].name}` : null;
  return (
    <div className="side-panel right">
      <div className="sp-head" style={{ borderColor: n.color }}>
        <div>
          {renaming
            ? <input className="rename" autoFocus maxLength={40} defaultValue={w.name} onBlur={(e) => { store.cmd('doRenameWing', [w.id, e.target.value]); setRenaming(false); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); }} />
            : <div className="sp-title editable" title="Click to rename" onClick={() => setRenaming(true)}>{w.name}</div>}
          <div className="sp-sub">
            Airbase <a onClick={() => focusProvince(w.base)}>{PROV[w.base].name}</a>
            {w.rebase && <> · moving to <a onClick={() => focusProvince(w.rebase!.to)}>{PROV[w.rebase.to].name}</a> ({w.rebase.days}d)</>}
          </div>
        </div>
        <button className="iconbtn" onClick={close}><Icon name="close" /></button>
      </div>
      <div className="sp-body">
        <div className="wing-summary">
          <svg width="44" height="44" viewBox="-22 -22 44 44"><circle r="20" fill={n.color} stroke="#9fd4ff" strokeWidth="1.5" /><GlyphShape g={bombers.length * 2 > w.units.length ? 'bomber' : 'fighter'} cx={0} cy={0} h={28} /></svg>
          <div>
            <b>{wingPlanes(w)} aircraft</b> in {w.units.length} squadron{w.units.length === 1 ? '' : 's'}
            <div className="small muted">{fighters.length} fighter · {bombers.length} bomber · reach {num(wingRange(w))} km</div>
            {w.last.sorties > 0 && <div className="small">Yesterday: flew over {w.last.sorties} {w.mission === 'bombing' || w.mission === 'naval' ? 'target' : `battle${w.last.sorties > 1 ? 's' : ''}`}{w.last.lost ? <span className="bad"> · lost {w.last.lost} aircraft</span> : ''}</div>}
          </div>
        </div>
        <h4 className="sp-h">Mission{target ? <span className="muted"> — {target}</span> : ''}</h4>
        <div className="mission-grid">
          {MISSIONS.map((m) => (
            <button key={m} className={`posture${w.mission === m ? ' on' : ''}`} onClick={() => {
              if ((m === 'bombing' || m === 'naval') && w.mission !== m) { store.toast(m === 'bombing' ? 'Right-click an enemy province on the map to bomb it.' : 'Right-click a sea zone on the map to strike ships there.', 'info'); return; }
              say(store.cmd('doWingMission', [w.id, m, m === w.mission ? w.target : null]));
            }}>{AIR_MISSION_INFO[m].label}<span>{AIR_MISSION_INFO[m].desc}</span></button>
          ))}
        </div>
        <p className="small muted">On the map: right-click <b>your</b> province to move the airbase · right-click an <b>enemy</b> province to bomb it · right-click a <b>sea zone</b> for naval strikes. The circle shows how far the squadrons reach.</p>
        <h4 className="sp-h">Squadrons</h4>
        <table className="tbl">
          <thead><tr><th>Type</th><th>Aircraft</th><th>Crews</th><th>Readiness</th><th /></tr></thead>
          <tbody>
            {w.units.map((u) => (
              <tr key={u.id}>
                <td>{UNITS[u.type].label}<div className="small muted">exp {pct(u.experience)} · {num(AIR.RANGE[u.type])} km</div></td>
                <td>{planesOf(u)}/{AIR.PLANES[u.type]}</td>
                <td>{pct(u.strength / UNITS[u.type].personnel)}</td>
                <td style={{ minWidth: 60 }}><Bar value={u.org} h={5} /></td>
                <td><button className="iconbtn small" title="Retire this squadron" onClick={() => store.setUI({ confirm: { title: 'Retire squadron?', body: `${UNITS[u.type].label}: its crews return to the manpower pool and the aircraft are scrapped.`, danger: true, onOk: () => say(store.cmd('doDisbandSquadron', [w.id, u.id])) } })}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {g.provinces[w.base].owner === g.player && g.provinces[w.base].controller === g.player && (
          <div className="row gap wrap" style={{ marginTop: 8 }}>
            {(['air', 'bomber'] as const).map((t) => (
              <Btn key={t} small onClick={() => { const r = store.cmd('doRecruit', [t, w.base]); if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); if (r.ok) audio.sfx('coins'); } }}>
                + {t === 'air' ? 'Fighter' : 'Bomber'} squadron ({money(recruitCost(t, n), { digits: 1 })}, {trainDays(t, n)}d)
              </Btn>
            ))}
          </div>
        )}
        <p className="small muted">Losses are replaced at the airbase over time (paid from the treasury); "Stand down" refits twice as fast.</p>
        <Btn small kind="danger" onClick={() => store.setUI({ confirm: { title: `Retire ${w.name}?`, body: `All ${w.units.length} squadron${w.units.length === 1 ? '' : 's'}: the crews return to the manpower pool and the aircraft are scrapped. This cannot be undone.`, danger: true, okLabel: 'Retire', onOk: () => { say(store.cmd('doDisbandWing', [w.id])); close(); } } })}>Retire the whole wing</Btn>
      </div>
    </div>
  );
}
