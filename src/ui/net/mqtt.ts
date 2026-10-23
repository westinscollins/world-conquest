// A minimal MQTT 3.1.1 client over WebSockets (QoS 0 only) for the relay fallback.
// Public brokers forward messages between players when no direct connection is possible.

export interface MqttOptions {
  clientId: string;
  keepalive?: number;          // seconds
  username?: string;
  password?: string;
  onMessage: (topic: string, payload: Uint8Array) => void;
  onClose?: (reason: string) => void;
  timeoutMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- packet encoding
export function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}
function str(s: string): Uint8Array {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8; out[1] = b.length & 0xff; out.set(b, 2);
  return out;
}
function packet(type: number, ...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((t, p) => t + p.length, 0);
  const rl = remainingLength(len);
  const out = new Uint8Array(1 + rl.length + len);
  out[0] = type; out.set(rl, 1);
  let o = 1 + rl.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function connectPacket(o: { clientId: string; keepalive: number; username?: string; password?: string }): Uint8Array {
  let flags = 0x02; // clean session
  if (o.username != null) flags |= 0x80;
  if (o.password != null) flags |= 0x40;
  const vh = new Uint8Array([0, 4, 0x4d, 0x51, 0x54, 0x54, 4, flags, o.keepalive >> 8, o.keepalive & 0xff]);
  const parts = [vh, str(o.clientId)];
  if (o.username != null) parts.push(str(o.username));
  if (o.password != null) parts.push(str(o.password));
  return packet(0x10, ...parts);
}
export const publishPacket = (topic: string, payload: Uint8Array) => packet(0x30, str(topic), payload);
export const subscribePacket = (id: number, topic: string) => packet(0x82, new Uint8Array([id >> 8, id & 0xff]), str(topic), new Uint8Array([0]));
export const pingPacket = () => new Uint8Array([0xc0, 0]);
export const disconnectPacket = () => new Uint8Array([0xe0, 0]);

export interface Parsed { type: number; flags: number; body: Uint8Array }
/** Splits a byte stream into MQTT packets; keeps a partial packet for the next chunk. */
export class PacketReader {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Parsed[] {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf); b.set(chunk, this.buf.length);
    const out: Parsed[] = [];
    let o = 0;
    for (;;) {
      if (b.length - o < 2) break;
      let mult = 1, len = 0, i = o + 1, done = false;
      for (let k = 0; k < 4 && i < b.length; k++, i++) {
        len += (b[i] & 0x7f) * mult; mult *= 128;
        if ((b[i] & 0x80) === 0) { done = true; i++; break; }
      }
      if (!done || b.length - i < len) break;
      out.push({ type: b[o] >> 4, flags: b[o] & 0x0f, body: b.slice(i, i + len) });
      o = i + len;
    }
    this.buf = b.slice(o);
    return out;
  }
}
export function parsePublish(p: Parsed): { topic: string; payload: Uint8Array } {
  const tl = (p.body[0] << 8) | p.body[1];
  const topic = dec.decode(p.body.subarray(2, 2 + tl));
  const qos = (p.flags >> 1) & 3;
  const start = 2 + tl + (qos > 0 ? 2 : 0);
  return { topic, payload: p.body.slice(start) };
}

// ---------------------------------------------------------------- client
export class MqttClient {
  private ws: WebSocket | null = null;
  private reader = new PacketReader();
  private ping: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private closedByUs = false;
  up = false;
  readonly url: string;

  constructor(url: string, private o: MqttOptions) {
    // credentials may be given in the URL: wss://user:pass@host/path
    try {
      const u = new URL(url);
      if (u.username) { o.username = decodeURIComponent(u.username); o.password = decodeURIComponent(u.password); u.username = ''; u.password = ''; }
      this.url = u.toString();
    } catch { this.url = url; }
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why: string) => { if (settled) return; settled = true; this.teardown(); reject(new Error(why)); };
      const timer = setTimeout(() => fail('timeout'), this.o.timeoutMs ?? 7000);
      let ws: WebSocket;
      try { ws = new WebSocket(this.url, 'mqtt'); } catch (e) { clearTimeout(timer); fail(String(e)); return; }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(connectPacket({ clientId: this.o.clientId, keepalive: this.o.keepalive ?? 60, username: this.o.username, password: this.o.password }));
      ws.onerror = () => fail('socket error');
      ws.onclose = () => {
        clearTimeout(timer);
        if (!settled) { fail('closed'); return; }
        const was = this.up;
        this.teardown();
        if (was && !this.closedByUs) this.o.onClose?.('closed');
      };
      ws.onmessage = (ev) => {
        const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : typeof ev.data === 'string' ? enc.encode(ev.data) : new Uint8Array(0);
        for (const p of this.reader.push(data)) {
          if (p.type === 2) { // CONNACK
            clearTimeout(timer);
            if (p.body[1] !== 0) { fail(`refused (${p.body[1]})`); return; }
            this.up = true; settled = true;
            const ka = (this.o.keepalive ?? 60) * 500;
            this.ping = setInterval(() => this.raw(pingPacket()), ka);
            resolve();
          } else if (p.type === 3) {
            const m = parsePublish(p);
            try { this.o.onMessage(m.topic, m.payload); } catch { /* handler error */ }
          }
          // SUBACK (9) and PINGRESP (13) need no action
        }
      };
    });
  }
  subscribe(topic: string) { this.raw(subscribePacket(this.nextId++ & 0xffff || 1, topic)); }
  publish(topic: string, payload: Uint8Array) { this.raw(publishPacket(topic, payload)); }
  close() {
    this.closedByUs = true;
    try { this.raw(disconnectPacket()); } catch { /* closing */ }
    try { this.ws?.close(); } catch { /* closing */ }
    this.teardown();
  }
  private raw(b: Uint8Array) { if (this.ws && this.ws.readyState === 1) this.ws.send(b); }
  private teardown() {
    this.up = false;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    if (this.ws) { this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null; try { this.ws.close(); } catch { /* closing */ } }
    this.ws = null;
  }
}
