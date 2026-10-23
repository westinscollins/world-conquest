/**
 * Online multiplayer session (deterministic lockstep).
 *
 * The host owns the clock and the order of everything that happens. Each client runs the same
 * simulation; the host broadcasts an ordered stream of events — "advance one day", "nation X
 * ordered Y", periodic checksums — in numbered batches. Guests send their orders to the host,
 * which executes them and puts them into the stream, so every computer applies identical
 * events in identical order. Lost batches are re-sent from history; a checksum mismatch or
 * a long gap is repaired by sending the whole game as a compressed snapshot in small chunks.
 */
import type { GameState } from '../../engine/types';
import { runCommand, stateHash } from '../../engine/commands';
import { tick } from '../../engine/sim';
import { joinRoom, MAX_MSG, type NetRoom, type NetPeer, type NetMessage } from './transport';
import { saveCode, fromSaveCode } from '../storage';

export type Ev = ['t'] | ['c', string, string, string, unknown[], string?] | ['h', number, string] | ['sp', number];
interface Batch { q: number; e: Ev[] }
export interface Seat { peer: string; name: string; nation: string | null; role: 'host' | 'guest'; phase: string; online: boolean }

export interface SessionHooks {
  onGame(g: GameState): void;                       // a (new or resynced) game is ready to show
  onTick(g: GameState): void;                       // guest applied a day
  onSpeed(i: number): void;                         // host changed speed
  onResult(r: { ok: boolean; message: string }, done?: (r: { ok: boolean; message: string }) => void): void;
  onChange(): void;                                  // lobby / peer list changed
  toast(text: string, kind?: 'info' | 'good' | 'bad' | 'war'): void;
  getGame(): GameState | null;
  getSpeed(): number;
}

/** Plain-language explanation of a room error. */
export function netError(e: unknown, what: string): string {
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'not_permitted') return `${what}: your access to this page is view-only. Ask the owner to share it with you with permission to edit or contribute, then reload.`;
  if (code === 'not_granted' || code === 'revoked') return `${what}: you can't connect to this page's online rooms. You must be signed in to claude.ai and have access to the page (ask the owner to share it with you), then reload.`;
  return `${what}: ${(e as Error)?.message || 'connection problem'}.`;
}
const rid = () => Math.random().toString(36).slice(2, 8);
export const newRoomCode = () => Array.from({ length: 6 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');

export class Session {
  role: 'host' | 'guest';
  code: string;
  room!: NetRoom;
  name: string;
  nation: string | null = null;
  phase: 'lobby' | 'loading' | 'playing' = 'lobby';
  hostPeer: string | null = null;
  seats: Seat[] = [];
  status = '';
  loading: { got: number; of: number } | null = null;
  desyncs = 0;
  private hooks: SessionHooks;
  private unsub: (() => void)[] = [];
  // host state
  private seq = 0;
  private outbox: Ev[] = [];
  private history = new Map<number, Batch>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private seatOf = new Map<string, string>(); // peer -> nation (host's authority)
  private sending = 0;
  private resumeSpeed = 0;
  // guest state
  private applied = 0;
  private buffer = new Map<number, Batch>();
  private gapSince = 0;
  private lastNeed = 0;
  private stalled = false;
  private pending = new Map<string, ((r: { ok: boolean; message: string }) => void) | null>();
  private snap: { sid: string; q: number; n: number; parts: (string | undefined)[]; last: number } | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(role: 'host' | 'guest', code: string, name: string, hooks: SessionHooks) {
    this.role = role; this.code = code; this.name = name || (role === 'host' ? 'Host' : 'Guest'); this.hooks = hooks;
  }

  get kind() { return this.room?.kind ?? 'local'; }
  connected() { return this.room?.connected() ?? false; }
  get myPeer() { return this.room?.myPeer() ?? ''; }

  async open() {
    this.room = await joinRoom(`wc-${this.code}`);
    this.unsub.push(this.room.onPeers((peers, joined, left) => this.peersChanged(peers, joined, left)));
    this.unsub.push(this.room.on('step', (m) => this.onStep(m)));
    this.unsub.push(this.room.on('cmd', (m) => this.onCmd(m)));
    this.unsub.push(this.room.on('snap', (m) => this.onSnap(m)));
    this.unsub.push(this.room.on('need', (m) => this.onNeed(m)));
    this.unsub.push(this.room.on('meta', (m) => this.onMeta(m)));
    await this.announce();
    if (this.role === 'host') {
      let beat = 0;
      // flush every 100 ms; every 2 s also announce the latest batch number so a guest that lost the last one notices
      this.flushTimer = setInterval(() => { this.flush(); if (++beat % 20 === 0 && this.phase === 'playing') void this.room.emit('step', { hb: this.seq }).catch(() => {}); }, 100);
    }
    else this.watchdog = setInterval(() => this.guestWatchdog(), 500);
  }

  async close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    for (const u of this.unsub) u();
    try { await this.room?.leave(); } catch { /* already gone */ }
  }

  async setNation(nation: string | null) { this.nation = nation; await this.announce(); this.hooks.onChange(); }
  private announce() { return this.room.presence({ app: 'wc', v: 1, role: this.role, name: this.name.slice(0, 24), nation: this.nation, phase: this.phase }); }

  private peersChanged(peers: readonly NetPeer[], joined: readonly NetPeer[], left: readonly NetPeer[]) {
    const prevOnline = new Set(this.seats.filter((s) => s.online).map((s) => s.peer));
    this.seats = peers
      .filter((p) => p.presence?.app === 'wc')
      .map((p) => ({ peer: p.peer, name: String(p.presence.name ?? 'Player').slice(0, 24), nation: (p.presence.nation as string) ?? null, role: p.presence.role === 'host' ? 'host' : 'guest', phase: String(p.presence.phase ?? 'lobby'), online: true }) as Seat);
    const host = this.seats.find((s) => s.role === 'host' && !(s.peer === this.myPeer && this.role !== 'host'));
    if (host) this.hostPeer = host.peer;
    if (this.role === 'guest') {
      if (left.some((p) => p.peer === this.hostPeer)) { this.status = 'The host disconnected. The game is frozen until they return.'; this.hooks.toast(this.status, 'bad'); }
      else if (joined.some((p) => p.peer === this.hostPeer) && this.status.startsWith('The host')) { this.status = ''; this.requestSnapshot(); }
    } else {
      const g = this.hooks.getGame();
      for (const p of left) { const n = this.seatOf.get(p.peer); if (n && prevOnline.has(p.peer)) this.hooks.toast(`${String(p.presence?.name ?? 'A player')} (${g?.nations[n]?.name ?? n}) disconnected. Their nation waits; you can hand it to the AI from the menu.`, 'bad'); }
      // a player re-joining a running game for a nation that is human-controlled gets the game
      if (g && this.phase === 'playing') {
        for (const s of this.seats) {
          if (s.role !== 'guest' || !s.nation || this.seatOf.get(s.peer) === s.nation) continue;
          if (g.players.includes(s.nation) && ![...this.seatOf.entries()].some(([peer, n]) => n === s.nation && this.seats.some((x) => x.peer === peer))) {
            this.seatOf.set(s.peer, s.nation);
            this.hooks.toast(`${s.name} rejoined as ${g.nations[s.nation].name}.`, 'good');
            void this.sendSnapshot(s.peer);
          }
        }
      }
    }
    this.hooks.onChange();
  }

  // ------------------------------------------------------------------ host
  /** Host: begin play with an assembled game; every guest seat is bound to its nation. */
  async hostStart(g: GameState) {
    this.seatOf.clear();
    this.seatOf.set(this.myPeer, g.player);
    for (const s of this.seats) if (s.role === 'guest' && s.nation) this.seatOf.set(s.peer, s.nation);
    this.phase = 'playing';
    await this.announce();
    this.hooks.onGame(g);
    await this.sendSnapshot(null);
  }
  /** Host: record an event at the current point in the stream. */
  record(e: Ev) { if (this.role === 'host' && this.phase === 'playing') this.outbox.push(e); }
  recordTick(g: GameState) {
    this.record(['t']);
    if (g.day % 30 === 0) this.record(['h', g.day, stateHash(g)]);
  }
  private flush() {
    if (!this.outbox.length) return;
    const events = this.outbox; this.outbox = [];
    let cur: Ev[] = [];
    let size = 20;
    const send = () => {
      if (!cur.length) return;
      const b: Batch = { q: ++this.seq, e: cur };
      this.history.set(b.q, b);
      if (this.history.size > 4000) this.history.delete(b.q - 4000);
      void this.room.emit('step', b).catch(() => { /* re-sent on request */ });
      cur = []; size = 20;
    };
    for (const e of events) {
      const len = JSON.stringify(e).length + 1;
      if (size + len > MAX_MSG) send();
      cur.push(e); size += len;
    }
    send();
  }
  private onCmd(m: NetMessage) {
    if (this.role !== 'host' || this.phase !== 'playing') return;
    const g = this.hooks.getGame();
    const nation = this.seatOf.get(m.peer);
    const d = m.data as { id?: unknown; n?: unknown; a?: unknown };
    if (!g || !nation || typeof d?.n !== 'string' || !Array.isArray(d.a)) return;
    runCommand(g, nation, d.n, d.a);
    this.record(['c', m.peer, nation, d.n, d.a, typeof d.id === 'string' ? d.id.slice(0, 12) : undefined]);
    this.flush();
    this.hooks.onChange();
  }
  private onMeta(m: NetMessage) {
    const d = m.data as { speed?: number };
    if (this.role === 'host' && this.seatOf.has(m.peer) && typeof d?.speed === 'number' && d.speed >= 0 && d.speed <= 3) {
      if (this.sending) return;
      this.hooks.onSpeed(d.speed);
      const who = this.seats.find((s) => s.peer === m.peer)?.name ?? 'A player';
      this.hooks.toast(d.speed === 0 ? `${who} paused the game.` : `${who} set the speed to ${['', 'normal', 'fast', 'very fast'][d.speed]}.`, 'info');
    }
  }
  private onNeed(m: NetMessage) {
    if (this.role !== 'host') return;
    const d = m.data as { from?: number; snap?: boolean; sid?: string; miss?: number[] };
    if (d?.sid && Array.isArray(d.miss) && this.outgoing?.sid === d.sid) { void this.resendChunks(d.miss); return; }
    if (d?.snap) { void this.sendSnapshot(m.peer); return; }
    if (typeof d?.from === 'number') {
      if (!this.history.has(d.from) && d.from <= this.seq) { void this.sendSnapshot(m.peer); return; }
      for (let q = d.from; q <= Math.min(this.seq, d.from + 40); q++) { const b = this.history.get(q); if (b) void this.room.emit('step', b).catch(() => {}); }
    }
  }
  private outgoing: { sid: string; chunks: string[]; to: string | null; q: number } | null = null;
  /** Send the whole game (compressed) to one peer or everyone; the clock pauses meanwhile. */
  async sendSnapshot(to: string | null) {
    const g = this.hooks.getGame();
    if (!g) return;
    this.flush();
    if (!this.sending) this.resumeSpeed = this.hooks.getSpeed();
    this.sending++;
    this.hooks.onSpeed(0);
    try {
      const trimmed = { ...g, events: g.events.slice(-60), battles: Object.fromEntries(Object.entries(g.battles).filter(([, b]) => b.result == null || g.day - b.startDay < 45)) } as GameState;
      const code = await saveCode(trimmed);
      const size = MAX_MSG - 200;
      const chunks: string[] = [];
      for (let i = 0; i < code.length; i += size) chunks.push(code.slice(i, i + size));
      this.outgoing = { sid: rid(), chunks, to, q: this.seq };
      for (let i = 0; i < chunks.length; i++) {
        await this.room.emit('snap', { sid: this.outgoing.sid, to, q: this.outgoing.q, i, n: chunks.length, d: chunks[i] }).catch(() => {});
        if (i % 12 === 11) await new Promise((r) => setTimeout(r, 650)); // stay well under the message budget
      }
      // give guests time to ask for missing chunks, then resume
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      this.sending--;
      if (!this.sending) this.hooks.onSpeed(this.resumeSpeed);
    }
  }
  private async resendChunks(miss: number[]) {
    const o = this.outgoing;
    if (!o) return;
    this.sending++;
    try {
      let k = 0;
      for (const i of miss.slice(0, 120)) {
        if (o.chunks[i] == null) continue;
        await this.room.emit('snap', { sid: o.sid, to: o.to, q: o.q, i, n: o.chunks.length, d: o.chunks[i] }).catch(() => {});
        if (++k % 12 === 0) await new Promise((r) => setTimeout(r, 650));
      }
      await new Promise((r) => setTimeout(r, 1500));
    } finally { this.sending--; if (!this.sending) this.hooks.onSpeed(this.resumeSpeed); }
  }
  /** Host: speed changes are part of the stream so guests show the same clock state. */
  hostSpeed(i: number) { this.record(['sp', i]); this.flush(); }

  // ------------------------------------------------------------------ guest
  /** Guest: send an order to the host; `done` runs when it comes back executed. */
  sendCommand(name: string, args: unknown[], done?: (r: { ok: boolean; message: string }) => void) {
    if (this.phase !== 'playing' || this.stalled) { this.hooks.toast('Not connected to the game right now; order not sent.', 'bad'); return; }
    const id = rid();
    this.pending.set(id, done ?? null);
    this.room.emit('cmd', { id, n: name, a: args }).catch((e) => { this.pending.delete(id); this.hooks.toast(netError(e, 'Order could not be sent'), 'bad'); });
    setTimeout(() => { if (this.pending.delete(id)) this.hooks.toast('The host did not confirm your last order. It may have been lost — check and try again.', 'bad'); }, 12000);
  }
  requestSpeed(i: number) { void this.room.emit('meta', { speed: i }).catch((e) => this.hooks.toast(netError(e, 'Could not change the speed'), 'bad')); }

  private onStep(m: NetMessage) {
    if (this.role !== 'guest' || m.peer !== this.hostPeer) return;
    const hb = (m.data as { hb?: number })?.hb;
    if (typeof hb === 'number') {
      if (hb > this.applied && this.phase === 'playing' && !this.stalled) this.gapSince = this.gapSince || Date.now() - 1000;
      return;
    }
    const b = m.data as Batch;
    if (!b || typeof b.q !== 'number' || !Array.isArray(b.e)) return;
    if (b.q <= this.applied) return;
    this.buffer.set(b.q, b);
    this.drain();
  }
  private drain() {
    const g = this.hooks.getGame();
    if (!g || this.phase !== 'playing' || this.stalled) return;
    let progressed = false;
    while (this.buffer.has(this.applied + 1)) {
      const b = this.buffer.get(this.applied + 1)!;
      this.buffer.delete(b.q);
      for (const e of b.e) {
        if (this.stalled) break;
        this.applyEvent(g, e);
      }
      if (this.stalled) return;
      this.applied = b.q;
      progressed = true;
    }
    this.gapSince = this.buffer.size ? (this.gapSince || Date.now()) : 0;
    if (progressed) this.gapSince = this.buffer.size ? Date.now() : 0;
    if (progressed) this.hooks.onChange();
  }
  private applyEvent(g: GameState, e: Ev) {
    switch (e[0]) {
      case 't': tick(g); this.hooks.onTick(g); break;
      case 'c': {
        const [, peer, nation, name, args, id] = e;
        const r = runCommand(g, nation, name, args);
        if (peer === this.myPeer && id && this.pending.has(id)) {
          const done = this.pending.get(id);
          this.pending.delete(id);
          this.hooks.onResult(r, done ?? undefined);
        }
        break;
      }
      case 'h': if (e[1] === g.day && e[2] !== stateHash(g)) { this.desyncs++; this.requestSnapshot(); } break;
      case 'sp': this.hooks.onSpeed(e[1]); break;
    }
  }
  private requestSnapshot() {
    this.stalled = true;
    this.status = 'Re-synchronising with the host…';
    this.hooks.onChange();
    void this.room.emit('need', { snap: true }).catch(() => {});
    this.lastNeed = Date.now();
  }
  private guestWatchdog() {
    const now = Date.now();
    if (this.snap && now - this.snap.last > 1800 && now - this.lastNeed > 1800) {
      const miss: number[] = [];
      for (let i = 0; i < this.snap.n && miss.length < 120; i++) if (this.snap.parts[i] == null) miss.push(i); // (sparse array: no forEach)
      this.lastNeed = now;
      void this.room.emit('need', { sid: this.snap.sid, miss }).catch(() => {});
      return;
    }
    if (this.stalled && !this.snap && now - this.lastNeed > 6000) { this.lastNeed = now; void this.room.emit('need', { snap: true }).catch(() => {}); return; }
    if (this.phase === 'playing' && this.gapSince && now - this.gapSince > 900 && now - this.lastNeed > 1500) {
      this.lastNeed = now;
      void this.room.emit('need', { from: this.applied + 1 }).catch(() => {});
    }
  }
  private onSnap(m: NetMessage) {
    if (this.role !== 'guest' || m.peer !== this.hostPeer) return;
    const d = m.data as { sid: string; to: string | null; q: number; i: number; n: number; d: string };
    if (!d || typeof d.sid !== 'string' || (d.to && d.to !== this.myPeer)) return;
    if (!this.snap || this.snap.sid !== d.sid) {
      if (this.phase === 'playing' && !this.stalled && !d.to) return; // a broadcast for someone else's (re)join
      this.snap = { sid: d.sid, q: d.q, n: d.n, parts: new Array(d.n), last: Date.now() };
      this.phase = 'loading';
    }
    const s = this.snap;
    s.parts[d.i] = d.d; s.last = Date.now();
    let got = 0;
    for (let i = 0; i < s.n; i++) if (s.parts[i] != null) got++;
    this.loading = { got, of: s.n };
    this.hooks.onChange();
    if (got === s.n) void this.finishSnapshot();
  }
  private async finishSnapshot() {
    const s = this.snap!;
    this.snap = null;
    try {
      const g = await fromSaveCode(s.parts.join(''));
      if (!this.nation || !g.nations[this.nation]) throw new Error('Your nation is not in this game.');
      g.player = this.nation;
      g.outcome = null;
      this.applied = s.q;
      for (const k of [...this.buffer.keys()]) if (k <= s.q) this.buffer.delete(k);
      this.stalled = false;
      this.status = '';
      this.loading = null;
      this.phase = 'playing';
      await this.announce();
      this.hooks.onGame(g);
      this.drain();
    } catch (e) {
      this.status = `Could not load the game from the host: ${(e as Error).message}`;
      this.requestSnapshot();
    }
  }
}
