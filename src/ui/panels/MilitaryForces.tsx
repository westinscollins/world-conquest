// Military → Forces: every army (select by number, give one order to many), the air force and the navy.
import { useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Bar } from '../common';
import { num, pct, cls } from '../format';
import { PROV, WORLD } from '../../engine/geo';
import { POSTURES, AIR_MISSIONS, AIR_MISSION_INFO, SHIPS } from '../../engine/config';
import { armyStrength, armyOrg } from '../../engine/military';
import { enemiesOf } from '../../engine/world';
import { wingsOf, wingPlanes } from '../../engine/air';
import { nationTransportCapacity, merchantCapacity } from '../../engine/naval';
import type { Army, Posture, ShipType } from '../../engine/types';
import { myArmies, armyNumbers, selectedIds, setSelection, parseRange, ctrlGroup, setCtrlGroup, groupOf } from '../selection';
import { focusProvince } from '../commands';
import { planInvasion } from '../InvasionPlanner';

const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');
const status = (g: ReturnType<typeof useGame>, a: Army) => (a.battleId != null ? '⚔ fighting' : a.embarked ? '⛴ at sea' : a.seaDest != null ? '⚓ to port' : a.campaign ? `➜ invading ${g.nations[a.campaign]?.name ?? ''}` : a.path.length ? '→ moving' : a.stance === 'advance' ? '▲ attack' : a.stance === 'defend' ? '■ defend' : a.stance === 'withdraw' ? '▼ withdraw' : '● hold');

/** Every army in one table: pick them by number, filter or group, then give one order to all. */
export function ArmyRoster() {
  const g = useGame();
  const list = myArmies(g);
  const nums = armyNumbers(g);
  const sel = new Set(selectedIds().filter((id) => g.armies[id]?.owner === g.player));
  const [range, setRange] = useState('');
  const ids = [...sel];
  const toggle = (id: number) => setSelection(sel.has(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const pick = (f: (a: Army) => boolean) => setSelection(list.filter(f).map((a) => a.id));
  const need = !ids.length;
  const enemies = enemiesOf(g, g.player);
  return (
    <Section title={`Armies (${list.length})`} icon="manpower">
      <div className="roster-select">
        <input className="range-in" placeholder="e.g. 1-6, 9" value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSelection(parseRange(g, range)); }} />
        <Btn small kind="primary" onClick={() => setSelection(parseRange(g, range))}>Select</Btn>
        <Btn small onClick={() => pick(() => true)}>All</Btn>
        <Btn small onClick={() => setSelection([])}>None</Btn>
        <Btn small onClick={() => pick((a) => a.battleId == null && !a.path.length && !a.embarked && !a.campaign)}>Idle</Btn>
        <Btn small onClick={() => pick((a) => a.battleId != null)}>Fighting</Btn>
        <Btn small onClick={() => pick((a) => armyOrg(a) < 0.35 || a.lastSupplyRatio < 0.5)}>Exhausted</Btn>
        <Btn small onClick={() => pick((a) => enemies.length > 0 && PROV[a.location].neighbors.some((q) => enemies.includes(g.provinces[q].controller)))}>At the front</Btn>
      </div>
      <div className="row gap wrap small" style={{ margin: '4px 0 6px' }}>
        <span className="muted">Control groups:</span>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => {
          const n = ctrlGroup(k).filter((id) => g.armies[id]?.owner === g.player).length;
          return <button key={k} className={cls('cg', n > 0 && 'set')} title={n ? `Group ${k}: ${n} armies — click to select (key ${k})` : `Empty — select armies and click to store them here (or Shift+${k})`} onClick={() => (n ? setSelection(ctrlGroup(k)) : ids.length && setCtrlGroup(k, ids))}>{k}{n ? <small>{n}</small> : null}</button>;
        })}
      </div>

      <div className="bulk">
        <b>{ids.length} selected</b>
        {enemies.length > 0 ? (
          <select disabled={need} value="" title="The armies take that country's provinces one after another on their own" onChange={(e) => e.target.value && say(store.cmd('doCampaign', [ids, e.target.value]))}>
            <option value="">Invade…</option>
            {enemies.map((x) => <option key={x} value={x}>{g.nations[x]?.name}</option>)}
          </select>
        ) : <Btn small disabled={need} onClick={() => store.toast('Select a foreign province or use Command → Invade to start a war first.', 'info')}>Invade…</Btn>}
        <Btn small kind="primary" disabled={need} onClick={() => { store.setUI({ panel: null, moveMode: ids[0], group: ids.slice(1) }); store.toast('Click a province to send the selected armies there.', 'info'); }}>Move to…</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doAttackNearest', [ids]))}>Attack nearest</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doStances', [ids, 'defend']))}>Defend</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doHaltMany', [ids]))}>Halt</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doDigIn', [ids]))}>Dig in</Btn>
        <Btn small disabled={ids.length < 2} onClick={() => say(store.cmd('doMergeMany', [ids]))}>Merge</Btn>
        <Btn small kind="danger" disabled={need} onClick={() => say(store.cmd('doRetreatMany', [ids]))}>Retreat</Btn>
        <Btn small kind="danger" disabled={need} onClick={() => store.setUI({ confirm: { title: `Disband ${ids.length} ${ids.length === 1 ? 'army' : 'armies'}?`, body: `${num(Math.round(ids.reduce((t, id) => t + (g.armies[id] ? armyStrength(g.armies[id]) : 0), 0) * 0.9))} soldiers return to the manpower pool and their equipment is scrapped. Armies in battle or at sea are skipped. This cannot be undone.`, danger: true, okLabel: 'Disband', onOk: () => { say(store.cmd('disbandArmies', [ids])); setSelection([]); } } })}>Disband</Btn>
        <select disabled={need} value="" title="How the armies fight: changes casualties, attack and when they break off" onChange={(e) => e.target.value && say(store.cmd('doPostureMany', [ids, e.target.value as Posture]))}>
          <option value="">Posture…</option>
          {(Object.keys(POSTURES) as Posture[]).map((p) => <option key={p} value={p}>{POSTURES[p].label}</option>)}
        </select>
      </div>

      <table className="tbl clickable roster">
        <thead><tr><th /><th>#</th><th>Army</th><th>Location</th><th>Soldiers</th><th>Org</th><th>Supply</th><th>Doing</th><th>Grp</th></tr></thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id} className={sel.has(a.id) ? 'sel' : ''} onClick={() => toggle(a.id)} onDoubleClick={() => { setSelection([a.id]); store.setUI({ selectedArmy: a.id }); focusProvince(a.location); }}>
              <td><input type="checkbox" readOnly checked={sel.has(a.id)} /></td>
              <td><b>{nums.get(a.id)}</b></td>
              <td>{a.name}</td>
              <td className="small">{a.embarked ? 'At sea' : PROV[a.location].name}</td>
              <td>{num(armyStrength(a))}</td>
              <td><Bar value={armyOrg(a)} h={5} /></td>
              <td className={a.lastSupplyRatio < 0.6 ? 'bad' : ''}>{pct(a.lastSupplyRatio)}</td>
              <td className="small">{status(g, a)}</td>
              <td className="small">{groupOf(a.id) ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.length && <p className="muted small">No armies. Recruit some in the Build tab.</p>}
      <p className="small muted">Click rows to tick armies, or type numbers like <b>1-6, 9</b>. Double-click to zoom. On the map: number keys recall control groups, Shift+number stores the current selection, Shift-drag draws a selection box. <a onClick={() => { const e = enemies[0]; if (e) planInvasion(e); }}>{enemies.length ? 'Open the invasion planner' : ''}</a></p>
    </Section>
  );
}

export function AirForce() {
  const g = useGame();
  const n = g.nations[g.player];
  const wings = wingsOf(g, g.player);
  const enemies = enemiesOf(g, g.player);
  const r = n.regime;
  if (!wings.length) return <Section title="Air force" icon="star"><p className="small muted">No air wings. Build fighter or bomber squadrons in the Build tab: they win the skies over your battles and allow air strikes.</p></Section>;
  return (
    <Section title={`Air force (${wings.length} wings · ${wings.reduce((t, w) => t + wingPlanes(w), 0)} aircraft)`} icon="star">
      {wings.map((w) => (
        <div key={w.id} className="army-row" onClick={() => { store.setUI({ selectedWing: w.id, selectedArmy: null, selectedFleet: null }); focusProvince(w.base); }}>
          <span className="chip">{w.units.filter((u) => u.type === 'bomber').length * 2 > w.units.length ? '✈ BMB' : '✈ FTR'}</span>
          <b>{w.name}</b>
          <span className="muted small">{PROV[w.base].name}{w.rebase ? ` → ${PROV[w.rebase.to].name}` : ''} · {wingPlanes(w)} aircraft · {AIR_MISSION_INFO[w.mission].label}{w.mission === 'bombing' && w.target != null ? `: ${PROV[w.target].name}` : w.mission === 'naval' && w.target != null ? `: ${WORLD.seas[w.target].name}` : ''}</span>
        </div>
      ))}
      <div className="small muted" style={{ margin: '6px 0 3px' }}>One order for every wing:</div>
      <div className="policy-opts four">
        {(Object.keys(AIR_MISSIONS) as (keyof typeof AIR_MISSIONS)[]).map((k) => (
          <button key={k} className={cls('posture', r.air.mission === k && 'on')} disabled={k === 'bombing' && !enemies.length} onClick={() => say(store.cmd('doAirMission', [k, k === 'bombing' ? (r.air.target && enemies.includes(r.air.target) ? r.air.target : enemies[0] ?? null) : null]))}>{AIR_MISSIONS[k].label}<span>{AIR_MISSIONS[k].desc}</span></button>
        ))}
      </div>
      {r.air.mission === 'bombing' && (
        <div className="row gap" style={{ marginTop: 6 }}><span className="small">Bomb</span>
          <select value={r.air.target ?? ''} onChange={(e) => say(store.cmd('doAirMission', ['bombing', e.target.value]))}>{enemies.map((e) => <option key={e} value={e}>{g.nations[e]?.name}</option>)}</select>
        </div>
      )}
      <p className="small muted">Click a wing (or its jet on the map) for its own mission or to move its base. Wings reach battles within range of their base: fighters 1,300 km, bombers 2,800 km.</p>
    </Section>
  );
}

export function Navy() {
  const g = useGame();
  const n = g.nations[g.player];
  const fleets = Object.values(g.fleets).filter((f) => f.owner === g.player);
  const tc = nationTransportCapacity(g, n);
  const kinds: ShipType[] = ['destroyer', 'cruiser', 'battlegroup', 'submarine', 'transport'];
  const short: Record<ShipType, string> = { destroyer: 'DD', cruiser: 'CR', battlegroup: 'CV', submarine: 'SS', transport: 'TR' };
  return (
    <Section title={`Navy (${fleets.length} fleets)`} icon="anchor" right={<span className="small muted" title={`Brigades that can be at sea at once: ${merchantCapacity(n)} from chartered merchant shipping + ${SHIPS.transport.capacity} per Transport Flotilla.`}>shipping {Math.max(0, tc.cap - tc.used)}/{tc.cap} brigades</span>}>
      {fleets.map((f) => (
        <div key={f.id} className="army-row" onClick={() => { store.setUI({ selectedFleet: f.id, selectedArmy: null, selectedWing: null }); }}>
          <b>{f.name}</b><span className="muted small"> {WORLD.seas[f.sea].name}</span><div style={{ flex: 1 }} />
          <span className="small" title="DD destroyers · CR cruisers · CV carrier groups · SS submarines · TR transports">{kinds.filter((k) => (f.ships[k] ?? 0) >= 0.5).map((k) => `${Math.round(f.ships[k])} ${short[k]}`).join(' · ') || 'empty'}</span>
        </div>
      ))}
      {!fleets.length && <p className="small muted">No fleets. Build warships at a port in the Build tab.</p>}
      <p className="small muted">Click a fleet, then right-click a sea zone or coast to sail. Destroyers hunt submarines; submarines sink transports and raid enemy trade near their ports; carriers bring their own air cover.</p>
    </Section>
  );
}
