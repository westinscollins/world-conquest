import { useEffect, useState } from 'react';
import { store, useStore, type MapMode, type Panel } from './store';
import { Icon } from './icons';
import { Modal, Btn } from './common';
import { EconomyPanel } from './panels/EconomyPanel';
import { WarPanel } from './panels/WarPanel';
import { live } from './live';
import { num, neg } from './format';
import { PROV } from '../engine/geo';
import { armyStrength, armyMaxStrength, armyOrg } from '../engine/military';
import { MilitaryPanel } from './panels/MilitaryPanel';
import { DiplomacyPanel } from './panels/DiplomacyPanel';
import { ResearchPanel, StatsPanel, HelpPanel } from './panels/OtherPanels';
import { fmtDate } from '../engine/events';
import { focusProvince } from './commands';
import { TUTORIAL } from '../engine/tutorial';
import { EVENTS } from '../engine/policy';
import { cls } from './format';
import { audio } from '../audio/music';

const NAV: [Exclude<Panel, null>, string, string][] = [
  ['war', 'War Room', 'battle'], ['economy', 'Economy', 'coin'], ['military', 'Military', 'manpower'], ['diplomacy', 'Diplomacy', 'handshake'],
  ['research', 'Research', 'flask'], ['stats', 'Objectives', 'crown'], ['help', 'Help', 'book'],
];
const TITLES: Record<string, string> = { war: 'War Room', economy: 'Economy & Budget', military: 'Military Command', diplomacy: 'Diplomacy', research: 'Research & Technology', stats: 'Objectives & History', help: 'Field Manual' };

export function LeftNav() {
  const { g, ui } = useStore();
  if (!g) return null;
  const fights = g.activeBattles.filter((id) => { const b = g.battles[id]; return b && (b.attacker.nation === g.player || b.defender.nation === g.player); }).length;
  const offers = g.peaceOffers.filter((o) => o.to === g.player).length + g.proposals.filter((p) => p.to === g.player).length;
  return (
    <>
      <nav className="leftnav">
        {NAV.map(([k, l, i]) => (
          <button key={k} className={cls('nav-btn', ui.panel === k && 'on')} onClick={() => { audio.sfx('click'); store.setUI({ panel: ui.panel === k ? null : k }); }}>
            <Icon name={i} size={20} />
            <span>{l}</span>
            {k === 'diplomacy' && offers > 0 && <span className="badge">{offers}</span>}
            {k === 'war' && fights > 0 && <span className="badge">{fights}</span>}
          </button>
        ))}
      </nav>
      {ui.panel && (
        <div className="drawer">
          <div className="drawer-h"><span>{TITLES[ui.panel]}</span><button className="iconbtn" onClick={() => store.setUI({ panel: null })}><Icon name="close" /></button></div>
          {ui.panel === 'war' && <WarPanel />}
          {ui.panel === 'economy' && <EconomyPanel />}
          {ui.panel === 'military' && <MilitaryPanel />}
          {ui.panel === 'diplomacy' && <DiplomacyPanel />}
          {ui.panel === 'research' && <ResearchPanel />}
          {ui.panel === 'stats' && <StatsPanel />}
          {ui.panel === 'help' && <HelpPanel />}
        </div>
      )}
    </>
  );
}

export function MapModes() {
  const { ui } = useStore();
  const modes: [MapMode, string][] = [['political', 'Political'], ['terrain', 'Terrain'], ['resources', 'Resources'], ['infrastructure', 'Infrastructure'], ['supply', 'Supply'], ['military', 'Military'], ['diplomacy', 'Diplomacy']];
  return (
    <div className="mapmodes">
      {modes.map(([m, l]) => <button key={m} className={cls('mm', ui.mapMode === m && 'on')} onClick={() => store.setUI({ mapMode: m })}>{l}</button>)}
    </div>
  );
}

export function EventLog() {
  const { g } = useStore();
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<'all' | 'battle' | 'economy' | 'diplomacy'>('all');
  if (!g) return null;
  const evs = g.events.filter((e) => filter === 'all' || e.kind === filter || (filter === 'diplomacy' && (e.kind === 'war' || e.kind === 'peace'))).slice(-60).reverse();
  return (
    <div className={cls('eventlog', !open && 'closed')}>
      <div className="el-h">
        <button className="iconbtn small" onClick={() => setOpen(!open)}>{open ? '▾' : '▴'}</button>
        <b>Dispatches</b>
        {open && (['all', 'battle', 'economy', 'diplomacy'] as const).map((f) => <button key={f} className={cls('mm small', filter === f && 'on')} onClick={() => setFilter(f)}>{f}</button>)}
      </div>
      {open && (
        <div className="el-list">
          {evs.map((e) => (
            <div key={e.id} className={`el-ev k-${e.kind}${e.important ? ' imp' : ''}`} onClick={() => { if (e.battleId != null && g.battles[e.battleId]) store.setUI({ battleReport: e.battleId }); else if (e.province != null) { focusProvince(e.province); store.setUI({ selectedProvince: e.province }); } }}>
              <span className="el-date">{fmtDate(g, e.day)}</span>
              <span>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Live war ticker: provinces changing hands and the running casualty count. */
/** Tab / shift-Tab: jump between your armies. */
function cycleArmy(dir: number) {
  const g = store.game!;
  const list = Object.values(g.armies).filter((a) => a.owner === g.player && !a.embarked).sort((a, b) => a.id - b.id);
  if (!list.length) return;
  const i = list.findIndex((a) => a.id === store.ui.selectedArmy);
  const a = list[(i + dir + list.length) % list.length];
  store.setUI({ selectedArmy: a.id, selectedProvince: a.location, selectedFleet: null, group: [] });
  focusProvince(a.location);
}
/** Single-key orders for the selected army (and any armies grouped with it). */
function armyHotkey(k: string) {
  const g = store.game!;
  const id = store.ui.selectedArmy;
  if (id == null || g.armies[id]?.owner !== g.player) return;
  const ids = [id, ...store.ui.group];
  const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');
  if (k === 'm') store.setUI({ moveMode: store.ui.moveMode === id ? null : id });
  else if (k === 'h') ids.forEach((x) => store.cmd('haltArmy', [x]));
  else if (k === 'r') ids.forEach((x) => { if (g.armies[x]?.battleId != null) say(store.cmd('retreatArmy', [x])); });
  else if (k === 'f') { ids.forEach((x) => store.cmd('setStance', [x, 'advance'])); store.toast('Orders: attack', 'info'); }
  else if (k === 'd') { ids.forEach((x) => store.cmd('setStance', [x, 'defend'])); store.toast('Orders: defend', 'info'); }
  else if (k === 'g') { ids.forEach((x) => store.cmd('setStance', [x, 'hold'])); store.toast('Orders: hold', 'info'); }
}

/** One-click list of your armies above the map modes. */
export function ArmyBar() {
  const { g, ui } = useStore();
  if (!g) return null;
  const list = Object.values(g.armies).filter((a) => a.owner === g.player).sort((a, b) => a.id - b.id);
  if (!list.length) return null;
  return (
    <div className="army-bar">
      {list.map((a) => {
        const sel = ui.selectedArmy === a.id || ui.group.includes(a.id);
        const str = armyStrength(a), max = armyMaxStrength(a) || 1;
        return (
          <button key={a.id} className={cls('ab', sel && 'sel', a.battleId != null && 'fight')} title={`${a.name} — ${PROV[a.location].name}${a.path.length ? ' (moving)' : ''}. Click: select · shift-click: add to group · double-click: zoom`}
            onClick={(e) => {
              if (e.shiftKey && ui.selectedArmy != null && ui.selectedArmy !== a.id) store.setUI({ group: ui.group.includes(a.id) ? ui.group.filter((x) => x !== a.id) : [...ui.group, a.id] });
              else store.setUI({ selectedArmy: a.id, selectedProvince: a.location, selectedFleet: null, group: [] });
            }}
            onDoubleClick={() => focusProvince(a.location)}>
            {a.battleId != null ? '⚔' : a.path.length ? '→' : a.stance === 'advance' ? '▲' : a.stance === 'defend' ? '■' : '●'} {a.name.replace(' Army', '')}
            <span className="mini"><div style={{ width: `${(str / max) * 100}%`, background: armyOrg(a) < 0.35 ? 'var(--bad)' : undefined }} /></span>
            <span className="muted">{num(Math.round(str / 1000))}k</span>
          </button>
        );
      })}
    </div>
  );
}

export function LiveTicker() {
  const { g } = useStore();
  if (!g) return null;
  const atWarNow = g.wars.some((w) => w.attackers.includes(g.player) || w.defenders.includes(g.player));
  const [mine, theirs] = live.recent(g, 7);
  if (!atWarNow && !live.ticker.length) return null;
  return (
    <div className="live-ticker">
      {live.ticker.map((t) => (
        <div key={t.id} className={cls('lt', t.kind)} onClick={() => { focusProvince(t.province); store.setUI({ selectedProvince: t.province }); }}>{t.kind === 'good' ? '⚑ ' : '✖ '}{t.text}</div>
      ))}
      {atWarNow && (
        <div className="lt-sum" onClick={() => store.setUI({ panel: 'war' })} title="Open the War Room">
          ⚔ Last 7 days: <b className="bad">{neg(mine)}</b> yours · <b>{neg(theirs)}</b> enemy
        </div>
      )}
    </div>
  );
}

export function Toasts() {
  const { ui } = useStore();
  return <div className="toasts">{ui.toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}

export function ConfirmDialog() {
  const { ui } = useStore();
  const c = ui.confirm;
  if (!c) return null;
  const close = () => store.setUI({ confirm: null });
  return (
    <Modal title={c.title} onClose={close}>
      <p className="pre">{c.body}</p>
      <div className="row gap end">
        <Btn onClick={close}>Cancel</Btn>
        <Btn kind={c.danger ? 'danger' : 'primary'} onClick={() => { close(); c.onOk(); }}>Confirm</Btn>
      </div>
    </Modal>
  );
}

/** A national event waiting for the player's decision (time keeps running). */
export function DecisionCard() {
  const { g } = useStore();
  const [min, setMin] = useState(false);
  const e = g?.nations[g.player]?.gov?.event;
  if (!g || !e) return null;
  const spec = EVENTS[e.kind];
  if (!spec) return null;
  const n = g.nations[g.player];
  return (
    <div className={cls('decision-card', min && 'min')} style={g.tutorial && !g.tutorial.done ? { top: 280 } : undefined}>
      <div className="row"><h4>{spec.title}</h4><div style={{ flex: 1 }} /><span className="small muted">{Math.max(0, e.deadline - g.day)}d to decide</span><button className="iconbtn small" onClick={() => setMin(!min)}>{min ? '▴' : '▾'}</button></div>
      {!min && (
        <>
          <p style={{ margin: '4px 0' }}>{spec.text(g, n, e)}</p>
          {spec.options.map((o, i) => (
            <button key={i} className="btn opt" onClick={() => { const r = store.cmd('doAnswerEvent', [i]); if (r && !r.ok) store.toast(r.message, 'bad'); }}>
              {o.label}<small>{o.desc}{i === 0 ? ' (chosen automatically if you wait)' : ''}</small>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

export function TutorialCard() {
  const { g, ui } = useStore();
  const [min, setMin] = useState(false);
  if (!g?.tutorial || g.tutorial.done || ui.panel === 'help') return null;
  const s = TUTORIAL[g.tutorial.step];
  if (!s) return null;
  return (
    <div className={cls('tut-card', min && 'min')}>
      <div className="row"><b>Tutorial {g.tutorial.step + 1}/{TUTORIAL.length}: {s.title}</b><div style={{ flex: 1 }} /><button className="iconbtn small" onClick={() => setMin(!min)}>{min ? '▴' : '▾'}</button></div>
      {!min && <><p>{s.text}</p><p className="hint">▶ {s.hint}</p></>}
    </div>
  );
}

export function OutcomeModal() {
  const { g } = useStore();
  const [dismissed, setDismissed] = useState<number | null>(null);
  if (!g?.outcome || dismissed === g.outcome.day) return null;
  const o = g.outcome;
  const n = g.nations[g.player];
  return (
    <Modal title={o.won ? 'Victory' : 'Defeat'} onClose={() => setDismissed(o.day)} className={o.won ? 'victory' : 'defeat'}>
      <div className="outcome">
        <Icon name={o.won ? 'crown' : 'alert'} size={56} color={o.won ? '#e8c36a' : '#c0504a'} />
        <h2>{o.reason}</h2>
        <p>{fmtDate(g, o.day)} — {n.name}</p>
        <p className="small">Battles won {n.stats.battlesWon} · lost {n.stats.battlesLost} · provinces at peak {n.stats.peakProvinces}</p>
        <div className="row gap center">
          {o.won && <Btn kind="primary" onClick={() => { g.outcome = { ...o, reason: o.reason }; setDismissed(o.day); store.setUI({}); }}>Keep playing</Btn>}
          {!o.won && n.alive && <Btn onClick={() => { g.outcome = null; setDismissed(o.day); store.setUI({}); }}>Continue anyway</Btn>}
          <Btn onClick={() => store.setUI({ panel: 'stats' })}>View history</Btn>
          <Btn kind="ghost" onClick={() => store.quitToMenu()}>Main menu</Btn>
        </div>
      </div>
    </Modal>
  );
}

/** Global keyboard shortcuts. */
export function useHotkeys() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (!store.game || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); store.togglePause(); }
      else if (e.key === '1' || e.key === '2' || e.key === '3') store.setSpeed(+e.key);
      else if (e.key === 'Escape') store.setUI({ selectedArmy: null, selectedFleet: null, panel: null, intel: null, battleReport: null, moveMode: null, strike: null, group: [] });
      else if (e.key === 'Tab') { e.preventDefault(); cycleArmy(e.shiftKey ? -1 : 1); }
      else armyHotkey(e.key.toLowerCase());
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}

/** In-game multiplayer status: who is connected, sync state, and host controls for absent players. */
export function OnlineBar() {
  const { g } = useStore();
  const [open, setOpen] = useState(false);
  const s = store.net;
  if (!s || !g) return null;
  const online = new Map(s.seats.map((x) => [x.nation, x]));
  const absent = g.players.filter((n) => n !== g.player && !online.get(n));
  const problem = s.status || (s.loading ? `Receiving the game… ${s.loading.got}/${s.loading.of}` : '');
  return (
    <>
      <div className={cls('online-pill', (!!problem || absent.length > 0) && 'warn')} onClick={() => setOpen(!open)} title="Multiplayer status">
        <span className="dot" /> Online · {s.code} · {s.seats.length} connected{s.role === 'guest' ? '' : ' · you host'}
      </div>
      {open && (
        <div className="online-pop" onMouseLeave={() => setOpen(false)}>
          <b>Players</b>
          {g.players.map((n) => {
            const seat = online.get(n);
            return (
              <div key={n} className="row gap">
                <span className="swatch" style={{ background: g.nations[n]?.color }} />
                <span style={{ flex: 1 }}>{g.nations[n]?.name}{n === g.player ? ' (you)' : ''}</span>
                <span className={seat ? 'good small' : 'bad small'}>{seat ? seat.name : 'disconnected'}</span>
                {s.role === 'host' && !seat && n !== g.player && <Btn small onClick={() => store.cmd('setHumanControl', [n, false])}>Hand to AI</Btn>}
              </div>
            );
          })}
          {s.role === 'host' && g.players.length === 1 && <p className="small muted">Everyone else has left or been handed to the AI.</p>}
          <p className="small muted">{s.role === 'host' ? 'Your computer runs the shared clock. Save from the menu as usual; to continue later, host again from that save and players rejoin with the code.' : 'The host runs the shared clock. Anyone can pause. Orders take a moment to reach the host.'}{s.desyncs ? ` Re-synced ${s.desyncs}×.` : ''}</p>
        </div>
      )}
      {problem && <div className="net-banner">{problem}</div>}
    </>
  );
}
