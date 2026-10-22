import { useState } from 'react';
import { store, useStore } from './store';
import { PROV, COUNTRY_GEO } from '../engine/geo';
import { BUILDINGS, TERRAIN, WEATHER, UNITS, ECON } from '../engine/config';
import { provinceOutput, buildCost, resourceYield, collectionEfficiency } from '../engine/economy';
import type { GameState, Nation, ProvinceState } from '../engine/types';
import { provinceWeather } from '../engine/weather';
import { armiesIn, peekRel, atWar, ownedBy, controlledBy, alliesOf } from '../engine/world';
import { perceivedPower } from '../engine/diplomacy';
import { supplyMap } from '../engine/supply';
import { build, doProvinceStatus, doRecruit, doRelease } from '../engine/actions';
import { checkRecruit, armyStrength } from '../engine/military';
import type { BuildingKind, UnitType } from '../engine/types';
import { Section, Btn, Tip, Stat, Bar, Tabs } from './common';
import { Icon } from './icons';
import { money, moneyIC, num, pct } from './format';
import { audio } from '../audio/music';

export function ProvincePanel() {
  const { g, ui } = useStore();
  const [tab, setTab] = useState<'info' | 'build' | 'recruit'>('info');
  if (!g || ui.selectedProvince == null) return null;
  const p = ui.selectedProvince;
  const geo = PROV[p];
  const st = g.provinces[p];
  const owner = g.nations[st.owner];
  const ctrl = g.nations[st.controller];
  const mine = st.owner === g.player;
  const out = provinceOutput(g, st, owner);
  const w = provinceWeather(g, p);
  const armies = armiesIn(g, p);
  const sm = supplyMap(g, g.nations[g.player]);
  const player = g.nations[g.player];
  const rel = peekRel(g, st.owner, g.player);
  const showTabs = mine && st.controller === g.player;

  return (
    <div className="side-panel right">
      <div className="sp-head" style={{ borderColor: owner?.color }}>
        <div>
          <div className="sp-title">{geo.name}{geo.capital || owner?.capital === p ? <Icon name="star" size={14} color="#e8c36a" style={{ marginLeft: 6 }} /> : null}</div>
          <div className="sp-sub"><span className="swatch" style={{ background: owner?.color }} /> {owner?.name}{st.controller !== st.owner && <> · <span className="bad">occupied by {ctrl?.name}</span></>}</div>
        </div>
        <button className="iconbtn" onClick={() => store.setUI({ selectedProvince: null, selectedArmy: null })}><Icon name="close" /></button>
      </div>
      {showTabs && <Tabs tabs={[['info', 'Overview'], ['build', 'Construction'], ['recruit', 'Recruit']]} value={tab} onChange={setTab} />}
      <div className="sp-body">
        {(tab === 'info' || !showTabs) && (
          <>
            <div className="grid2">
              <Stat label="Terrain" value={<>{TERRAIN[geo.terrain].label}{geo.river ? ' · river' : ''}</>} tip={`Movement ×${TERRAIN[geo.terrain].move}, attacker ×${TERRAIN[geo.terrain].attack}, defender ×${TERRAIN[geo.terrain].defense}, combat width ${TERRAIN[geo.terrain].width}${geo.river ? '. Major river: −15% to attackers.' : ''}`} />
              <Stat label="Weather" value={WEATHER[w].label} tip={`Attack ×${WEATHER[w].attack}, movement ×${WEATHER[w].move}, air ×${WEATHER[w].air}, supply use ×${WEATHER[w].supply}`} />
              <Stat label="Population" value={num(st.pop)} />
              <Stat label="Output" value={`${money(out)} IC/yr`} tip={<div>Population {num(st.pop)} × productivity {st.dev.toFixed(1)} M IC per million{st.buildings.power ? ` × power plants +${st.buildings.power * 12}%` : ''}<br />+ buildings · × status {st.status} ({pct(ECON.STATUS_OUTPUT[st.status])}) · damage −{pct(st.damage * 0.75)} · resistance −{pct(st.resistance / 250)}</div>} />
              <Stat label="Infrastructure" value={st.infra} tip="1 + roads + 2×railways (+1 with a port). Speeds movement and supply throughput." />
              <Stat label="Supply here" value={sm[p] < 0 ? '—' : `${sm[p].toFixed(0)}/day`} tip="Supply your armies could draw in this province (from your network)." tone={sm[p] < 5 ? 'bad' : undefined} />
              <Stat label="Status" value={st.status} tone={st.status === 'core' ? undefined : 'warn'} tip={{ core: 'Fully integrated: full output, taxes and recruitment.', occupied: `Military occupation: ${pct(ECON.STATUS_OUTPUT.occupied)} output, high resistance, admin costs.`, integrating: 'Integration under way.', autonomous: 'Autonomous: lower resistance, tribute instead of full tax; cannot recruit.' }[st.status]} />
              {st.damage > 0.01 && <Stat label="War damage" value={pct(st.damage)} tone="bad" />}
              {st.resistance > 1 && <Stat label="Resistance" value={st.resistance.toFixed(0)} tone={st.resistance > 60 ? 'bad' : 'warn'} tip="Grows under occupation, low stability and irredentism; garrisons suppress it. Above 90, uprisings break out." />}
            </div>
            <Section title="Resources" icon="factory">
              <div className="res-row">
                {(['food', 'steel', 'oil', 'rare'] as const).map((r) => <Tip key={r} tip={`${r}: level ${geo.resources[r]}${r === 'food' && st.buildings.farm ? ` +${st.buildings.farm} (estates)` : ''}; produces ${resourceYield(st, r).toFixed(1)} units/yr`}><span className={`res res-${r}`}>{r} {geo.resources[r] + (r === 'food' ? st.buildings.farm : 0)}</span></Tip>)}
              </div>
              <div className="bld-row">
                {(Object.keys(BUILDINGS) as BuildingKind[]).filter((k) => st.buildings[k] > 0).map((k) => <span key={k} className="chip">{BUILDINGS[k].label} {st.buildings[k]}</span>)}
              </div>
            </Section>
            {armies.length > 0 && (
              <Section title="Armies present" icon="sword">
                {armies.map((a) => {
                  const n = g.nations[a.owner];
                  const visible = a.owner === g.player || armiesIn(g, p).some((x) => x.owner === g.player) || n?.isPlayer;
                  return (
                    <div key={a.id} className="army-row" onClick={() => a.owner === g.player && store.setUI({ selectedArmy: a.id })}>
                      <span className="swatch" style={{ background: n?.color }} />
                      <span>{a.owner === g.player ? a.name : `${n?.name} army`}</span>
                      <div style={{ flex: 1 }} />
                      <b>{visible ? num(armyStrength(a)) : `~${num(Math.round(armyStrength(a) / 5000) * 5000 || 3000)}`}</b>
                    </div>
                  );
                })}
              </Section>
            )}
            {owner && <NationSummary id={owner.id} />}
            {mine && st.status !== 'core' && (
              <Section title="Administration of conquered land" icon="flag">
                <p className="small muted">Former owner: {g.nations[st.formerOwner]?.name ?? COUNTRY_GEO[st.formerOwner]?.name}. {st.status === 'integrating' ? `Integration ${pct(st.integration)} complete.` : ''}</p>
                <div className="row gap wrap">
                  {(st.status === 'occupied' || st.status === 'autonomous') && (() => { const c = buildCost(g, player, p, 'integrate'); return <Btn kind="primary" disabled={!c.ok || player.treasury < c.cost} onClick={() => store.setUI({ confirm: { title: `Integrate ${geo.name}?`, body: `Cost: ${moneyIC(c.cost)} · Time: ${c.days} days.\nThe province becomes core: full output, taxes and recruitment. Resistance falls.`, onOk: () => { const r = store.act((s) => build(s, p, 'integrate')); r && store.toast(r.message, r.ok ? 'good' : 'bad'); } } })}>Integrate ({moneyIC(c.cost)}, {c.days}d)</Btn>; })()}
                  {st.status === 'occupied' && <Btn onClick={() => { const r = store.act((s) => doProvinceStatus(s, p, 'autonomous')); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Grant autonomy</Btn>}
                  {st.status === 'autonomous' && <Btn onClick={() => { const r = store.act((s) => doProvinceStatus(s, p, 'occupied')); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Direct rule</Btn>}
                  {st.formerOwner !== g.player && <Btn kind="ghost" onClick={() => store.setUI({ confirm: { title: `Release ${g.nations[st.formerOwner]?.name ?? st.formerOwner}?`, body: `All non-core provinces you hold that belonged to ${g.nations[st.formerOwner]?.name} are returned and it becomes your subject state (pays 15% tribute, follows you in wars). Reduces infamy. This is irreversible except by later annexation.`, danger: true, onOk: () => { const r = store.act((s) => doRelease(s, st.formerOwner)); r && store.toast(r.message, r.ok ? 'good' : 'bad'); } } })}>Release as subject</Btn>}
                </div>
              </Section>
            )}
            {!mine && owner && (
              <div className="small muted" style={{ marginTop: 8 }}>
                Relations with you: <b>{(rel?.value ?? 0).toFixed(0)}</b>{rel?.alliance ? ' · Allied' : ''}{rel?.trade ? ' · Trade' : ''}{(rel?.nap ?? 0) > g.day ? ' · Non-aggression pact' : ''}{atWar(g, owner.id, g.player) ? ' · AT WAR' : ''}
                <div style={{ marginTop: 6 }}><Btn small onClick={() => store.setUI({ panel: 'diplomacy', selectedNation: owner.id })}>Open diplomacy</Btn></div>
              </div>
            )}
          </>
        )}
        {tab === 'build' && showTabs && <BuildTab p={p} />}
        {tab === 'recruit' && showTabs && <RecruitTab p={p} />}
      </div>
    </div>
  );
}

function NationSummary({ id }: { id: string }) {
  const g = store.game!;
  const n = g.nations[id];
  const isMe = id === g.player;
  const pp = perceivedPower(g, g.player, id);
  const my = perceivedPower(g, g.player, g.player);
  return (
    <Section title={<>{n.name}{n.overlord ? <span className="muted small"> (subject of {g.nations[n.overlord]?.name})</span> : null}</>} icon="flag">
      <div className="grid2">
        <Stat label="Provinces" value={ownedBy(g, id).length} />
        <Stat label="Population" value={num(ownedBy(g, id).reduce((t, p) => t + g.provinces[p].pop, 0))} />
        <Stat label="Output" value={`${money(n.budget.output)} IC`} />
        <Stat label="Treasury" value={isMe ? `${money(n.treasury)} IC` : `~${money(Math.round(n.treasury / 25) * 25)} IC`} tip={isMe ? undefined : 'Estimated by your intelligence services.'} />
        <Stat label="Stability" value={`${n.stability.toFixed(0)}%`} />
        <Stat label="Military" value={isMe ? pp.toFixed(0) : `~${pp.toFixed(0)}`} tip={isMe ? 'Your combat power index.' : `Estimated combat power (your intel is imperfect). Yours: ${my.toFixed(0)}.`} tone={!isMe && pp > my * 1.3 ? 'bad' : undefined} />
        <Stat label="Personality" value={isMe ? '—' : n.personality} />
        <Stat label="Allies" value={alliesOf(g, id).length} />
      </div>
      {!isMe && controlledBy(g, id).length !== ownedBy(g, id).length && <div className="small warn">Part of its territory is under foreign occupation.</div>}
    </Section>
  );
}

function BuildTab({ p }: { p: number }) {
  const g = store.game!;
  const n = g.nations[g.player];
  const st = g.provinces[p];
  const queue = n.construction.filter((c) => c.province === p);
  const kinds: (BuildingKind | 'repair' | 'develop')[] = ['road', 'railway', 'factory', 'farm', 'mine', 'power', 'lab', 'port', 'fort', 'depot', 'develop', 'repair'];
  return (
    <>
      {queue.length > 0 && (
        <Section title="Under construction" icon="hammer">
          {queue.map((c) => (
            <div key={c.id} className="queue-row">
              <span>{c.kind === 'develop' ? 'Development' : c.kind === 'repair' ? 'Repairs' : c.kind === 'integrate' ? 'Integration' : BUILDINGS[c.kind].label}</span>
              <Bar value={1 - c.daysLeft / c.totalDays} />
              <span className="muted">{c.daysLeft}d</span>
            </div>
          ))}
        </Section>
      )}
      <div className="build-list">
        {kinds.map((k) => {
          const c = buildCost(g, n, p, k);
          const label = k === 'develop' ? 'Economic development' : k === 'repair' ? 'Repair war damage' : BUILDINGS[k].label;
          const lvl = k === 'develop' || k === 'repair' ? null : st.buildings[k];
          if (k === 'repair' && st.damage < 0.02) return null;
          const afford = n.treasury >= c.cost;
          return (
            <div key={k} className={`build-item${!c.ok ? ' dis' : ''}`}>
              <div className="bi-top">
                <b>{label}{lvl != null ? <span className="muted"> · level {lvl}/{BUILDINGS[k as BuildingKind].max}</span> : null}</b>
                <Btn small kind="primary" disabled={!c.ok || !afford} title={c.reason ?? (!afford ? 'Insufficient funds' : '')} onClick={() => { const r = store.act((s) => build(s, p, k)); if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); if (r.ok) audio.sfx('coins'); } }}>Build</Btn>
              </div>
              <div className="bi-cost"><span><Icon name="coin" size={12} color="#e8c36a" /> {moneyIC(c.cost)}</span><span>⏱ {c.days} days</span>{c.upkeep > 0 && <span>upkeep {money(c.upkeep, { digits: 2 })}/yr</span>}{(() => { const r = c.ok ? yearlyReturn(g, n, p, k) : null; return r == null ? null : <span className={r > 0 && c.cost / r <= 30 ? 'good' : 'muted'} title="Estimated change in your yearly budget once built: extra taxes (and food exports for estates) minus upkeep.">{r > 0 && c.cost / r <= 30 ? `≈ +${money(r, { digits: 2 })}/yr · pays back in ~${Math.ceil(c.cost / r)} yr` : `≈ ${money(r, { digits: 2, sign: true })}/yr · built for its other effects, not profit`}</span>; })()}</div>
              <div className="bi-desc">{c.reason ? <span className="warn">{c.reason}</span> : c.effect}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function RecruitTab({ p }: { p: number }) {
  const g = store.game!;
  const n = g.nations[g.player];
  const types = Object.keys(UNITS) as UnitType[];
  const training = n.training.filter((t) => t.province === p);
  return (
    <>
      <p className="small muted">Recruitment fees are paid now. Equipment is drawn from your stockpile when training ends — keep factories producing it (Economy → Production), or the unit deploys under-equipped.</p>
      {training.length > 0 && (
        <Section title="Training here" icon="manpower">
          {training.map((t) => <div key={t.id} className="queue-row"><span>{UNITS[t.type].label}</span><Bar value={1 - t.daysLeft / t.totalDays} /><span className="muted">{t.daysLeft}d</span></div>)}
        </Section>
      )}
      <div className="build-list">
        {types.map((t) => {
          const c = checkRecruit(g, n, t, p);
          const sp = UNITS[t];
          const eq = Object.entries(sp.equip).map(([k, v]) => `${k} ${v}`).join(', ');
          const stockOk = Object.entries(sp.equip).every(([k, v]) => n.stockpile[k as keyof typeof n.stockpile] >= (v ?? 0));
          return (
            <div key={t} className={`build-item${!c.ok ? ' dis' : ''}`}>
              <div className="bi-top">
                <b>{sp.label}</b>
                <Btn small kind="primary" disabled={!c.ok} title={c.reason} onClick={() => { const r = store.act((s) => doRecruit(s, t, p)); if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); if (r.ok) audio.sfx('coins'); } }}>Recruit</Btn>
              </div>
              <div className="bi-cost">
                <span><Icon name="coin" size={12} color="#e8c36a" /> {moneyIC(c.cost, { digits: 2 })}</span>
                <span><Icon name="manpower" size={12} /> {num(sp.personnel)}</span>
                <span>⏱ {sp.trainDays}d</span>
                <span>upkeep {money(c.upkeep, { digits: 2 })}/yr</span>
                <span className={n.budget.net - c.upkeep < 0 ? 'bad' : 'muted'}>net after: {money(n.budget.net - c.upkeep, { sign: true })}/yr</span>
              </div>
              <div className="bi-desc">{sp.desc} <span className={stockOk ? 'good' : 'warn'}>Needs equipment: {eq} M IC{stockOk ? ' (in stock)' : ' (not yet in stock)'}</span>{c.reason && <><br /><span className="warn">{c.reason}</span></>}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Estimated yearly budget effect of a project: tax on extra output (+ food exports) minus upkeep. */
function yearlyReturn(g: GameState, n: Nation, p: number, k: BuildingKind | 'repair' | 'develop'): number | null {
  const st = g.provinces[p];
  let next: ProvinceState;
  if (k === 'develop') next = { ...st, dev: st.dev * 1.04 };
  else if (k === 'repair') next = { ...st, damage: 0 };
  else next = { ...st, buildings: { ...st.buildings, [k]: st.buildings[k] + 1 } };
  const dOut = provinceOutput(g, next, n) - provinceOutput(g, st, n);
  let r = dOut * n.taxRate * collectionEfficiency(n) * (ECON.STATUS_TAX[st.status] ?? 1);
  if (k === 'farm' && n.resourceNet.food >= 0) r += (resourceYield(next, 'food') - resourceYield(st, 'food')) * g.market.food.price * 0.8;
  if (k !== 'develop' && k !== 'repair') r -= BUILDINGS[k].upkeep * n.priceIndex;
  return Math.abs(r) < 0.005 ? null : r;
}
