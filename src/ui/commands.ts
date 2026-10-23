// Map command routing (right-click orders) shared by the map and panels.
import { store } from './store';
import { PROV, WORLD, isCoastal } from '../engine/geo';
import { armiesIn, atWar, isFriendly } from '../engine/world';
import { findPath } from '../engine/military';
import { moveArmy, seaMove, doMoveFleet } from '../engine/actions';
import { checkSeaMove } from '../engine/naval';
import { checkStrike } from '../engine/strikes';
import { NUKE } from '../engine/config';
import { moneyIC } from './format';
import { audio } from '../audio/music';

export function focusProvince(p: number) {
  window.dispatchEvent(new CustomEvent('wc-focus', { detail: p }));
}

/** Strike mode: fire at the clicked province (nuclear use asks for confirmation first). */
export function strikeAt(p: number) {
  const g = store.game;
  const st = store.ui.strike;
  if (!g || !st) return;
  const n = g.nations[g.player];
  const err = checkStrike(g, n, st.kind, p, st.kind === 'nuke' ? 1 : Math.min(st.count, Math.max(1, n.arsenal[st.kind])));
  if (err) { store.toast(err, 'bad'); return; }
  if (st.kind === 'nuke') {
    store.setUI({
      confirm: {
        title: '☢ Launch a nuclear weapon?', danger: true,
        body: `Target: ${PROV[p].name} (${g.nations[g.provinces[p].controller]?.name}).\n\nThis kills ~85% of every army there, a third of the population, and wrecks the province for decades.\n\nTHE PRICE:\n• Every nation on Earth cuts trade with you for ${NUKE.embargoDays / 365} years: no trade income, no exports or imports, no treaties, −12% of your output to the embargo.\n• All alliances are void; relations with everyone collapse (−80).\n• Every nation gets a casus belli against you; expect new wars.\n• Your infamy hits 100, stability −25, war support −25.\n• Any nuclear-armed enemy will retaliate immediately on your army or capital.\n\nThere is no undo.`,
        onOk: () => { const r = store.cmd('doStrike', ['nuke', p, 1]); if (r) store.toast(r.message, r.ok ? 'war' : 'bad'); store.setUI({ strike: null }); audio.sfx('alarm'); },
      },
    });
    return;
  }
  const count = Math.min(st.count, n.arsenal[st.kind]);
  const r = store.cmd('doStrike', [st.kind, p, count]);
  if (r) { store.toast(r.message, r.ok ? 'good' : 'bad'); if (r.ok) audio.sfx('battle'); }
  if (n.arsenal[st.kind] <= 0) store.setUI({ strike: null });
}

export function onMapRightClick(p: number | null, sea: number | null, queue = false) {
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
  if (queue && a.path.length) {
    const r = store.cmd('queueMove', [a.id, p]);
    if (r) store.toast(r.message, r.ok ? 'info' : 'bad');
    return;
  }
  const group = ui.group.filter((id) => g.armies[id]?.owner === g.player && id !== a.id);
  if (group.length) {
    const r = store.cmd('moveArmies', [[a.id, ...group], p]);
    if (r) { store.toast(r.message, r.ok ? 'info' : 'bad'); if (r.ok) audio.sfx('click'); }
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
