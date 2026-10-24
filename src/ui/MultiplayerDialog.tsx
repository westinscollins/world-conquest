import { useEffect, useState } from 'react';
import { store, createSession, useStore } from './store';
import { Modal, Btn } from './common';
import { NationPicker } from './NationPicker';
import { newRoomCode, netError, BUILD, type Session } from './net/session';
import { NetCheck } from './NetCheck';
import { transportKind, isHosted } from './net/transport';
import { newGame } from '../engine/setup';
import { listSaves, loadGame } from './storage';
import type { SaveMeta } from '../engine/save';
import { COUNTRY_GEO } from '../engine/geo';
import { fmtDate } from '../engine/events';
import { audio } from '../audio/music';
import { latestBuild, updateIfStale } from './update';

const NAME_KEY = 'wc-mp-name';
function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
function rememberName(n: string) { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } }

export function MultiplayerDialog({ onClose }: { onClose: () => void }) {
  useStore();
  const [name, setName] = useState(savedName());
  const [code, setCode] = useState(() => (typeof location !== 'undefined' ? decodeURIComponent(location.hash.match(/join=([^&]+)/)?.[1] ?? '') : ''));
  const [opening, setOpening] = useState<Session | null>(null);
  const [kind, setKind] = useState<'online' | 'p2p' | 'local' | 'unavailable' | undefined>(undefined);
  const [session, setSession] = useState<Session | null>(store.net);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<'new' | string>('new');
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  useEffect(() => { transportKind().then(setKind); listSaves().then(setSaves).catch(() => {}); }, []);
  // an old copy of the page loads the newest version first (and comes back to this window)
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void (async () => {
      if (!store.net && (await updateIfStale('#mp'))) return;
      setLatest(await latestBuild());
    })();
  }, []);
  // once the game is running the lobby is done
  useEffect(() => { if (store.ui.screen === 'game' && session?.phase === 'playing') onClose(); });

  const open = async (role: 'host' | 'guest') => {
    setErr('');
    const nm = name.trim() || (role === 'host' ? 'Host' : 'Guest');
    rememberName(nm);
    // accept a pasted invite link or a sentence containing the code
    const c = role === 'host' ? newRoomCode() : extractCode(code);
    if (role === 'guest' && c.length < 4) { setErr('Enter the room code your host gave you.'); return; }
    if (busy) return;
    setBusy(true);
    try {
      audio.init();
      const s = createSession(role, c, nm);
      setOpening(s);
      await s.open();
      if (location.hash.includes('join=')) history.replaceState(null, '', location.pathname + location.search);
      store.net = s;
      if (role === 'host') await s.setNation('SRB');
      setSession(s);
    } catch (e) {
      setErr(netError(e, 'Could not open the room'));
    } finally { setBusy(false); setOpening(null); }
  };
  const leave = async () => { await session?.close(); store.net = null; setSession(null); };
  // closing the window keeps the room open (return to it from the menu); only "Leave room" closes it
  const closeAll = () => onClose();

  return (
    <Modal title="Online multiplayer" onClose={closeAll} wide backdropCloses={!session}>
      {kind === undefined && <p className="muted">Checking the connection…</p>}
      {kind === 'unavailable' && !isHosted() && <div className="error"><b>Online play isn't available in this browser.</b> It needs WebRTC, which this browser doesn't support or has turned off. Try an up-to-date Chrome, Edge, Firefox or Safari.</div>}
      {kind === 'p2p' && <p className="note small">Players connect directly to each other. Anyone with this page's link and your room code can join, with no sign-in or approval.</p>}
      {kind === 'unavailable' && isHosted() && <div className="error"><b>Online play isn't available to you on this page.</b> To connect, you must be signed in to claude.ai and the game must be shared with you with permission to edit or contribute (the owner sets this in the page's Share menu). Ask the person who shared it to check your access, then reload the page.</div>}
      {kind === 'local' && <p className="note small">Local test mode: this copy of the game is not on the hosted page, so players can only connect from other tabs of this same browser. On the hosted page, players on different computers connect through the room code.</p>}
      {err && <div className="error">{err}</div>}
      {busy && opening && <p className="note small">{progressText(opening)}</p>}
      {!session && (kind === 'online' || kind === 'p2p' || kind === 'local') && (
        <div className="mp-start">
          <label className="mp-field">Your name<input id="mp-name" maxLength={24} value={name} placeholder="e.g. Alex" onChange={(e) => setName(e.target.value)} /></label>
          <div className="mp-choice">
            <div>
              <h4>Host a game</h4>
              <p className="small muted">Create a room, share its code, pick nations and start. Your computer runs the clock; the game pauses for everyone if you leave.</p>
              <Btn kind="primary" disabled={busy} onClick={() => open('host')}>Create room</Btn>
            </div>
            <div>
              <h4>Join a game</h4>
              <p className="small muted">Enter the code the host shared with you.</p>
              <div className="row gap">
                <input id="mp-code" className="code-in" maxLength={120} value={code} placeholder="room code" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open('guest')} />
                <Btn kind="primary" disabled={busy} onClick={() => open('guest')}>Join</Btn>
              </div>
            </div>
          </div>
          {kind === 'p2p'
            ? <p className="small muted">Everyone plays in real time on one shared clock. Anyone can pause; the host saves the game. Send the other players this page's link and the room code.</p>
            : <p className="small muted">Everyone plays in real time on one shared clock. Anyone can pause; the host saves the game. To play from different computers, the other players need access to this page: share it from its Share menu with permission to edit or contribute.</p>}
        </div>
      )}
      {session && <Lobby s={session} source={source} setSource={setSource} saves={saves} onLeave={leave} setErr={setErr} />}
      {kind === 'p2p' && <NetCheck />}
      <p className="small muted" style={{ marginTop: 8 }}>
        Game version <b>{BUILD}</b>{latest === BUILD ? ' (the newest)' : ''}. Everyone in a game should show the same version.
        {latest && latest !== BUILD
          ? <span className="warn"> A newer version ({latest}) is out: {session ? 'after this game, reload the page to get it' : 'reload the page (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) to get it'}.</span>
          : ' The game updates itself when you open it.'}
      </p>
    </Modal>
  );
}

const CODE_CHARS = /[abcdefghjkmnpqrstuvwxyz23456789]{6}/;
/** Pull the room code out of whatever was typed or pasted (an invite link, a sentence…). */
export function extractCode(text: string): string {
  const low = text.trim().toLowerCase();
  const fromLink = low.match(/join=([a-z0-9]+)/)?.[1];
  if (fromLink) return fromLink;
  const words = low.split(/[^a-z0-9]+/).filter(Boolean);
  const exact = words.find((w) => w.length === 6 && CODE_CHARS.test(w));
  if (exact) return exact;
  return low.match(CODE_CHARS)?.[0] ?? low.replace(/[^a-z0-9]/g, '');
}
function inviteLink(code: string) { return `${location.origin}${location.pathname}#join=${code}`; }
const VIA: Record<string, string> = { direct: 'direct peer-to-peer', server: 'through the matchmaking server', mqtt: 'through a relay server' };
function progressText(s: Session) {
  const p = s.progress;
  if (s.role === 'host') return 'Opening your room…';
  if (!p || p.stage === 'searching') return `Looking for game ${s.code}…`;
  if (p.stage === 'found') return `Found the game — connecting (${VIA[p.via ?? ''] ?? 'connecting'})…`;
  return 'Connected.';
}
function connectionText(s: Session) {
  const i = s.info();
  if (!i) return 'online';
  if (i.role === 'guest') return `online (${VIA[i.via ?? ''] ?? 'connected'}${i.via && i.via !== 'direct' ? ', a little slower' : ''})`;
  return 'online — your room is open';
}
function HostPaths({ s }: { s: Session }) {
  const i = s.info()!;
  const up = i.paths.filter((p) => p.up).length;
  return (
    <p className="small muted">
      Reachable via: {i.paths.map((p) => <span key={p.name} className={p.up ? 'good' : 'bad'} title={p.detail}>{p.up ? '✓' : '✗'} {p.name} </span>)}
      {!up && <b className="bad"> — your room is offline, reconnecting… Players can't join until this clears.</b>}
      {i.guests.length > 0 && <> · players connected {i.guests.map((g) => `${s.seats.find((x) => x.peer === g.peer)?.name ?? 'player'} (${g.via ?? '…'})`).join(', ')}</>}
    </p>
  );
}

function Lobby({ s, source, setSource, saves, onLeave, setErr }: { s: Session; source: string; setSource: (v: string) => void; saves: SaveMeta[]; onLeave: () => void; setErr: (e: string) => void }) {
  useStore();
  const me = s.myPeer;
  const seats = s.seats;
  const taken: Record<string, string> = {};
  for (const x of seats) if (x.nation && x.peer !== me) taken[x.nation] = x.name;
  const guests = seats.filter((x) => x.role === 'guest');
  const dupes = new Set<string>();
  const seen = new Set<string>();
  for (const x of seats) if (x.nation) { if (seen.has(x.nation)) dupes.add(x.nation); seen.add(x.nation); }
  const hostSeat = seats.find((x) => x.role === 'host');
  const fromSave = source !== 'new' ? saves.find((m) => m.slot === source) : undefined;
  const ready = guests.length > 0 && guests.every((x) => x.nation) && !dupes.size && !!s.nation;
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const start = async () => {
    try {
      let g;
      const guestNations = guests.map((x) => x.nation!).filter(Boolean);
      if (fromSave) {
        g = await loadGame(fromSave.slot);
        g.tutorial = null;
        for (const n of [g.player, ...guestNations]) { if (g.nations[n]) { g.nations[n].isPlayer = true; } }
        g.players = [...new Set([g.player, ...guestNations])];
      } else {
        g = newGame('sandbox', { nation: s.nation!, players: guestNations });
      }
      await s.hostStart(g);
    } catch (e) { setErr(`Could not start: ${(e as Error).message}`); }
  };

  return (
    <div className="lobby">
      <div className="lobby-code">
        <span className="small muted">Room code</span>
        <b className="code">{s.code}</b>
        <Btn small onClick={async () => { try { await navigator.clipboard.writeText(s.code); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy'}</Btn>
        {s.kind === 'online' && !isHosted() && <Btn small onClick={async () => { try { await navigator.clipboard.writeText(inviteLink(s.code)); setCopiedLink(true); } catch { setCopiedLink(false); } }}>{copiedLink ? 'Link copied' : 'Copy invite link'}</Btn>}
        <span className="small muted">{s.role === 'host' ? 'Give this code to the other players.' : hostSeat ? `Connected to ${hostSeat.name}'s room.` : 'Looking for the host…'}</span>
      </div>
      <div className="lobby-grid">
        <div>
          <h4>Players ({seats.length})</h4>
          <ul className="seats">
            {seats.map((x) => (
              <li key={x.peer} className={x.peer === me ? 'me' : ''}>
                <b>{x.name}</b>{x.peer === me && <span className="muted"> (you)</span>}{x.role === 'host' && <span className="chip">host</span>}
                <span className={x.nation ? (dupes.has(x.nation) ? 'bad' : '') : 'muted'}>{x.nation ? COUNTRY_GEO[x.nation]?.name : 'choosing a nation…'}</span>
              </li>
            ))}
          </ul>
          {s.role === 'host' && (
            <>
              <h4>World</h4>
              <select id="mp-source" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="new">New world (2040)</option>
                {saves.map((m) => <option key={m.slot} value={m.slot}>Continue save: {COUNTRY_GEO[m.nation]?.name} · {fmtDate({ startYear: 2040 }, m.day)}</option>)}
              </select>
              {fromSave && <p className="small muted">You play {COUNTRY_GEO[fromSave.nation]?.name} from this save; guests take over the nations they pick.</p>}
            </>
          )}
          {s.loading && <div className="loadbar"><span>Receiving the game… {s.loading.got}/{s.loading.of}</span><div className="bar" style={{ height: 6 }}><div style={{ width: `${(s.loading.got / s.loading.of) * 100}%`, background: 'var(--gold)' }} /></div></div>}
          {s.status && <p className="warn small">{s.status}</p>}
          {seats.some((x) => x.peer !== me && x.build !== BUILD) && (
            <p className="bad small">⚠ Not everyone is running the same version of the game ({seats.filter((x) => x.build !== BUILD).map((x) => `${x.name}: ${x.build ?? 'older'}`).join(', ')}; yours: {BUILD}). Everyone should reload the page with Ctrl+Shift+R before starting.</p>
          )}
          <p className="small muted">Connection: {s.kind === 'online' ? (isHosted() ? 'online (claude.ai room)' : connectionText(s)) : 'local test mode (tabs of this browser only)'} · {seats.length} in this room{s.connected() ? '' : ' · reconnecting…'}</p>
          {s.role === 'host' && s.info() && <HostPaths s={s} />}
          {s.role === 'guest' && !hostSeat && <p className="warn small">The host isn't visible in this room yet. Check the code matches exactly, and that the host's lobby also says “online”. If it still doesn't appear after a few seconds, leave and join again.</p>}
          {s.role === 'host' && !guests.length && <p className="small muted">Waiting for players. Each player opens this same page, clicks Online multiplayer → Join and types the code. They appear here as soon as they join.</p>}
        </div>
        <div>
          <h4>Your nation</h4>
          {fromSave && s.role === 'host'
            ? <p>{COUNTRY_GEO[fromSave.nation]?.name}</p>
            : <NationPicker value={s.nation} taken={taken} onChange={(id) => void s.setNation(id)} />}
        </div>
      </div>
      <div className="row gap end">
        <Btn kind="ghost" onClick={onLeave}>Leave room</Btn>
        {s.role === 'host'
          ? <Btn kind="primary" disabled={!ready} title={ready ? '' : 'Every player needs a different nation (and at least one guest must have joined).'} onClick={() => { if (fromSave) void s.setNation(fromSave.nation).then(start); else void start(); }}>Start game</Btn>
          : <span className="muted small">{s.phase === 'loading' ? 'Loading the game…' : s.nation ? 'Ready. Waiting for the host to start.' : 'Pick a nation.'}</span>}
      </div>
    </div>
  );
}
