// PeerJS paths for the public website build. One PeerJS connection to the free public
// matchmaking server (0.peerjs.com, over HTTPS port 443) gives two ways to reach the host:
//  - direct: a WebRTC data channel (fastest; often blocked on school and office networks)
//  - server: messages tunnelled through the matchmaking server itself (works anywhere the
//    matchmaking server is reachable). Tunnelled messages are encrypted with the room key.
// The host keeps its registration alive: it re-registers after drops, sleep and network changes.
import { BaseLink, isWire, type Wire } from './wire';
import type { HostListener, ListenerStatus } from './star';
import { Batcher, Inbox, fromB64, toB64, type RoomKeys } from './crypt';
import { TIMING, rand } from './config';
import { after, every } from './clock';

export const PREFIX = 'worldconquest-v1-';

export class PeerError extends Error { constructor(message: string, public code: string) { super(message); } }

interface Conn {
  peer: string; open: boolean; metadata?: { gid?: string }; peerConnection?: RTCPeerConnection;
  send(d: unknown): void; close(): void; on(ev: string, fn: (...a: never[]) => void): void;
}
interface SocketLike { send(m: unknown): void; on(ev: string, fn: (m: never) => void): void; off?(ev: string, fn: (m: never) => void): void }
interface PeerLike {
  id: string; open: boolean; disconnected: boolean; destroyed: boolean; socket: SocketLike;
  on(ev: string, fn: (...a: never[]) => void): void; off?(ev: string, fn?: (...a: never[]) => void): void;
  connect(id: string, o: object): Conn; reconnect(): void; destroy(): void;
}

async function newPeer(opts: Record<string, unknown>, id?: string): Promise<PeerLike> {
  const { Peer } = await import('peerjs');
  return (id ? new Peer(id, opts) : new Peer(opts)) as unknown as PeerLike;
}
/** Is the peer's WebSocket to the matchmaking server open right now? */
const socketOpen = (p: PeerLike) => !!(p.socket as unknown as { _wsOpen?: () => boolean })._wsOpen?.();
/**
 * Resolves once the matchmaking server holds our id: on 'open', or, because the server takes back
 * a known id with the same token silently, once the socket has stayed open for a moment without
 * an error. Rejects on an error (id taken: 'id_taken') or after `ms`.
 */
function whenRegistered(p: PeerLike, ms = TIMING.SIGNAL_OPEN_MS): Promise<void> {
  if (p.open) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false, openSince = 0;
    const finish = (e?: PeerError) => { if (done) return; done = true; stopTimer(); stopPoll(); if (e) reject(e); else resolve(); };
    const stopTimer = after(ms, () => finish(new PeerError('Could not reach the matchmaking server.', 'network')));
    const stopPoll = every(250, () => {
      if (!socketOpen(p) || p.disconnected) { openSince = 0; return; }
      openSince ||= Date.now();
      if (Date.now() - openSince > 2500) finish();
    });
    p.on('open', () => finish());
    p.on('error', ((e: { type?: string }) => {
      if (p.open) return;
      finish(new PeerError(e?.type === 'unavailable-id' ? 'That room code is already in use.' : `Matchmaking server error (${e?.type ?? 'unknown'}).`, e?.type === 'unavailable-id' ? 'id_taken' : 'network'));
    }) as never);
  });
}

/**
 * Our own keep-alive for a matchmaking registration, on the background-safe clock: PeerJS's own
 * heartbeat runs on page timers, which a background tab can slow to once a minute, and the server
 * drops registrations that stay quiet for about that long.
 */
function keepAlive(p: PeerLike): () => void {
  return every(20000, () => { if (!p.disconnected && !p.destroyed) { try { p.socket.send({ type: 'HEARTBEAT' }); } catch { /* reconnecting */ } } });
}

/** A WebRTC data channel to the other side. */
class DirectLink extends BaseLink {
  constructor(peer: string, private conn: Conn) {
    super(peer, 'direct');
    conn.on('data', ((d: unknown) => { if (isWire(d)) this.receive(d); }) as never);
    conn.on('close', () => this.lost());
    conn.on('error', () => this.lost());
  }
  send(w: Wire) { if (!this.closed && this.conn.open) { try { this.conn.send(w); } catch { /* channel closing */ } } }
  protected shutdown() { try { this.conn.close(); } catch { /* closing */ } }
}

/**
 * Tunnelled messages are shaped like ICE-candidate signalling: the public server disconnects a
 * client that sends a candidate message without a candidate in it, but it forwards extra fields
 * untouched (verified against 0.peerjs.com by tests/e2e/peerjs-shapes.mjs).
 */
const TUNNEL_CID = 'dc_wctunnel';
const tunnelMessage = (dst: string, bytes: Uint8Array) => ({
  type: 'CANDIDATE', dst,
  payload: { candidate: { candidate: 'candidate:0 1 udp 1 0.0.0.0 9 typ host', sdpMLineIndex: 0, sdpMid: '0' }, type: 'data', connectionId: TUNNEL_CID, wct: toB64(bytes) },
});
/** Is this a tunnelled message (and not real WebRTC signalling)? */
const tunnelled = (m: { type?: string; payload?: { wct?: unknown; connectionId?: unknown } }) => m?.type === 'CANDIDATE' && typeof m.payload?.wct === 'string' && m.payload.connectionId === TUNNEL_CID;
/** PeerJS keeps candidates for connections it doesn't know (ours) until one opens: drop them. */
const forgetTunnelled = (p: PeerLike | null) => { (p as unknown as { _lostMessages?: Map<string, unknown> } | null)?._lostMessages?.delete(TUNNEL_CID); };

/** Messages tunnelled through the matchmaking server's WebSocket. */
class ServerLink extends BaseLink {
  private batch: Batcher;
  constructor(gid: string, private dst: string, key: CryptoKey, getSocket: () => SocketLike | null) {
    super(gid, 'server');
    this.batch = new Batcher(key, (b) => getSocket()?.send(tunnelMessage(this.dst, b)), {}, TIMING.BATCH_MS, 6000);
  }
  send(w: Wire) { if (!this.closed) this.batch.push(w); }
  feed(w: Wire) { this.receive(w); }
  dead() { this.lost(); }
  protected shutdown() { this.batch.flush(); }
}

// ---------------------------------------------------------------- host
export class PeerHostListener implements HostListener {
  private peer: PeerLike | null = null;
  private state: 'connecting' | 'up' | 'reconnecting' | 'down' = 'connecting';
  private stopped = false;
  private creating = false;
  private attempts = 0;
  private retry: (() => void) | null = null;
  private stopKeepAlive: (() => void) | null = null;
  private tunnels = new Map<string, ServerLink>(); // guest peer id -> link
  /** One token for every registration of this room: the server then gives the id back at once. */
  private token = rand(16);
  private add: (l: BaseLink) => void = () => {};
  private changed: () => void = () => {};
  private wake = () => {
    if (this.stopped) return;
    if (!this.peer || this.peer.destroyed) { this.retry?.(); this.retry = null; void this.recreate(); }
    else if (this.peer.disconnected) this.reconnectNow();
  };

  constructor(private id: string, private opts: Record<string, unknown>, private keys: RoomKeys, private accept: { direct: boolean; server: boolean }) {}

  async start(add: (l: BaseLink) => void, changed: () => void) {
    this.add = add; this.changed = changed;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      window.addEventListener('focus', this.wake);
      window.addEventListener('pageshow', this.wake);
      document.addEventListener('visibilitychange', this.wake);
    }
    try { await this.create(); }
    catch (e) {
      // a taken code is final (the host picks another); anything else is retried in the background
      if ((e as PeerError).code !== 'id_taken' && !this.stopped) { this.state = 'reconnecting'; this.changed(); this.schedule(); }
      throw e;
    }
  }
  private async create() {
    this.creating = true;
    try {
      const p = await newPeer({ ...this.opts, token: this.token }, this.id);
      if (this.stopped) { p.destroy(); return; }
      this.peer = p;
      this.stopKeepAlive?.();
      this.stopKeepAlive = keepAlive(p);
      p.on('connection', ((c: Conn) => this.onConnection(c)) as never);
      p.on('disconnected', () => { if (this.stopped || p !== this.peer) return; this.state = 'reconnecting'; this.changed(); this.schedule(); });
      p.on('open', () => { if (p !== this.peer) return; this.state = 'up'; this.attempts = 0; this.changed(); });
      p.on('error', ((e: { type?: string }) => {
        if (this.stopped || p !== this.peer || this.state === 'connecting') return; // (the first registration reports through whenRegistered)
        if (e?.type === 'peer-unavailable') return; // a tunnelled guest went away
        if (p.destroyed || p.disconnected) { this.state = 'reconnecting'; this.changed(); this.schedule(); }
      }) as never);
      p.socket.on('message', ((m: { type?: string; src?: string; payload?: { wct?: string } }) => { if (p === this.peer && tunnelled(m)) { forgetTunnelled(p); this.onTunnel(m.src ?? '', m.payload!.wct!); } }) as never);
      try { await whenRegistered(p); if (this.peer === p) { this.state = 'up'; this.attempts = 0; this.changed(); } }
      catch (e) { if (this.peer === p) { this.peer = null; this.stopKeepAlive?.(); this.stopKeepAlive = null; p.destroy(); } throw e; }
    } finally { this.creating = false; }
  }
  private schedule() {
    if (this.stopped || this.retry) return;
    const delay = [500, 1000, 2000, 4000, 8000, 15000][Math.min(this.attempts, 5)];
    this.attempts++;
    this.retry = after(delay, () => {
      this.retry = null;
      // reconnect the same registration whenever possible: a new one would cut every direct link
      if (!this.peer || this.peer.destroyed) void this.recreate();
      else this.reconnectNow();
    });
  }
  private reconnectNow() {
    const p = this.peer;
    if (this.stopped) return;
    if (!p || p.destroyed) { void this.recreate(); return; }
    if (!p.disconnected) return;
    try { p.reconnect(); } catch { this.schedule(); return; }
    // the server takes a known id back silently (no 'open'): up once the socket stays open
    let n = 0;
    const check = () => {
      if (this.peer !== p || this.stopped || p.disconnected || this.state === 'up') return;
      if (socketOpen(p)) { if (++n >= 3) { this.state = 'up'; this.attempts = 0; this.changed(); return; } }
      else n = 0;
      after(1000, check);
    };
    after(1000, check);
  }
  private async recreate() {
    if (this.stopped || this.creating) return;
    const old = this.peer;
    this.peer = null;
    try { old?.destroy(); } catch { /* gone */ }
    try { await this.create(); }
    catch { if (!this.stopped) { this.state = 'reconnecting'; this.changed(); this.schedule(); } }
  }
  private onConnection(c: Conn) {
    if (!this.accept.direct) { c.close(); return; }
    let linked = false;
    const t = setTimeout(() => { if (!linked) c.close(); }, TIMING.LINK_TIMEOUT_MS);
    c.on('data', ((d: unknown) => {
      if (linked || !isWire(d) || d.k !== 'hello' || typeof d.gid !== 'string') return;
      linked = true; clearTimeout(t);
      this.add(new DirectLink(d.gid.slice(0, 24), c));
    }) as never);
  }
  private rx = new Inbox();
  private onTunnel(src: string, data: string) {
    if (!this.accept.server || !src) return;
    let bytes: Uint8Array;
    try { bytes = fromB64(data); } catch { return; }
    // decrypt in arrival order, so the messages of one guest stay in order
    this.rx.open(this.keys.key, bytes, (env) => {
      const e = env as { w?: unknown[] };
      if (!Array.isArray(e.w)) return;
      let link = this.tunnels.get(src);
      for (const w of e.w) {
        if (!isWire(w)) continue;
        if (!link || link.closed) {
          if (w.k !== 'hello' || typeof w.gid !== 'string') continue;
          link = new ServerLink(w.gid.slice(0, 24), src, this.keys.key, () => this.peer?.socket ?? null);
          this.tunnels.set(src, link);
          const l = link;
          link.onClose(() => { if (this.tunnels.get(src) === l) this.tunnels.delete(src); });
          this.add(link);
          continue;
        }
        link.feed(w);
      }
    });
  }
  stop() {
    this.stopped = true;
    this.retry?.();
    this.retry = null;
    this.stopKeepAlive?.();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.wake);
      window.removeEventListener('focus', this.wake);
      window.removeEventListener('pageshow', this.wake);
      document.removeEventListener('visibilitychange', this.wake);
    }
    for (const l of this.tunnels.values()) l.close();
    this.tunnels.clear();
    // give the goodbyes a moment to go out before the connection to the server closes
    const p = this.peer;
    after(500, () => { if (this.peer === p) this.peer = null; try { p?.destroy(); } catch { /* gone */ } });
    this.state = 'down';
  }
  status(): ListenerStatus[] {
    const up = this.state === 'up' && !!this.peer && !this.peer.disconnected;
    return [{ name: 'matchmaking server', up, detail: this.state }];
  }
}

// ---------------------------------------------------------------- guest
export interface PeerDial {
  direct: Promise<DirectLink> | null;
  server: Promise<ServerLink> | null;
  /** Resolves 'notfound' if the server says nobody holds the host id, 'network' if it is unreachable. */
  signal: Promise<'ok' | 'notfound' | 'network'>;
  /** The direct path got an answer from the host (so it exists but the networks could not connect). */
  answered(): boolean;
  /** Stop everything except the chosen link. */
  finish(keep: 'direct' | 'server' | null): void;
}
export function dialPeer(hostId: string, opts: Record<string, unknown>, keys: RoomKeys, gid: string, name: string, use: { direct: boolean; server: boolean }): PeerDial {
  let peer: PeerLike | null = null;
  let conn: Conn | null = null;
  let answered = false, finished = false;
  let helloTimer: ReturnType<typeof setInterval> | null = null;
  let tunnel: ServerLink | null = null;
  let directLink: DirectLink | null = null;
  let stopDirect: (() => void) | null = null;
  let signalResolve: (v: 'ok' | 'notfound' | 'network') => void = () => {};
  const signal = new Promise<'ok' | 'notfound' | 'network'>((r) => { signalResolve = r; });
  let released = false, stopKeepAlive: (() => void) | null = null;
  /** Give up this guest's matchmaking registration (also closes its WebRTC connections). */
  const release = () => {
    if (released) return;
    released = true;
    stopKeepAlive?.();
    try { peer?.destroy(); } catch { /* gone */ }
  };
  const ready = newPeer(opts).then(async (p) => {
    peer = p;
    if (released) { p.destroy(); throw new PeerError('cancelled', 'network'); }
    await whenRegistered(p);
    if (!released) stopKeepAlive = keepAlive(p);
    return p;
  });
  ready.catch(() => signalResolve('network'));

  const direct = use.direct ? new Promise<DirectLink>((resolve, reject) => {
    ready.then((p) => {
      if (finished) return;
      const c = p.connect(hostId, { reliable: true, serialization: 'json', metadata: { gid } });
      conn = c;
      const t = setTimeout(() => { stop(); reject(new PeerError(answered ? 'direct connection blocked' : 'no answer', answered ? 'unreachable' : 'not_found')); }, TIMING.JOIN_BUDGET_MS);
      const watchAnswer = setInterval(() => { if (c.peerConnection?.remoteDescription) { answered = true; clearInterval(watchAnswer); } }, 250);
      const stop = () => { clearTimeout(t); clearInterval(watchAnswer); };
      stopDirect = stop;
      c.on('open', () => { c.send({ k: 'hello', gid, name } satisfies Wire); });
      c.on('data', ((d: unknown) => {
        if (isWire(d) && d.k === 'welcome' && !directLink) { stop(); directLink = new DirectLink(String(d.gid ?? 'host'), c); resolve(directLink); }
      }) as never);
      c.on('error', () => { stop(); reject(new PeerError('direct connection failed', 'unreachable')); });
      c.on('iceStateChanged', ((s: string) => { if (s === 'failed') { stop(); reject(new PeerError('direct connection blocked', 'unreachable')); } }) as never);
      p.on('error', ((e: { type?: string }) => { if (e?.type === 'peer-unavailable' && !answered) { stop(); reject(new PeerError('no such room', 'not_found')); } }) as never);
    }, (e) => reject(e));
  }) : null;

  const server = use.server ? new Promise<ServerLink>((resolve, reject) => {
    ready.then((p) => {
      if (finished) return;
      const link = new ServerLink('host', hostId, keys.key, () => (peer && !peer.destroyed ? peer.socket : null));
      tunnel = link;
      let welcomed = false;
      const rx = new Inbox();
      p.socket.on('message', ((m: { type?: string; src?: string; payload?: { wct?: string } }) => {
        if (!tunnelled(m)) return;
        forgetTunnelled(p);
        if (m.src !== hostId) return;
        let bytes: Uint8Array;
        try { bytes = fromB64(m.payload!.wct!); } catch { return; }
        rx.open(keys.key, bytes, (env) => {
          const e = env as { w?: unknown[] };
          if (!Array.isArray(e.w)) return;
          for (const w of e.w) {
            if (!isWire(w)) continue;
            if (!welcomed && w.k === 'welcome') { welcomed = true; link.peer = String(w.gid ?? 'host'); if (helloTimer) clearInterval(helloTimer); signalResolve('ok'); resolve(link); }
            else if (welcomed) link.feed(w);
          }
        });
      }) as never);
      const say = () => link.send({ k: 'hello', gid, name });
      say();
      helloTimer = setInterval(say, TIMING.HELLO_EVERY_MS);
      // the server answers EXPIRE (peer-unavailable) when nobody holds the host id
      const giveUp = setTimeout(() => { if (!welcomed) { if (helloTimer) clearInterval(helloTimer); reject(new PeerError('no answer from the host', 'not_found')); } }, TIMING.JOIN_BUDGET_MS);
      p.on('error', ((e: { type?: string }) => {
        if (e?.type !== 'peer-unavailable' || welcomed) return;
        // the server could not deliver our hello: nobody holds this room code right now
        signalResolve('notfound');
        clearTimeout(giveUp);
        if (helloTimer) clearInterval(helloTimer);
        reject(new PeerError('no such room', 'not_found'));
      }) as never);
    }, (e) => reject(e));
  }) : null;

  return {
    direct, server, signal,
    answered: () => answered,
    finish(keep) {
      finished = true;
      if (helloTimer) clearInterval(helloTimer);
      stopDirect?.();
      if (keep !== 'direct') { try { conn?.close(); } catch { /* closing */ } }
      if (keep !== 'server') tunnel?.dead();
      // the registration is needed only while the chosen link lives (a goodbye goes out first)
      const kept = keep === 'direct' ? directLink : keep === 'server' ? tunnel : null;
      if (!kept) release();
      else kept.onClose(() => { after(1000, release); });
    },
  };
}
