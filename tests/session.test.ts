// Multiplayer sessions over in-memory links: the real Session, HostRoom and GuestRoom with no
// network. Covers the situations a review reproduced: copies of the game for several guests at
// once, a reloaded guest tab, orders during a copy, late chunk re-sends, oversized orders, the host
// closing the game, and a host broker connection dropping for a moment.
import { describe, it, expect } from 'vitest';
import { HostRoom, GuestRoom, type HostListener } from '../src/ui/net/star';
import { BaseLink, type Wire, type Via } from '../src/ui/net/wire';
import { Session, type SessionHooks } from '../src/ui/net/session';
import { every } from '../src/ui/net/clock';
import { MqttHostListener, dialMqtt } from '../src/ui/net/relay';
import { roomKeys } from '../src/ui/net/crypt';
import { newGame } from '../src/engine/setup';
import { stateHash } from '../src/engine/commands';
import type { GameState } from '../src/engine/types';
// @ts-expect-error plain JS test helper
import { startBroker } from './e2e/mqtt-broker.mjs';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number) { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await wait(100); return cond(); }

class TestLink extends BaseLink {
  other!: TestLink;
  sent: Wire[] = [];
  send(w: Wire) {
    if (this.closed) return;
    this.sent.push(w);
    const copy = JSON.parse(JSON.stringify(w)) as Wire;
    setTimeout(() => this.other.deliverIn(copy), 1);
  }
  deliverIn(w: Wire) { if (w.k === 'bye') { this.lost(); return; } this.receive(w); }
  protected shutdown() { setTimeout(() => this.other.lost(), 1); }
  lost() { super.lost(); }
}
function pair(via: Via, hostGid: string, guestGid: string) {
  const h = new TestLink(guestGid, via), g = new TestLink(hostGid, via);
  h.other = g; g.other = h;
  return { h, g };
}
const listener: HostListener = { start: async () => {}, stop: () => {}, status: () => [{ name: 'test', up: true }] };

interface Side { s: Session; st: { game: GameState | null; speed: number; toasts: string[] } }
type Priv = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const priv = (s: Session) => s as unknown as Priv;
function mkSession(role: 'host' | 'guest', name: string): Side {
  const st = { game: null as GameState | null, speed: 0, toasts: [] as string[] };
  let s: Session;
  const hooks: SessionHooks = {
    onGame: (g) => { st.game = g; },
    onTick: () => {},
    // like the store: the host's speed changes go into the shared stream
    onSpeed: (i) => { st.speed = i; if (role === 'host') s.hostSpeed(i); },
    onResult: () => {},
    onChange: () => {},
    toast: (t) => { st.toasts.push(t); },
    getGame: () => st.game,
    getSpeed: () => st.speed,
  };
  s = new Session(role, 'abcdef', name, hooks);
  return { s, st };
}
async function attach(side: Side, room: HostRoom | GuestRoom) {
  const p = priv(side.s);
  p.room = room;
  p.attach();
  await p.announce();
  if (side.s.role === 'guest') p.stopWatchdog = every(500, () => p.guestWatchdog());
}
/** A host playing Poland with guests on the given nations, game started. */
async function game(guests: [string, string][], via: Via = 'direct') {
  const H = mkSession('host', 'Host');
  const room = new HostRoom('H', [listener]);
  H.s.nation = 'POL';
  await attach(H, room);
  const G: Record<string, Side & { link: TestLink }> = {};
  for (const [gid, nation] of guests) {
    const side = mkSession('guest', gid);
    const p = pair(via, 'H', gid);
    room.addLink(p.h);
    side.s.nation = nation;
    await attach(side, new GuestRoom(gid, p.g));
    G[gid] = { ...side, link: p.h };
  }
  await wait(200);
  const g = newGame('sandbox', { seed: 7, nation: 'POL', players: guests.map(([, n]) => n) });
  await H.s.hostStart(g);
  await until(() => Object.values(G).every((x) => x.s.phase === 'playing'), 5000);
  return { H, room, G, g };
}
const stop = async (...sides: Side[]) => { for (const x of sides) { priv(x.s).stopWatchdog?.(); priv(x.s).closed = true; } };

describe('multiplayer session', () => {
  it('two guests that need a copy at the same time both get one, and the clock resumes', async () => {
    const { H, G, g } = await game([['B', 'DEU'], ['C', 'FRA']]);
    expect(stateHash(G.B.st.game!)).toBe(stateHash(g));
    H.s.hostSpeed(2); H.st.speed = 2;
    priv(G.B.s).requestSnapshot();
    await wait(300);
    priv(G.C.s).requestSnapshot();
    expect(await until(() => G.B.s.phase === 'playing' && G.C.s.phase === 'playing' && !priv(G.B.s).stalled && !priv(G.C.s).stalled && priv(H.s).sending === 0, 40000)).toBe(true);
    expect(H.st.speed).toBe(2); // resumed
    H.s.hostSpeed(0); H.st.speed = 0;
    await wait(1500);
    expect(stateHash(G.B.st.game!)).toBe(stateHash(g));
    expect(stateHash(G.C.st.game!)).toBe(stateHash(g));
    await stop(G.B, G.C);
  });

  it('a copy for one guest goes only to that guest', async () => {
    const { H, G } = await game([['B', 'DEU'], ['C', 'FRA']]);
    const before = G.C.link.sent.length;
    const snapsTo = (l: TestLink) => l.sent.filter((w) => w.k === 'ev' && w.topic === 'snap').length;
    const cBefore = snapsTo(G.C.link), bBefore = snapsTo(G.B.link);
    await H.s.sendSnapshot('B');
    expect(snapsTo(G.B.link) - bBefore).toBeGreaterThan(10);
    expect(snapsTo(G.C.link) - cBefore).toBe(0);
    expect(G.C.link.sent.length - before).toBeLessThan(20); // only the clock and presence
    await stop(G.B, G.C);
  });

  it('a reloaded guest tab gets its seat back and the host is not left paused', async () => {
    const { H, room, G, g } = await game([['B', 'DEU']], 'server');
    H.s.hostSpeed(2); H.st.speed = 2;
    // the old page vanishes without a goodbye; the new page (same tab id) has picked no nation yet
    await stop(G.B);
    (G.B.link.other as TestLink).closed = true;
    const B2 = mkSession('guest', 'B');
    const p2 = pair('server', 'H', 'B');
    room.addLink(p2.h);
    await attach(B2, new GuestRoom('B', p2.g));
    expect(await until(() => B2.s.phase === 'playing', 30000)).toBe(true);
    expect(B2.s.nation).toBe('DEU');
    expect(await until(() => priv(H.s).sending === 0 && H.st.speed === 2, 15000)).toBe(true);
    await wait(12000); // no loop: it stays that way
    expect(priv(H.s).sending).toBe(0);
    expect(H.st.speed).toBe(2);
    expect(B2.st.game!.player).toBe('DEU');
    void g;
    await stop(B2);
  });

  it('an order executed while a copy is being made is not lost', async () => {
    const { H, G, g } = await game([['B', 'DEU'], ['C', 'FRA']]);
    void H.s.sendSnapshot('B');
    priv(G.B.s).stalled = true;
    priv(H.s).onCmd({ topic: 'cmd', data: { id: 'x1', n: 'doRecruit', a: ['infantry', g.nations.FRA.capital] }, peer: 'C', isMe: false, sameTab: false });
    expect(await until(() => priv(H.s).sending === 0 && G.B.s.phase === 'playing' && !priv(G.B.s).stalled, 30000)).toBe(true);
    await wait(500);
    expect(stateHash(G.B.st.game!)).toBe(stateHash(g));
    expect(stateHash(G.C.st.game!)).toBe(stateHash(g));
    await stop(G.B, G.C);
  });

  it('a late chunk re-send does not un-pause, and a speed request during a copy applies after it', async () => {
    const { H, G } = await game([['B', 'DEU']]);
    H.s.hostSpeed(2); H.st.speed = 2;
    await H.s.sendSnapshot('B');
    expect(H.st.speed).toBe(2);
    H.s.hostSpeed(0); H.st.speed = 0;
    const sid = priv(H.s).recent.at(-1).sid;
    priv(H.s).onNeed({ topic: 'need', data: { sid, miss: [3] }, peer: 'B', isMe: false, sameTab: false });
    await wait(2500);
    expect(H.st.speed).toBe(0);
    // a guest asks for "fast" while a copy is on its way: it applies when the copy is done
    priv(H.s).snapAt.clear(); // (skip the per-guest pause between copies)
    const p = H.s.sendSnapshot('B');
    await wait(200);
    priv(H.s).onMeta({ topic: 'meta', data: { speed: 2 }, peer: 'B', isMe: false, sameTab: false });
    expect(H.st.speed).toBe(0);
    await p;
    expect(H.st.speed).toBe(2);
    await stop(G.B);
  });

  it('refuses oversized orders, and an unsendable event never stalls the stream', async () => {
    const { H, G, g } = await game([['B', 'DEU']]);
    expect(Session.orderFits([1, 'x'.repeat(5000)])).toBe(false);
    expect(Session.orderFits([1, 'Northern Army'])).toBe(true);
    const army = Object.values(g.armies).find((a) => a.owner === 'POL')!;
    H.s.record(['c', H.s.myPeer, 'POL', 'renameArmy', [army.id, 'x'.repeat(5000)]]); // (the store refuses these first)
    for (let i = 0; i < 5; i++) H.s.record(['t']);
    priv(H.s).flush();
    for (let i = 0; i < 5; i++) H.s.record(['t']);
    priv(H.s).flush();
    expect(await until(() => priv(G.B.s).applied === priv(H.s).seq && priv(G.B.s).buffer.size === 0, 5000)).toBe(true);
    await stop(G.B);
  });

  it('when the host closes the game, guests say so and stop reconnecting', async () => {
    const { H, G } = await game([['B', 'DEU']]);
    await H.s.close();
    expect(await until(() => G.B.s.status === 'The host closed the game.', 3000)).toBe(true);
    await wait(1500);
    expect(priv(G.B.s).reconnecting).toBe(false);
    expect(G.B.s.status).toBe('The host closed the game.');
    await stop(G.B);
  });
});

describe('MQTT relay', () => {
  it("keeps guests' links when the host's broker connection drops for a moment", async () => {
    const broker = await startBroker(18094);
    try {
      const url = 'ws://127.0.0.1:18094/mqtt';
      const keys = await roomKeys('blip42');
      const hl = new MqttHostListener([url], keys);
      const host = new HostRoom('H', [hl]);
      await hl.start(host.addLink, host.changed);
      await host.presence({ app: 'wc', role: 'host' });
      const dial = dialMqtt([url], keys, 'B', 'player');
      const guest = new GuestRoom('B', await dial.link);
      await guest.presence({ app: 'wc', role: 'guest' });
      const cmds: string[] = [];
      host.on('cmd', (m) => cmds.push(String((m.data as { n: string }).n)));
      await until(() => host.info().guests.length === 1, 3000);
      // the broker drops only the host's connection
      const clients = Object.values(broker.aedes.clients as Record<string, { id: string; close(): void }>);
      clients.find((c) => c.id.startsWith('wch'))!.close();
      expect(await until(() => !hl.status()[0].up, 3000)).toBe(true);
      expect(await until(() => hl.status()[0].up, 10000)).toBe(true); // reconnected
      await guest.emit('cmd', { n: 'after-blip' });
      expect(await until(() => cmds.includes('after-blip'), 5000)).toBe(true);
      await wait(13000); // past the link timeout: nobody was dropped
      expect(guest.connected()).toBe(true);
      expect(host.info().guests.map((x) => x.peer)).toEqual(['B']);
      await guest.leave(); await host.leave();
    } finally { broker.close(); }
  });
});
