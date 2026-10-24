import { useState } from 'react';
import { store, useStore } from './store';
import { PROV, COUNTRY_GEO } from '../engine/geo';
import { BUILDINGS, TERRAIN, WEATHER, UNITS, ECON, FOCUS, FOCUS_CHANGE_COST } from '../engine/config';
import { provinceOutput, buildCost, resourceYield, collectionEfficiency } from '../engine/economy';
import type { GameState, Nation, ProvinceState } from '../engine/types';
import { provinceWeather } from '../engine/weather';
import { armiesIn, peekRel, atWar, ownedBy, controlledBy, alliesOf, isAtWar } from '../engine/world';
import { supplyMap } from '../engine/supply';
import { build, doProvinceStatus, doRecruit, doRelease } from '../engine/actions';
import { checkRecruit, armyStrength, militaryStrength, industryBonus } from '../engine/military';
import type { BuildingKind, UnitType, ProvinceFocus } from '../engine/types';
import { Section, Btn, Tip, Stat, Bar, Tabs } from './common';
import { Icon } from './icons';
import { money, moneyIC, num, pct } from './format';
import { audio } from '../audio/music';
import { checkStrike } from '../engine/strikes';

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
  const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');

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
            {atWar(g, g.player, st.controller) && <WarActions p={p} />}
            {st.owner === g.player && (
              <div className="war-actions calm">
                {st.controller === g.player && st.status === 'core' && <span className={st.resistance >= 70 ? 'bad small' : 'small'}>Unrest {Math.round(st.resistance)}{st.resistance >= 70 ? ' — IN REVOLT' : ''}</span>}
                {st.controller === g.player && <Btn small kind={st.martialLaw ? 'danger' : undefined} title="Troops rule the streets: unrest falls fast, output −30%, stability −1/month" onClick={() => say(store.cmd('doMartialLaw', [p]))}>{st.martialLaw ? 'Lift martial law' : 'Martial law'}</Btn>}
                {st.controller === g.player && isAtWar(g, g.player) && <Btn small kind="danger" title="Destroy half of every building so an invader gains nothing; the enemy gets little supply here for a year" onClick={() => store.setUI({ confirm: { title: `Scorched earth in ${PROV[p].name}?`, danger: true, body: 'Half of every building (rail, depots, factories, power…) is destroyed and war damage +40%. An enemy occupying it will barely be supplied for a year. Your own people suffer: stability −3, workers −5.', onOk: () => say(store.cmd('doScorched', [p])) } })}>Scorched earth</Btn>}
                {st.controller !== g.player && atWar(g, g.player, st.controller) && <Btn small kind="primary" title="Partisans harass the occupier for 120 days: their armies here lose men and organisation, their supply −30%" onClick={() => say(store.cmd('doPartisans', [p]))}>Fund partisans ({money(3 * player.priceIndex)}){(st.partisansUntil ?? 0) > g.day ? ` · ${st.partisansUntil! - g.day}d left` : ''}</Btn>}
              </div>
            )}
            {mine && st.controller === g.player && st.status === 'core' && (
              <Section title="Regional focus" icon="map" right={<span className="small muted">change costs {money(FOCUS_CHANGE_COST * player.priceIndex)}</span>}>
                <div className="focus-row">
                  <button className={`posture${!st.focus ? ' on' : ''}`} onClick={() => st.focus && say(store.cmd('doSetFocus', [p, null]))}>None</button>
                  {(Object.keys(FOCUS) as ProvinceFocus[]).map((f) => <button key={f} title={FOCUS[f].desc} className={`posture${st.focus === f ? ' on' : ''}`} onClick={() => st.focus !== f && say(store.cmd('doSetFocus', [p, f]))}>{FOCUS[f].label}</button>)}
                </div>
                <p className="small muted">{st.focus ? FOCUS[st.focus].desc : 'Give this region a specialisation.'}</p>
              </Section>
            )}
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
                  {(st.status === 'occupied' || st.status === 'autonomous') && (() => { const c = buildCost(g, player, p, 'integrate'); return <Btn kind="primary" disabled={!c.ok || player.treasury < c.cost} onClick={() => store.setUI({ confirm: { title: `Integrate ${geo.name}?`, body: `Cost: ${moneyIC(c.cost)} · Time: ${c.days} days.\nThe province becomes core: full output, taxes and recruitment. Resistance falls.`, onOk: () => { const r = store.cmd('build', [p, 'integrate']); r && store.toast(r.message, r.ok ? 'good' : 'bad'); } } })}>Integrate ({moneyIC(c.cost)}, {c.days}d)</Btn>; })()}
                  {st.status === 'occupied' && <Btn onClick={() => { const r = store.cmd('doProvinceStatus', [p, 'autonomous']); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Grant autonomy</Btn>}
                  {st.status === 'autonomous' && <Btn onClick={() => { const r = store.cmd('doProvinceStatus', [p, 'occupied']); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>Direct rule</Btn>}
                  {st.formerOwner !== g.player && <Btn kind="ghost" onClick={() => store.setUI({ confirm: { title: `Release ${g.nations[st.formerOwner]?.name ?? st.formerOwner}?`, body: `All non-core provinces you hold that belonged to ${g.nations[st.formerOwner]?.name} are returned and it becomes your subject state (pays 15% tribute, follows you in wars). Reduces infamy. This is irreversible except by later annexation.`, danger: true, onOk: () => { const r = store.cmd('doRelease', [st.formerOwner]); r && store.toast(r.message, r.ok ? 'good' : 'bad'); } } })}>Release as subject</Btn>}
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
  const pp = militaryStrength(g, id);
  const my = militaryStrength(g, g.player);
  return (
    <Section title={<>{n.name}{n.overlord ? <span className="muted small"> (subject of {g.nations[n.overlord]?.name})</span> : null}</>} icon="flag">
      <div className="grid2">
        <Stat label="Provinces" value={ownedBy(g, id).length} />
        <Stat label="Population" value={num(ownedBy(g, id).reduce((t, p) => t + g.provinces[p].pop, 0))} />
        <Stat label="Output" value={`${money(n.budget.output)} IC`} />
        <Stat label="Treasury" value={isMe ? `${money(n.treasury)} IC` : `~${money(Math.round(n.treasury / 25) * 25)} IC`} tip={isMe ? undefined : 'Estimated by your intelligence services.'} />
        <Stat label="Stability" value={`${n.stability.toFixed(0)}%`} />
        <Stat label="Military strength" value={pp.toLocaleString()} tip={`Military strength: fixed points per formation (infantry 10, mechanized 18, armored 30, artillery 12, air 25…) and warship, including units still in training. It only changes when forces are raised, disbanded or destroyed.${isMe ? '' : ` Yours: ${my.toLocaleString()}.`}`} tone={!isMe && pp > my * 1.3 ? 'bad' : undefined} />
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
                <Btn small kind="primary" disabled={!c.ok || !afford} title={c.reason ?? (!afford ? 'Insufficient funds' : '')} onClick={() => { const r = store.cmd('build', [p, k]); if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); if (r.ok) audio.sfx('coins'); } }}>Build</Btn>
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
  const all = Object.keys(UNITS) as UnitType[];
  const types = [...all.filter((t) => t !== 'air' && t !== 'bomber'), ...all.filter((t) => t === 'air' || t === 'bomber')];
  const training = n.training.filter((t) => t.province === p);
  return (
    <>
      <p className="small muted">One price covers training and full equipment. The unit appears here, ready to fight, when training ends. {industryBonus(n).discount > 0 ? `Your ${Math.round(n.lastFactories)} factories make units ${Math.round(industryBonus(n).discount * 100)}% cheaper and ${Math.round(industryBonus(n).speed * 100)}% faster to train.` : 'Build factories to make units cheaper and faster to train.'}</p>
      {training.length > 0 && (
        <Section title="Training here" icon="manpower">
          {training.map((t) => <div key={t.id} className="queue-row"><span>{UNITS[t.type].label}</span><Bar value={1 - t.daysLeft / t.totalDays} /><span className="muted">{t.daysLeft}d</span></div>)}
        </Section>
      )}
      <div className="build-list">
        {types.map((t) => {
          const c = checkRecruit(g, n, t, p);
          const sp = UNITS[t];
          return (
            <div key={t} className={`build-item${!c.ok ? ' dis' : ''}`}>
              {t === 'air' && <h4 className="sp-h">Aircraft — they form an air wing based here</h4>}
              <div className="bi-top">
                <b>{sp.label}</b>
                <Btn small kind="primary" disabled={!c.ok} title={c.reason} onClick={() => { const r = store.cmd('doRecruit', [t, p]); if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); if (r.ok) audio.sfx('coins'); } }}>Recruit</Btn>
              </div>
              <div className="bi-cost">
                <span><Icon name="coin" size={12} color="#e8c36a" /> {moneyIC(c.cost, { digits: 2 })}</span>
                <span><Icon name="manpower" size={12} /> {num(sp.personnel)}</span>
                <span>⏱ {c.days}d</span>
                <span title="Military strength points this unit adds">+{sp.points} strength</span>
                <span>upkeep {money(c.upkeep, { digits: 2 })}/yr</span>
                <span className={n.budget.net - c.upkeep < 0 ? 'bad' : 'muted'}>net after: {money(n.budget.net - c.upkeep, { sign: true })}/yr</span>
              </div>
              <div className="bi-desc">{sp.desc}{c.reason && <><br /><span className="warn">{c.reason}</span></>}</div>
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

/** Quick war orders against an enemy province. */
function WarActions({ p }: { p: number }) {
  const g = store.game!;
  const n = g.nations[g.player];
  const near = Object.values(g.armies).filter((a) => a.owner === g.player && a.battleId == null && !a.embarked && (PROV[p].neighbors.includes(a.location) || PROV[p].straits.includes(a.location)));
  const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'good' : 'bad');
  const strike = (kind: 'drone' | 'missile', c: number) => { const e = checkStrike(g, n, kind, p, c); if (e) { store.toast(e, 'bad'); return; } say(store.cmd('doStrike', [kind, p, c])); audio.sfx('battle'); };
  return (
    <div className="war-actions">
      <Btn small kind="primary" disabled={!near.length} title={near.length ? near.map((a) => a.name).join(', ') : 'None of your armies are next to this province'} onClick={() => say(store.cmd('attackWithAll', [p]))}>⚔ Attack with all nearby armies ({near.length})</Btn>
      <Btn small disabled={n.arsenal.drone < 1} title={`${n.arsenal.drone} drones in stock`} onClick={() => strike('drone', Math.min(5, n.arsenal.drone))}>Drone strike ×{Math.min(5, n.arsenal.drone)}</Btn>
      <Btn small disabled={n.arsenal.missile < 1} title={`${n.arsenal.missile} missiles in stock`} onClick={() => strike('missile', Math.min(3, n.arsenal.missile))}>Missile strike ×{Math.min(3, n.arsenal.missile)}</Btn>
      {n.arsenal.drone + n.arsenal.missile < 1 && <span className="small muted">Buy drones and missiles in the War Room.</span>}
    </div>
  );
}
