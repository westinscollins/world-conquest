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
import { joinRoom, MAX_MSG, type NetRoom, type NetPeer, type NetMessage, type JoinProgress } from './transport';
import { saveCode, fromSaveCode } from '../storage';
import { every, after, sleep } from './clock';

export type Ev = ['t'] | ['c', string, string, string, unknown[], string?] | ['h', number, string] | ['sp', number];
interface Batch { q: number; e: Ev[] }
/** One copy of the game on its way to some guests (null: everyone). */
interface Outgoing { sid: string; chunks: string[]; to: string[] | null; q: number; seats?: Record<string, string | null> }
/** Largest order (JSON of its arguments) that fits in the shared stream. */
export const MAX_ORDER = 2000;
const SNAP_COOLDOWN_MS = 8000; // a guest gets at most one full copy per this interval
export interface Seat { peer: string; name: string; nation: string | null; role: 'host' | 'guest'; phase: string; online: boolean; build: string | null }
/** This build's id (old builds don't send one). */
export const BUILD = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev';

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
  if (code === 'not_found') return `No open game with that code. Check the code with your host, and make sure their game is still showing the lobby (not closed or asleep).`;
  if (code === 'unreachable') return `Found the host's game, but couldn't connect to it from this network. First make sure you and the host show the same game version (at the bottom of this window): if not, whoever is behind should reload the page. Then try again. If it still fails, press "Check my network" below on both computers.`;
  if (code === 'network') return `${what}: couldn't reach the matchmaking server or any relay. Check your internet connection, or run the network check below to see what this network blocks.`;
  if (code === 'id_taken') return `${what}: that room code is in use. Try again for a new code.`;
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
  /** Guest: how far joining has got (for the lobby). */
  progress: JoinProgress | null = null;
  private hooks: SessionHooks;
  private unsub: (() => void)[] = [];
  // host state
  private seq = 0;
  private outbox: Ev[] = [];
  private history = new Map<number, Batch>();
  private stopFlush: (() => void) | null = null;
  private seatOf = new Map<string, string>(); // peer -> nation (host's authority)
  private away = new Set<string>();             // seated peers that disconnected
  private sending = 0;
  private resumeSpeed = 0;
  private settingClock = false;
  private snapWant = new Set<string>();   // peers waiting for a copy of the game
  private snapAll = false;                 // everyone needs one (game start)
  private snapRun: Promise<void> | null = null;
  private inFlight: string[] | 'all' | null = null;
  private snapAt = new Map<string, number>(); // peer -> when its last copy finished
  private recent: Outgoing[] = [];         // the last few copies, for re-sending lost chunks
  // guest state
  private applied = 0;
  private buffer = new Map<number, Batch>();
  private gapSince = 0;
  private lastNeed = 0;
  private stalled = false;
  private pending = new Map<string, ((r: { ok: boolean; message: string }) => void) | null>();
  private snap: { sid: string; q: number; n: number; parts: (string | undefined)[]; last: number; seat: string | null } | null = null;
  private doneSnaps: string[] = []; // copies already loaded or given up (late chunks are ignored)
  private hostClosed = false;
  private stopWatchdog: (() => void) | null = null;

  constructor(role: 'host' | 'guest', code: string, name: string, hooks: SessionHooks) {
    this.role = role; this.code = code; this.name = name || (role === 'host' ? 'Host' : 'Guest'); this.hooks = hooks;
  }

  get kind() { return this.room?.kind ?? 'local'; }
  connected() { return this.room?.connected() ?? false; }
  get myPeer() { return this.room?.myPeer() ?? ''; }
  info() { return this.room?.info?.() ?? null; }

  private joinOpts() { return { onProgress: (p: JoinProgress) => { this.progress = p; this.hooks.onChange(); }, onChanged: () => this.hooks.onChange() }; }
  /** Subscribe this session to the current room. */
  private attach() {
    for (const u of this.unsub) u();
    this.unsub = [
      this.room.onPeers((peers, joined, left) => this.peersChanged(peers, joined, left)),
      this.room.on('step', (m) => this.onStep(m)),
      this.room.on('cmd', (m) => this.onCmd(m)),
      this.room.on('snap', (m) => this.onSnap(m)),
      this.room.on('need', (m) => this.onNeed(m)),
      this.room.on('meta', (m) => this.onMeta(m)),
    ];
  }
  async open() {
    for (let attempt = 0; ; attempt++) {
      try { this.room = await joinRoom(`wc-${this.code}`, this.role, this.joinOpts()); break; }
      catch (e) {
        // public peer ids are global: if this code is taken, the host simply picks another
        if (this.role === 'host' && (e as { code?: string }).code === 'id_taken' && attempt < 3) { this.code = newRoomCode(); continue; }
        throw e;
      }
    }
    this.attach();
    await this.announce();
    if (this.role === 'host') {
      let beat = 0;
      // flush every 100 ms; every 2 s also announce the latest batch number so a guest that lost the last one notices
      this.stopFlush = every(100, () => { this.flush(); if (++beat % 20 === 0 && this.phase === 'playing') void this.room.emit('step', { hb: this.seq }).catch(() => {}); });
    }
    else this.stopWatchdog = every(500, () => this.guestWatchdog());
  }

  private closed = false;
  private reconnecting = false;
  /**
   * Guest: the link to the host died (Wi-Fi hiccup, sleep, network change). Join again with the
   * same tab id; the host recognises us and sends the game again. Keeps trying until it works.
   */
  private async reconnect() {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    this.status = 'Connection to the host lost — reconnecting…';
    this.hooks.onChange();
    let delay = 1000;
    while (!this.closed && !this.hostClosed) {
      try {
        const room = await joinRoom(`wc-${this.code}`, 'guest', this.joinOpts());
        if (this.closed) { await room.leave(); break; }
        const old = this.room;
        this.room = room;
        this.attach();
        try { await old.leave(); } catch { /* already gone */ }
        await this.announce();
        if (this.phase === 'playing') { this.status = 'Reconnected — reloading the game from the host…'; this.stalled = true; this.lastNeed = Date.now(); }
        else this.status = '';
        break;
      } catch {
        await sleep(delay);
        delay = Math.min(15000, delay * 2);
      }
    }
    this.reconnecting = false;
    this.hooks.onChange();
  }

  async close() {
    this.closed = true;
    this.stopFlush?.();
    this.stopWatchdog?.();
    for (const u of this.unsub) u();
    // so guests stop trying to reconnect
    if (this.role === 'host') { try { await this.room?.emit('meta', { closed: true }); } catch { /* gone */ } }
    try { await this.room?.leave(); } catch { /* already gone */ }
  }

  async setNation(nation: string | null) { this.nation = nation; await this.announce(); this.hooks.onChange(); }
  private announce() { return this.room.presence({ app: 'wc', v: 1, b: BUILD, role: this.role, name: this.name.slice(0, 24), nation: this.nation, phase: this.phase }); }

  private peersChanged(peers: readonly NetPeer[], joined: readonly NetPeer[], left: readonly NetPeer[]) {
    const prevOnline = new Set(this.seats.filter((s) => s.online).map((s) => s.peer));
    this.seats = peers
      .filter((p) => p.presence?.app === 'wc')
      .map((p) => ({ peer: p.peer, name: String(p.presence.name ?? 'Player').slice(0, 24), nation: (p.presence.nation as string) ?? null, role: p.presence.role === 'host' ? 'host' : 'guest', phase: String(p.presence.phase ?? 'lobby'), online: true, build: typeof p.presence.b === 'string' ? p.presence.b : null }) as Seat);
    const host = this.seats.find((s) => s.role === 'host' && !(s.peer === this.myPeer && this.role !== 'host'));
    if (host) this.hostPeer = host.peer;
    if (this.role === 'guest') {
      if (left.some((p) => p.peer === this.hostPeer)) { if (!this.hostClosed) { this.status = 'The host disconnected. The game is frozen until they return.'; this.hooks.toast(this.status, 'bad'); } }
      else if (joined.some((p) => p.peer === this.hostPeer) && this.status.startsWith('The host')) { this.status = ''; this.requestSnapshot(); }
    } else {
      const g = this.hooks.getGame();
      for (const p of left) if (this.seatOf.has(p.peer)) this.away.add(p.peer);
      for (const p of left) { const n = this.seatOf.get(p.peer); if (n && prevOnline.has(p.peer)) this.hooks.toast(`${String(p.presence?.name ?? 'A player')} (${g?.nations[n]?.name ?? n}) disconnected. Their nation waits; you can hand it to the AI from the menu.`, 'bad'); }
      // a player re-joining a running game for a nation that is human-controlled gets the game
      if (g && this.phase === 'playing') {
        for (const s of this.seats) {
          if (s.role !== 'guest' || !s.nation) continue;
          if (this.seatOf.get(s.peer) === s.nation) {
            // the same player came back (same tab after a reload or a dropped connection): resend the game
            if (this.away.delete(s.peer)) { this.hooks.toast(`${s.name} reconnected as ${g.nations[s.nation]?.name}.`, 'good'); void this.sendSnapshot(s.peer); }
            continue;
          }
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
  /** Does this order fit in the shared stream? */
  static orderFits(args: unknown[]) { try { return JSON.stringify(args).length <= MAX_ORDER; } catch { return false; } }
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
      if (len > MAX_MSG - 100) { console.warn('multiplayer: event too large to send, dropped', e[0]); continue; } // (orders are capped earlier)
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
    if (!g || !nation || typeof d?.n !== 'string' || !Array.isArray(d.a) || !Session.orderFits(d.a)) return;
    runCommand(g, nation, d.n, d.a);
    this.record(['c', m.peer, nation, d.n, d.a, typeof d.id === 'string' ? d.id.slice(0, 12) : undefined]);
    this.flush();
    this.hooks.onChange();
  }
  private onMeta(m: NetMessage) {
    const d = m.data as { speed?: number; closed?: boolean };
    if (this.role === 'guest' && d?.closed && m.peer === this.hostPeer) {
      this.hostClosed = true;
      this.status = 'The host closed the game.';
      this.hooks.toast(this.status, 'bad');
      this.hooks.onChange();
      return;
    }
    if (this.role === 'host' && this.seatOf.has(m.peer) && typeof d?.speed === 'number' && d.speed >= 0 && d.speed <= 3) {
      if (this.sending) this.resumeSpeed = d.speed; // a copy of the game is on its way: applies when it has arrived
      else this.setClock(d.speed);
      const who = this.seats.find((s) => s.peer === m.peer)?.name ?? 'A player';
      this.hooks.toast(d.speed === 0 ? `${who} paused the game.` : `${who} set the speed to ${['', 'normal', 'fast', 'very fast'][d.speed]}.`, 'info');
    }
  }
  private onNeed(m: NetMessage) {
    if (this.role !== 'host') return;
    const d = m.data as { from?: number; snap?: boolean; sid?: string; miss?: number[] };
    if (typeof d?.sid === 'string' && Array.isArray(d.miss)) { void this.resendChunks(m.peer, d.sid, d.miss); return; }
    if (d?.snap) { if (!this.receiving(m.peer)) void this.sendSnapshot(m.peer); return; }
    if (typeof d?.from === 'number') {
      if (!this.history.has(d.from) && d.from <= this.seq) { if (!this.receiving(m.peer)) void this.sendSnapshot(m.peer); return; }
      for (let q = d.from; q <= Math.min(this.seq, d.from + 40); q++) { const b = this.history.get(q); if (b) void this.room.emit('step', b, [m.peer]).catch(() => {}); }
    }
  }
  /** Is a copy of the game already on its way to this peer (or queued for it)? */
  private receiving(peer: string) { return this.inFlight === 'all' || !!this.inFlight?.includes(peer) || this.snapWant.has(peer) || this.snapAll; }
  /**
   * Send the whole game (compressed) to one peer, or everyone (null). Copies go out one at a time
   * (requests that arrive meanwhile are queued and share the next copy); the clock pauses meanwhile.
   */
  sendSnapshot(to: string | null): Promise<void> {
    if (to === null) this.snapAll = true; else this.snapWant.add(to);
    if (!this.snapRun) {
      this.snapRun = (async () => {
        try { await this.runSnapshots(); } finally { this.snapRun = null; }
        if (!this.closed && (this.snapAll || this.snapWant.size)) void this.sendSnapshot(this.snapAll ? null : [...this.snapWant][0]);
      })();
    }
    return this.snapRun;
  }
  private async runSnapshots() {
    while (!this.closed && (this.snapAll || this.snapWant.size)) {
      let to: string[] | null;
      if (this.snapAll) { to = null; this.snapAll = false; this.snapWant.clear(); }
      else {
        // a guest that just got a copy waits a little before the next (a broken guest can't stall everyone)
        const now = Date.now();
        const ready = [...this.snapWant].filter((p) => now - (this.snapAt.get(p) ?? 0) >= SNAP_COOLDOWN_MS);
        if (!ready.length) {
          const next = Math.min(...[...this.snapWant].map((p) => (this.snapAt.get(p) ?? 0) + SNAP_COOLDOWN_MS));
          await sleep(Math.max(200, next - now));
          continue;
        }
        to = ready;
        for (const p of ready) this.snapWant.delete(p);
      }
      try { await this.transfer(to); } catch { /* the guests ask again */ }
      const done = Date.now();
      for (const p of to ?? []) this.snapAt.set(p, done);
    }
  }
  private async transfer(to: string[] | null) {
    const g = this.hooks.getGame();
    if (!g) return;
    this.flush();
    if (!this.sending) this.resumeSpeed = this.hooks.getSpeed();
    this.sending++;
    this.setClock(0);
    this.inFlight = to ?? 'all';
    try {
      const trimmed = { ...g, events: g.events.slice(-60), battles: Object.fromEntries(Object.entries(g.battles).filter(([, b]) => b.result == null || g.day - b.startDay < 45)) } as GameState;
      // this copy's place in the stream; read right before saveCode, which serialises at once
      const q = this.seq;
      const code = await saveCode(trimmed);
      const size = MAX_MSG - 300;
      const chunks: string[] = [];
      for (let i = 0; i < code.length; i += size) chunks.push(code.slice(i, i + size));
      // each receiver learns which nation it plays (a reloaded tab takes its seat back)
      const seats = to ? Object.fromEntries(to.map((p) => [p, this.seatOf.get(p) ?? null])) : undefined;
      const o: Outgoing = { sid: rid(), chunks, to, q, seats };
      this.recent = [...this.recent.slice(-3), o];
      for (let i = 0; i < chunks.length; i++) {
        await this.emitChunk(o, i, to);
        if (i % 12 === 11) await sleep(650); // stay well under the message budget
      }
      // give guests time to ask for missing chunks, then resume
      await sleep(2500);
    } finally {
      this.inFlight = null;
      this.sending--;
      if (!this.sending) this.setClock(this.resumeSpeed);
    }
  }
  private emitChunk(o: Outgoing, i: number, to: string[] | null) {
    return this.room.emit('snap', { sid: o.sid, to: o.to, q: o.q, i, n: o.chunks.length, d: o.chunks[i], ...(o.seats ? { seats: o.seats } : {}) }, to ?? undefined).catch(() => {});
  }
  /** A guest lost some chunks of a copy: send just those again (or a fresh copy if that one is gone). */
  private async resendChunks(peer: string, sid: string, miss: number[]) {
    const o = this.recent.find((x) => x.sid === sid);
    if (!o || (o.to && !o.to.includes(peer))) { if (!this.receiving(peer)) void this.sendSnapshot(peer); return; }
    let k = 0;
    for (const i of miss.slice(0, 120)) {
      if (!Number.isInteger(i) || o.chunks[i] == null) continue;
      await this.emitChunk(o, i, [peer]);
      if (++k % 12 === 0) await sleep(650);
    }
  }
  /** Set the host's clock on the session's behalf (pausing for a transfer, a guest's request). */
  private setClock(i: number) {
    this.settingClock = true;
    try { this.hooks.onSpeed(i); } finally { this.settingClock = false; }
  }
  /** Host: speed changes are part of the stream so guests show the same clock state. */
  hostSpeed(i: number) {
    if (this.sending && !this.settingClock) this.resumeSpeed = i; // the host's own choice outlasts the transfer
    this.record(['sp', i]);
    this.flush();
  }

  // ------------------------------------------------------------------ guest
  /** Guest: send an order to the host; `done` runs when it comes back executed. */
  sendCommand(name: string, args: unknown[], done?: (r: { ok: boolean; message: string }) => void) {
    if (this.phase !== 'playing' || this.stalled) { this.hooks.toast('Not connected to the game right now; order not sent.', 'bad'); return; }
    if (!Session.orderFits(args)) { this.hooks.toast('That order is too long to send to the host.', 'bad'); return; }
    const id = rid();
    this.pending.set(id, done ?? null);
    this.room.emit('cmd', { id, n: name, a: args }).catch((e) => { this.pending.delete(id); this.hooks.toast(netError(e, 'Order could not be sent'), 'bad'); });
    after(12000, () => { if (this.pending.delete(id)) this.hooks.toast('The host did not confirm your last order. It may have been lost — check and try again.', 'bad'); });
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
    if (this.hostClosed) return;
    // public-site rooms (they report info()) heal themselves when the link to the host dies
    if (!this.reconnecting && !this.closed && this.room?.info && !this.room.connected()) { void this.reconnect(); return; }
    if (this.reconnecting) return;
    if (this.snap && now - this.snap.last > 8000) {
      // chunks stopped coming although we asked for them: start again with a fresh copy
      this.forget(this.snap.sid);
      this.snap = null;
      this.loading = null;
      this.requestSnapshot();
      return;
    }
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
    const d = m.data as { sid: string; to: string[] | string | null; q: number; i: number; n: number; d: string; seats?: Record<string, string | null> };
    if (!d || typeof d.sid !== 'string' || typeof d.q !== 'number' || typeof d.n !== 'number' || typeof d.i !== 'number') return;
    if (d.to && !(Array.isArray(d.to) ? d.to.includes(this.myPeer) : d.to === this.myPeer)) return;
    if (this.doneSnaps.includes(d.sid)) return; // late chunks of a copy we already have
    if (!this.snap || this.snap.sid !== d.sid) {
      if (this.phase === 'playing' && !this.stalled && !d.to) return; // a broadcast for someone else's (re)join
      if (this.snap && d.q < this.snap.q) return; // an older copy than the one arriving
      if (this.snap) this.forget(this.snap.sid);
      this.snap = { sid: d.sid, q: d.q, n: d.n, parts: new Array(d.n), last: Date.now(), seat: d.seats?.[this.myPeer] ?? null };
      this.phase = 'loading';
    }
    const s = this.snap;
    if (d.i < 0 || d.i >= s.n) return;
    s.parts[d.i] = d.d; s.last = Date.now();
    let got = 0;
    for (let i = 0; i < s.n; i++) if (s.parts[i] != null) got++;
    this.loading = { got, of: s.n };
    this.hooks.onChange();
    if (got === s.n) void this.finishSnapshot();
  }
  private forget(sid: string) { this.doneSnaps = [...this.doneSnaps.slice(-9), sid]; }
  private async finishSnapshot() {
    const s = this.snap!;
    this.snap = null;
    this.forget(s.sid);
    try {
      const g = await fromSaveCode(s.parts.join(''));
      // the host says which nation this tab plays (a reloaded tab gets its seat back)
      if (s.seat && g.nations[s.seat]) this.nation = s.seat;
      if (!this.nation || !g.nations[this.nation]) {
        // no seat in this game: back to the lobby to pick one (asking again would only repeat this)
        this.phase = 'lobby';
        this.stalled = false;
        this.loading = null;
        this.status = 'This game is already running. Pick the nation you played to rejoin it.';
        await this.announce();
        this.hooks.onChange();
        return;
      }
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
