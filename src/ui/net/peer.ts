// Peer-to-peer transport for the public website build: WebRTC data channels via PeerJS and its
// free public signalling server. Star topology: the host registers a well-known id derived from
// the room code; guests connect to it and the host relays every message and presence update.
import type { NetMessage, NetPeer, NetRoom } from './transport';

const PREFIX = 'worldconquest-v1-';
const HEARTBEAT_MS = 2000;
const TIMEOUT_MS = 8000;

type Wire =
  | { k: 'ev'; topic: string; data: unknown; from?: string }
  | { k: 'pres'; presence: Record<string, unknown> }
  | { k: 'peers'; list: { peer: string; presence: Record<string, unknown> }[] }
  | { k: 'ping' };

interface Conn { peer: string; open: boolean; send(d: unknown): void; close(): void; on(ev: string, fn: (...a: never[]) => void): void }
interface PeerLike { id: string; on(ev: string, fn: (...a: never[]) => void): void; connect(id: string, o: object): Conn; destroy(): void }

/** The free public PeerJS server by default; `?peerhost=host:port` points at a self-hosted one (tests). */
function serverOptions(): Record<string, unknown> {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('peerhost') : null;
  if (!q) return { debug: 0 };
  const [host, port] = q.split(':');
  return { debug: 0, host, port: Number(port || 9000), path: '/', secure: false };
}

export class PeerError extends Error { constructor(message: string, public code: string) { super(message); } }

async function makePeer(id?: string): Promise<PeerLike> {
  const { Peer } = await import('peerjs');
  const p = (id ? new Peer(id, serverOptions()) : new Peer(serverOptions())) as unknown as PeerLike;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new PeerError('Could not reach the matchmaking server. Check your internet connection and try again.', 'network')), TIMEOUT_MS);
    p.on('open', () => { clearTimeout(t); resolve(p); });
    p.on('error', ((e: { type?: string }) => {
      clearTimeout(t);
      if (e?.type === 'unavailable-id') reject(new PeerError('That room code is already in use.', 'id_taken'));
      else reject(new PeerError(`Connection error (${e?.type ?? 'unknown'}).`, e?.type ?? 'network'));
    }) as never);
  });
}

export async function joinPeerRoom(name: string, role: 'host' | 'guest'): Promise<NetRoom> {
  if (role === 'host') {
    const peer = await makePeer(PREFIX + name);
    return new PeerRoom(peer, null);
  }
  const peer = await makePeer();
  const conn = peer.connect(PREFIX + name, { reliable: true, serialization: 'json' });
  await new Promise<void>((resolve, reject) => {
    const fail = () => { peer.destroy(); reject(new PeerError('No game found with that code. Check the code and that the host has the lobby open.', 'not_found')); };
    const t = setTimeout(fail, TIMEOUT_MS);
    conn.on('open', () => { clearTimeout(t); resolve(); });
    peer.on('error', ((e: { type?: string }) => { if (e?.type === 'peer-unavailable') { clearTimeout(t); fail(); } }) as never);
  });
  return new PeerRoom(peer, conn);
}

class PeerRoom implements NetRoom {
  readonly kind = 'online' as const;
  private handlers = new Map<string, Set<(m: NetMessage) => void>>();
  private peerFns = new Set<(p: readonly NetPeer[], j: readonly NetPeer[], l: readonly NetPeer[]) => void>();
  private mine: Record<string, unknown> = {};
  private snapshot: readonly NetPeer[] = [];
  private others = new Map<string, Record<string, unknown>>();   // peer -> presence
  private guests = new Map<string, { conn: Conn; seen: number }>(); // host only
  private timer: ReturnType<typeof setInterval>;
  private up = true;

  constructor(private peer: PeerLike, private host: Conn | null) {
    if (host) {
      host.on('data', ((d: Wire) => this.fromHost(d)) as never);
      host.on('close', () => this.hostGone());
      host.on('error', () => this.hostGone());
    } else {
      peer.on('connection', ((c: Conn) => this.accept(c)) as never);
    }
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
    setTimeout(() => this.rebuild([], []), 0);
  }

  myPeer() { return this.peer.id; }
  connected() { return this.up; }

  async emit(topic: string, data: unknown) {
    if (JSON.stringify(data ?? null).length > 4096) throw Object.assign(new Error('data over 4 KiB'), { code: 'invalid_argument' });
    const w: Wire = { k: 'ev', topic, data, from: this.peer.id };
    if (this.host) { if (this.up) this.host.send(w); }
    else for (const g of this.guests.values()) if (g.conn.open) g.conn.send(w);
    setTimeout(() => this.deliver({ topic, data, peer: this.peer.id, isMe: true, sameTab: true }), 0);
  }
  on(topic: string, fn: (m: NetMessage) => void) {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(fn); this.handlers.set(topic, set);
    return () => set.delete(fn);
  }
  async presence(patch: Record<string, unknown>) {
    for (const k in patch) { if (patch[k] === null) delete this.mine[k]; else this.mine[k] = patch[k]; }
    if (this.host) { if (this.up) this.host.send({ k: 'pres', presence: this.mine } satisfies Wire); }
    else this.broadcastPeers();
    this.rebuild([], []);
  }
  peers() { return this.snapshot; }
  onPeers(fn: (p: readonly NetPeer[], j: readonly NetPeer[], l: readonly NetPeer[]) => void) {
    this.peerFns.add(fn);
    setTimeout(() => fn(this.snapshot, this.snapshot, []), 0);
    return () => this.peerFns.delete(fn);
  }
  async leave() {
    clearInterval(this.timer);
    this.up = false;
    try { this.host?.close(); for (const g of this.guests.values()) g.conn.close(); } catch { /* closing */ }
    this.peer.destroy();
  }

  // ---- host side
  private accept(c: Conn) {
    c.on('open', () => {
      this.guests.set(c.peer, { conn: c, seen: Date.now() });
      this.others.set(c.peer, {});
      this.broadcastPeers();
      this.rebuild([c.peer], []);
    });
    c.on('data', ((d: Wire) => this.fromGuest(c.peer, d)) as never);
    c.on('close', () => this.dropGuest(c.peer));
    c.on('error', () => this.dropGuest(c.peer));
  }
  private fromGuest(peer: string, d: Wire) {
    const g = this.guests.get(peer);
    if (!g) return;
    g.seen = Date.now();
    if (d.k === 'ping') return;
    if (d.k === 'pres') { this.others.set(peer, d.presence ?? {}); this.broadcastPeers(); this.rebuild([], []); return; }
    if (d.k === 'ev' && typeof d.topic === 'string') {
      const w: Wire = { k: 'ev', topic: d.topic, data: d.data, from: peer };
      for (const [p, o] of this.guests) if (p !== peer && o.conn.open) o.conn.send(w);
      this.deliver({ topic: d.topic, data: d.data, peer, isMe: false, sameTab: false });
    }
  }
  private dropGuest(peer: string) {
    if (!this.guests.delete(peer)) return;
    this.others.delete(peer);
    this.broadcastPeers();
    this.rebuild([], [peer]);
  }
  private broadcastPeers() {
    if (this.host) return;
    const list = [{ peer: this.peer.id, presence: this.mine }, ...[...this.others].map(([peer, presence]) => ({ peer, presence }))];
    for (const g of this.guests.values()) if (g.conn.open) g.conn.send({ k: 'peers', list } satisfies Wire);
  }

  // ---- guest side
  private fromHost(d: Wire) {
    if (d.k === 'ev' && typeof d.topic === 'string') this.deliver({ topic: d.topic, data: d.data, peer: d.from ?? '', isMe: false, sameTab: false });
    else if (d.k === 'peers' && Array.isArray(d.list)) {
      const before = new Set(this.others.keys());
      this.others = new Map(d.list.filter((x) => x.peer !== this.peer.id).map((x) => [x.peer, x.presence ?? {}]));
      const now = new Set(this.others.keys());
      this.rebuild([...now].filter((p) => !before.has(p)), [...before].filter((p) => !now.has(p)));
    }
  }
  private hostGone() {
    if (!this.up) return;
    this.up = false;
    const gone = [...this.others.keys()];
    this.others.clear();
    this.rebuild([], gone);
  }

  private beat() {
    if (this.host) { if (this.up && this.host.open) this.host.send({ k: 'ping' } satisfies Wire); return; }
    const now = Date.now();
    for (const [p, g] of this.guests) if (now - g.seen > TIMEOUT_MS) { g.conn.close(); this.dropGuest(p); }
  }
  private rebuild(joined: string[], left: string[]) {
    const prev = this.snapshot;
    this.snapshot = Object.freeze([
      { peer: this.peer.id, isMe: true, sameTab: true, presence: { ...this.mine } },
      ...[...this.others].map(([peer, presence]) => ({ peer, isMe: false, sameTab: false, presence })),
    ]);
    const j = this.snapshot.filter((p) => joined.includes(p.peer));
    const l = prev.filter((p) => left.includes(p.peer));
    for (const fn of this.peerFns) fn(this.snapshot, j, l);
  }
  private deliver(m: NetMessage) { for (const fn of this.handlers.get(m.topic) ?? []) fn(m); }
}
