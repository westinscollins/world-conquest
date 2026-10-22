import type { GameState, ProvinceStatus, Nation } from './types';
import { PROV, COUNTRY_GEO } from './geo';
import { invalidateDiplo, invalidateTerritory, ownedBy, controlledBy, armiesIn, atWar, warBetween } from './world';
import { addEvent } from './events';
import { infraOf } from './economy';
import { DIPLO } from './config';

/** Military control change (occupation during war). Ownership is unchanged until peace. */
export function setController(s: GameState, p: number, by: string) {
  const st = s.provinces[p];
  const prev = st.controller;
  if (prev === by) return;
  st.controller = by;
  st.capturedDay = s.day;
  st.capturedFrom = prev;
  if (st.owner !== by) {
    st.damage = Math.min(0.9, st.damage + 0.06);
    st.resistance = Math.min(100, Math.max(st.resistance, 25));
  } else {
    // liberated
    st.resistance = Math.max(0, st.resistance - 20);
  }
  invalidateTerritory();
  const war = warBetween(s, by, prev);
  if (war) {
    const byA = war.attackers.includes(by);
    const list = byA ? war.occupiedByA : war.occupiedByD;
    const other = byA ? war.occupiedByD : war.occupiedByA;
    if (st.owner !== by && !list.includes(p)) list.push(p);
    const i = other.indexOf(p);
    if (i >= 0) other.splice(i, 1);
  }
  const nb = s.nations[by], np = s.nations[prev];
  if (nb) nb.stats.provincesCaptured++;
  const g = PROV[p];
  addEvent(s, 'territory', `${nb?.name ?? by} ${st.owner === by ? 'liberated' : 'occupied'} ${g.name}${np ? ` (from ${np.name})` : ''}.`, [by, prev], { province: p, important: g.capital || by === s.player || prev === s.player });
  // capital captured: heavy stability blow, relocate capital
  if (np && np.capital === p && st.owner === prev) {
    np.stability = Math.max(0, np.stability - 15);
    np.warExhaustion = Math.min(100, np.warExhaustion + 15);
    const alt = controlledBy(s, prev).filter((q) => s.provinces[q].owner === prev).sort((a, b) => PROV[b].cityPop - PROV[a].cityPop)[0];
    if (alt != null) {
      np.capital = alt;
      addEvent(s, 'territory', `${np.name}'s government relocates to ${PROV[alt].name}.`, [prev], { province: alt, important: true });
    }
  }
}

/** Permanent transfer of a province (peace treaty, annexation). */
export function transferProvince(s: GameState, p: number, to: string, status: ProvinceStatus = 'occupied') {
  const st = s.provinces[p];
  const from = st.owner;
  st.owner = to;
  st.controller = to;
  st.capturedDay = s.day;
  st.capturedFrom = from;
  // a former core of the new owner becomes core again immediately
  st.status = st.formerOwner === to ? 'core' : status;
  st.integration = st.status === 'core' ? 1 : 0;
  if (st.status !== 'core') st.resistance = Math.max(st.resistance, 35);
  st.infra = infraOf(st);
  const nTo = s.nations[to];
  if (nTo) nTo.infamy = Math.min(100, nTo.infamy + (st.formerOwner === to ? 0 : DIPLO.INFAMY_PER_PROVINCE));
  // cancel constructions of the old owner
  const old = s.nations[from];
  if (old) old.construction = old.construction.filter((c) => c.province !== p);
  invalidateTerritory();
  if (old && old.capital === p) {
    const alt = ownedBy(s, from).sort((a, b) => PROV[b].cityPop - PROV[a].cityPop)[0];
    if (alt != null) old.capital = alt;
  }
  checkNationAlive(s, from);
}

export function checkNationAlive(s: GameState, id: string) {
  const n = s.nations[id];
  if (!n || !n.alive) return;
  if (ownedBy(s, id).length > 0) return;
  n.alive = false;
  // disband remaining forces
  for (const a of Object.values(s.armies)) if (a.owner === id) delete s.armies[a.id];
  for (const f of Object.values(s.fleets)) if (f.owner === id) delete s.fleets[f.id];
  for (const g of Object.values(s.generals)) if (g.owner === id) delete s.generals[g.id];
  // leave wars and alliances
  for (const w of s.wars) { w.attackers = w.attackers.filter((x) => x !== id); w.defenders = w.defenders.filter((x) => x !== id); }
  s.wars = s.wars.filter((w) => w.attackers.length && w.defenders.length);
  for (const k in s.relations) if (k.split('|').includes(id)) { s.relations[k].alliance = false; s.relations[k].trade = false; }
  for (const o of Object.values(s.nations)) if (o.overlord === id) o.overlord = null;
  invalidateDiplo();
  s.stats.annexations++;
  addEvent(s, 'territory', `${n.name} has ceased to exist as an independent state.`, [id], { important: true });
}

/** Player/AI choice for a non-core province. */
export function setProvinceStatus(s: GameState, n: Nation, p: number, status: 'occupied' | 'autonomous'): string | null {
  const st = s.provinces[p];
  if (st.owner !== n.id) return 'Not your province.';
  if (st.status === 'core') return 'Core provinces cannot change status.';
  if (st.status === 'integrating') return 'Cancel the integration first.';
  st.status = status;
  if (status === 'autonomous') st.resistance = Math.max(0, st.resistance - 25);
  return null;
}

/**
 * Release a former nation's homeland as a subject state. Provinces whose formerOwner is `target`
 * and which `n` owns are handed back; the restored nation becomes n's subject.
 */
export function releaseSubject(s: GameState, n: Nation, target: string): string | null {
  const t = s.nations[target];
  if (!t) return 'Unknown nation.';
  const provs = ownedBy(s, n.id).filter((p) => s.provinces[p].formerOwner === target && s.provinces[p].status !== 'core');
  if (!provs.length) return 'You hold none of their former provinces.';
  for (const p of provs) {
    const st = s.provinces[p];
    st.owner = target; st.controller = target; st.status = 'core'; st.resistance = 0; st.integration = 1;
  }
  invalidateTerritory();
  t.alive = true;
  t.overlord = n.id;
  invalidateDiplo();
  if (!provs.includes(t.capital)) t.capital = provs.sort((a, b) => PROV[b].cityPop - PROV[a].cityPop)[0];
  t.treasury = Math.max(t.treasury, 10);
  t.stability = 55;
  n.infamy = Math.max(0, n.infamy - 5 * provs.length);
  n.construction = n.construction.filter((c) => !provs.includes(c.province));
  // armies of n inside those provinces stay (allowed via overlord relationship)
  addEvent(s, 'diplomacy', `${n.name} restored ${t.name} as a subject state (${provs.length} provinces).`, [n.id, target], { important: true });
  return null;
}

/** Monthly unrest: resistance growth, uprisings, defection to the former owner. */
export function resistanceMonthly(s: GameState) {
  for (const st of s.provinces) {
    if (st.status === 'core' && st.controller === st.owner) { st.resistance = Math.max(0, st.resistance - 5); continue; }
    const owner = s.nations[st.owner];
    const garrison = armiesIn(s, st.id).filter((a) => a.owner === st.controller).reduce((t, a) => t + a.units.length, 0);
    let delta = 0;
    if (st.controller !== st.owner) delta += 3; // enemy occupation in war
    if (st.status === 'occupied') delta += 2.5;
    if (st.status === 'integrating') delta += 0.5;
    if (st.status === 'autonomous') delta -= 2;
    delta += owner ? (50 - owner.stability) / 25 : 0;
    delta -= Math.min(6, garrison * 1.5);
    const former = s.nations[st.formerOwner];
    if (former?.alive && st.formerOwner !== st.owner) delta += 1; // irredentism
    st.resistance = Math.max(0, Math.min(100, st.resistance + delta));
    if (st.resistance >= 90 && garrison === 0) {
      st.damage = Math.min(0.9, st.damage + 0.1);
      st.resistance = 60;
      if (former?.alive && former.id !== st.owner && !atWar(s, former.id, st.owner) && st.controller === st.owner) {
        // uprising: province breaks away to its former state
        transferProvince(s, st.id, former.id, 'core');
        addEvent(s, 'unrest', `Uprising in ${PROV[st.id].name}! The province broke away and rejoined ${former.name}.`, [owner?.id ?? '', former.id], { province: st.id, important: true });
      } else {
        addEvent(s, 'unrest', `Uprising in ${PROV[st.id].name}: sabotage and strikes damage the economy. Station a garrison to restore order.`, [st.owner], { province: st.id, important: st.owner === s.player });
      }
    }
  }
}

export const countryName = (id: string) => COUNTRY_GEO[id]?.name ?? id;
