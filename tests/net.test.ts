// Offline tests for the online-multiplayer connection layer.
import { describe, it, expect, afterAll } from 'vitest';
import { remainingLength, PacketReader, publishPacket, parsePublish, MqttClient } from '../src/ui/net/mqtt';
import { roomKeys, seal, open, toB64, fromB64, Batcher } from '../src/ui/net/crypt';
import { HostRoom, GuestRoom, type HostListener } from '../src/ui/net/star';
import { BaseLink, type Wire, type Via } from '../src/ui/net/wire';
import { extractCode } from '../src/ui/MultiplayerDialog';
// @ts-expect-error plain JS test helper
import { startBroker } from './e2e/mqtt-broker.mjs';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MQTT codec', () => {
  it('encodes remaining lengths at the byte boundaries', () => {
    expect(remainingLength(0)).toEqual([0]);
    expect(remainingLength(127)).toEqual([127]);
    expect(remainingLength(128)).toEqual([0x80, 1]);
    expect(remainingLength(16383)).toEqual([0xff, 0x7f]);
    expect(remainingLength(16384)).toEqual([0x80, 0x80, 1]);
  });
  it('reassembles packets split across and merged within WebSocket frames', () => {
    const big = new Uint8Array(20000).map((_, i) => i % 251);
    const a = publishPacket('t/a', new Uint8Array([1, 2, 3]));
    const b = publishPacket('t/b', big);
    const all = new Uint8Array(a.length + b.length); all.set(a); all.set(b, a.length);
    const r = new PacketReader();
    const got = [...r.push(all.subarray(0, 7)), ...r.push(all.subarray(7, 5000)), ...r.push(all.subarray(5000))];
    expect(got.length).toBe(2);
    expect(parsePublish(got[0]).topic).toBe('t/a');
    expect([...parsePublish(got[0]).payload]).toEqual([1, 2, 3]);
    expect(parsePublish(got[1]).payload.length).toBe(20000);
    expect(parsePublish(got[1]).payload[300]).toBe(300 % 251);
  });
});

describe('room encryption', () => {
  it('derives the same topic and key from the same code, and rejects tampering', async () => {
    const a = await roomKeys('k7m2xq'), b = await roomKeys('k7m2xq'), c = await roomKeys('k7m2xr');
    expect(a.tid).toBe(b.tid);
    expect(a.tid).not.toBe(c.tid);
    const box = await seal(a.key, { hello: 'world', n: [1, 2] });
    expect(await open(b.key, box)).toEqual({ hello: 'world', n: [1, 2] });
    expect(await open(c.key, box)).toBeNull();
    const bad = box.slice(); bad[20] ^= 1;
    expect(await open(a.key, bad)).toBeNull();
    expect([...fromB64(toB64(box))]).toEqual([...box]);
  });
  it('batches messages into ordered envelopes under the size cap', async () => {
    const k = await roomKeys('batch1');
    const out: Uint8Array[] = [];
    const bt = new Batcher(k.key, (b) => out.push(b), { s: 'me' }, 5, 1000);
    for (let i = 0; i < 30; i++) bt.push({ k: 'ev', topic: 't', data: 'x'.repeat(100), i });
    await wait(60);
    const envs = await Promise.all(out.map((b) => open(k.key, b))) as { s: string; w: { i: number }[] }[];
    expect(envs.length).toBeGreaterThan(2);
    expect(envs.every((e) => e.s === 'me')).toBe(true);
    expect(envs.flatMap((e) => e.w.map((w) => w.i))).toEqual([...Array(30).keys()]);
  });
});

describe('room code entry', () => {
  it('finds the code in pasted text and invite links', () => {
    expect(extractCode('k7m2xq')).toBe('k7m2xq');
    expect(extractCode('  K7M2XQ ')).toBe('k7m2xq');
    expect(extractCode('Code: k7m2xq')).toBe('k7m2xq');
    expect(extractCode('https://westinscollins.github.io/world-conquest/#join=k7m2xq')).toBe('k7m2xq');
  });
});

/** An in-memory pair of links (what each side sees). */
function pair(via: Via, hostGid: string, guestGid: string): { h: TestLink; g: TestLink } {
  const h = new TestLink(guestGid, via), g = new TestLink(hostGid, via);
  h.other = g; g.other = h;
  return { h, g };
}
class TestLink extends BaseLink {
  other!: TestLink;
  sent: Wire[] = [];
  send(w: Wire) { if (this.closed) return; this.sent.push(w); const o = this.other; setTimeout(() => o.deliverIn(w), 1); }
  deliverIn(w: Wire) { if (w.k === 'bye') { this.lost(); return; } this.receive(w); }
  protected shutdown() { setTimeout(() => this.other.lost(), 1); }
  lost() { super.lost(); }
}

describe('star rooms over any links', () => {
  it('relays events and presence between guests on different paths, and merges duplicate paths', async () => {
    const listener: HostListener = { start: async () => {}, stop: () => {}, status: () => [{ name: 'test', up: true }] };
    const host = new HostRoom('H', [listener]);
    const got: string[] = [];
    host.on('cmd', (m) => got.push(`${m.peer}:${JSON.stringify(m.data)}`));
    // guest A says hello on two paths, then chooses the relay one
    const a1 = pair('direct', 'H', 'A'), a2 = pair('mqtt', 'H', 'A');
    host.addLink(a1.h); host.addLink(a2.h);
    a1.g.close();
    const A = new GuestRoom('A', a2.g);
    // guest B on the server tunnel
    const b = pair('server', 'H', 'B');
    host.addLink(b.h);
    const B = new GuestRoom('B', b.g);
    const bSaw: string[] = [];
    B.on('step', (m) => bSaw.push(`${m.peer}:${JSON.stringify(m.data)}`));
    await A.presence({ app: 'wc', name: 'Alice' });
    await B.presence({ app: 'wc', name: 'Bob' });
    await wait(30);
    expect(host.peers().map((p) => p.peer).sort()).toEqual(['A', 'B', 'H']);
    expect(B.peers().find((p) => p.peer === 'A')?.presence.name).toBe('Alice');
    await A.emit('cmd', { n: 'setTax' });
    await host.emit('step', { q: 1 });
    await A.emit('step', { q: 'fromA' });
    await wait(30);
    expect(got).toEqual(['A:{"n":"setTax"}']);
    expect(bSaw).toEqual(['H:{"q":1}', 'A:{"q":"fromA"}']);
    expect(host.info().guests.find((g) => g.peer === 'A')?.via).toBe('mqtt');
    // A leaves: everyone notices
    await A.leave();
    await wait(30);
    expect(host.peers().map((p) => p.peer).sort()).toEqual(['B', 'H']);
    await host.leave(); await B.leave();
  });
});

describe('MQTT client against a real broker (aedes)', () => {
  let broker: { close(): Promise<void>; port: number } | null = null;
  afterAll(async () => { await broker?.close(); });
  it('connects, subscribes and passes binary messages both ways', async () => {
    broker = await startBroker(18093);
    const inbox: { t: string; p: number[] }[] = [];
    const a = new MqttClient('ws://127.0.0.1:18093/mqtt', { clientId: 'testa', onMessage: (t, p) => inbox.push({ t, p: [...p.subarray(0, 4)] }) });
    const b = new MqttClient('ws://127.0.0.1:18093/mqtt', { clientId: 'testb', onMessage: () => {} });
    await a.connect(); await b.connect();
    a.subscribe('wc1/x/h');
    await wait(100);
    const big = new Uint8Array(9000).fill(7); big[0] = 1; big[1] = 2;
    b.publish('wc1/x/h', new Uint8Array([9, 8, 7]));
    b.publish('wc1/x/h', big);
    b.publish('wc1/other', new Uint8Array([1]));
    await wait(200);
    expect(inbox).toEqual([{ t: 'wc1/x/h', p: [9, 8, 7] }, { t: 'wc1/x/h', p: [1, 2, 7, 7] }]);
    a.close(); b.close();
  });
});
