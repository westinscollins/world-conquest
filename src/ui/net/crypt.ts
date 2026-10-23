// Room encryption for relayed messages: the room code is the shared secret. Relays (the
// matchmaking server, public MQTT brokers) only ever see random-looking bytes.
import { after } from './clock';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface RoomKeys { tid: string; key: CryptoKey }
const cache = new Map<string, Promise<RoomKeys>>();

/** Topic id and AES-GCM key derived from the room code (PBKDF2-SHA256). */
export function roomKeys(code: string): Promise<RoomKeys> {
  let p = cache.get(code);
  if (!p) {
    p = (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('wc-relay-topic-v1'), iterations: 60000 }, base, 80);
      const tid = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('wc-relay-key-v1'), iterations: 60000 }, base, { name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
      return { tid, key };
    })();
    cache.set(code, p);
  }
  return p;
}

export async function seal(key: CryptoKey, obj: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
export async function open(key: CryptoKey, bytes: Uint8Array): Promise<unknown> {
  if (bytes.length < 13) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return JSON.parse(dec.decode(pt));
  } catch { return null; }
}
export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Queues wires and sends them as one encrypted envelope a few milliseconds later, keeping each
 * envelope under `maxBytes` of JSON. Envelopes are sent strictly in order.
 */
export class Batcher {
  private q: unknown[] = [];
  private size = 0;
  private timer: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  constructor(private key: CryptoKey, private out: (bytes: Uint8Array) => void, private extra: Record<string, unknown> = {}, private delay = 20, private maxBytes = 12000) {}
  push(w: unknown) {
    const len = JSON.stringify(w).length;
    if (this.size + len > this.maxBytes && this.q.length) this.flush();
    this.q.push(w); this.size += len;
    if (!this.timer) this.timer = after(this.delay, () => { this.timer = null; this.flush(); });
  }
  flush() {
    if (this.timer) { this.timer(); this.timer = null; }
    if (!this.q.length) return;
    const env = { ...this.extra, w: this.q };
    this.q = []; this.size = 0;
    this.chain = this.chain.then(async () => { try { this.out(await seal(this.key, env)); } catch { /* dropped; the session resyncs */ } });
  }
  stop() { if (this.timer) this.timer(); this.timer = null; this.q = []; }
}
