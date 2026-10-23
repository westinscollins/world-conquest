// PeerJS paths for the public website build. One PeerJS connection to the free public
// matchmaking server (0.peerjs.com, over HTTPS port 443) gives two ways to reach the host:
//  - direct: a WebRTC data channel (fastest; often blocked on school and office networks)
//  - server: messages tunnelled through the matchmaking server itself (works anywhere the
//    matchmaking server is reachable). Tunnelled messages are encrypted with the room key.
// The host keeps its registration alive: it re-registers after drops, sleep and network changes.
import { BaseLink, isWire, type Wire } from './wire';
import type { HostListener, ListenerStatus } from './star';
import { Batcher, fromB64, open, toB64, type RoomKeys } from './crypt';
import { TIMING } from './config';
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
/** Resolves when the peer is registered with the matchmaking server. */
function whenOpen(p: PeerLike, ms = TIMING.SIGNAL_OPEN_MS): Promise<void> {
  if (p.open) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new PeerError('Could not reach the matchmaking server.', 'network')), ms);
    p.on('open', () => { clearTimeout(t); resolve(); });
    p.on('error', ((e: { type?: string }) => {
      if (p.open) return;
      clearTimeout(t);
      reject(new PeerError(e?.type === 'unavailable-id' ? 'That room code is already in use.' : `Matchmaking server error (${e?.type ?? 'unknown'}).`, e?.type === 'unavailable-id' ? 'id_taken' : 'network'));
    }) as never);
  });
}

/**
 * Our own keep-alive for a matchmaking registration, on the background-safe clock: PeerJS's own
 * heartbeat runs on page timers, which a background tab can slow to once a minute, and the server
 * drops registrations that stay quiet for about that long.
 */
function keepAlive(p: PeerLike): () => void {
  return every(20000, () => { if (p.open && !p.disconnected && !p.destroyed) { try { p.socket.send({ type: 'HEARTBEAT' }); } catch { /* reconnecting */ } } });
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

/** Messages tunnelled through the matchmaking server's WebSocket. */
class ServerLink extends BaseLink {
  private batch: Batcher;
  constructor(gid: string, private dst: string, key: CryptoKey, getSocket: () => SocketLike | null) {
    super(gid, 'server');
    this.batch = new Batcher(key, (b) => getSocket()?.send({ type: 'CANDIDATE', dst: this.dst, payload: { wct: toB64(b) } }), {}, TIMING.BATCH_MS, 9000);
  }
  send(w: Wire) { if (!this.closed) this.batch.push(w); }
  feed(w: Wire) { this.receive(w); }
  dead() { this.lost(); }
  protected shutdown() { this.batch.flush(); }
}
/** Is this a tunnelled message (and not real WebRTC signalling)? */
const tunnelled = (m: { type?: string; payload?: { wct?: unknown; connectionId?: unknown } }) => m?.type === 'CANDIDATE' && typeof m.payload?.wct === 'string' && m.payload.connectionId == null;

// ---------------------------------------------------------------- host
export class PeerHostListener implements HostListener {
  private peer: PeerLike | null = null;
  private state: 'connecting' | 'up' | 'reconnecting' | 'down' = 'connecting';
  private stopped = false;
  private attempts = 0;
  private retry: (() => void) | null = null;
  private stopKeepAlive: (() => void) | null = null;
  private tunnels = new Map<string, ServerLink>(); // guest peer id -> link
  private add: (l: BaseLink) => void = () => {};
  private changed: () => void = () => {};
  private wake = () => { if (this.peer?.disconnected && !this.peer.destroyed) this.reconnectNow(); };

  constructor(private id: string, private opts: Record<string, unknown>, private keys: RoomKeys, private accept: { direct: boolean; server: boolean }) {}

  async start(add: (l: BaseLink) => void, changed: () => void) {
    this.add = add; this.changed = changed;
    await this.create();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      window.addEventListener('focus', this.wake);
      window.addEventListener('pageshow', this.wake);
      document.addEventListener('visibilitychange', this.wake);
    }
  }
  private async create() {
    const p = await newPeer(this.opts, this.id);
    this.peer = p;
    this.stopKeepAlive?.();
    this.stopKeepAlive = keepAlive(p);
    p.on('connection', ((c: Conn) => this.onConnection(c)) as never);
    p.on('disconnected', () => { if (this.stopped || p !== this.peer) return; this.state = 'reconnecting'; this.changed(); this.schedule(); });
    p.on('open', () => { if (p !== this.peer) return; this.state = 'up'; this.attempts = 0; this.changed(); });
    p.on('error', ((e: { type?: string }) => {
      if (this.stopped || p !== this.peer || !p.open && this.state === 'connecting') return;
      if (e?.type === 'peer-unavailable') return; // a tunnelled guest went away
      if (e?.type === 'unavailable-id') { this.state = 'reconnecting'; this.changed(); this.schedule(true); return; }
      if (p.disconnected) { this.state = 'reconnecting'; this.changed(); this.schedule(); }
    }) as never);
    p.socket.on('message', ((m: { type?: string; src?: string; payload?: { wct?: string } }) => { if (p === this.peer && tunnelled(m)) void this.onTunnel(m.src ?? '', m.payload!.wct!); }) as never);
    try { await whenOpen(p); this.state = 'up'; this.changed(); }
    catch (e) { if (this.peer === p) { this.peer = null; p.destroy(); } throw e; }
  }
  private schedule(recreate = false) {
    if (this.stopped || this.retry) return;
    const delay = [500, 1000, 2000, 4000, 8000, 15000][Math.min(this.attempts, 5)];
    this.attempts++;
    this.retry = after(delay, () => {
      this.retry = null;
      if (recreate || this.attempts > 4) void this.recreate();
      else this.reconnectNow();
    });
  }
  private reconnectNow() {
    const p = this.peer;
    if (!p || p.destroyed || this.stopped) { void this.recreate(); return; }
    if (!p.disconnected) return;
    try { p.reconnect(); } catch { void this.recreate(); return; }
    // the server re-attaches a known id without a new 'open'; treat a quiet few seconds as success
    after(3000, () => { if (this.peer === p && !p.disconnected && this.state !== 'up') { this.state = 'up'; this.attempts = 0; this.changed(); } });
  }
  private async recreate() {
    if (this.stopped) return;
    const old = this.peer;
    this.peer = null;
    try { old?.destroy(); } catch { /* gone */ }
    try { await this.create(); }
    catch { this.state = 'reconnecting'; this.changed(); this.schedule(true); }
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
  private async onTunnel(src: string, data: string) {
    if (!this.accept.server || !src) return;
    let bytes: Uint8Array;
    try { bytes = fromB64(data); } catch { return; }
    const env = (await open(this.keys.key, bytes)) as { w?: unknown[] } | null;
    if (!env || !Array.isArray(env.w)) return;
    let link = this.tunnels.get(src);
    for (const w of env.w) {
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
    try { this.peer?.destroy(); } catch { /* gone */ }
    this.peer = null;
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
    await whenOpen(p);
    if (!released) stopKeepAlive = keepAlive(p);
    return p;
  });
  ready.catch(() => signalResolve('network'));

  const direct = use.direct ? new Promise<DirectLink>((resolve, reject) => {
    ready.then((p) => {
      if (finished) return;
      const c = p.connect(hostId, { reliable: true, serialization: 'json', metadata: { gid } });
      conn = c;
      const t = setTimeout(() => reject(new PeerError(answered ? 'direct connection blocked' : 'no answer', answered ? 'unreachable' : 'not_found')), TIMING.JOIN_BUDGET_MS);
      const watchAnswer = setInterval(() => { if (c.peerConnection?.remoteDescription) { answered = true; clearInterval(watchAnswer); } }, 250);
      c.on('open', () => { c.send({ k: 'hello', gid, name } satisfies Wire); });
      c.on('data', ((d: unknown) => {
        if (isWire(d) && d.k === 'welcome') { clearTimeout(t); clearInterval(watchAnswer); directLink = new DirectLink(String(d.gid ?? 'host'), c); resolve(directLink); }
      }) as never);
      c.on('error', () => { clearTimeout(t); clearInterval(watchAnswer); reject(new PeerError('direct connection failed', 'unreachable')); });
      c.on('iceStateChanged', ((s: string) => { if (s === 'failed') { clearTimeout(t); clearInterval(watchAnswer); reject(new PeerError('direct connection blocked', 'unreachable')); } }) as never);
      p.on('error', ((e: { type?: string }) => { if (e?.type === 'peer-unavailable' && !answered) { clearTimeout(t); clearInterval(watchAnswer); reject(new PeerError('no such room', 'not_found')); } }) as never);
    }, (e) => reject(e));
  }) : null;

  const server = use.server ? new Promise<ServerLink>((resolve, reject) => {
    ready.then((p) => {
      if (finished) return;
      const link = new ServerLink('host', hostId, keys.key, () => (peer && !peer.destroyed ? peer.socket : null));
      tunnel = link;
      let welcomed = false;
      p.socket.on('message', (async (m: { type?: string; src?: string; payload?: { wct?: string } }) => {
        if (!tunnelled(m) || m.src !== hostId) return;
        let bytes: Uint8Array;
        try { bytes = fromB64(m.payload!.wct!); } catch { return; }
        const env = (await open(keys.key, bytes)) as { w?: unknown[] } | null;
        if (!env || !Array.isArray(env.w)) return;
        for (const w of env.w) {
          if (!isWire(w)) continue;
          if (!welcomed && w.k === 'welcome') { welcomed = true; link.peer = String(w.gid ?? 'host'); if (helloTimer) clearInterval(helloTimer); signalResolve('ok'); resolve(link); }
          else if (welcomed) link.feed(w);
        }
      }) as never);
      const say = () => link.send({ k: 'hello', gid, name });
      say();
      helloTimer = setInterval(say, TIMING.HELLO_EVERY_MS);
      // the server answers EXPIRE (peer-unavailable) when nobody holds the host id
      let unavailable = 0;
      const giveUp = setTimeout(() => { if (!welcomed) { if (helloTimer) clearInterval(helloTimer); reject(new PeerError('no answer from the host', 'not_found')); } }, TIMING.JOIN_BUDGET_MS);
      p.on('error', ((e: { type?: string }) => {
        if (e?.type !== 'peer-unavailable' || welcomed || ++unavailable < 1) return;
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
      if (keep !== 'direct') { try { conn?.close(); } catch { /* closing */ } }
      if (keep !== 'server') tunnel?.dead();
      // the registration is needed only while the chosen link lives (a goodbye goes out first)
      const kept = keep === 'direct' ? directLink : keep === 'server' ? tunnel : null;
      if (!kept) release();
      else kept.onClose(() => { after(1000, release); });
    },
  };
}
