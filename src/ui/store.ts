// UI store: owns the live GameState, the clock, selection and transient UI state.
// The simulation mutates state in place; components subscribe to a version counter.
import { live } from './live';
import { useSyncExternalStore } from 'react';
import type { GameState } from '../engine/types';
import { money } from './format';
import { tick } from '../engine/sim';
import { SPEEDS } from '../engine/config';
import { refreshAllBudgets } from '../engine/setup';
import { invalidateArmies, invalidateTerritory, invalidateDiplo } from '../engine/world';
import { resetSupplyCache } from '../engine/supply';
import { saveGame } from './storage';
import { audio } from '../audio/music';
import { runCommand, stateHash } from '../engine/commands';
import { Session } from './net/session';
import { every } from './net/clock';
import type { Result } from '../engine/actions';

export type MapMode = 'political' | 'terrain' | 'resources' | 'infrastructure' | 'supply' | 'military' | 'diplomacy' | 'unrest';
export type Panel = null | 'war' | 'regime' | 'economy' | 'military' | 'diplomacy' | 'research' | 'stats' | 'help';

export interface UIState {
  screen: 'menu' | 'game';
  speed: number;            // index into SPEEDS
  selectedProvince: number | null;
  selectedArmy: number | null;
  selectedFleet: number | null;
  selectedWing: number | null;
  selectedNation: string | null;
  panel: Panel;
  mapMode: MapMode;
  battleReport: number | null;
  intel: null | { armyId: number; province: number };
  moveMode: number | null; // army id awaiting a left-click destination
  /** Extra armies selected with shift-click; they move together with the selected army. */
  group: number[];
  /** Strike targeting mode: the next province clicked is hit. */
  strike: null | { kind: 'drone' | 'missile' | 'nuke' | 'ballistic' | 'recon'; count: number };
  /** Waiting for a map click to choose the target of a coordinated operation. */
  pickOperation: boolean;
  toasts: { id: number; text: string; kind: 'info' | 'good' | 'bad' | 'war' }[];
  confirm: null | { title: string; body: string; danger?: boolean; onOk: () => void; okLabel?: string; alt?: { label: string; onOk: () => void } };
  peaceWar: number | null;
  lastAutosave: number;
  hover: null | { province: number; x: number; y: number };
}

class Store {
  game: GameState | null = null;
  /** Online multiplayer session, if any. */
  net: Session | null = null;
  ui: UIState = {
    screen: 'menu', speed: 0, selectedProvince: null, selectedArmy: null, selectedFleet: null, selectedWing: null, selectedNation: null,
    panel: null, mapMode: 'political', battleReport: null, intel: null, moveMode: null, group: [], strike: null, pickOperation: false, toasts: [], confirm: null, peaceWar: null, lastAutosave: 0, hover: null,
  };
  version = 0;
  private listeners = new Set<() => void>();
  private raf = 0;
  private lastT = 0;
  private acc = 0;
  private toastId = 1;

  subscribe = (l: () => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getVersion = () => this.version;
  emit() { this.version++; for (const l of this.listeners) l(); }

  setUI(patch: Partial<UIState>) { this.ui = { ...this.ui, ...patch }; this.emit(); }

  start(g: GameState, opts: { net?: Session } = {}) {
    if (opts.net) this.net = opts.net;
    else if (this.net) { void this.net.close(); this.net = null; }
    const resync = this.net && this.game && this.ui.screen === 'game';
    this.game = g;
    live.reset(g);
    invalidateTerritory(); invalidateArmies(); invalidateDiplo(); resetSupplyCache();
    // guests take the host's state verbatim (recomputing here could make the two copies differ)
    if (this.net?.role !== 'guest') refreshAllBudgets(g);
    if (resync) { this.emit(); return; }
    this.ui = { ...this.ui, screen: 'game', speed: 0, selectedProvince: g.nations[g.player].capital, selectedArmy: null, selectedNation: null, panel: g.tutorial ? 'help' : null, lastAutosave: g.day, battleReport: null, intel: null };
    this.emit();
    this.loop();
    this.lastMood = this.moodFor();
    audio.setMood(this.lastMood);
  }
  quitToMenu() {
    cancelAnimationFrame(this.raf);
    this.bgClock?.(); this.bgClock = null;
    if (this.net) { void this.net.close(); this.net = null; }
    this.game = null;
    this.ui = { ...this.ui, screen: 'menu', speed: 0, panel: null };
    this.emit();
    audio.setMood('menu');
  }

  setSpeed(i: number) {
    if (this.net?.role === 'guest') { this.net.requestSpeed(i); return; } // the host owns the clock
    this.ui = { ...this.ui, speed: i };
    if (this.net?.role === 'host') this.net.hostSpeed(i);
    this.emit();
  }
  /** Show the clock state the host announced (guests). */
  setSpeedDisplay(i: number) { this.ui = { ...this.ui, speed: i }; this.emit(); }

  /**
   * Issue a player order by name. Single player and host: runs at once and returns the result.
   * Guest: sent to the host and executed when it comes back in the shared stream; the result is
   * shown as a message when it arrives (returns undefined).
   */
  cmd(name: string, args: unknown[] = [], done?: (r: Result) => void): Result | undefined {
    const g = this.game;
    if (!g) return undefined;
    if (this.net?.role === 'guest') { this.net.sendCommand(name, args, done); return undefined; }
    if (this.net && !Session.orderFits(args)) { const r = { ok: false, message: 'That order is too long to send to the other players.' }; this.toast(r.message, 'bad'); done?.(r); return r; }
    const r = runCommand(g, g.player, name, args);
    live.update(g); // show strike blasts and captures at once, even while paused
    this.syncMood();
    if (this.net?.role === 'host') this.net.record(['c', this.net.myPeer, g.player, name, args]);
    this.emit();
    done?.(r);
    return r;
  }
  togglePause() { this.setSpeed(this.ui.speed === 0 ? 1 : 0); }

  /** Run a mutation against the game and refresh views. */
  act<T>(fn: (g: GameState) => T): T | undefined {
    if (!this.game) return undefined;
    const r = fn(this.game);
    invalidateArmies();
    refreshAllBudgetsLite(this.game);
    this.emit();
    return r;
  }

  toast(text: string, kind: UIState['toasts'][0]['kind'] = 'info') {
    const id = this.toastId++;
    this.ui = { ...this.ui, toasts: [...this.ui.toasts.slice(-4), { id, text, kind }] };
    this.emit();
    setTimeout(() => { this.ui = { ...this.ui, toasts: this.ui.toasts.filter((t) => t.id !== id) }; this.emit(); }, kind === 'war' ? 7000 : 4500);
  }

  /** Switch the music the moment a war starts or ends: a trumpet call for war, a soft chord for peace. */
  syncMood() {
    const mood = this.moodFor();
    if (mood === this.lastMood) return;
    const was = this.lastMood;
    this.lastMood = mood;
    audio.setMood(mood);
    if (mood === 'war') audio.sfx('warhorn');
    else if (was === 'war') audio.sfx('peace');
  }
  moodFor(): 'peace' | 'war' {
    const g = this.game;
    if (!g) return 'peace';
    return g.wars.some((w) => w.attackers.includes(g.player) || w.defenders.includes(g.player)) ? 'war' : 'peace';
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    this.bgClock?.();
    this.lastT = performance.now();
    const step = (t: number) => { this.frame(t); this.raf = requestAnimationFrame(step); };
    this.raf = requestAnimationFrame(step);
    // a hidden tab gets no animation frames: an online host keeps the shared clock running anyway
    this.bgClock = every(100, () => { if (document.hidden && this.net?.role === 'host') this.frame(performance.now()); });
  };
  private bgClock: (() => void) | null = null;
  private frame(t: number) {
    const dt = Math.max(0, Math.min(0.25, (t - this.lastT) / 1000)); // (frame times and clock ticks can interleave)
    this.lastT = Math.max(this.lastT, t);
    const g = this.game;
    const guest = this.net?.role === 'guest';
    const host = this.net?.role === 'host';
    if (g && !guest && this.ui.speed > 0 && (host || (!this.ui.confirm && !g.outcome))) {
      this.acc += dt * SPEEDS[this.ui.speed];
      let n = 0;
      const t0 = performance.now();
      while (this.acc >= 1 && n < 8 && performance.now() - t0 < 30) {
        this.acc -= 1;
        tick(g);
        n++;
        if (host) this.net!.recordTick(g);
        this.afterTick(g);
      }
      if (this.acc > 3) this.acc = 3;
      // redraw at most ~10 times per second while time runs: keeps fast speeds smooth
      if (n && t - this.lastEmit > 100) { this.lastEmit = t; this.emit(); }
    }
  }

  private lastMood: 'peace' | 'war' = 'peace';
  private lastEmit = 0;
  private wasDeficit = false;
  /** Guest: a day arrived from the host. */
  netTick(g: GameState) {
    this.afterTick(g);
    const t = performance.now();
    if (t - this.lastEmit > 100) { this.lastEmit = t; this.emit(); }
  }
  private afterTick(g: GameState) {
    live.update(g);
    const online = !!this.net;
    // notifications → toasts (+ pause on war declarations against the player)
    if (g.notifications.length) {
      const ids = new Set(g.notifications);
      g.notifications = [];
      for (const e of g.events.filter((x) => ids.has(x.id))) {
        const kind = e.kind === 'war' ? 'war' : e.kind === 'battle' ? (e.text.includes(`${g.nations[g.player].name} victorious`) ? 'good' : e.text.includes('victorious') ? 'bad' : 'info') : e.kind === 'achievement' ? 'good' : 'info';
        this.toast(e.text, kind);
        if (e.kind === 'war' && e.text.includes('declared war on ' + g.nations[g.player].name)) { if (!online) this.ui = { ...this.ui, speed: 0 }; }
        else if (e.kind === 'battle') audio.sfx('battle');
        else if (e.kind === 'achievement') audio.sfx('fanfare');
      }
    }
    // offers no longer pause the game: a chime and the Diplomacy badge announce them
    if (g.peaceOffers.some((o) => o.to === g.player && o.day === g.day) || g.proposals.some((p) => p.to === g.player && p.day === g.day && p.kind === 'callToArms')) audio.sfx('chime');
    const pn = g.nations[g.player];
    if (pn && g.day % 7 === 0) {
      const deficit = pn.budget.net < 0;
      if (deficit && !this.wasDeficit) {
        const top = pn.budget.expenses.slice().sort((a, b) => b.amount - a.amount).slice(0, 2).map((l) => l.label.toLowerCase()).join(' and ');
        this.toast(`Budget deficit: losing ${money(Math.abs(pn.budget.net))} a year (largest costs: ${top}). Open Economy for fixes.`, 'bad');
      }
      this.wasDeficit = deficit;
    }
    this.syncMood();
    if (g.day - this.ui.lastAutosave >= 30) {
      this.ui = { ...this.ui, lastAutosave: g.day };
      saveGame('autosave', g).catch(() => this.toast('Autosave failed (storage full or unavailable).', 'bad'));
    }
    if (g.outcome && !online) { this.ui = { ...this.ui, speed: 0 }; audio.sfx(g.outcome.won ? 'fanfare' : 'alarm'); }
  }
}

function refreshAllBudgetsLite(g: GameState) {
  // only the player's budget needs to reflect an action instantly
  const p = g.nations[g.player];
  if (!p) return;
  refreshPlayer(g);
}
import { aggregate, computeBudget } from '../engine/economy';
function refreshPlayer(g: GameState) {
  const armiesBy = new Map<string, number[]>();
  for (const a of Object.values(g.armies)) if (a.owner === g.player) (armiesBy.get(a.owner) || armiesBy.set(a.owner, []).get(a.owner)!).push(a.id);
  const fleetsBy = new Map<string, number[]>();
  for (const f of Object.values(g.fleets)) if (f.owner === g.player) (fleetsBy.get(f.owner) || fleetsBy.set(f.owner, []).get(f.owner)!).push(f.id);
  const n = g.nations[g.player];
  n.budget = computeBudget(g, n, aggregate(g, n, armiesBy, fleetsBy));
}

export const store = new Store();

/** Create a multiplayer session wired to the store. */
export function createSession(role: 'host' | 'guest', code: string, name: string) {
  const s: Session = new Session(role, code, name, {
    onGame: (g) => store.start(g, { net: s }),
    onTick: (g) => store.netTick(g),
    onSpeed: (i) => (role === 'host' ? store.setSpeed(i) : store.setSpeedDisplay(i)),
    onResult: (r, done) => { if (done) done(r); else if (r.message) store.toast(r.message, r.ok ? 'info' : 'bad'); store.emit(); },
    onChange: () => store.emit(),
    toast: (t, k) => store.toast(t, k),
    getGame: () => store.game,
    getSpeed: () => store.ui.speed,
  });
  return s;
}

export function useStore() {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return { g: store.game, ui: store.ui };
}
export function useGame(): GameState {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.game!;
}

// exposed for automated browser tests and debugging
if (typeof window !== 'undefined') (window as unknown as { __wc: Store }).__wc = store;
/** Test hook: `${day}:${checksum}` of the running game (used by the live multiplayer test). */
if (typeof window !== 'undefined') (window as unknown as { __wcHash: () => string }).__wcHash = () => (store.game ? `${store.game.day}:${stateHash(store.game)}` : '0:');
