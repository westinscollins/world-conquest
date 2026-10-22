import { useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Tabs, Stat, Bar, Tip } from '../common';
import { money, moneyIC, num, pct } from '../format';
import { UNITS, SHIPS, ECON, MIL } from '../../engine/config';
import { armyStrength, armyOrg, unitUpkeep, recruitCost, TRAITS, unitUpkeepBreakdown, equipValue, armyMaxStrength } from '../../engine/military';
import { doRecruit, hireGeneral, doAssignGeneral, setMobilization, cancelTraining, doOrderShip } from '../../engine/actions';
import { PROV, WORLD } from '../../engine/geo';
import { ownedBy } from '../../engine/world';
import { nationTransportCapacity } from '../../engine/naval';
import type { ShipType, UnitType } from '../../engine/types';
import { focusProvince } from '../commands';
import { audio } from '../../audio/music';

export function MilitaryPanel() {
  const g = useGame();
  const [tab, setTab] = useState<'armies' | 'recruit' | 'generals' | 'navy'>('armies');
  const n = g.nations[g.player];
  const armies = Object.values(g.armies).filter((a) => a.owner === g.player);
  const [where, setWhere] = useState<number>(n.capital);
  const myProvs = ownedBy(g, g.player).filter((p) => g.provinces[p].controller === g.player && g.provinces[p].status !== 'occupied' && g.provinces[p].status !== 'autonomous');
  const upkeep = n.budget.expenses.find((l) => l.key === 'military')?.amount ?? 0;
  return (
    <div className="panel-body">
      <div className="grid3">
        <Stat label="Personnel" value={num(armies.reduce((t, a) => t + armyStrength(a), 0))} />
        <Stat label="Formations" value={armies.reduce((t, a) => t + a.units.length, 0)} />
        <Stat label="Upkeep" value={`${money(upkeep)}/yr`} tip="Wages, equipment maintenance, garrison supply and standby fuel." />
      </div>
      <div className="mob">
        <Tip wide tip={`Mobilisation (${ECON.MOBILIZATION_DAYS} days to full): raises the organisation cap of all formations from 55% to 100%, more than doubles available manpower; costs +35% military upkeep and −5% output.`}>
          <label className="check"><input type="checkbox" checked={n.mobilize} onChange={(e) => { const r = store.act((s) => setMobilization(s, e.target.checked)); r && store.toast(r.message, 'info'); }} /> National mobilisation</label>
        </Tip>
        <Bar value={n.mobilization} h={6} />
        <span className="small">{pct(n.mobilization)}</span>
      </div>
      <Tabs tabs={[['armies', `Armies (${armies.length})`], ['recruit', `Recruit${n.training.length ? ` (${n.training.length})` : ''}`], ['generals', 'Generals'], ['navy', 'Navy']]} value={tab} onChange={setTab} />
      {tab === 'armies' && (
        <table className="tbl clickable">
          <thead><tr><th>Army</th><th>Location</th><th>Strength</th><th>Org</th><th>Supply</th><th>General</th></tr></thead>
          <tbody>
            {armies.map((a) => (
              <tr key={a.id} onClick={() => { store.setUI({ selectedArmy: a.id, selectedProvince: a.location }); focusProvince(a.location); }}>
                <td>{a.name}{a.battleId != null ? <span className="bad"> ⚔</span> : a.path.length ? ' →' : ''}</td>
                <td>{a.embarked ? 'At sea' : PROV[a.location].name}</td>
                <td>{num(armyStrength(a))}<span className="muted small">/{num(armyMaxStrength(a))}</span></td>
                <td><Bar value={armyOrg(a)} h={5} /></td>
                <td className={a.lastSupplyRatio < 0.6 ? 'bad' : ''}>{pct(a.lastSupplyRatio)}</td>
                <td className="small">{a.generalId != null ? g.generals[a.generalId]?.name : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
            <thead><tr><th>Type</th><th>Fee</th><th>Equipment</th><th>Upkeep/yr</th><th>Train</th><th /></tr></thead>
            <tbody>
              {(Object.keys(UNITS) as UnitType[]).map((t) => {
                const u = UNITS[t];
                const br = unitUpkeepBreakdown(t, n);
                return (
                  <tr key={t}>
                    <td><Tip wide tip={<div><b>{u.label}</b><br />{u.desc}<br />{num(u.personnel)} personnel · speed {u.speed} km/day<br />Soft {u.soft} · Hard {u.hard} · Defence {u.defense} · Breakthrough {u.breakthrough} · Armour {pct(u.hardness)}<br />Supply {u.supply}/day · fuel {u.fuel}/day</div>}>{u.label}</Tip></td>
                    <td>{money(recruitCost(t, n), { digits: 2 })}</td>
                    <td><Tip tip={`Drawn from stockpile: ${Object.entries(u.equip).map(([k, v]) => `${k} ${v} M (stock ${n.stockpile[k as keyof typeof n.stockpile].toFixed(1)})`).join(', ')}`}>{money(equipValue(t), { digits: 1 })}</Tip></td>
                    <td><Tip tip={`Wages ${br.wages.toFixed(2)} + maintenance ${br.maint.toFixed(2)} + garrison supply ${br.supply.toFixed(2)} + fuel ${br.fuel.toFixed(2)}`}>{money(unitUpkeep(t, n), { digits: 2 })}</Tip></td>
                    <td>{u.trainDays}d</td>
                    <td><Btn small kind="primary" onClick={() => { const r = store.act((s) => doRecruit(s, t, where)); if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); r.ok && audio.sfx('coins'); } }}>Recruit</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {n.training.length > 0 && <Section title="In training" icon="manpower">
            {n.training.map((t) => (
              <div key={t.id} className="queue-row"><span>{UNITS[t.type].short} — {PROV[t.province].name}</span><Bar value={1 - t.daysLeft / t.totalDays} /><span className="muted">{t.daysLeft}d</span>
                <button className="iconbtn small" title="Cancel" onClick={() => store.setUI({ confirm: { title: 'Cancel training?', body: 'Recruits return to the manpower pool. The recruitment fee is not refunded.', danger: true, onOk: () => store.act((s) => cancelTraining(s, t.id)) } })}>✕</button></div>
            ))}
          </Section>}
          <p className="small muted">Formations need weeks to train and draw equipment from the stockpile on completion. Upkeep starts at half rate during training. Max {MIL.MAX_ARMY_UNITS} formations per army.</p>
        </>
      )}
      {tab === 'generals' && (
        <>
          <Section title="Your generals" icon="star">
            {Object.values(g.generals).filter((x) => x.owner === g.player && !x.available).map((x) => (
              <div key={x.id} className="general-row">
                <div><b>{x.name}</b> <span className="chip">{TRAITS[x.trait].label}</span><div className="small muted">Atk {x.attack} · Def {x.defense} · Log {x.logistics} — {TRAITS[x.trait].desc}</div></div>
                <select value={x.armyId ?? ''} onChange={(e) => store.act((s) => doAssignGeneral(s, x.id, e.target.value === '' ? null : +e.target.value))}>
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
                <Btn small kind="primary" disabled={n.treasury < x.hireCost} onClick={() => { const r = store.act((s) => hireGeneral(s, x.id)); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Hire {moneyIC(x.hireCost)}</Btn>
              </div>
            ))}
            <p className="small muted">Generals cost a one-time appointment fee and 0.25 M IC/yr salary. They gain experience in battle and improve their skills.</p>
          </Section>
        </>
      )}
      {tab === 'navy' && <NavyTab />}
    </div>
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
        <Stat label="Transport capacity" value={`${tc.cap - tc.used}/${tc.cap}`} tip="Brigades that can be at sea at once (4 from chartered merchant shipping + 4 per Transport Flotilla)." />
        <Stat label="Naval materiel" value={`${money(n.stockpile.ships)} IC`} tip="Produced by factories on the Naval line; consumed when laying down ships." />
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
            <thead><tr><th>Ship</th><th>Materiel</th><th>Build</th><th>Upkeep/yr</th><th /></tr></thead>
            <tbody>
              {(Object.keys(SHIPS) as ShipType[]).map((k) => (
                <tr key={k}><td>{SHIPS[k].label}</td><td>{money(SHIPS[k].cost)}</td><td>{SHIPS[k].days}d</td><td>{money(SHIPS[k].personnel * MIL.SOLDIER_WAGE + SHIPS[k].cost * 0.06, { digits: 2 })}</td>
                  <td><Btn small kind="primary" disabled={port == null || n.stockpile.ships < SHIPS[k].cost} title={n.stockpile.ships < SHIPS[k].cost ? 'Assign factories to Naval production first' : ''} onClick={() => { const r = store.act((s) => doOrderShip(s, k, port!)); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Lay down</Btn></td></tr>
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
