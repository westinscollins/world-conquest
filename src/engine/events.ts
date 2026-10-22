import type { GameEvent, GameState } from './types';

const MAX_EVENTS = 400;

export function addEvent(
  s: GameState,
  kind: GameEvent['kind'],
  text: string,
  nations: string[],
  extra: { province?: number; battleId?: number; important?: boolean } = {},
): GameEvent {
  const ev: GameEvent = { id: s.nextId++, day: s.day, kind, text, nations, ...extra };
  const involvesPlayer = nations.includes(s.player);
  // Keep the log focused: world events not involving the player are only logged when important.
  if (!involvesPlayer && !extra.important) return ev;
  s.events.push(ev);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  if (extra.important || kind === 'war' || kind === 'peace' || (kind === 'territory' && involvesPlayer)) {
    s.timeline.push(ev);
    if (s.timeline.length > 600) s.timeline.splice(0, s.timeline.length - 600);
  }
  if (involvesPlayer && (extra.important || kind === 'war' || kind === 'battle' || kind === 'peace')) s.notifications.push(ev.id);
  return ev;
}

export function dateOf(s: { startYear: number }, day: number) {
  const d = new Date(Date.UTC(s.startYear, 0, 1) + day * 86400000);
  return d;
}
export function fmtDate(s: { startYear: number }, day: number) {
  const d = dateOf(s, day);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
let mCache = { y: -1, d: -1, m: 0 };
export function monthOf(s: { startYear: number }, day: number) {
  if (mCache.y !== s.startYear || mCache.d !== day) mCache = { y: s.startYear, d: day, m: dateOf(s, day).getUTCMonth() };
  return mCache.m;
}
