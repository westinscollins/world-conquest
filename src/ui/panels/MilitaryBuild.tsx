// Military → Build: troops, aircraft, warships, mercenaries, missiles and drones, air defence and the bomb.
import { Fragment, useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Bar, Tip } from '../common';
import { money, num, pct } from '../format';
import { UNITS, SHIPS, MIL, AIR, STRIKES, NUKE, SAM_COST, SAM_MAX } from '../../engine/config';
import { unitUpkeep, recruitCost, unitUpkeepBreakdown, trainDays } from '../../engine/military';
import { PROV } from '../../engine/geo';
import { ownedBy } from '../../engine/world';
import { shipCost } from '../../engine/naval';
import { MERC_TYPES, mercenaryCost } from '../../engine/warplans';
import { munitionCost, nukeProgramCost, warheadCost } from '../../engine/strikes';
import { fmtDate } from '../../engine/events';
import type { ShipType, UnitType } from '../../engine/types';
import { audio } from '../../audio/music';

const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'good' : 'bad');
const SHIP_NOTE: Record<ShipType, string> = {
  destroyer: 'Fast escorts. The best submarine hunters.',
  cruiser: 'Heavy guns: shells the coast in support of your armies.',
  battlegroup: 'Carrier with its own air wing: rules the sea and the sky above it.',
  submarine: 'Strikes unseen: sinks troopships and drains enemy treasuries by raiding trade near their ports. Weak against destroyers.',
  transport: 'Carries 4 more brigades by sea.',
};

export function BuildTab() {
  const g = useGame();
  const n = g.nations[g.player];
  const myProvs = ownedBy(g, g.player).filter((p) => g.provinces[p].controller === g.player && g.provinces[p].status !== 'occupied' && g.provinces[p].status !== 'autonomous');
  const [where, setWhere] = useState<number>(myProvs.includes(n.capital) ? n.capital : myProvs[0]);
  const ports = myProvs.filter((p) => g.provinces[p].buildings.port > 0);
  const [port, setPort] = useState<number | undefined>(ports[0]);
  const [mt, setMt] = useState<(typeof MERC_TYPES)[number]>('infantry');
  const recruit = (t: UnitType, at: number) => { const r = store.cmd('doRecruit', [t, at]); if (r) { say(r); r.ok && audio.sfx('coins'); } };
  return (
    <>
      <div className="row gap" style={{ margin: '6px 0' }}>
        <span>Build in</span>
        <select value={where} onChange={(e) => setWhere(+e.target.value)}>{myProvs.map((p) => <option key={p} value={p}>{PROV[p].name}</option>)}</select>
        <span className="muted small">Treasury {money(n.treasury)} · manpower {num(n.manpower)}</span>
      </div>
      <Section title="Land forces" icon="manpower">
        <table className="tbl">
          <thead><tr><th>Type</th><th>Price</th><th>Upkeep/yr</th><th>Train</th><th>Strength</th><th /></tr></thead>
          <tbody>
            {(Object.keys(UNITS) as UnitType[]).filter((t) => t !== 'air' && t !== 'bomber').map((t) => {
              const u = UNITS[t];
              const br = unitUpkeepBreakdown(t, n);
              return (
                <tr key={t}>
                  <td><Tip wide tip={<div><b>{u.label}</b><br />{u.desc}<br />{num(u.personnel)} personnel · speed {u.speed} km/day<br />Soft {u.soft} · Hard {u.hard} · Defence {u.defense} · Breakthrough {u.breakthrough} · Armour {pct(u.hardness)}</div>}>{u.label}</Tip></td>
                  <td>{money(recruitCost(t, n), { digits: 2 })}</td>
                  <td><Tip tip={`Wages ${br.wages.toFixed(2)} + maintenance ${br.maint.toFixed(2)} + garrison supply ${br.supply.toFixed(2)} + fuel ${br.fuel.toFixed(2)}`}>{money(unitUpkeep(t, n), { digits: 2 })}</Tip></td>
                  <td>{trainDays(t, n)}d</td>
                  <td>+{u.points}</td>
                  <td><Btn small kind="primary" onClick={() => recruit(t, where)}>Recruit</Btn></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {n.training.length > 0 && n.training.map((t) => (
          <div key={t.id} className="queue-row"><span>{UNITS[t.type].short} — {PROV[t.province].name}</span><Bar value={1 - t.daysLeft / t.totalDays} /><span className="muted">{t.daysLeft}d</span>
            <button className="iconbtn small" title="Cancel" onClick={() => store.setUI({ confirm: { title: 'Cancel training?', body: 'Recruits return to the manpower pool. The fee is not refunded.', danger: true, onOk: () => store.cmd('cancelTraining', [t.id]) } })}>✕</button></div>
        ))}
        <p className="small muted">Prices include full equipment. Artillery lets you call barrages in battle; recon makes your scouts' reports surer. Max {MIL.MAX_ARMY_UNITS} formations per army.</p>
        <div className="row gap wrap" style={{ marginTop: 4 }}>
          <b className="small">Mercenaries</b>
          <select value={mt} onChange={(e) => setMt(e.target.value as typeof mt)}>{MERC_TYPES.map((t) => <option key={t} value={t}>{UNITS[t].label}</option>)}</select>
          <Btn small disabled={n.treasury < mercenaryCost(mt, n)} onClick={() => say(store.cmd('doMercenaries', [mt, where]))}>Hire now ({money(mercenaryCost(mt, n), { digits: 1 })})</Btn>
          <span className="small muted">Ready at once and experienced, but 2.5× the price and the officers resent them.</span>
        </div>
      </Section>
      <Section title="Aircraft" icon="star">
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
                <td><Btn small kind="primary" onClick={() => recruit(t, where)}>Build</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">Squadrons join an air wing based in {PROV[where].name}. Air superiority over a battle gives up to +{Math.round(AIR.SUPERIORITY * 100)}% attack, and lets you call air strikes.</p>
      </Section>
      <Section title="Warships" icon="anchor">
        {ports.length ? (
          <>
            <div className="row gap"><span>Shipyard</span><select value={port} onChange={(e) => setPort(+e.target.value)}>{ports.map((p) => <option key={p} value={p}>{PROV[p].name}</option>)}</select></div>
            <table className="tbl">
              <thead><tr><th>Ship</th><th>Price</th><th>Build</th><th>Upkeep/yr</th><th /></tr></thead>
              <tbody>
                {(Object.keys(SHIPS) as ShipType[]).map((k) => (
                  <tr key={k}><td><Tip wide tip={<div><b>{SHIPS[k].label}</b><br />{SHIP_NOTE[k]}<br />Attack {SHIPS[k].attack} · defence {SHIPS[k].defense}</div>}>{SHIPS[k].label}</Tip></td><td>{money(shipCost(k, n), { digits: 1 })}</td><td>{SHIPS[k].days}d</td><td>{money(SHIPS[k].personnel * MIL.SOLDIER_WAGE + SHIPS[k].cost * 0.06, { digits: 2 })}</td>
                    <td><Btn small kind="primary" disabled={port == null || n.treasury < shipCost(k, n)} onClick={() => say(store.cmd('doOrderShip', [k, port!]))}>Lay down</Btn></td></tr>
                ))}
              </tbody>
            </table>
            {n.shipyard.map((o) => <div key={o.id} className="queue-row"><span>{SHIPS[o.type].label} — {PROV[o.port].name}</span><Bar value={1 - o.daysLeft / o.totalDays} /><span className="muted">{o.daysLeft}d</span></div>)}
          </>
        ) : <p className="muted small">You have no ports. Build one in a coastal province (Economy → Construction) to build ships.</p>}
      </Section>
      <StrikeForces />
    </>
  );
}

const SALVOS = [1, 5, 10];
/** Drones, missiles, air defence and the nuclear option. */
function StrikeForces() {
  const g = useGame();
  const n = g.nations[g.player];
  const atWarNow = g.wars.some((w) => w.attackers.includes(g.player) || w.defenders.includes(g.player));
  const aim = (kind: 'drone' | 'missile' | 'nuke' | 'ballistic' | 'recon', count: number) => {
    if (!atWarNow) { store.toast('Strikes need a war: you can only hit provinces of nations you are fighting.', 'bad'); return; }
    store.setUI({ strike: { kind, count }, panel: null, selectedArmy: null });
  };
  return (
    <Section title="Drones, missiles and air defence" icon="battle">
      <div className="arsenal">
        {(['recon', 'drone', 'missile', 'ballistic'] as const).map((k) => (
          <Fragment key={k}>
            <Tip wide tip={<div><b>{STRIKES[k].label}</b><br />{STRIKES[k].desc}<br />Enemy fighters near the target shoot some down.</div>}><b>{STRIKES[k].label}s: {n.arsenal[k]}</b></Tip>
            <span className="row gap">{SALVOS.map((c) => <Btn key={c} small onClick={() => say(store.cmd('doBuyMunitions', [k, c]))}>Buy {c} ({money(munitionCost(k, n) * c, { digits: 1 })})</Btn>)}</span>
            <span className="row gap">{[1, 5].map((c) => <Btn key={c} small kind="primary" disabled={n.arsenal[k] < 1} onClick={() => aim(k, c)}>Fire {c}</Btn>)}</span>
          </Fragment>
        ))}
      </div>
      <p className="small muted">Fire, then click a highlighted enemy province. Attack drones are also used from the battle screen: a drone strike there hits the enemy line and shows you their next move for certain.</p>
      <div className="row gap"><b>Air defence: {n.regime.sam} SAM batteries</b><span className="small muted">each shoots down 4% more incoming strikes (max {SAM_MAX})</span><div style={{ flex: 1 }} /><Btn small disabled={n.regime.sam >= SAM_MAX || n.treasury < SAM_COST} onClick={() => say(store.cmd('doBuySam', []))}>Buy battery ({money(SAM_COST * n.priceIndex)})</Btn></div>
      <div className="nuke-box">
        <div className="row gap"><b>☢ Nuclear weapons: {n.arsenal.nuke}</b>{n.warheads.length > 0 && <span className="small muted">{n.warheads.length} ICBM{n.warheads.length > 1 ? 's' : ''} being built ({Math.min(...n.warheads)}d)</span>}<div style={{ flex: 1 }} />
          {n.nukeProgram < 0 && <Btn small onClick={() => store.setUI({ confirm: { title: 'Start a nuclear programme?', danger: true, body: `Costs ${money(nukeProgramCost(n), { digits: 0 })} and takes about ${(NUKE.programDays / 365).toFixed(1)} years. Relations with every nation fall by 10.`, onOk: () => say(store.cmd('doNuclearProgram', [])) } })}>Start programme ({money(nukeProgramCost(n), { digits: 0 })})</Btn>}
          {n.nukeProgram > 0 && <span className="small">Programme: {n.nukeProgram} days left</span>}
          {n.nukeProgram === 0 && <Btn small onClick={() => say(store.cmd('doBuildWarhead', []))}>Build ICBM ({money(warheadCost(n), { digits: 0 })}, {NUKE.warheadDays}d)</Btn>}
          {n.arsenal.nuke > 0 && <Btn small kind="danger" onClick={() => aim('nuke', 1)}>Launch…</Btn>}
        </div>
        <p className="small" style={{ margin: '6px 0 0' }}>A nuclear strike destroys ~85% of the armies in a province and wrecks it for decades. <b className="warn">Why you shouldn't:</b> the whole world embargoes you for {NUKE.embargoDays / 365} years, every alliance ends, every nation gets a casus belli against you, and nuclear-armed enemies retaliate at once.</p>
        {n.embargoUntil > g.day && <p className="bad small">You are under the global embargo until {fmtDate(g, n.embargoUntil)}.</p>}
      </div>
    </Section>
  );
}
