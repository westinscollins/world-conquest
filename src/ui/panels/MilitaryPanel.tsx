import { useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Tabs, Stat, Bar, Tip } from '../common';
import { money, moneyIC, num, pct } from '../format';
import { UNITS, SHIPS, ECON, MIL, AIR, AIR_MISSION_INFO } from '../../engine/config';
import { wingsOf, wingPlanes } from '../../engine/air';
import { armyStrength, armyOrg, unitUpkeep, recruitCost, TRAITS, unitUpkeepBreakdown, armyMaxStrength, militaryStrength, trainDays } from '../../engine/military';
import { doRecruit, hireGeneral, doAssignGeneral, setMobilization, cancelTraining, doOrderShip } from '../../engine/actions';
import { PROV, WORLD } from '../../engine/geo';
import { ownedBy } from '../../engine/world';
import { nationTransportCapacity, shipCost, merchantCapacity } from '../../engine/naval';
import type { ShipType, UnitType } from '../../engine/types';
import { focusProvince } from '../commands';
import { audio } from '../../audio/music';

export function MilitaryPanel() {
  const g = useGame();
  const [tab, setTab] = useState<'armies' | 'recruit' | 'generals' | 'navy' | 'air'>('armies');
  const [picked, setPicked] = useState<number[]>([]);
  const n = g.nations[g.player];
  const armies = Object.values(g.armies).filter((a) => a.owner === g.player);
  const [where, setWhere] = useState<number>(n.capital);
  const myProvs = ownedBy(g, g.player).filter((p) => g.provinces[p].controller === g.player && g.provinces[p].status !== 'occupied' && g.provinces[p].status !== 'autonomous');
  const upkeep = n.budget.expenses.find((l) => l.key === 'military')?.amount ?? 0;
  return (
    <div className="panel-body">
      <div className="grid3">
        <Stat label="Military strength" value={militaryStrength(g, g.player).toLocaleString()} tip="Fixed points per formation (infantry 10, mechanized 18, armored 30, artillery 12), squadron (fighter 25, bomber 30) and warship, including units in training. Changes only when you raise, disband or lose units." />
        <Stat label="Soldiers" value={num(armies.reduce((t, a) => t + armyStrength(a), 0))} tip={`${armies.reduce((t, a) => t + a.units.length, 0)} formations in ${armies.length} armies`} />
        <Stat label="Upkeep" value={`${money(upkeep)}/yr`} tip="Wages, equipment maintenance, garrison supply and standby fuel." />
      </div>
      <div className="mob">
        <Tip wide tip={`Mobilisation (${ECON.MOBILIZATION_DAYS} days to full): raises the organisation cap of all formations from 55% to 100%, more than doubles available manpower; costs +${Math.round((ECON.MOBILIZED_UPKEEP - 1) * 100)}% military upkeep and −${Math.round((1 - ECON.MOBILIZED_OUTPUT) * 100)}% output.`}>
          <label className="check"><input type="checkbox" checked={n.mobilize} onChange={(e) => { const r = store.cmd('setMobilization', [e.target.checked]); r && store.toast(r.message, 'info'); }} /> National mobilisation</label>
        </Tip>
        <Bar value={n.mobilization} h={6} />
        <span className="small">{pct(n.mobilization)}</span>
      </div>
      <Tabs tabs={[['armies', `Armies (${armies.length})`], ['recruit', `Recruit${n.training.length ? ` (${n.training.length})` : ''}`], ['air', `Air force (${wingsOf(g, g.player).length})`], ['navy', 'Navy'], ['generals', 'Generals']]} value={tab} onChange={setTab} />
      {tab === 'armies' && (() => {
        const live = picked.filter((id) => g.armies[id]?.owner === g.player);
        const toggle = (id: number) => setPicked(live.includes(id) ? live.filter((x) => x !== id) : [...live, id]);
        return (
        <>
        <div className="bulk">
          <label className="check"><input type="checkbox" checked={armies.length > 0 && live.length === armies.length} onChange={() => setPicked(live.length === armies.length ? [] : armies.map((a) => a.id))} /> Select all</label>
          <b style={{ marginLeft: 8 }}>{live.length} selected</b>
          <Btn small kind="danger" disabled={!live.length} onClick={() => store.setUI({ confirm: { title: `Disband ${live.length} ${live.length === 1 ? 'army' : 'armies'}?`, body: `${num(Math.round(live.reduce((t, id) => t + armyStrength(g.armies[id]), 0) * 0.9))} soldiers return to the manpower pool and their equipment is scrapped. Armies in battle or at sea are skipped. This cannot be undone.`, danger: true, okLabel: 'Disband', onOk: () => { const r = store.cmd('disbandArmies', [live]); if (r) store.toast(r.message, r.ok ? 'info' : 'bad'); setPicked([]); } } })}>Disband selected</Btn>
          <span className="small muted">Tick armies here (or in the War Room) to disband many at once.</span>
        </div>
        <table className="tbl clickable">
          <thead><tr><th /><th>Army</th><th>Location</th><th>Soldiers</th><th>Org</th><th>Supply</th><th>Orders</th></tr></thead>
          <tbody>
            {armies.map((a) => (
              <tr key={a.id} className={live.includes(a.id) ? 'sel' : ''} onClick={() => { store.setUI({ selectedArmy: a.id, selectedProvince: a.location }); focusProvince(a.location); }}>
                <td onClick={(e) => { e.stopPropagation(); toggle(a.id); }}><input type="checkbox" readOnly checked={live.includes(a.id)} /></td>
                <td>{a.name}{a.battleId != null ? <span className="bad"> ⚔</span> : a.path.length ? ' →' : ''}</td>
                <td>{a.embarked ? 'At sea' : PROV[a.location].name}</td>
                <td>{num(armyStrength(a))}<span className="muted small">/{num(armyMaxStrength(a))}</span></td>
                <td><Bar value={armyOrg(a)} h={5} /></td>
                <td className={a.lastSupplyRatio < 0.6 ? 'bad' : ''}>{pct(a.lastSupplyRatio)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select value={a.stance} onChange={(e) => store.cmd('setStance', [a.id, e.target.value])}>
                    <option value="hold">Hold</option><option value="defend">Defend</option><option value="advance">Attack</option><option value="withdraw">Withdraw</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
        );
      })()}
      {tab === 'recruit' && (
        <>
          <div className="row gap">
            <span>Recruit in</span>
            <select value={where} onChange={(e) => setWhere(+e.target.value)}>
              {myProvs.map((p) => <option key={p} value={p}>{PROV[p].name}</option>)}
            </select>
            <span className="muted small">Manpower {num(n.manpower)}</span>
          </div>
          <table className="tbl">
            <thead><tr><th>Type</th><th>Price</th><th>Upkeep/yr</th><th>Train</th><th>Strength</th><th /></tr></thead>
            <tbody>
              {(Object.keys(UNITS) as UnitType[]).filter((t) => t !== 'air' && t !== 'bomber').map((t) => {
                const u = UNITS[t];
                const br = unitUpkeepBreakdown(t, n);
                return (
                  <tr key={t}>
                    <td><Tip wide tip={<div><b>{u.label}</b><br />{u.desc}<br />{num(u.personnel)} personnel · speed {u.speed} km/day<br />Soft {u.soft} · Hard {u.hard} · Defence {u.defense} · Breakthrough {u.breakthrough} · Armour {pct(u.hardness)}<br />Supply {u.supply}/day · fuel {u.fuel}/day</div>}>{u.label}</Tip></td>
                    <td>{money(recruitCost(t, n), { digits: 2 })}</td>
                    <td><Tip tip={`Wages ${br.wages.toFixed(2)} + maintenance ${br.maint.toFixed(2)} + garrison supply ${br.supply.toFixed(2)} + fuel ${br.fuel.toFixed(2)}`}>{money(unitUpkeep(t, n), { digits: 2 })}</Tip></td>
                    <td>{trainDays(t, n)}d</td>
                    <td>+{u.points}</td>
                    <td><Btn small kind="primary" onClick={() => { const r = store.cmd('doRecruit', [t, where]); if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); r.ok && audio.sfx('coins'); } }}>Recruit</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {n.training.length > 0 && <Section title="In training" icon="manpower">
            {n.training.map((t) => (
              <div key={t.id} className="queue-row"><span>{UNITS[t.type].short} — {PROV[t.province].name}</span><Bar value={1 - t.daysLeft / t.totalDays} /><span className="muted">{t.daysLeft}d</span>
                <button className="iconbtn small" title="Cancel" onClick={() => store.setUI({ confirm: { title: 'Cancel training?', body: 'Recruits return to the manpower pool. The recruitment fee is not refunded.', danger: true, onOk: () => store.cmd('cancelTraining', [t.id]) } })}>✕</button></div>
            ))}
          </Section>}
          <p className="small muted">The price includes full equipment. Formations train for a few weeks, then appear fully equipped in the province you chose. Factories make them cheaper and faster. Max {MIL.MAX_ARMY_UNITS} formations per army. Fighters and bombers: Air force tab; warships: Navy tab.</p>
        </>
      )}
      {tab === 'generals' && (
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
                <Btn small kind="primary" disabled={n.treasury < x.hireCost} onClick={() => { const r = store.cmd('hireGeneral', [x.id]); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Hire {moneyIC(x.hireCost)}</Btn>
              </div>
            ))}
            <p className="small muted">Generals cost a one-time appointment fee and 0.25 M IC/yr salary. They gain experience in battle and improve their skills.</p>
          </Section>
        </>
      )}
      {tab === 'navy' && <NavyTab />}
      {tab === 'air' && <AirTab />}
    </div>
  );
}

function AirTab() {
  const g = useGame();
  const n = g.nations[g.player];
  const wings = wingsOf(g, g.player);
  const bases = ownedBy(g, g.player).filter((p) => g.provinces[p].controller === g.player && g.provinces[p].status !== 'occupied' && g.provinces[p].status !== 'autonomous');
  const [base, setBase] = useState<number>(n.capital);
  const squads = wings.flatMap((w) => w.units);
  return (
    <>
      <div className="grid3">
        <Stat label="Aircraft" value={wings.reduce((t, w) => t + wingPlanes(w), 0)} tip="Fighters and bombers in all your air wings." />
        <Stat label="Squadrons" value={`${squads.filter((u) => u.type === 'air').length} fighter · ${squads.filter((u) => u.type === 'bomber').length} bomber`} />
        <Stat label="Air wings" value={wings.length} />
      </div>
      {wings.map((w) => (
        <div key={w.id} className="army-row" onClick={() => { store.setUI({ selectedWing: w.id, selectedArmy: null, selectedFleet: null }); focusProvince(w.base); }}>
          <span className="chip">{w.units.filter((u) => u.type === 'bomber').length * 2 > w.units.length ? '✈ BMB' : '✈ FTR'}</span>
          <b>{w.name}</b>
          <span className="muted small">{PROV[w.base].name}{w.rebase ? ` → ${PROV[w.rebase.to].name}` : ''} · {wingPlanes(w)} aircraft · {AIR_MISSION_INFO[w.mission].label}{w.mission === 'bombing' && w.target != null ? `: ${PROV[w.target].name}` : w.mission === 'naval' && w.target != null ? `: ${WORLD.seas[w.target].name}` : ''}</span>
        </div>
      ))}
      {!wings.length && <p className="muted">You have no air force yet.</p>}
      {wings.length > 0 && <p className="small muted">Click a wing to give it orders or retire it.</p>}
      <Section title="Build aircraft" icon="factory">
        <div className="row gap">
          <span>Airbase</span>
          <select value={base} onChange={(e) => setBase(+e.target.value)}>{bases.map((p) => <option key={p} value={p}>{PROV[p].name}</option>)}</select>
        </div>
        <table className="tbl">
          <thead><tr><th>Type</th><th>Price</th><th>Upkeep/yr</th><th>Train</th><th>Reach</th><th /></tr></thead>
          <tbody>
            {(['air', 'bomber'] as const).map((t) => (
              <tr key={t}>
                <td><Tip wide tip={<div><b>{UNITS[t].label}</b><br />{UNITS[t].desc}<br />{AIR.PLANES[t]} aircraft · {num(UNITS[t].personnel)} crew</div>}>{UNITS[t].label}</Tip></td>
                <td>{money(recruitCost(t, n), { digits: 2 })}</td>
                <td>{money(unitUpkeep(t, n), { digits: 2 })}</td>
                <td>{trainDays(t, n)}d</td>
                <td>{num(AIR.RANGE[t])} km</td>
                <td><Btn small kind="primary" onClick={() => { const r = store.cmd('doRecruit', [t, base]); if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); r.ok && audio.sfx('coins'); } }}>Build</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">New squadrons join an air wing at that airbase. Click a wing's jet on the map to give it a mission: support your battles, defend your airspace, bomb a province or strike ships. Air superiority over a battle gives up to +{Math.round(AIR.SUPERIORITY * 100)}% attack, and bombers hit the enemy hard.</p>
      </Section>
    </>
  );
}

function NavyTab() {
  const g = useGame();
  const n = g.nations[g.player];
  const fleets = Object.values(g.fleets).filter((f) => f.owner === g.player);
  const ports = ownedBy(g, g.player).filter((p) => g.provinces[p].buildings.port > 0 && g.provinces[p].controller === g.player);
  const [port, setPort] = useState<number | undefined>(ports[0]);
  const tc = nationTransportCapacity(g, n);
  return (
    <>
      <div className="grid3">
        <Stat label="Fleets" value={fleets.length} />
        <Stat label="Transport capacity" value={`${Math.max(0, tc.cap - tc.used)}/${tc.cap}`} tip={`Brigades that can be at sea at once: ${merchantCapacity(n)} from chartered merchant shipping (more for bigger economies) + 4 per Transport Flotilla.`} />
        <Stat label="Warships" value={fleets.reduce((t, f) => t + Math.round(f.ships.destroyer + f.ships.cruiser + f.ships.battlegroup), 0)} />
      </div>
      {fleets.map((f) => (
        <div key={f.id} className="army-row" onClick={() => store.setUI({ selectedFleet: f.id, selectedArmy: null })}>
          <b>{f.name}</b><span className="muted small"> {WORLD.seas[f.sea].name}</span><div style={{ flex: 1 }} />
          <span className="small">{(['destroyer', 'cruiser', 'battlegroup', 'transport'] as ShipType[]).map((k) => `${Math.round(f.ships[k])} ${k.slice(0, 3)}`).join(' · ')}</span>
        </div>
      ))}
      {ports.length ? (
        <Section title="Shipyards" icon="anchor">
          <div className="row gap"><span>Build at</span><select value={port} onChange={(e) => setPort(+e.target.value)}>{ports.map((p) => <option key={p} value={p}>{PROV[p].name}</option>)}</select></div>
          <table className="tbl">
            <thead><tr><th>Ship</th><th>Price</th><th>Build</th><th>Upkeep/yr</th><th /></tr></thead>
            <tbody>
              {(Object.keys(SHIPS) as ShipType[]).map((k) => (
                <tr key={k}><td>{SHIPS[k].label}</td><td>{money(shipCost(k, n), { digits: 1 })}</td><td>{SHIPS[k].days}d</td><td>{money(SHIPS[k].personnel * MIL.SOLDIER_WAGE + SHIPS[k].cost * 0.06, { digits: 2 })}</td>
                  <td><Btn small kind="primary" disabled={port == null || n.treasury < shipCost(k, n)} onClick={() => { const r = store.cmd('doOrderShip', [k, port!]); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Lay down</Btn></td></tr>
              ))}
            </tbody>
          </table>
          {n.shipyard.map((o) => <div key={o.id} className="queue-row"><span>{SHIPS[o.type].label} — {PROV[o.port].name}</span><Bar value={1 - o.daysLeft / o.totalDays} /><span className="muted">{o.daysLeft}d</span></div>)}
        </Section>
      ) : <p className="muted small">You have no ports. Build one in a coastal province to construct ships and embark armies.</p>}
      <p className="small muted">To move an army by sea: select it in a friendly port and right-click a coastal province with no land route. Enemy fleets on the route can intercept transports.</p>
    </>
  );
}
