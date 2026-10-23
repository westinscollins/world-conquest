// Star-topology rooms over any mix of links. The host accepts guests on every path at once
// (direct WebRTC, the matchmaking-server tunnel, MQTT relays) and relays every message and
// presence update between them; each guest talks to the host over the one path it chose.
import type { NetMessage, NetPeer, NetRoom } from './transport';
import type { Link, Via, Wire } from './wire';
import { TIMING } from './config';
import { every } from './clock';

export interface ListenerStatus { name: string; up: boolean; detail?: string }
export interface HostListener {
  /** Begin accepting links; resolves once listening (rejects if this path is unusable). */
  start(add: (l: Link) => void, changed: () => void): Promise<void>;
  stop(): void;
  status(): ListenerStatus[];
}
export interface NetInfo { role: 'host' | 'guest'; via?: Via; paths: ListenerStatus[]; guests: { peer: string; via: Via | null }[] }

type Peers = (p: readonly NetPeer[], j: readonly NetPeer[], l: readonly NetPeer[]) => void;

abstract class StarBase {
  readonly kind = 'online' as const;
  protected handlers = new Map<string, Set<(m: NetMessage) => void>>();
  protected peerFns = new Set<Peers>();
  protected mine: Record<string, unknown> = {};
  protected snapshot: readonly NetPeer[] = [];
  protected others = new Map<string, Record<string, unknown>>();
  protected stopBeat: () => void;
  constructor(protected me: string, protected drop = 0) {
    this.stopBeat = every(TIMING.PING_MS, () => this.beat());
    setTimeout(() => this.rebuild([], []), 0);
  }
  protected abstract beat(): void;
  myPeer() { return this.me; }
  on(topic: string, fn: (m: NetMessage) => void) {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(fn); this.handlers.set(topic, set);
    return () => { set.delete(fn); };
  }
  peers() { return this.snapshot; }
  onPeers(fn: Peers) {
    this.peerFns.add(fn);
    setTimeout(() => fn(this.snapshot, this.snapshot, []), 0);
    return () => { this.peerFns.delete(fn); };
  }
  protected checkSize(data: unknown) {
    if (JSON.stringify(data ?? null).length > 4096) throw Object.assign(new Error('data over 4 KiB'), { code: 'invalid_argument' });
  }
  protected rebuild(joined: string[], left: string[]) {
    const prev = this.snapshot;
    this.snapshot = Object.freeze([
      { peer: this.me, isMe: true, sameTab: true, presence: { ...this.mine } },
      ...[...this.others].map(([peer, presence]) => ({ peer, isMe: false, sameTab: false, presence })),
    ]);
    const j = this.snapshot.filter((p) => joined.includes(p.peer));
    const l = prev.filter((p) => left.includes(p.peer));
    for (const fn of this.peerFns) fn(this.snapshot, j, l);
  }
  protected deliver(m: NetMessage) {
    if (!m.isMe && this.drop && Math.random() < this.drop) return; // test hook: lossy network
    for (const fn of this.handlers.get(m.topic) ?? []) fn(m);
  }
}

interface GuestEntry { links: Map<Link, number>; active: Link | null; joined: boolean; presence: Record<string, unknown>; sid?: string }

export class HostRoom extends StarBase implements NetRoom {
  private guests = new Map<string, GuestEntry>();
  private up = true;
  constructor(me: string, private listeners: HostListener[], drop = 0, private onChanged: () => void = () => {}) { super(me, drop); }

  /** Called by a listener when a guest has said hello on a new link. */
  addLink = (link: Link) => {
    let e = this.guests.get(link.peer);
    if (!e) { e = { links: new Map(), active: null, joined: false, presence: {} }; this.guests.set(link.peer, e); }
    e.links.set(link, Date.now());
    link.onData((w) => this.fromLink(link, w));
    link.onClose(() => this.dropLink(link));
    link.send({ k: 'welcome', gid: this.me });
    this.onChanged();
  };
  changed = () => this.onChanged();

  connected() { return this.up && this.listeners.some((l) => l.status().some((s) => s.up)); }
  async emit(topic: string, data: unknown) {
    this.checkSize(data);
    const w: Wire = { k: 'ev', topic, data, from: this.me };
    for (const [gid] of this.guests) this.sendTo(gid, w);
    setTimeout(() => this.deliver({ topic, data, peer: this.me, isMe: true, sameTab: true }), 0);
  }
  async presence(patch: Record<string, unknown>) {
    for (const k in patch) { if (patch[k] === null) delete this.mine[k]; else this.mine[k] = patch[k]; }
    this.broadcastPeers();
    this.rebuild([], []);
  }
  async leave() {
    this.up = false;
    this.stopBeat();
    for (const e of this.guests.values()) for (const l of e.links.keys()) l.close();
    this.guests.clear();
    for (const l of this.listeners) l.stop();
  }
  info(): NetInfo {
    return { role: 'host', paths: this.listeners.flatMap((l) => l.status()), guests: [...this.guests].filter(([, e]) => e.joined).map(([peer, e]) => ({ peer, via: e.active?.via ?? null })) };
  }

  private sendTo(gid: string, w: Wire) {
    const e = this.guests.get(gid);
    if (!e) return;
    if (e.active && !e.active.closed) e.active.send(w);
    else for (const l of e.links.keys()) l.send(w);
  }
  private fromLink(link: Link, w: Wire) {
    const gid = link.peer;
    const e = this.guests.get(gid);
    if (!e) return;
    e.links.set(link, Date.now());
    switch (w.k) {
      case 'hello': link.send({ k: 'welcome', gid: this.me }); return;
      case 'bye': link.close(); return;
      case 'ping': return;
      case 'use':
        if (e.joined && (w.sid ? e.sid !== w.sid : e.active !== link)) {
          // the same tab connected again (e.g. after a reload): report it as leaving and rejoining
          e.active = link; e.sid = w.sid;
          this.others.delete(gid);
          this.rebuild([], [gid]);
          this.others.set(gid, e.presence);
          this.broadcastPeers();
          this.rebuild([gid], []);
          return;
        }
        e.active = link; e.sid = w.sid; this.markJoined(gid, e); return;
      case 'pres':
        e.active ??= link;
        e.presence = w.presence ?? {};
        this.others.set(gid, e.presence);
        if (!e.joined) this.markJoined(gid, e);
        else { this.broadcastPeers(); this.rebuild([], []); }
        return;
      case 'ev':
        if (typeof w.topic !== 'string') return;
        e.active ??= link;
        if (!e.joined) this.markJoined(gid, e);
        for (const [other] of this.guests) if (other !== gid) this.sendTo(other, { k: 'ev', topic: w.topic, data: w.data, from: gid });
        this.deliver({ topic: w.topic, data: w.data, peer: gid, isMe: false, sameTab: false });
        return;
      default:
    }
  }
  private markJoined(gid: string, e: GuestEntry) {
    if (e.joined) return;
    e.joined = true;
    this.others.set(gid, e.presence);
    this.broadcastPeers();
    this.rebuild([gid], []);
    this.onChanged();
  }
  private dropLink(link: Link) {
    const e = this.guests.get(link.peer);
    if (!e || !e.links.delete(link)) return;
    if (e.active === link) e.active = null;
    if (e.links.size) { this.onChanged(); return; }
    this.guests.delete(link.peer);
    if (e.joined) {
      this.others.delete(link.peer);
      this.broadcastPeers();
      this.rebuild([], [link.peer]);
    }
    this.onChanged();
  }
  private broadcastPeers() {
    const list = [{ peer: this.me, presence: this.mine }, ...[...this.others].map(([peer, presence]) => ({ peer, presence }))];
    for (const [gid, e] of this.guests) if (e.joined) this.sendTo(gid, { k: 'peers', list });
  }
  protected beat() {
    const now = Date.now();
    for (const [gid, e] of [...this.guests]) {
      for (const [l, seen] of [...e.links]) if (now - seen > TIMING.LINK_TIMEOUT_MS) l.close();
      if (this.guests.has(gid)) this.sendTo(gid, { k: 'ping' });
    }
  }
}

export class GuestRoom extends StarBase implements NetRoom {
  private up = true;
  private seen = Date.now();
  constructor(me: string, private link: Link, drop = 0) {
    super(me, drop);
    link.onData((w) => this.fromHost(w));
    link.onClose(() => this.hostGone());
    link.send({ k: 'use', sid: Math.random().toString(36).slice(2, 10) });
  }
  get via(): Via { return this.link.via; }
  connected() { return this.up && !this.link.closed; }
  async emit(topic: string, data: unknown) {
    this.checkSize(data);
    if (this.connected()) this.link.send({ k: 'ev', topic, data, from: this.me });
    setTimeout(() => this.deliver({ topic, data, peer: this.me, isMe: true, sameTab: true }), 0);
  }
  async presence(patch: Record<string, unknown>) {
    for (const k in patch) { if (patch[k] === null) delete this.mine[k]; else this.mine[k] = patch[k]; }
    if (this.connected()) this.link.send({ k: 'pres', presence: this.mine });
    this.rebuild([], []);
  }
  async leave() { this.up = false; this.stopBeat(); this.link.close(); }
  info(): NetInfo { return { role: 'guest', via: this.link.via, paths: [{ name: this.link.via, up: this.connected() }], guests: [] }; }

  private fromHost(w: Wire) {
    this.seen = Date.now();
    if (w.k === 'ev' && typeof w.topic === 'string') this.deliver({ topic: w.topic, data: w.data, peer: w.from ?? '', isMe: false, sameTab: false });
    else if (w.k === 'peers' && Array.isArray(w.list)) {
      const before = new Set(this.others.keys());
      this.others = new Map(w.list.filter((x) => x.peer !== this.me).map((x) => [x.peer, x.presence ?? {}]));
      const now = new Set(this.others.keys());
      this.rebuild([...now].filter((p) => !before.has(p)), [...before].filter((p) => !now.has(p)));
    } else if (w.k === 'bye') this.link.close();
  }
  private hostGone() {
    if (!this.up) return;
    this.up = false;
    const gone = [...this.others.keys()];
    this.others.clear();
    this.rebuild([], gone);
  }
  protected beat() {
    if (!this.connected()) return;
    if (Date.now() - this.seen > TIMING.LINK_TIMEOUT_MS) { this.link.close(); return; }
    this.link.send({ k: 'ping' });
  }
}
