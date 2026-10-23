// Messages exchanged on a link between a guest and the host, and the Link abstraction every
// connection path (direct WebRTC, the matchmaking-server tunnel, the MQTT relay) implements.

export type Via = 'direct' | 'server' | 'mqtt';

export type Wire =
  | { k: 'hello'; gid: string; name?: string }          // guest -> host, first message on any path
  | { k: 'welcome'; gid: string }                       // host -> guest
  | { k: 'use'; sid?: string }                          // guest -> host: this is the path I chose (sid: this join attempt)
  | { k: 'bye' }                                        // either side: this path is closing
  | { k: 'ev'; topic: string; data: unknown; from?: string }
  | { k: 'pres'; presence: Record<string, unknown> }
  | { k: 'peers'; list: { peer: string; presence: Record<string, unknown> }[] }
  | { k: 'ping' };

export interface Link {
  /** The other side's tab id (gid) once known. */
  readonly peer: string;
  readonly via: Via;
  send(w: Wire): void;
  /** Close locally (and tell the other side when possible). */
  close(): void;
  onData(fn: (w: Wire) => void): void;
  onClose(fn: () => void): void;
  readonly closed: boolean;
}

/** Base class: handler bookkeeping and idempotent close. */
export abstract class BaseLink implements Link {
  closed = false;
  private dataFns: ((w: Wire) => void)[] = [];
  private closeFns: (() => void)[] = [];
  constructor(public peer: string, public readonly via: Via) {}
  abstract send(w: Wire): void;
  protected abstract shutdown(): void;
  onData(fn: (w: Wire) => void) { this.dataFns.push(fn); }
  onClose(fn: () => void) { if (this.closed) fn(); else this.closeFns.push(fn); }
  protected receive(w: Wire) { if (!this.closed) for (const f of this.dataFns) f(w); }
  close() {
    if (this.closed) return;
    try { this.send({ k: 'bye' }); } catch { /* best effort */ }
    this.closed = true;
    try { this.shutdown(); } catch { /* closing */ }
    for (const f of this.closeFns) f();
    this.closeFns = [];
  }
  /** The other side went away (no bye needed). */
  protected lost() {
    if (this.closed) return;
    this.closed = true;
    try { this.shutdown(); } catch { /* closing */ }
    for (const f of this.closeFns) f();
    this.closeFns = [];
  }
}

export function isWire(w: unknown): w is Wire {
  return !!w && typeof w === 'object' && typeof (w as { k?: unknown }).k === 'string';
}
