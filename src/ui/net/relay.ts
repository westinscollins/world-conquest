// Relay path over public MQTT brokers (secure WebSockets). Works on networks that block
// direct WebRTC connections. Every message is encrypted with a key derived from the room code;
// topics are derived from it too, so the broker never sees the code or the game.
import { MqttClient } from './mqtt';
import { Batcher, Inbox, type RoomKeys } from './crypt';
import { BaseLink, isWire, type Wire } from './wire';
import type { HostListener, ListenerStatus } from './star';
import { TIMING, rand } from './config';
import { after } from './clock';

const hostTopic = (tid: string) => `wc1/${tid}/h`;
const guestTopic = (tid: string, gid: string) => `wc1/${tid}/g/${gid}`;
const short = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

/** A link carried by one broker (through whichever connection to it is current). */
class MqttLink extends BaseLink {
  private batch: Batcher;
  constructor(gid: string, client: () => MqttClient | null, topic: string, key: CryptoKey, from: string | null) {
    super(gid, 'mqtt');
    this.batch = new Batcher(key, (b) => client()?.publish(topic, b), from ? { s: from } : {}, TIMING.BATCH_MS);
  }
  send(w: Wire) { if (!this.closed) this.batch.push(w); }
  feed(w: Wire) { this.receive(w); }
  dead() { this.lost(); }
  protected shutdown() { this.batch.flush(); }
}

interface Env { s?: string; w?: unknown[] }

// ---------------------------------------------------------------- host side
export class MqttHostListener implements HostListener {
  private brokers: { url: string; client: MqttClient | null; up: boolean; error?: string; retry?: () => void; links: Map<string, MqttLink>; rx: Inbox }[];
  private stopped = false;
  private add: (l: MqttLink) => void = () => {};
  private changed: () => void = () => {};
  constructor(urls: string[], private keys: RoomKeys) {
    this.brokers = urls.map((url) => ({ url, client: null, up: false, links: new Map(), rx: new Inbox() }));
  }
  async start(add: (l: MqttLink) => void, changed: () => void) {
    this.add = add; this.changed = changed;
    if (!this.brokers.length) throw Object.assign(new Error('no relay brokers'), { code: 'network' });
    // succeed as soon as one broker is listening; the rest keep connecting in the background
    await new Promise<void>((resolve, reject) => {
      let left = this.brokers.length;
      for (const b of this.brokers) this.connect(b).then(() => resolve(), () => { if (--left === 0) reject(Object.assign(new Error('no relay broker reachable'), { code: 'network' })); });
    });
  }
  private async connect(b: (typeof this.brokers)[number], attempt = 0): Promise<void> {
    if (this.stopped) return;
    const client = new MqttClient(b.url, {
      clientId: `wch${rand(10)}`, keepalive: 60,
      onMessage: (_t, payload) => this.onMessage(b, payload),
      // links outlive a short drop: the guests' messages flow again once this reconnects (links to
      // guests that are really gone time out in the room)
      onClose: () => { b.up = false; this.changed(); this.schedule(b, 0); },
    });
    b.client = client;
    try {
      await client.connect();
      if (this.stopped) { client.close(); return; }
      client.subscribe(hostTopic(this.keys.tid));
      b.up = true; b.error = undefined;
      this.changed();
    } catch (e) {
      b.error = (e as Error).message;
      this.changed();
      this.schedule(b, attempt + 1);
      throw e;
    }
  }
  private schedule(b: (typeof this.brokers)[number], attempt: number) {
    if (this.stopped || b.retry) return;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(attempt, 4));
    b.retry = after(delay, () => { b.retry = undefined; this.connect(b, attempt).catch(() => {}); });
  }
  private onMessage(b: (typeof this.brokers)[number], payload: Uint8Array) {
    b.rx.open(this.keys.key, payload, (x) => this.onEnvelope(b, x as Env));
  }
  private onEnvelope(b: (typeof this.brokers)[number], env: Env) {
    if (typeof env.s !== 'string' || !Array.isArray(env.w)) return;
    const gid = env.s.slice(0, 24);
    let link = b.links.get(gid);
    for (const w of env.w) {
      if (!isWire(w)) continue;
      if (!link) {
        if (w.k !== 'hello') continue;
        link = new MqttLink(gid, () => b.client, guestTopic(this.keys.tid, gid), this.keys.key, null);
        b.links.set(gid, link);
        const l = link;
        link.onClose(() => { if (b.links.get(gid) === l) b.links.delete(gid); });
        this.add(link);
        continue;
      }
      link.feed(w);
    }
  }
  stop() {
    this.stopped = true;
    for (const b of this.brokers) {
      b.retry?.(); b.retry = undefined;
      for (const l of b.links.values()) l.close();
      b.up = false;
      const c = b.client;
      after(500, () => c?.close()); // let the goodbyes go out first
    }
  }
  status(): ListenerStatus[] { return this.brokers.map((b) => ({ name: `relay ${short(b.url)}`, up: b.up, detail: b.error })); }
}

// ---------------------------------------------------------------- guest side
export interface MqttDial {
  link: Promise<MqttLink>;
  /** Number of brokers that accepted the connection (for error reporting). */
  reachable(): number;
  tried(): number;
  cancel(): void;
}
export function dialMqtt(urls: string[], keys: RoomKeys, gid: string, name: string): MqttDial {
  const clients: MqttClient[] = [];
  let reachable = 0, done = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  const cancel = () => { done = true; for (const t of timers) clearInterval(t); for (const c of clients) c.close(); };
  const link = new Promise<MqttLink>((resolve, reject) => {
    if (!urls.length) { reject(Object.assign(new Error('relay disabled'), { code: 'network' })); return; }
    let failed = 0, firstUp = 0;
    const giveUp = setTimeout(() => { if (!done) { cancel(); reject(Object.assign(new Error(reachable ? 'no answer on the relay' : 'no relay broker reachable'), { code: reachable ? 'not_found' : 'network' })); } }, TIMING.JOIN_BUDGET_MS);
    timers.push(giveUp as unknown as ReturnType<typeof setInterval>);
    for (const url of urls) {
      let mine: MqttLink | null = null;
      const rx = new Inbox();
      const client: MqttClient = new MqttClient(url, {
        clientId: `wcg${rand(10)}`, keepalive: 60,
        onMessage: (_t, payload) => rx.open(keys.key, payload, (x) => {
          const env = x as Env;
          if (!Array.isArray(env.w)) return;
          for (const w of env.w) {
            if (!isWire(w)) continue;
            if (!mine && w.k === 'welcome' && !done) {
              done = true;
              clearTimeout(giveUp);
              for (const t of timers) clearInterval(t);
              for (const c of clients) if (c !== client) c.close();
              mine = new MqttLink(String(w.gid ?? 'host'), () => client, hostTopic(keys.tid), keys.key, gid);
              mine.onClose(() => { after(500, () => client.close()); }); // (after the goodbye)
              resolve(mine);
            } else if (mine) mine.feed(w);
          }
        }),
        onClose: () => mine?.dead(),
      });
      clients.push(client);
      client.connect().then(() => {
        if (done) { client.close(); return; }
        reachable++;
        if (!firstUp) {
          firstUp = Date.now();
          // a reachable relay with no answer for a while means there is no such room
          setTimeout(() => { if (!done) { cancel(); clearTimeout(giveUp); reject(Object.assign(new Error('no answer on the relay'), { code: 'not_found' })); } }, TIMING.NOT_FOUND_MS);
        }
        client.subscribe(guestTopic(keys.tid, gid));
        const hello = new Batcher(keys.key, (b) => client.publish(hostTopic(keys.tid), b), { s: gid }, 0);
        const say = () => { if (!done) { hello.push({ k: 'hello', gid, name } satisfies Wire); hello.flush(); } };
        say();
        timers.push(setInterval(say, TIMING.HELLO_EVERY_MS));
      }, () => {
        if (++failed === urls.length && !done) { cancel(); clearTimeout(giveUp); reject(Object.assign(new Error('no relay broker reachable'), { code: 'network' })); }
      });
    }
  });
  return { link, reachable: () => reachable, tried: () => urls.length, cancel };
}

/** Connection check for the lobby: can this browser reach each broker? */
export async function probeBroker(url: string): Promise<{ url: string; ok: boolean; ms: number; error?: string }> {
  const t0 = performance.now();
  const c = new MqttClient(url, { clientId: `wcp${rand(10)}`, onMessage: () => {}, timeoutMs: 6000 });
  try { await c.connect(); c.close(); return { url, ok: true, ms: Math.round(performance.now() - t0) }; }
  catch (e) { return { url, ok: false, ms: Math.round(performance.now() - t0), error: (e as Error).message }; }
}
