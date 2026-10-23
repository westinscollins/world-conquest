import { useEffect, useState } from 'react';
import { store, createSession, useStore } from './store';
import { Modal, Btn } from './common';
import { NationPicker } from './NationPicker';
import { newRoomCode, type Session } from './net/session';
import { transportKind } from './net/transport';
import { newGame } from '../engine/setup';
import { listSaves, loadGame } from './storage';
import type { SaveMeta } from '../engine/save';
import { COUNTRY_GEO } from '../engine/geo';
import { fmtDate } from '../engine/events';
import { audio } from '../audio/music';

const NAME_KEY = 'wc-mp-name';
function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
function rememberName(n: string) { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } }

export function MultiplayerDialog({ onClose }: { onClose: () => void }) {
  useStore();
  const [name, setName] = useState(savedName());
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'online' | 'local' | null | undefined>(undefined);
  const [session, setSession] = useState<Session | null>(store.net);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<'new' | string>('new');
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  useEffect(() => { transportKind().then(setKind); listSaves().then(setSaves).catch(() => {}); }, []);
  // once the game is running the lobby is done
  useEffect(() => { if (store.ui.screen === 'game' && session?.phase === 'playing') onClose(); });

  const open = async (role: 'host' | 'guest') => {
    setErr('');
    const nm = name.trim() || (role === 'host' ? 'Host' : 'Guest');
    rememberName(nm);
    const c = role === 'host' ? newRoomCode() : code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (role === 'guest' && c.length < 4) { setErr('Enter the room code your host gave you.'); return; }
    setBusy(true);
    try {
      audio.init();
      const s = createSession(role, c, nm);
      await s.open();
      store.net = s;
      if (role === 'host') await s.setNation('SRB');
      setSession(s);
    } catch (e) {
      setErr(`Could not open the room: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };
  const leave = async () => { await session?.close(); store.net = null; setSession(null); };
  const closeAll = async () => { if (session && session.phase !== 'playing') await leave(); onClose(); };

  return (
    <Modal title="Online multiplayer" onClose={closeAll} wide>
      {kind === undefined && <p className="muted">Checking the connection…</p>}
      {kind === null && <p className="error">Multiplayer is not available in this browser.</p>}
      {kind === 'local' && <p className="note small">Local test mode: this copy of the game is not on the hosted page, so players can only connect from other tabs of this same browser. On the hosted page, players on different computers connect through the room code.</p>}
      {err && <div className="error">{err}</div>}
      {!session && kind && (
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
                <input id="mp-code" className="code-in" maxLength={8} value={code} placeholder="room code" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open('guest')} />
                <Btn kind="primary" disabled={busy} onClick={() => open('guest')}>Join</Btn>
              </div>
            </div>
          </div>
          <p className="small muted">Everyone plays in real time on one shared clock. Anyone can pause; the host saves the game. To play from different computers, the other players need access to this page: share it from its Share menu with permission to edit or contribute.</p>
        </div>
      )}
      {session && <Lobby s={session} source={source} setSource={setSource} saves={saves} onLeave={leave} setErr={setErr} />}
    </Modal>
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
