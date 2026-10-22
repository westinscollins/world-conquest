// UI store: owns the live GameState, the clock, selection and transient UI state.
// The simulation mutates state in place; components subscribe to a version counter.
import { useSyncExternalStore } from 'react';
import type { GameState } from '../engine/types';
import { tick } from '../engine/sim';
import { SPEEDS } from '../engine/config';
import { refreshAllBudgets } from '../engine/setup';
import { invalidateArmies, invalidateTerritory, invalidateDiplo } from '../engine/world';
import { resetSupplyCache } from '../engine/supply';
import { saveGame } from './storage';
import { audio } from '../audio/music';

export type MapMode = 'political' | 'terrain' | 'resources' | 'infrastructure' | 'supply' | 'military' | 'diplomacy';
export type Panel = null | 'economy' | 'military' | 'diplomacy' | 'research' | 'stats' | 'help';

export interface UIState {
  screen: 'menu' | 'game';
  speed: number;            // index into SPEEDS
  selectedProvince: number | null;
  selectedArmy: number | null;
  selectedFleet: number | null;
  selectedNation: string | null;
  panel: Panel;
  mapMode: MapMode;
  battleReport: number | null;
  intel: null | { armyId: number; province: number };
  moveMode: number | null; // army id awaiting a left-click destination
  toasts: { id: number; text: string; kind: 'info' | 'good' | 'bad' | 'war' }[];
  confirm: null | { title: string; body: string; danger?: boolean; onOk: () => void };
  peaceWar: number | null;
  lastAutosave: number;
  hover: null | { province: number; x: number; y: number };
}

class Store {
  game: GameState | null = null;
  ui: UIState = {
    screen: 'menu', speed: 0, selectedProvince: null, selectedArmy: null, selectedFleet: null, selectedNation: null,
    panel: null, mapMode: 'political', battleReport: null, intel: null, moveMode: null, toasts: [], confirm: null, peaceWar: null, lastAutosave: 0, hover: null,
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

  start(g: GameState) {
    this.game = g;
    invalidateTerritory(); invalidateArmies(); invalidateDiplo(); resetSupplyCache();
    refreshAllBudgets(g);
    this.ui = { ...this.ui, screen: 'game', speed: 0, selectedProvince: g.nations[g.player].capital, selectedArmy: null, selectedNation: null, panel: g.tutorial ? 'help' : null, lastAutosave: g.day, battleReport: null, intel: null };
    this.emit();
    this.loop();
    audio.setMood(this.moodFor());
  }
  quitToMenu() {
    cancelAnimationFrame(this.raf);
    this.game = null;
    this.ui = { ...this.ui, screen: 'menu', speed: 0, panel: null };
    this.emit();
    audio.setMood('menu');
  }

  setSpeed(i: number) { this.ui = { ...this.ui, speed: i }; this.emit(); }
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

  moodFor(): 'peace' | 'war' {
    const g = this.game;
    if (!g) return 'peace';
    return g.wars.some((w) => w.attackers.includes(g.player) || w.defenders.includes(g.player)) ? 'war' : 'peace';
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    this.lastT = performance.now();
    const step = (t: number) => {
      const dt = Math.min(0.25, (t - this.lastT) / 1000);
      this.lastT = t;
      const g = this.game;
      if (g && this.ui.speed > 0 && !this.ui.confirm && !g.outcome) {
        this.acc += dt * SPEEDS[this.ui.speed];
        let n = 0;
        const t0 = performance.now();
        while (this.acc >= 1 && n < 8 && performance.now() - t0 < 30) {
          this.acc -= 1;
          tick(g);
          n++;
          this.afterTick(g);
        }
        if (this.acc > 3) this.acc = 3;
        // redraw at most ~10 times per second while time runs: keeps fast speeds smooth
        if (n && t - this.lastEmit > 100) { this.lastEmit = t; this.emit(); }
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };

  private lastMood: string = 'peace';
  private lastEmit = 0;
  private wasDeficit = false;
  private afterTick(g: GameState) {
    // notifications → toasts (+ pause on war declarations against the player)
    if (g.notifications.length) {
      const ids = new Set(g.notifications);
      g.notifications = [];
      for (const e of g.events.filter((x) => ids.has(x.id))) {
        const kind = e.kind === 'war' ? 'war' : e.kind === 'battle' ? (e.text.includes(`${g.nations[g.player].name} victorious`) ? 'good' : e.text.includes('victorious') ? 'bad' : 'info') : e.kind === 'achievement' ? 'good' : 'info';
        this.toast(e.text, kind);
        if (e.kind === 'war' && e.text.includes('declared war on ' + g.nations[g.player].name)) { this.ui = { ...this.ui, speed: 0 }; audio.sfx('alarm'); }
        else if (e.kind === 'battle') audio.sfx('battle');
        else if (e.kind === 'achievement') audio.sfx('fanfare');
      }
    }
    if (g.peaceOffers.some((o) => o.to === g.player && o.day === g.day) || g.proposals.some((p) => p.to === g.player && p.day === g.day && p.kind === 'callToArms')) {
      this.ui = { ...this.ui, speed: 0 };
      audio.sfx('chime');
    }
    const pn = g.nations[g.player];
    if (pn && g.day % 7 === 0) {
      const deficit = pn.budget.net < 0;
      if (deficit && !this.wasDeficit) {
        const top = pn.budget.expenses.slice().sort((a, b) => b.amount - a.amount).slice(0, 2).map((l) => l.label.toLowerCase()).join(' and ');
        this.toast(`Budget deficit: losing ${Math.abs(pn.budget.net).toFixed(1)} M IC a year (largest costs: ${top}). Open Economy for fixes.`, 'bad');
      }
      this.wasDeficit = deficit;
    }
    const mood = this.moodFor();
    if (mood !== this.lastMood) { this.lastMood = mood; audio.setMood(mood); }
    if (g.day - this.ui.lastAutosave >= 30) {
      this.ui = { ...this.ui, lastAutosave: g.day };
      saveGame('autosave', g).catch(() => this.toast('Autosave failed (storage full or unavailable).', 'bad'));
    }
    if (g.outcome) { this.ui = { ...this.ui, speed: 0 }; audio.sfx(g.outcome.won ? 'fanfare' : 'alarm'); }
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
