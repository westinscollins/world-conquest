// Live war feedback: watches the game day by day (on this computer only, outside the simulation)
// and turns changes into short-lived visuals — casualty numbers rising from battles, provinces
// flashing as they change hands, and a running ticker of the player's war.
import type { GameState } from '../engine/types';
import { PROV } from '../engine/geo';
import { isFriendly } from '../engine/world';

export interface LiveFloat { id: number; province: number; text: string; mine: boolean; amount: number; t: number }
export interface LiveFlash { id: number; province: number; gained: boolean; t: number }
export interface LiveBlast { id: number; province: number; kind: 'drone' | 'missile' | 'nuke'; t: number }
export interface LiveTick { id: number; text: string; kind: 'good' | 'bad'; province: number; t: number }

const FLOAT_MS = 2600, FLASH_MS = 4200, TICK_MS = 12000, BLAST_MS = 3500;

class Live {
  floats: LiveFloat[] = [];
  flashes: LiveFlash[] = [];
  ticker: LiveTick[] = [];
  blasts: LiveBlast[] = [];
  private lastStrike = 0;
  /** Casualties per day for the last 30 days: [day, yours, enemy]. */
  days: [number, number, number][] = [];
  private g: GameState | null = null;
  private ctrl: string[] = [];
  private losses = new Map<number, [number, number]>();
  private nextId = 1;

  reset(g: GameState | null) {
    this.g = g;
    this.floats = []; this.flashes = []; this.ticker = []; this.days = []; this.blasts = [];
    this.lastStrike = g?.strikes?.length ? g.strikes[g.strikes.length - 1].id : 0;
    this.ctrl = g ? g.provinces.map((p) => p.controller) : [];
    this.losses = new Map();
    if (g) for (const id of g.activeBattles) { const b = g.battles[id]; if (b) this.losses.set(id, sides(g, b)); }
  }

  /** Call after every simulated day. */
  update(g: GameState) {
    if (g !== this.g || this.ctrl.length !== g.provinces.length) { this.reset(g); return; }
    const now = performance.now();
    const me = g.player;
    // territory changing hands
    for (let i = 0; i < g.provinces.length; i++) {
      const was = this.ctrl[i], is = g.provinces[i].controller;
      if (was === is) continue;
      this.ctrl[i] = is;
      if (was !== me && is !== me) continue;
      const gained = is === me;
      const other = g.nations[gained ? was : is]?.name ?? 'the enemy';
      this.flashes.push({ id: this.nextId++, province: i, gained, t: now });
      this.ticker.push({ id: this.nextId++, province: i, t: now, kind: gained ? 'good' : 'bad', text: gained ? `Captured ${PROV[i].name} from ${other}` : `Lost ${PROV[i].name} to ${other}` });
    }
    // casualties in battles the player (or an ally) is fighting
    let mineToday = 0, enemyToday = 0;
    const seen = new Set<number>();
    for (const id of g.activeBattles) {
      const b = g.battles[id];
      if (!b) continue;
      seen.add(id);
      const cur = sides(g, b);
      const prev = this.losses.get(id) ?? [0, 0];
      this.losses.set(id, cur);
      const ours = b.attacker.nation === me ? 'a' : b.defender.nation === me ? 'd' : isFriendly(g, me, b.defender.nation) ? 'd' : isFriendly(g, me, b.attacker.nation) ? 'a' : null;
      if (!ours) continue;
      const dA = cur[0] - prev[0], dD = cur[1] - prev[1];
      const mine = ours === 'a' ? dA : dD, theirs = ours === 'a' ? dD : dA;
      if (b.attacker.nation === me || b.defender.nation === me) { mineToday += mine; enemyToday += theirs; }
      this.float(b.province, mine, true, now);
      this.float(b.province, theirs, false, now);
    }
    for (const id of [...this.losses.keys()]) if (!seen.has(id)) this.losses.delete(id);
    // strikes since the last day
    for (const r of g.strikes ?? []) {
      if (r.id <= this.lastStrike) continue;
      this.lastStrike = r.id;
      this.blasts.push({ id: this.nextId++, province: r.province, kind: r.kind, t: now });
      const mineHit = r.target === me, mineFired = r.by === me;
      if (!mineHit && !mineFired) continue;
      this.float(r.province, r.killed, mineHit, now);
      if (mineHit) mineToday += r.killed; else enemyToday += r.killed;
      const what = r.kind === 'nuke' ? 'Nuclear strike' : `${r.count} ${r.kind === 'drone' ? 'drone' : 'missile'}${r.count > 1 ? 's' : ''}`;
      this.ticker.push({ id: this.nextId++, province: r.province, t: now, kind: mineFired ? 'good' : 'bad', text: `${r.kind === 'nuke' ? '☢ ' : ''}${what} ${mineFired ? 'hit' : 'struck'} ${PROV[r.province].name}${mineHit ? '!' : ''} −${Math.round(r.killed).toLocaleString()}` });
    }
    if (mineToday || enemyToday) {
      const last = this.days[this.days.length - 1];
      if (last && last[0] === g.day) { last[1] += mineToday; last[2] += enemyToday; } else this.days.push([g.day, mineToday, enemyToday]);
      while (this.days.length && this.days[0][0] < g.day - 30) this.days.shift();
    }
    this.prune(now);
  }

  /** Casualties over the last `n` days: [yours, enemy]. */
  recent(g: GameState, n: number): [number, number] {
    let a = 0, b = 0;
    for (const d of this.days) if (d[0] > g.day - n) { a += d[1]; b += d[2]; }
    return [a, b];
  }

  private float(province: number, amount: number, mine: boolean, now: number) {
    if (amount < 1) return;
    // merge into a number that is still rising so fast speeds don't stack dozens of labels
    const f = this.floats.find((x) => x.province === province && x.mine === mine && now - x.t < 700);
    if (f) { f.amount += amount; f.text = `−${Math.round(f.amount).toLocaleString()}`; return; }
    this.floats.push({ id: this.nextId++, province, mine, amount, text: `−${Math.round(amount).toLocaleString()}`, t: now });
  }
  private prune(now: number) {
    this.floats = this.floats.filter((x) => now - x.t < FLOAT_MS).slice(-40);
    this.flashes = this.flashes.filter((x) => now - x.t < FLASH_MS).slice(-40);
    this.ticker = this.ticker.filter((x) => now - x.t < TICK_MS).slice(-6);
    this.blasts = this.blasts.filter((x) => now - x.t < BLAST_MS).slice(-30);
  }
}

/** Running casualties [attacker, defender] of a battle. */
function sides(_g: GameState, b: { attacker: { losses: { killed: number; wounded: number } }; defender: { losses: { killed: number; wounded: number } } }): [number, number] {
  return [b.attacker.losses.killed + b.attacker.losses.wounded, b.defender.losses.killed + b.defender.losses.wounded];
}

export const live = new Live();
