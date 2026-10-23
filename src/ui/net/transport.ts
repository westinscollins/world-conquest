// Network transport. Inside claude.ai this is the viewer's live `room` capability; on any other
// website (e.g. GitHub Pages) players connect peer-to-peer via PeerJS; `?transport=local` selects a
// BroadcastChannel stand-in that connects tabs of one browser (automated tests).
import { joinStar, type JoinProgress } from './join';
import type { NetInfo } from './star';
import { probeBroker } from './relay';
import { DEFAULT_BROKERS } from './config';
/** Test hook for the live network check (tests/e2e/live.mjs). */
if (typeof window !== 'undefined') (window as unknown as { __wcNet: unknown }).__wcNet = { probeBroker, brokers: DEFAULT_BROKERS };
export type { JoinProgress, NetInfo };

export interface NetMessage { topic: string; data: unknown; peer: string; isMe: boolean; sameTab: boolean }
export interface NetPeer { peer: string; isMe: boolean; sameTab: boolean; presence: Record<string, unknown> }
export interface NetRoom {
  readonly kind: 'online' | 'local';
  myPeer(): string | null;
  emit(topic: string, data: unknown): Promise<void>;
  on(topic: string, fn: (m: NetMessage) => void): () => void;
  presence(patch: Record<string, unknown>): Promise<void>;
  peers(): readonly NetPeer[];
  onPeers(fn: (peers: readonly NetPeer[], joined: readonly NetPeer[], left: readonly NetPeer[]) => void): () => void;
  connected(): boolean;
  leave(): Promise<void>;
  /** Connection details for the lobby (public-site rooms only). */
  info?(): NetInfo;
}

/** Topics the game sends on (must match the artifact's room declaration). */
export const TOPICS = ['step', 'cmd', 'snap', 'need', 'meta'] as const;
export const MAX_MSG = 3600; // bytes of JSON per message (platform limit is 4 KiB)

type RoomLike = {
    emit(t: string, d?: unknown): Promise<void>;
    on(t: string, fn: (m: { topic: string; data?: unknown; peer: string; isMe: boolean; sameTab: boolean }) => void, onErr?: (e: unknown) => void): () => void;
    presence(p: Record<string, unknown>): Promise<void>;
    peers(): readonly { peer: string; isMe: boolean; sameTab: boolean; presence: Record<string, unknown> }[];
    onPeers(fn: (c: { peers: readonly NetPeer[]; joined: readonly NetPeer[]; left: readonly NetPeer[] }) => void, onErr?: (e: unknown) => void): () => void;
    connected(): boolean;
};
type RoomApi = RoomLike & {
  join(name: string): Promise<{
    emit(t: string, d?: unknown): Promise<void>;
    on(t: string, fn: (m: { topic: string; data?: unknown; peer: string; isMe: boolean; sameTab: boolean }) => void, onErr?: (e: unknown) => void): () => void;
    presence(p: Record<string, unknown>): Promise<void>;
    peers(): readonly { peer: string; isMe: boolean; sameTab: boolean; presence: Record<string, unknown> }[];
    onPeers(fn: (c: { peers: readonly NetPeer[]; joined: readonly NetPeer[]; left: readonly NetPeer[] }) => void, onErr?: (e: unknown) => void): () => void;
    connected(): boolean;
    leave(): Promise<void>;
  }>;
};

let roomApi: Promise<RoomApi | null> | null = null;
function onlineApi(): Promise<RoomApi | null> {
  if (!roomApi) {
    const c = (typeof window !== 'undefined' ? (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude : undefined);
    roomApi = c?.use ? (c.use('room') as Promise<RoomApi | null>).catch(() => null) : Promise.resolve(null);
  }
  return roomApi;
}

/** True when this copy runs inside claude.ai (the hosted page), where only the online room may be used. */
export function isHosted() {
  return typeof window !== 'undefined' && !!(window as unknown as { claude?: unknown }).claude;
}
/**
 * Which transport this page can use: 'online' (hosted page with the live room), 'local' (a copy
 * running outside claude.ai: tabs of the same browser), or 'unavailable' (on claude.ai, but this
 * viewer cannot connect to the room — never silently fall back to local there, or players end up
 * in separate private rooms and cannot see each other).
 */
export async function transportKind(): Promise<'online' | 'p2p' | 'local' | 'unavailable'> {
  if (await onlineApi()) return 'online';
  if (isHosted()) return 'unavailable';
  if (wantsLocal()) return typeof BroadcastChannel !== 'undefined' ? 'local' : 'unavailable';
  return typeof RTCPeerConnection !== 'undefined' ? 'p2p' : 'unavailable';
}
function wantsLocal() {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('transport') === 'local';
}

export async function joinRoom(name: string, role: 'host' | 'guest', opts: { onProgress?: (p: JoinProgress) => void; onChanged?: () => void } = {}): Promise<NetRoom> {
  const api = await onlineApi();
  if (api) {
    let r: Awaited<ReturnType<RoomApi['join']>>;
    try {
      r = await api.join(name);
    } catch {
      // named rooms refused for this viewer: share the page's main room, keyed by the room name
      return lobbyRoom(api, name);
    }
    return {
      kind: 'online',
      myPeer: () => r.peers().find((p) => p.sameTab)?.peer ?? null,
      emit: (t, d) => r.emit(t, d),
      on: (t, fn) => r.on(t, (m) => fn({ topic: m.topic, data: m.data, peer: m.peer, isMe: m.isMe, sameTab: m.sameTab })),
      presence: (p) => r.presence(p),
      peers: () => r.peers(),
      onPeers: (fn) => r.onPeers((c) => fn(c.peers, c.joined, c.left)),
      connected: () => r.connected(),
      leave: () => r.leave(),
    };
  }
  if (isHosted()) throw new Error('Online play is not available to you on this page (see the note above).');
  if (wantsLocal()) return new LocalRoom(name);
  return joinStar(name, role, opts.onProgress, opts.onChanged);
}

/** Fallback over the page's main room: every message and presence carries the room name and others are ignored. */
function lobbyRoom(api: RoomLike, name: string): NetRoom {
  const mine = (p: { presence: Record<string, unknown> }) => p.presence?.room === name;
  const filter = (peers: readonly NetPeer[]) => peers.filter((p) => p.sameTab || mine(p));
  return {
    kind: 'online',
    myPeer: () => api.peers().find((p) => p.sameTab)?.peer ?? null,
    emit: (t, d) => api.emit(t, { room: name, d }),
    on: (t, fn) => api.on(t, (m) => { const w = m.data as { room?: string; d?: unknown }; if (w?.room === name) fn({ topic: m.topic, data: w.d, peer: m.peer, isMe: m.isMe, sameTab: m.sameTab }); }),
    presence: (p) => api.presence({ ...p, room: name }),
    peers: () => filter(api.peers()),
    onPeers: (fn) => api.onPeers((c) => fn(filter(c.peers), filter(c.joined), c.left)),
    connected: () => api.connected(),
    leave: async () => { await api.presence({ app: null, room: null, role: null, name: null, nation: null, phase: null, v: null }); },
  };
}

/** BroadcastChannel stand-in with the same contract (incl. size limit and optional message loss). */
class LocalRoom implements NetRoom {
  readonly kind = 'local' as const;
  private ch: BroadcastChannel;
  private me = Math.random().toString(36).slice(2, 10);
  private mine: Record<string, unknown> = {};
  private others = new Map<string, { presence: Record<string, unknown>; seen: number }>();
  private handlers = new Map<string, Set<(m: NetMessage) => void>>();
  private peerFns = new Set<(p: readonly NetPeer[], j: readonly NetPeer[], l: readonly NetPeer[]) => void>();
  private timer: ReturnType<typeof setInterval>;
  private snapshot: readonly NetPeer[] = [];
  /** Test hook: ?netdrop=0.1 drops 10% of incoming messages to exercise resync. */
  private drop = Number(new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('netdrop') || 0);

  constructor(name: string) {
    this.ch = new BroadcastChannel(`wc-local-${name}`);
    this.ch.onmessage = (ev) => this.receive(ev.data);
    this.timer = setInterval(() => { this.announce(); this.prune(); }, 700);
    setTimeout(() => { this.announce(); this.ch.postMessage({ k: 'hello', from: this.me }); this.rebuild([], []); }, 0);
  }
  myPeer() { return this.me; }
  connected() { return true; }
  async emit(topic: string, data: unknown) {
    if (JSON.stringify(data ?? null).length > 4096) throw Object.assign(new Error('data over 4 KiB'), { code: 'invalid_argument' });
    this.ch.postMessage({ k: 'ev', from: this.me, topic, data });
    setTimeout(() => this.deliver({ topic, data, peer: this.me, isMe: true, sameTab: true }), 0);
  }
  on(topic: string, fn: (m: NetMessage) => void) {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(fn); this.handlers.set(topic, set);
    return () => set.delete(fn);
  }
  async presence(patch: Record<string, unknown>) {
    for (const k in patch) { if (patch[k] === null) delete this.mine[k]; else this.mine[k] = patch[k]; }
    this.announce();
    this.rebuild([], []);
  }
  peers() { return this.snapshot; }
  onPeers(fn: (p: readonly NetPeer[], j: readonly NetPeer[], l: readonly NetPeer[]) => void) {
    this.peerFns.add(fn);
    setTimeout(() => fn(this.snapshot, this.snapshot, []), 0);
    return () => this.peerFns.delete(fn);
  }
  async leave() { this.ch.postMessage({ k: 'bye', from: this.me }); clearInterval(this.timer); this.ch.close(); }

  private announce() { this.ch.postMessage({ k: 'pres', from: this.me, presence: this.mine }); }
  private receive(m: { k: string; from: string; topic?: string; data?: unknown; presence?: Record<string, unknown> }) {
    if (m.from === this.me) return;
    if (m.k === 'ev') { if (this.drop && Math.random() < this.drop) return; this.deliver({ topic: m.topic!, data: m.data, peer: m.from, isMe: false, sameTab: false }); return; }
    if (m.k === 'hello') { this.announce(); return; }
    if (m.k === 'bye') { if (this.others.delete(m.from)) this.rebuild([], [m.from]); return; }
    if (m.k === 'pres') {
      const known = this.others.has(m.from);
      const prev = this.others.get(m.from);
      this.others.set(m.from, { presence: m.presence ?? {}, seen: Date.now() });
      if (!known || JSON.stringify(prev?.presence) !== JSON.stringify(m.presence)) this.rebuild(known ? [] : [m.from], []);
    }
  }
  private prune() {
    const gone: string[] = [];
    for (const [p, v] of this.others) if (Date.now() - v.seen > 3000) { this.others.delete(p); gone.push(p); }
    if (gone.length) this.rebuild([], gone);
  }
  private rebuild(joined: string[], left: string[]) {
    const prev = this.snapshot;
    this.snapshot = Object.freeze([
      { peer: this.me, isMe: true, sameTab: true, presence: { ...this.mine } },
      ...[...this.others].map(([peer, v]) => ({ peer, isMe: false, sameTab: false, presence: v.presence })),
    ]);
    const j = this.snapshot.filter((p) => joined.includes(p.peer));
    const l = prev.filter((p) => left.includes(p.peer));
    for (const fn of this.peerFns) fn(this.snapshot, j, l);
  }
  private deliver(m: NetMessage) { for (const fn of this.handlers.get(m.topic) ?? []) fn(m); }
}
