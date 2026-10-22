import { useState } from 'react';
import { store, useStore } from './store';
import { PROV, WORLD } from '../engine/geo';
import { UNITS, POSTURES, MIL, SHIPS } from '../engine/config';
import { armyStrength, armyMaxStrength, armyOrg, armyMorale, armyEquip, armySupplyDemand, pathDays, TRAITS, unitUpkeep, qualityOf } from '../engine/military';
import { supplyReport } from '../engine/supply';
import { setPosture, setStance, splitArmy, mergeArmies, disbandUnit, doAssignGeneral, markTutorial, renameArmy } from '../engine/actions';
import { armiesIn } from '../engine/world';
import type { Posture, Stance, ShipType } from '../engine/types';
import { Section, Btn, Bar, Tabs, Stat, Tip } from './common';
import { Icon } from './icons';
import { money, num, pct } from './format';
import { focusProvince } from './commands';

const STANCES: [Stance, string, string][] = [
  ['hold', 'Hold', 'Stay in position and dig in. No automatic movement.'],
  ['defend', 'Defend', 'Automatically reinforce adjacent friendly provinces under attack.'],
  ['advance', 'Advance', 'Automatically attack adjacent enemy provinces when the odds are favourable.'],
  ['withdraw', 'Withdraw', 'Fall back to the nearest supplied home province.'],
];

export function ArmyPanel() {
  const { g, ui } = useStore();
  const [tab, setTab] = useState<'units' | 'supply' | 'orders'>('units');
  const [sel, setSel] = useState<number[]>([]);
  const [renaming, setRenaming] = useState(false);
  if (!g || ui.selectedArmy == null) return null;
  const a = g.armies[ui.selectedArmy];
  if (!a) return null;
  const mine = a.owner === g.player;
  const n = g.nations[a.owner];
  const str = armyStrength(a), max = armyMaxStrength(a);
  const gen = a.generalId != null ? g.generals[a.generalId] : null;
  const others = armiesIn(g, a.location).filter((x) => x.owner === a.owner && x.id !== a.id);
  if (!mine) {
    return (
      <div className="side-panel right">
        <div className="sp-head" style={{ borderColor: n?.color }}><div><div className="sp-title">{n?.name} army</div><div className="sp-sub">in {PROV[a.location].name}</div></div><button className="iconbtn" onClick={() => store.setUI({ selectedArmy: null })}><Icon name="close" /></button></div>
        <div className="sp-body"><p className="muted">Foreign army. Estimated strength ~{num(Math.round(str / 2000) * 2000 || 1000)} personnel in {a.units.length > 6 ? 'many' : 'several'} formations. Exact composition is unknown.</p></div>
      </div>
    );
  }
  const rep = supplyReport(g, a);
  return (
    <div className="side-panel right">
      <div className="sp-head" style={{ borderColor: n.color }}>
        <div>
          {renaming ? (
            <input id="army-rename" className="rename" autoFocus defaultValue={a.name} onBlur={(e) => { store.act((s) => renameArmy(s, a.id, e.target.value)); setRenaming(false); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); }} />
          ) : <div className="sp-title editable" title="Click to rename" onClick={() => setRenaming(true)}>{a.name}</div>}
          <div className="sp-sub">
            {a.embarked ? <>At sea → {PROV[a.embarked.dest].name}</> : <>in <a onClick={() => focusProvince(a.location)}>{PROV[a.location].name}</a></>}
            {a.battleId != null && <> · <a className="bad" onClick={() => store.setUI({ battleReport: a.battleId })}>IN BATTLE</a></>}
            {a.path.length > 0 && !a.battleId && <> · marching to {PROV[a.path[a.path.length - 1]].name} (~{Math.ceil(pathDays(g, a, a.path))}d)</>}
          </div>
        </div>
        <button className="iconbtn" onClick={() => store.setUI({ selectedArmy: null })}><Icon name="close" /></button>
      </div>
      <div className="army-actions">
        <Btn small kind={ui.moveMode === a.id ? 'primary' : undefined} disabled={a.battleId != null || !!a.embarked} onClick={() => store.setUI({ moveMode: ui.moveMode === a.id ? null : a.id })}>{ui.moveMode === a.id ? 'Click a province…' : 'Move / attack'}</Btn>
        {a.path.length > 0 && !a.battleId && <Btn small onClick={() => store.act((s) => { s.armies[a.id].path = []; s.armies[a.id].moveProgress = 0; })}>Halt</Btn>}
        <Btn small kind="ghost" onClick={() => store.setUI({ selectedArmy: null, selectedProvince: a.location, moveMode: null })}>Province &amp; construction</Btn>
      </div>
      <div className="grid4">
        <Stat label="Strength" value={`${num(str)}`} tip={`${num(str)} of ${num(max)} personnel (${pct(str / max)})`} tone={str / max < 0.6 ? 'bad' : undefined} />
        <Stat label="Organisation" value={pct(armyOrg(a))} tip="Combat cohesion. Falls in battle; recovers when resting and supplied. Peacetime armies are capped until mobilised." tone={armyOrg(a) < 0.4 ? 'bad' : undefined} />
        <Stat label="Morale" value={pct(armyMorale(a))} tip="Fighting spirit: affects damage dealt and rout risk. Driven by stability, supply and war support." />
        <Stat label="Supply" value={`${a.supply.toFixed(0)}d`} tip={`Carried stocks: ${a.supply.toFixed(1)} days. Current supply ratio ${pct(a.lastSupplyRatio)}.`} tone={a.lastSupplyRatio < 0.6 ? 'bad' : undefined} />
      </div>
      <Tabs tabs={[['units', 'Formations'], ['supply', 'Supply'], ['orders', 'Orders & general']]} value={tab} onChange={(t) => { setTab(t); if (t === 'supply' && g.tutorial && !g.tutorial.flags.supply) store.act((s) => markTutorial(s, 'supply')); }} />
      <div className="sp-body">
        {tab === 'units' && (
          <>
            <table className="tbl units">
              <thead><tr><th /><th>Formation</th><th>Men</th><th>Equip</th><th>Org</th><th>Exp</th></tr></thead>
              <tbody>
                {a.units.map((u) => (
                  <tr key={u.id} className={sel.includes(u.id) ? 'sel' : ''} onClick={() => setSel(sel.includes(u.id) ? sel.filter((x) => x !== u.id) : [...sel, u.id])}>
                    <td><input type="checkbox" readOnly checked={sel.includes(u.id)} /></td>
                    <td><Tip tip={<div><b>{UNITS[u.type].label}</b><br />{UNITS[u.type].desc}<br />Upkeep {money(unitUpkeep(u.type, n), { digits: 2 })} IC/yr · quality ×{qualityOf(n, u.type).toFixed(2)}<br />Speed {UNITS[u.type].speed} km/day · supply {UNITS[u.type].supply}/day · fuel {UNITS[u.type].fuel}</div>}>{UNITS[u.type].short}</Tip></td>
                    <td>{num(u.strength)}</td>
                    <td><Bar value={u.equipment} h={5} title={pct(u.equipment)} /></td>
                    <td><Bar value={u.org} h={5} title={pct(u.org)} /></td>
                    <td>{pct(u.experience)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row gap wrap">
              <Btn small disabled={!sel.length || sel.length === a.units.length} onClick={() => { const r = store.act((s) => splitArmy(s, a.id, sel)); r && store.toast(r.message, r.ok ? 'info' : 'bad'); setSel([]); }}>Split selected</Btn>
              {others.map((o) => <Btn small key={o.id} onClick={() => { const r = store.act((s) => mergeArmies(s, a.id, o.id)); r && store.toast(r.message, r.ok ? 'info' : 'bad'); }}>Merge {o.name}</Btn>)}
              <Btn small kind="danger" disabled={sel.length !== 1} onClick={() => store.setUI({ confirm: { title: 'Disband formation?', body: 'Personnel return to the manpower pool; equipment is scrapped. This cannot be undone.', danger: true, onOk: () => { const r = store.act((s) => disbandUnit(s, a.id, sel[0])); r && store.toast(r.message, r.ok ? 'info' : 'bad'); setSel([]); } } })}>Disband</Btn>
            </div>
            <p className="small muted">Equipment average {pct(armyEquip(a))}. Right-click a province on the map to move; right-click an enemy province to see an intelligence report before attacking.</p>
          </>
        )}
        {tab === 'supply' && (
          <>
            <div className="grid2">
              <Stat label="Demand" value={`${rep.demand.toFixed(1)}/day`} tip="Supply units per day: food, ammunition, spares and fuel. Battles multiply demand ×2.4, marching ×1.25." />
              <Stat label="Deliverable" value={`${rep.delivered.toFixed(1)}/day`} tone={rep.delivered < rep.demand ? 'bad' : 'good'} tip="Maximum this province can receive from your network (before sharing among armies)." />
              <Stat label="Supply hub" value={rep.hubName} tip={rep.hubKind} />
              <Stat label="Route length" value={isFinite(rep.distKm) ? `${Math.round(rep.distKm)} km` : '—'} tip="Infrastructure-adjusted distance from the hub. Supply decays with distance; roads and railways shorten it." />
              <Stat label="Stocks" value={`${rep.stockDays.toFixed(1)} days`} tone={rep.stockDays < 5 ? 'bad' : undefined} />
              <Stat label="Supply ratio" value={pct(rep.ratio)} tone={rep.ratio < 0.6 ? 'bad' : rep.ratio < 0.9 ? 'warn' : 'good'} />
            </div>
            <Section title="Causes" icon="alert">
              {rep.causes.length ? <ul className="causes">{rep.causes.map((c) => <li key={c}>{c}</li>)}</ul> : <p className="good small">No supply problems.</p>}
            </Section>
            {rep.solutions.length > 0 && <Section title="Possible solutions" icon="check"><ul className="causes good-list">{rep.solutions.map((c) => <li key={c}>{c}</li>)}</ul></Section>}
            <p className="small muted">Shortage effects: below 60% organisation can't fully recover and vehicles slow down; below 35% the army suffers attrition ({pct(MIL.ATTRITION_NO_SUPPLY, 1)}/day), equipment wear and falling morale. In battle, attack falls to {pct(0.45)} at zero supply. Tip: switch the map to <a onClick={() => store.setUI({ mapMode: 'supply' })}>Supply mode</a>.</p>
          </>
        )}
        {tab === 'orders' && (
          <>
            <Section title="Operational posture (battle approach)" icon="sword">
              <div className="posture-grid">
                {(Object.keys(POSTURES) as Posture[]).map((p) => (
                  <Tip key={p} wide tip={<div><b>{POSTURES[p].label}</b><br />{POSTURES[p].desc}<br />Attack ×{POSTURES[p].attack} · Defence ×{POSTURES[p].defense} · Casualties ×{POSTURES[p].casualties} · breaks off at {pct(POSTURES[p].retreatAt)} org</div>}>
                    <button className={`posture${a.posture === p ? ' on' : ''}`} onClick={() => store.act((s) => setPosture(s, a.id, p))}>{POSTURES[p].label}</button>
                  </Tip>
                ))}
              </div>
            </Section>
            <Section title="Standing orders (stance)" icon="flag">
              <div className="posture-grid">
                {STANCES.map(([k, l, d]) => <Tip key={k} tip={d}><button className={`posture${a.stance === k ? ' on' : ''}`} onClick={() => store.act((s) => setStance(s, a.id, k))}>{l}</button></Tip>)}
              </div>
            </Section>
            <Section title="Commanding general" icon="star">
              {gen ? (
                <div className="general">
                  <b>{gen.name}</b> <span className="chip">{TRAITS[gen.trait].label}</span>
                  <div className="small">Attack {gen.attack} · Defence {gen.defense} · Logistics {gen.logistics} · XP {gen.xp.toFixed(0)}/40</div>
                  <div className="small muted">{TRAITS[gen.trait].desc}</div>
                  <Btn small kind="ghost" onClick={() => store.act((s) => doAssignGeneral(s, gen.id, null))}>Relieve of command</Btn>
                </div>
              ) : <p className="small muted">No general. Assign one for skill bonuses:</p>}
              <div className="row gap wrap">
                {Object.values(g.generals).filter((x) => x.owner === g.player && !x.available && x.armyId !== a.id).map((x) => (
                  <Btn small key={x.id} onClick={() => store.act((s) => doAssignGeneral(s, x.id, a.id))} title={`${TRAITS[x.trait].label}: ${TRAITS[x.trait].desc}`}>{x.name} ({x.attack}/{x.defense}/{x.logistics}){x.armyId != null ? ' ⇄' : ''}</Btn>
                ))}
              </div>
              <p className="small muted">Hire more generals in Military → Generals.</p>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

export function FleetPanel() {
  const { g, ui } = useStore();
  if (!g || ui.selectedFleet == null) return null;
  const f = g.fleets[ui.selectedFleet];
  if (!f) return null;
  const n = g.nations[f.owner];
  return (
    <div className="side-panel right">
      <div className="sp-head" style={{ borderColor: n?.color }}>
        <div><div className="sp-title">{f.name}</div><div className="sp-sub">{WORLD.seas[f.sea].name}{f.path.length ? ` → ${WORLD.seas[f.path[f.path.length - 1]].name}` : ''}</div></div>
        <button className="iconbtn" onClick={() => store.setUI({ selectedFleet: null })}><Icon name="close" /></button>
      </div>
      <div className="sp-body">
        <table className="tbl"><tbody>
          {(Object.keys(SHIPS) as ShipType[]).map((k) => <tr key={k}><td>{SHIPS[k].label}</td><td className="right">{f.ships[k].toFixed(1)}</td></tr>)}
        </tbody></table>
        <Stat label="Organisation" value={pct(f.org)} />
        {f.owner === g.player && <p className="small muted">Right-click a sea zone node on the map to sail there. Fleets fight enemy fleets in the same zone, protect your sea lanes, and blockade enemy ports (reducing their sea supply). Transport capacity: {f.ships.transport * SHIPS.transport.capacity} brigades.</p>}
      </div>
    </div>
  );
}
