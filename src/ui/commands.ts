// Map command routing (right-click orders) shared by the map and panels.
import { store } from './store';
import { PROV, WORLD, isCoastal } from '../engine/geo';
import { armiesIn, atWar, isFriendly } from '../engine/world';
import { findPath } from '../engine/military';
import { moveArmy, seaMove, doMoveFleet } from '../engine/actions';
import { checkSeaMove } from '../engine/naval';
import { moneyIC } from './format';
import { audio } from '../audio/music';

export function focusProvince(p: number) {
  window.dispatchEvent(new CustomEvent('wc-focus', { detail: p }));
}

export function onMapRightClick(p: number | null, sea: number | null) {
  const g = store.game;
  if (!g) return;
  const ui = store.ui;
  if (ui.selectedFleet != null && sea != null) {
    const r = store.cmd('doMoveFleet', [ui.selectedFleet!, sea]);
    if (r) store.toast(r.ok ? `${r.message} Destination: ${WORLD.seas[sea].name}.` : r.message, r.ok ? 'info' : 'bad');
    return;
  }
  if (ui.selectedArmy == null || p == null) return;
  const a = g.armies[ui.selectedArmy];
  if (!a || a.owner !== g.player) return;
  const ctrl = g.provinces[p].controller;
  if (ctrl !== g.player && !isFriendly(g, g.player, ctrl) && !atWar(g, g.player, ctrl)) {
    store.toast(`${g.nations[ctrl]?.name} is neutral: your armies have no military access. Declare war or ally with them first.`, 'bad');
    return;
  }
  const hostile = armiesIn(g, p).filter((x) => atWar(g, x.owner, g.player));
  const path = findPath(g, a, p);
  if (hostile.length && path) {
    store.setUI({ intel: { armyId: a.id, province: p } });
    return;
  }
  if (path) {
    const r = store.cmd('moveArmy', [a.id, p]);
    if (r) { store.toast(r.message, r.ok ? 'info' : 'bad'); if (r.ok) audio.sfx('click'); }
    return;
  }
  // no land route: offer naval transport
  if (isCoastal(p) && isCoastal(a.location)) {
    const chk = checkSeaMove(g, a, p);
    if (!chk.ok) { store.toast(`No land route. Naval transport unavailable: ${chk.reason}`, 'bad'); return; }
    store.setUI({
      confirm: {
        title: 'Naval transport',
        body: `No land route to ${PROV[p].name}. Embark ${a.name} (${a.units.length} formations) by sea?\n\nRoute: ${chk.route.length} sea zones · ~${chk.days} days\nCost: ${moneyIC(chk.cost)}\n${chk.risk > 0.3 ? `⚠ Enemy fleets dominate part of the route (risk ${Math.round(chk.risk * 100)}%): expect losses at sea.` : 'Route currently safe.'}${hostile.length ? '\n⚠ The landing zone is defended: amphibious assault penalties apply.' : ''}`,
        onOk: () => { const r = store.cmd('seaMove', [a.id, p]); if (r) store.toast(r.message, r.ok ? 'info' : 'bad'); },
      },
    });
    return;
  }
  store.toast(`No route to ${PROV[p].name}.`, 'bad');
}
