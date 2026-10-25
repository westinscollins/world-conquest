// Map command routing (right-click orders) shared by the map and panels.
import { store } from './store';
import { PROV, WORLD, isCoastal, seaRoute, distKm } from '../engine/geo';
import { armiesIn, atWar, isFriendly } from '../engine/world';
import { findPath, armyStrength } from '../engine/military';
import { invasionPlan, nationTransportCapacity, seaControl, transportFee } from '../engine/naval';
import { wingsOf } from '../engine/air';
import { checkStrike } from '../engine/strikes';
import { NUKE, AIR, MIL, COMBAT } from '../engine/config';
import { audio } from '../audio/music';
import { money } from './format';

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
  // air wings: rebase to your province, bomb an enemy province, strike ships in a sea zone
  const w = ui.selectedWing != null ? g.airWings?.[ui.selectedWing] : undefined;
  if (w && w.owner === g.player) {
    const say = (r: { ok: boolean; message: string } | undefined) => { if (r) { store.toast(r.message, r.ok ? 'info' : 'bad'); if (r.ok) audio.sfx('click'); } };
    if (sea != null) { say(store.cmd('doWingMission', [w.id, 'naval', sea])); return; }
    if (p == null) return;
    const ctrl = g.provinces[p].controller;
    if (ctrl === g.player) { say(store.cmd('doRebaseWing', [w.id, p])); return; }
    if (atWar(g, ctrl, g.player) || armiesIn(g, p).some((x) => atWar(g, x.owner, g.player))) { say(store.cmd('doWingMission', [w.id, 'bombing', p])); return; }
    store.toast(`${PROV[p].name}: air wings can only be based in provinces you hold, and bomb provinces of enemies you are at war with.`, 'bad');
    return;
  }
  // fleets: right-click a sea zone, or any coastal province, to sail there
  const f = ui.selectedFleet != null ? g.fleets[ui.selectedFleet] : undefined;
  if (f && f.owner === g.player && (sea != null || p != null)) {
    const zone = sea ?? (p != null && PROV[p].seas.length ? PROV[p].seas.slice().sort((a, b) => (seaRoute([f.sea], [a])?.length ?? 99) - (seaRoute([f.sea], [b])?.length ?? 99))[0] : null);
    if (zone == null) { store.toast(`${PROV[p!].name} is inland: ships can only sail to the sea. Right-click a coastal province or a sea zone.`, 'bad'); return; }
    const r = store.cmd('doMoveFleet', [f.id, zone]);
    if (r) { store.toast(r.ok ? `${r.message} Destination: ${WORLD.seas[zone].name}.` : r.message, r.ok ? 'info' : 'bad'); if (r.ok) audio.sfx('click'); }
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
  // overseas: one order — march to the best port, sail together, land
  const all = [a, ...group.map((id) => g.armies[id])].filter((x) => !x.battleId && !x.embarked);
  if (isCoastal(p) && all.length && all.some((x) => !findPath(g, x, p))) { confirmInvasion(all.map((x) => x.id), p); return; }
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
  store.toast(`No route to ${PROV[p].name}.`, 'bad');
}

/** Naval invasion: show what the landing will face, then order it (armies with a land route march there). */
function confirmInvasion(ids: number[], p: number) {
  const g = store.game!;
  const armies = ids.map((id) => g.armies[id]).filter((x) => !findPath(g, x, p)); // (the ones that must sail)
  const overland = ids.length - armies.length;
  const plan = invasionPlan(g, armies, p);
  if (!plan) { store.toast(`No route to ${PROV[p].name}: none of your ports with a sea route to it can be reached by ${armies.length > 1 ? 'all of these armies' : 'this army'}.`, 'bad'); return; }
  const n = g.nations[g.player];
  const tc = nationTransportCapacity(g, n);
  const brigades = armies.reduce((t, x) => t + x.units.length, 0);
  const soldiers = armies.reduce((t, x) => t + armyStrength(x), 0);
  const fee = transportFee(n, brigades, plan.seaDays / MIL.TRANSPORT_DAYS_PER_ZONE);
  const defenders = armiesIn(g, p).filter((x) => atWar(g, x.owner, g.player)).reduce((t, x) => t + armyStrength(x), 0);
  const sea = PROV[p].seas.map((z) => ({ z, c: seaControl(g, g.player, z) }));
  // the landing penalty as the battle will apply it (sea control of the best landing waters, amphibious tech)
  const ctl = Math.max(0, ...sea.map(({ c }) => (c.own > 0 ? c.own / (c.own + c.hostile) : 0)));
  const base = COMBAT.AMPHIBIOUS_PENALTY + 0.3 * ctl;
  const penalty = Math.round((1 - (base + (1 - base) * n.techMods.amphibious)) * 100);
  const held = ctl >= 0.5;
  const contested = sea.filter(({ c }) => c.hostile > c.own);
  const wings = wingsOf(g, g.player).filter((w) => w.mission === 'support' && w.units.some((u) => distKm(w.base, p) <= AIR.RANGE[u.type]));
  // the landing waters, and the warships that could go there first
  const route = seaRoute(PROV[plan.port].seas, PROV[p].seas) ?? PROV[p].seas;
  const zone = route[route.length - 1];
  const navy = Object.values(g.fleets).filter((f) => f.owner === g.player && f.sea !== zone && f.ships.destroyer + f.ships.cruiser + f.ships.battlegroup + (f.ships.submarine ?? 0) >= 0.5);
  const invade = () => { const r = store.cmd('moveArmies', [ids, p]); if (r) { store.toast(r.message, r.ok ? 'info' : 'bad'); if (r.ok) audio.sfx('click'); } };
  const lines = [
    `${armies.length === 1 ? armies[0].name : `${armies.length} armies`}: ${brigades} brigades, ${Math.round(soldiers / 1000)}k soldiers.${overland ? ` (${overland} more ${overland === 1 ? 'army has' : 'armies have'} a land route and march${overland === 1 ? 'es' : ''} there directly.)` : ''}`,
    plan.port === armies[0].location && armies.every((x) => x.location === plan.port) ? `They board at ${PROV[plan.port].name} and land in ~${Math.ceil(plan.seaDays)} days.` : `They march to ${PROV[plan.port].name}, sail together and land in ~${Math.ceil(plan.sailIn + plan.seaDays)} days.`,
    `Transport: ${Math.max(0, tc.cap - tc.used)} of ${tc.cap} brigades free${brigades > tc.cap - tc.used ? ' — NOT ENOUGH: send fewer armies or build Transport Flotillas' : ''}. Shipping costs ${money(fee, { digits: 1 })}.`,
    defenders ? `Defenders in ${PROV[p].name}: ~${Math.round(defenders / 1000)}k soldiers.` : `${PROV[p].name} is undefended right now.`,
    held ? `✓ Your fleets hold the landing waters: naval gunfire support, more troops ashore at once, landing penalty only −${penalty}%.` : contested.length ? `⚠ Enemy fleets hold the ${WORLD.seas[contested[0].z].name}: expect losses at sea and a −${penalty}% landing penalty. Send your navy first.` : `⚠ No fleet of yours covers the landing waters: −${penalty}% landing penalty and no naval gunfire. Send your navy first.`,
    wings.length ? `✓ ${wings.length} air wing${wings.length > 1 ? 's' : ''} on ground support can reach ${PROV[p].name}.` : `⚠ No air wing on ground support can reach ${PROV[p].name}: rebase wings near ${PROV[plan.port].name} and set them to "Support ground forces".`,
  ];
  store.setUI({
    confirm: {
      title: `Naval invasion of ${PROV[p].name}`,
      body: lines.join('\n'),
      okLabel: 'Invade',
      onOk: invade,
      alt: !held && navy.length ? {
        label: `Send the navy (${navy.length} fleet${navy.length > 1 ? 's' : ''}), then invade`,
        onOk: () => {
          const sent = navy.filter((f) => store.cmd('doMoveFleet', [f.id, zone])?.ok).length;
          if (sent) store.toast(`${sent} fleet${sent > 1 ? 's' : ''} sailing to the ${WORLD.seas[zone].name} to cover the landing.`, 'info');
          invade();
        },
      } : undefined,
    },
  });
}
