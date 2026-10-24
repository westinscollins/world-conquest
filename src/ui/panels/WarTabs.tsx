import { useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Bar } from '../common';
import { money, num, pct, cls } from '../format';
import { PROV } from '../../engine/geo';
import { POSTURES, WAR_ECONOMY, ROE, AIR_MISSIONS, UNITS } from '../../engine/config';
import { armyStrength, armyOrg } from '../../engine/military';
import { enemiesOf } from '../../engine/world';
import { airWings } from '../../engine/regime';
import { MERC_TYPES, mercenaryCost, borderProvinces } from '../../engine/warplans';
import type { Army, Posture } from '../../engine/types';
import { myArmies, armyNumbers, selectedIds, setSelection, parseRange, ctrlGroup, setCtrlGroup, groupOf } from '../selection';
import { focusProvince } from '../commands';

const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');
const status = (a: Army) => (a.battleId != null ? '⚔ fighting' : a.embarked ? '⛴ at sea' : a.path.length ? '→ moving' : a.stance === 'advance' ? '▲ attack' : a.stance === 'defend' ? '■ defend' : a.stance === 'withdraw' ? '▼ withdraw' : '● hold');

/** Every army in one table: pick them by number, filter or group, then give one order to all. */
export function ArmyRoster() {
  const g = useGame();
  const list = myArmies(g);
  const nums = armyNumbers(g);
  const sel = new Set(selectedIds());
  const [range, setRange] = useState('');
  const ids = [...sel];
  const toggle = (id: number) => setSelection(sel.has(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const pick = (f: (a: Army) => boolean) => setSelection(list.filter(f).map((a) => a.id));
  const need = !ids.length;
  return (
    <>
      <div className="roster-select">
        <input className="range-in" placeholder="e.g. 1-6, 9" value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSelection(parseRange(g, range)); }} />
        <Btn small kind="primary" onClick={() => setSelection(parseRange(g, range))}>Select</Btn>
        <Btn small onClick={() => pick(() => true)}>All</Btn>
        <Btn small onClick={() => setSelection([])}>None</Btn>
        <Btn small onClick={() => pick((a) => a.battleId == null && !a.path.length && !a.embarked)}>Idle</Btn>
        <Btn small onClick={() => pick((a) => a.battleId != null)}>Fighting</Btn>
        <Btn small onClick={() => pick((a) => armyOrg(a) < 0.35 || a.lastSupplyRatio < 0.5)}>Exhausted</Btn>
        <Btn small onClick={() => pick((a) => enemiesOf(g, g.player).length > 0 && PROV[a.location].neighbors.some((q) => enemiesOf(g, g.player).includes(g.provinces[q].controller)))}>At the front</Btn>
      </div>
      <div className="row gap wrap small" style={{ margin: '4px 0 6px' }}>
        <span className="muted">Control groups:</span>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => {
          const n = ctrlGroup(k).filter((id) => g.armies[id]?.owner === g.player).length;
          return <button key={k} className={cls('cg', n > 0 && 'set')} title={n ? `Group ${k}: ${n} armies — click to select (key ${k})` : `Empty — select armies and click to store them here (or Shift+${k})`} onClick={() => (n ? setSelection(ctrlGroup(k)) : ids.length && setCtrlGroup(k, ids))}>{k}{n ? <small>{n}</small> : null}</button>;
        })}
        {ids.length > 0 && <Btn small onClick={() => { const k = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((x) => !ctrlGroup(x).some((id) => g.armies[id])) ?? 9; setCtrlGroup(k, ids); store.toast(`Stored as group ${k}`, 'info'); }}>Save selection as group</Btn>}
      </div>

      <div className="bulk">
        <b>{ids.length} selected</b>
        <Btn small kind="primary" disabled={need} onClick={() => { store.setUI({ panel: null, moveMode: ids[0] }); store.toast('Click a province to send the selected armies there.', 'info'); }}>Move to…</Btn>
        <Btn small kind="primary" disabled={need} onClick={() => say(store.cmd('doAttackNearest', [ids]))}>Attack nearest</Btn>
        <Btn small kind="primary" disabled={need} onClick={() => { store.setUI({ panel: null, pickOperation: true }); }}>Joint operation…</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doStances', [ids, 'advance']))}>Auto-attack</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doStances', [ids, 'defend']))}>Defend</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doStances', [ids, 'hold']))}>Hold</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doHaltMany', [ids]))}>Halt</Btn>
        <Btn small kind="danger" disabled={need} onClick={() => say(store.cmd('doRetreatMany', [ids]))}>Retreat</Btn>
        <Btn small disabled={need} onClick={() => say(store.cmd('doDigIn', [ids]))}>Dig in</Btn>
        <Btn small disabled={ids.length < 2} onClick={() => say(store.cmd('doMergeMany', [ids]))}>Merge</Btn>
        <select disabled={need} value="" onChange={(e) => e.target.value && say(store.cmd('doPostureMany', [ids, e.target.value as Posture]))}>
          <option value="">Posture…</option>
          {(Object.keys(POSTURES) as Posture[]).map((p) => <option key={p} value={p}>{POSTURES[p].label}</option>)}
        </select>
      </div>

      <table className="tbl clickable roster">
        <thead><tr><th /><th>#</th><th>Army</th><th>Location</th><th>Soldiers</th><th>Org</th><th>Supply</th><th>Status</th><th>Grp</th></tr></thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id} className={sel.has(a.id) ? 'sel' : ''} onClick={() => toggle(a.id)} onDoubleClick={() => { setSelection([a.id]); focusProvince(a.location); }}>
              <td><input type="checkbox" readOnly checked={sel.has(a.id)} /></td>
              <td><b>{nums.get(a.id)}</b></td>
              <td>{a.name}</td>
              <td className="small">{a.embarked ? 'At sea' : PROV[a.location].name}</td>
              <td>{num(armyStrength(a))}</td>
              <td><Bar value={armyOrg(a)} h={5} /></td>
              <td className={a.lastSupplyRatio < 0.6 ? 'bad' : ''}>{pct(a.lastSupplyRatio)}</td>
              <td className="small">{status(a)}</td>
              <td className="small">{groupOf(a.id) ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Click rows to tick armies, or type numbers like <b>1-6, 9</b>. Double-click to zoom. On the map: number keys recall control groups, Shift+number stores the current selection, Shift-drag draws a selection box.</p>
    </>
  );
}

/** Coordinated offensives in progress. */
export function OperationsTab() {
  const g = useGame();
  const ops = g.operations.filter((o) => o.owner === g.player);
  const nums = armyNumbers(g);
  const ids = selectedIds();
  return (
    <>
      <p className="small">A joint operation sends several armies to start lines next to one enemy province. They wait until everyone has arrived (or 30 days pass), then all attack on the same day — far stronger than arriving one by one.</p>
      <Btn kind="primary" disabled={!ids.length} onClick={() => store.setUI({ panel: null, pickOperation: true })}>{ids.length ? `Plan an operation with ${ids.length} selected armies…` : 'Select armies first (Armies tab)'}</Btn>
      {!ops.length && <p className="muted small" style={{ marginTop: 10 }}>No operations under way.</p>}
      {ops.map((o) => {
        const armies = o.armyIds.map((id) => g.armies[id]).filter(Boolean) as Army[];
        const ready = armies.filter((a) => a.location === o.staging[a.id] && !a.path.length).length;
        return (
          <div key={o.id} className="war-card">
            <h4>Operation on {PROV[o.target].name}<span className="small muted">{o.state === 'staging' ? `staging · ${ready}/${armies.length} in place · launches by day ${o.deadline - g.day}` : 'ATTACKING'}</span></h4>
            <div className="small">{armies.map((a) => `#${nums.get(a.id)} ${a.name}`).join(', ')}</div>
            <Bar value={armies.length ? ready / armies.length : 0} h={5} color="var(--gold)" />
            <div className="row gap" style={{ marginTop: 6 }}>
              <Btn small onClick={() => focusProvince(o.target)}>Show target</Btn>
              <Btn small onClick={() => setSelection(o.armyIds)}>Select armies</Btn>
              <Btn small kind="danger" onClick={() => say(store.cmd('doCancelOperation', [o.id]))}>Cancel</Btn>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Grand strategy: war economy, rules of engagement, air campaigns, mercenaries, fortifications. */
export function StrategyTab() {
  const g = useGame();
  const n = g.nations[g.player];
  const r = n.regime;
  const enemies = enemiesOf(g, g.player);
  const wings = airWings(g, g.player);
  const [mt, setMt] = useState<(typeof MERC_TYPES)[number]>('infantry');
  const where = g.provinces[store.ui.selectedProvince ?? -1]?.owner === g.player && g.provinces[store.ui.selectedProvince!].controller === g.player ? store.ui.selectedProvince! : n.capital;
  return (
    <>
      <Section title="War economy" icon="factory">
        <div className="policy-opts">
          {(Object.keys(WAR_ECONOMY) as (keyof typeof WAR_ECONOMY)[]).map((k) => (
            <button key={k} className={cls('posture', r.warEconomy === k && 'on')} title={WAR_ECONOMY[k].desc} onClick={() => r.warEconomy !== k && say(store.cmd('doWarEconomy', [k]))}>{WAR_ECONOMY[k].label}<span>{WAR_ECONOMY[k].desc}</span></button>
          ))}
        </div>
      </Section>
      <Section title="Rules of engagement" icon="shield">
        <div className="policy-opts">
          {(Object.keys(ROE) as (keyof typeof ROE)[]).map((k) => (
            <button key={k} className={cls('posture', r.roe === k && 'on')} onClick={() => r.roe !== k && say(store.cmd('doRoe', [k]))}>{ROE[k].label}<span>{ROE[k].desc}</span></button>
          ))}
        </div>
      </Section>
      <Section title="Air force: orders for every wing" icon="star" right={<span className="small muted">{Math.round(wings)} squadrons</span>}>
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
        {wings < 0.5 ? <p className="small warn">You have no aircraft. Build fighter or bomber squadrons (Military → Air force) for air superiority, close air support and bombing.</p>
          : <p className="small muted">Each air wing can also get its own mission: click its jet on the map. Wings only reach battles and targets within range of their airbase (fighters 1,300 km, bombers 2,800 km).</p>}
      </Section>
      <Section title="Mercenaries" icon="manpower">
        <div className="row gap wrap">
          <select value={mt} onChange={(e) => setMt(e.target.value as typeof mt)}>{MERC_TYPES.map((t) => <option key={t} value={t}>{UNITS[t].label}</option>)}</select>
          <Btn small kind="primary" disabled={n.treasury < mercenaryCost(mt, n)} onClick={() => say(store.cmd('doMercenaries', [mt, where]))}>Hire in {PROV[where].name} ({money(mercenaryCost(mt, n), { digits: 1 })})</Btn>
        </div>
        <p className="small muted">Ready at once — no training, no manpower — and already experienced, but 2.5× the price and the officer corps resents them. They appear in the selected province (or the capital).</p>
      </Section>
      <Section title="Fortifications" icon="shield">
        <div className="row gap"><Btn small onClick={() => say(store.cmd('doFortifyBorder', []))}>Fortify the whole border ({borderProvinces(g, n).length} provinces)</Btn></div>
        <p className="small muted">Queues a fort level in every province facing an enemy or hostile neighbour. Per province you can also burn it (scorched earth) when the enemy closes in, and fund partisans where you have been occupied — open the province's panel.</p>
      </Section>
    </>
  );
}
