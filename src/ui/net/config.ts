// Network settings for the public website build. URL parameters override them for tests:
//   ?net=auto|direct|server|mqtt   force one connection path (default: try all, prefer direct)
//   ?relay=wss://a/mqtt,wss://b    MQTT brokers to use (?relay=none disables the MQTT relay)
//   ?peerhost=127.0.0.1:9000       self-hosted PeerJS signalling server (tests)
//   ?netsim=noice                  make WebRTC fail (no ICE servers, relay-only policy) to exercise the relays
//   ?peerdebug=3                   PeerJS console logging
//   ?netdrop=0.1                   drop 10% of incoming messages (resync tests)

export type NetMode = 'auto' | 'direct' | 'server' | 'mqtt';

/**
 * Public MQTT brokers reachable over secure WebSockets, verified by the live check
 * (tests/e2e/live.mjs). Port 443 first: it passes most school and office firewalls.
 */
export const DEFAULT_BROKERS = [
  'wss://public:public@public.cloud.shiftr.io:443',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

/** STUN for discovering public addresses, plus the free PeerJS TURN relays over UDP and TCP. */
const ICE: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478', 'turn:eu-0.turn.peerjs.com:3478?transport=tcp', 'turn:us-0.turn.peerjs.com:3478?transport=tcp'],
      username: 'peerjs', credential: 'peerjsp',
    },
  ],
  sdpSemantics: 'unified-plan',
} as RTCConfiguration;

export const TIMING = {
  SIGNAL_OPEN_MS: 12000,   // reaching the matchmaking server
  JOIN_BUDGET_MS: 22000,   // total time a guest keeps trying
  PREFER_DIRECT_MS: 5000,  // after a relay answers, how long to wait for a direct link
  HELLO_EVERY_MS: 1500,    // relay hellos until the host answers
  NOT_FOUND_MS: 9000,      // no answer on any reachable path after this = no such room
  PING_MS: 2000,
  LINK_TIMEOUT_MS: 12000,  // silence on a link before it is considered dead
  BATCH_MS: 20,
};

function params() {
  return new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
}

export interface NetConfig {
  mode: NetMode;
  brokers: string[];
  ice: RTCConfiguration;
  peerOptions: Record<string, unknown>;
  netdrop: number;
}

export function netConfig(): NetConfig {
  const q = params();
  const m = q.get('net');
  const mode: NetMode = m === 'direct' || m === 'server' || m === 'mqtt' ? m : 'auto';
  const r = q.get('relay');
  const brokers = r === 'none' ? [] : r ? r.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_BROKERS;
  const ice = q.get('netsim') === 'noice' ? ({ iceServers: [], iceTransportPolicy: 'relay' } as RTCConfiguration) : ICE;
  const debug = Number(q.get('peerdebug') || 0);
  const ph = q.get('peerhost');
  let peerOptions: Record<string, unknown> = { debug, config: ice };
  if (ph) {
    const [host, port] = ph.split(':');
    peerOptions = { ...peerOptions, host, port: Number(port || 9000), path: '/', secure: false };
  }
  return { mode, brokers, ice, peerOptions, netdrop: Number(q.get('netdrop') || 0) };
}

const GID_KEY = 'wc-gid';
/** A per-tab identity that survives reloads (so a reconnecting player is recognised). */
export function tabId(): string {
  try {
    let v = sessionStorage.getItem(GID_KEY);
    if (!v) { v = rand(12); sessionStorage.setItem(GID_KEY, v); }
    return v;
  } catch { return rand(12); }
}
// "Duplicate tab" copies sessionStorage, and with it the id: a new tab asks whether another open
// tab already uses its id, and takes a fresh one if so (a reloaded tab gets no answer and keeps it).
if (typeof BroadcastChannel !== 'undefined' && typeof sessionStorage !== 'undefined') {
  try {
    const ch = new BroadcastChannel('wc-tab-id');
    const asked = sessionStorage.getItem(GID_KEY);
    let checking = !!asked;
    ch.onmessage = (e: MessageEvent<{ q?: string; a?: string }>) => {
      const mine = sessionStorage.getItem(GID_KEY);
      if (!mine) return;
      if (e.data?.q === mine && !checking) ch.postMessage({ a: mine }); // in use here
      else if (checking && e.data?.a === mine) { sessionStorage.setItem(GID_KEY, rand(12)); checking = false; }
    };
    if (asked) { ch.postMessage({ q: asked }); setTimeout(() => { checking = false; }, 1500); }
  } catch { /* no storage: ids are per page load anyway */ }
}
export function rand(n: number) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  for (const b of buf) s += a[b % a.length];
  return s;
}
