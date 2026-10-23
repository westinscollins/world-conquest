// Opening a room on the public website build. The host listens on every path at once; a guest
// tries them all in parallel and keeps the best one that answers: a direct WebRTC link if it
// comes up within a few seconds, otherwise the matchmaking-server tunnel or an MQTT relay.
import { HostRoom, GuestRoom } from './star';
import { PeerHostListener, PeerError, PREFIX, dialPeer } from './peer';
import { MqttHostListener, dialMqtt } from './relay';
import { roomKeys } from './crypt';
import { netConfig, tabId, TIMING } from './config';
import type { Link } from './wire';
import type { NetRoom } from './transport';

export interface JoinProgress { stage: 'searching' | 'found' | 'connecting' | 'connected'; via?: string }

export async function joinStar(name: string, role: 'host' | 'guest', onProgress: (p: JoinProgress) => void = () => {}, onChanged: () => void = () => {}): Promise<NetRoom> {
  const cfg = netConfig();
  const code = name.replace(/^wc-/, '');
  const keys = await roomKeys(code);
  const gid = tabId();
  const hostId = PREFIX + name;
  const usePeer = { direct: cfg.mode === 'auto' || cfg.mode === 'direct', server: cfg.mode === 'auto' || cfg.mode === 'server' };
  const useMqtt = (cfg.mode === 'auto' || cfg.mode === 'mqtt') && cfg.brokers.length > 0;

  if (role === 'host') {
    const listeners = [];
    const peerL = usePeer.direct || usePeer.server ? new PeerHostListener(hostId, cfg.peerOptions, keys, usePeer) : null;
    const mqttL = useMqtt ? new MqttHostListener(cfg.brokers, keys) : null;
    if (peerL) listeners.push(peerL);
    if (mqttL) listeners.push(mqttL);
    const room = new HostRoom(gid, listeners, cfg.netdrop, onChanged);
    const starts = listeners.map((l) => l.start(room.addLink, room.changed));
    // the matchmaking id decides whether the code is free; otherwise one listening path is enough
    const results = await Promise.allSettled(starts);
    const idTaken = results.find((r) => r.status === 'rejected' && (r.reason as PeerError)?.code === 'id_taken');
    if (idTaken) { await room.leave(); throw (idTaken as PromiseRejectedResult).reason; }
    if (!results.some((r) => r.status === 'fulfilled')) {
      await room.leave();
      throw new PeerError("Couldn't reach the matchmaking server or any relay. Check your internet connection and try again.", 'network');
    }
    return room;
  }

  // ---- guest: race every path
  onProgress({ stage: 'searching' });
  const pd = usePeer.direct || usePeer.server ? dialPeer(hostId, cfg.peerOptions, keys, gid, 'player', usePeer) : null;
  const md = useMqtt ? dialMqtt(cfg.brokers, keys, gid, 'player') : null;
  type Got = { link: Link; kind: 'direct' | 'server' | 'mqtt' };
  const link = await new Promise<Got>((resolve, reject) => {
    let chosen = false, preferTimer: ReturnType<typeof setInterval> | null = null;
    let relay: Got | null = null;
    const failures = new Map<string, string>();
    const pending = new Set<string>();
    const choose = (g: Got) => {
      if (chosen) return;
      chosen = true;
      if (preferTimer) clearInterval(preferTimer);
      if (relay && relay !== g) relay.link.close();
      pd?.finish(g.kind === 'direct' || g.kind === 'server' ? g.kind : null);
      if (g.kind !== 'mqtt') md?.cancel();
      resolve(g);
    };
    const settle = () => {
      if (chosen) return;
      if (relay && (!pending.has('direct') || failures.has('direct'))) { choose(relay); return; }
      if (pending.size) return;
      chosen = true;
      pd?.finish(null); md?.cancel();
      const codes = [...failures.values()];
      const answered = pd?.answered() ?? false;
      if (answered || codes.includes('unreachable')) reject(new PeerError('unreachable', 'unreachable'));
      else if (codes.length && codes.every((c) => c === 'network')) reject(new PeerError('network', 'network'));
      else reject(new PeerError('not_found', 'not_found'));
    };
    const track = (kind: Got['kind'], p: Promise<Link> | null) => {
      if (!p) return;
      pending.add(kind);
      p.then((l) => {
        pending.delete(kind);
        if (chosen) { if (relay?.link !== l) l.close(); return; }
        if (kind === 'direct') { choose({ link: l, kind }); return; }
        onProgress({ stage: 'found', via: kind });
        const g = { link: l, kind };
        if (!relay || (relay.kind === 'mqtt' && kind === 'server')) { if (relay) relay.link.close(); relay = g; }
        else l.close();
        // give the direct link a moment to come up (it is faster than any relay), but only if the
        // host answered on it: a moment for the answer, a few seconds for the connection itself
        if (!pd?.direct || failures.has('direct')) { choose(relay); return; }
        const since = Date.now();
        preferTimer ??= setInterval(() => {
          const waited = Date.now() - since;
          if (relay && (waited > TIMING.PREFER_DIRECT_MS || (!pd.answered() && waited > 1500))) choose(relay);
        }, 250);
      }, (e) => {
        pending.delete(kind);
        const code = (e as PeerError)?.code ?? 'network';
        failures.set(kind, code);
        // the relay reached its brokers and nobody answered, and the matchmaking server shows no
        // sign of the host either: no such room (don't wait out the slower paths)
        if (kind === 'mqtt' && code === 'not_found' && !relay && !chosen && !(pd?.answered() ?? false)) {
          chosen = true;
          if (preferTimer) clearInterval(preferTimer);
          pd?.finish(null);
          reject(new PeerError('not_found', 'not_found'));
          return;
        }
        settle();
      });
    };
    track('direct', pd?.direct ?? null);
    track('server', pd?.server ?? null);
    track('mqtt', md?.link ?? null);
    pd?.signal.then((s) => { if (s === 'ok') onProgress({ stage: 'found', via: 'server' }); });
    if (!pending.size) { reject(new PeerError('No connection method is enabled.', 'network')); }
  });
  onProgress({ stage: 'connected', via: link.kind });
  return new GuestRoom(gid, link.link, cfg.netdrop);
}
