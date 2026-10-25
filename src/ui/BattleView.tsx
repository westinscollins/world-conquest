// The battlefield up close: both armies drawn on the ground, the day's fighting animated, and the
// commander's deck — tomorrow's manoeuvre, the scouts' report and support to call in.
import { useEffect, useRef } from 'react';
import { store, useStore } from './store';
import { Btn, Bar } from './common';
import { GlyphShape, type Glyph } from './glyphs';
import { num, neg, money, cls } from './format';
import { PROV, distKm } from '../engine/geo';
import { TACTICS, BATTLE_SUPPORT, TERRAIN, WEATHER, UNITS } from '../engine/config';
import { commandSide, canSupport, supportCost, ensureCmd } from '../engine/battle';
import { armyStrength, armyOrg } from '../engine/military';
import type { Army, Battle, GameState, SupportKind, Tactic, Terrain, Unit, Weather } from '../engine/types';
import { focusProvince } from './commands';
import { audio } from '../audio/music';

const W = 1000, H = 360, HORIZON = 132;
const LANE0 = 176, LANE = 38; // five lanes of troops from the horizon toward the viewer
const SKY: Record<Weather, [string, string]> = {
  clear: ['#5d97cf', '#cfe4f3'], rain: ['#4f5963', '#9ba6b0'], snow: ['#aeb9c4', '#eef2f6'], mud: ['#6f7368', '#b3b19d'],
  monsoon: ['#34424a', '#76868b'], heat: ['#d9a75c', '#f6e0ae'], fog: ['#a4a9ac', '#d8dadb'], storm: ['#252b32', '#535b63'],
};
const TACTIC_LIST: Tactic[] = ['assault', 'hold', 'flank'];
const SUPPORTS: SupportKind[] = ['barrage', 'drone', 'air', 'reserves', 'rally'];
const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');
/** Stable pseudo-random numbers for decoration (same picture every render). */
const hash = (i: number, k = 0) => { let h = (i * 374761393 + k * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

const glyphOf = (u: Unit): Glyph => (u.type === 'armored' ? 'armored' : u.type === 'mechanized' ? 'mechanized' : u.type === 'artillery' ? 'artillery' : u.type === 'recon' ? 'recon' : u.type === 'engineers' ? 'engineers' : 'infantry');

/** Open a battle: the live battlefield while it lasts, the report once it is over. */
export function openBattle(id: number) {
  const b = store.game?.battles[id];
  if (!b) return;
  if (b.result == null) store.setUI({ battleView: id, battleReport: null });
  else store.setUI({ battleReport: id, battleView: null });
}

export function BattleView() {
  const { g, ui } = useStore();
  const b: Battle | undefined = g && ui.battleView != null ? g.battles[ui.battleView] : undefined;
  // single player: the clock stops while you command, and runs again when you leave
  const resume = useRef(0);
  useEffect(() => {
    if (ui.battleView == null) return;
    document.body.classList.add('bv-open');
    if (!store.net && store.ui.speed > 0) { resume.current = store.ui.speed; store.setSpeed(0); }
    return () => { document.body.classList.remove('bv-open'); if (resume.current && !store.net && store.ui.speed === 0) store.setSpeed(resume.current); resume.current = 0; };
  }, [ui.battleView]);
  if (!g || !b) return null;
  const side = commandSide(g, b, g.player);
  const me = side ?? 'a';
  const mineSide = me === 'a' ? b.attacker : b.defender, theirSide = me === 'a' ? b.defender : b.attacker;
  const arm = (ids: number[]) => ids.map((id) => g.armies[id]).filter((a): a is Army => !!a && a.battleId === b.id);
  const mine = arm(mineSide.armyIds), theirs = arm(theirSide.armyIds);
  const last = b.timeline[b.timeline.length - 1];
  const close = () => store.setUI({ battleView: null });
  const myN = g.nations[mineSide.nation], thN = g.nations[theirSide.nation];
  const online = !!store.net;
  const over = b.result != null;
  const won = over && ((b.result === 'attacker') === (me === 'a')) && b.result !== 'stalemate';
  return (
    <div className="bv" role="dialog" aria-label={`Battle of ${PROV[b.province].name}`}>
      <div className="bv-top">
        <div>
          <h2>Battle of {PROV[b.province].name}</h2>
          <div className="small muted">Day {b.timeline.length} · {TERRAIN[b.terrain].label}{b.river ? ' · river' : ''}{b.amphibious ? ' · beach landing' : ''}{b.fort ? ` · forts ${b.fort}` : ''} · {WEATHER[b.weather].label}{side ? ` · you are ${me === 'a' ? 'attacking' : 'defending'}` : ' · you are watching'}</div>
        </div>
        <div style={{ flex: 1 }} />
        {!online && <Btn small onClick={() => store.togglePause()}>{ui.speed === 0 ? '▶ Resume time' : '❚❚ Pause'}</Btn>}
        {!online && !over && <Btn small kind="primary" onClick={() => { audio.sfx('battle'); store.stepDay(); }}>Fight next day ▸</Btn>}
        <Btn small onClick={() => { focusProvince(b.province); close(); }}>Map</Btn>
        <Btn small onClick={() => store.setUI({ battleReport: b.id, battleView: null })}>Report</Btn>
        <button className="iconbtn" title="Close (Esc)" onClick={close}>✕</button>
      </div>
      <div className="bv-strength">
        <SideBar name={myN?.name ?? ''} color={myN?.color} armies={mine} lost={mineSide.losses.killed + mineSide.losses.wounded} you={!!side} />
        <Odds g={g} mine={mine} theirs={theirs} />
        <SideBar name={thN?.name ?? ''} color={thN?.color} armies={theirs} lost={theirSide.losses.killed + theirSide.losses.wounded} right />
      </div>
      <Scene g={g} b={b} me={me} mine={mine} theirs={theirs} />
      {last && <DayBanner key={b.timeline.length} b={b} me={me} />}
      {over ? (
        <div className={cls('bv-over', won ? 'won' : b.result === 'stalemate' ? '' : 'lost')}>
          <b>{b.result === 'stalemate' ? 'Stalemate' : won ? 'Victory!' : 'Defeat'}</b>
          <span>{b.summary}</span>
          <Btn kind="primary" onClick={() => store.setUI({ battleReport: b.id, battleView: null })}>Full report</Btn>
          <Btn onClick={close}>Close</Btn>
        </div>
      ) : side ? <Deck g={g} b={b} side={side} mine={mine} /> : (
        <div className="bv-deck"><p className="muted">You have no troops in this battle. You can watch it unfold; the commanders on both sides choose their own manoeuvres.</p></div>
      )}
      <History b={b} me={me} />
    </div>
  );
}

function SideBar({ name, color, armies, lost, right, you }: { name: string; color?: string; armies: Army[]; lost: number; right?: boolean; you?: boolean }) {
  const str = armies.reduce((t, a) => t + armyStrength(a), 0);
  const org = armies.length ? armies.reduce((t, a) => t + armyOrg(a) * armyStrength(a), 0) / Math.max(1, str) : 0;
  return (
    <div className={cls('bv-side', right && 'r')}>
      <div className="row gap"><span className="swatch" style={{ background: color }} /><b>{you ? `You (${name})` : name}</b></div>
      <div className="small">{num(str)} soldiers · lost <span className="bad">{neg(lost)}</span></div>
      <Bar value={org} h={7} color={org < 0.3 ? 'var(--bad)' : org < 0.55 ? 'var(--warn)' : 'var(--good)'} title={`Organisation ${Math.round(org * 100)}%: at zero the army breaks and retreats`} />
    </div>
  );
}

/** A rough reading of who is winning: soldiers weighted by how organised they still are. */
function Odds({ g, mine, theirs }: { g: GameState; mine: Army[]; theirs: Army[] }) {
  void g;
  const pw = (xs: Army[]) => xs.reduce((t, a) => t + armyStrength(a) * Math.pow(armyOrg(a) + 0.05, 1.5), 0);
  const a = pw(mine), d = pw(theirs);
  const p = a + d > 0 ? a / (a + d) : 0.5;
  return (
    <div className="bv-odds" title="Who is ahead: soldiers weighted by their organisation. Win the daily manoeuvres to tip it.">
      <div className="small muted">who is ahead</div>
      <div className="bv-tug"><div style={{ width: `${p * 100}%` }} /></div>
      <div className={cls('small', p > 0.55 ? 'good' : p < 0.45 ? 'bad' : '')}>{p > 0.62 ? 'You are winning' : p > 0.52 ? 'Slight edge to you' : p >= 0.48 ? 'Even fight' : p >= 0.38 ? 'Slight edge to them' : 'You are losing'}</div>
    </div>
  );
}

function DayBanner({ b, me }: { b: Battle; me: 'a' | 'd' }) {
  const d = b.timeline[b.timeline.length - 1];
  if (!d?.aTactic || !d.dTactic) return null;
  const myT = me === 'a' ? d.aTactic : d.dTactic, thT = me === 'a' ? d.dTactic : d.aTactic;
  const res = d.edge == null ? 'draw' : d.edge === me ? 'win' : 'loss';
  const lostMe = me === 'a' ? d.aDamage : d.dDamage, lostThem = me === 'a' ? d.dDamage : d.aDamage;
  return (
    <div className={cls('bv-banner', res)}>
      <b>Day {d.day}:</b> {TACTICS[myT].icon} your {TACTICS[myT].label} vs their {TACTICS[thT].label} {TACTICS[thT].icon} —{' '}
      {res === 'win' ? 'you won the day!' : res === 'loss' ? 'they read you and won the day.' : 'neither side outmanoeuvred the other.'}
      <span className="small muted"> (damage taken {lostMe.toFixed(0)} vs {lostThem.toFixed(0)})</span>
    </div>
  );
}

function History({ b, me }: { b: Battle; me: 'a' | 'd' }) {
  const days = b.timeline.filter((d) => d.aTactic).slice(-14);
  if (!days.length) return null;
  return (
    <div className="bv-history" title="Each day's manoeuvres: yours on top, theirs below. Green: you won the day.">
      {days.map((d) => {
        const res = d.edge == null ? 'draw' : d.edge === me ? 'win' : 'loss';
        return <span key={d.day} className={cls('bv-chip', res)}><small>{d.day}</small>{TACTICS[(me === 'a' ? d.aTactic : d.dTactic)!].icon}<i>{TACTICS[(me === 'a' ? d.dTactic : d.aTactic)!].icon}</i></span>;
      })}
      <span className="small muted">Watch their habits: the enemy general often repeats a move that worked, or answers the move that beat him.</span>
    </div>
  );
}

function Deck({ g, b, side, mine }: { g: GameState; b: Battle; side: 'a' | 'd'; mine: Army[] }) {
  const c = ensureCmd(b)[side];
  const attacking = side === 'a';
  const helpers = Object.values(g.armies)
    .filter((a) => a.owner === g.player && a.battleId == null && !a.embarked && !a.path.length && a.location !== b.province)
    .map((a) => ({ a, d: distKm(a.location, b.province) }))
    .sort((x, y) => x.d - y.d).slice(0, 6);
  const counter = c.hint ? TACTIC_LIST.find((t) => TACTICS[t].beats === c.hint)! : null;
  return (
    <div className="bv-deck">
      <div className="bv-col">
        <h4>Your move tomorrow</h4>
        <div className="bv-tactics">
          {TACTIC_LIST.map((t) => (
            <button key={t} className={cls('bv-tac', c.plan === t && 'on', c.order === 'auto' && 'auto')} title={TACTICS[t].desc} onClick={() => { audio.sfx('click'); say(store.cmd('setBattleTactic', [b.id, t])); }}>
              <span className="ic">{TACTICS[t].icon}</span><b>{TACTICS[t].label}</b><small>beats {TACTICS[TACTICS[t].beats].label}</small>
            </button>
          ))}
        </div>
        <label className="check small"><input type="checkbox" checked={c.order === 'auto'} onChange={(e) => say(store.cmd('setBattleTactic', [b.id, e.target.checked ? 'auto' : c.plan]))} /> Let my general choose{c.order === 'auto' ? ` (he plans to ${TACTICS[c.plan].label.toLowerCase()})` : ''}</label>
        <p className="small muted">Assault beats Flank · Flank beats Hold · Hold beats Assault. Winning the matchup: +30% damage dealt, −20% taken.</p>
      </div>
      <div className="bv-col">
        <h4>Scouts report</h4>
        {c.hint ? (
          <div className="bv-intel">
            <div>The enemy will probably <b>{TACTICS[c.hint].label.toUpperCase()}</b> {TACTICS[c.hint].icon}</div>
            <Bar value={c.hintSure} h={6} color={c.hintSure >= 1 ? 'var(--good)' : 'var(--gold)'} title="How sure the scouts are" />
            <div className="small">{c.hintSure >= 1 ? 'Certain — our drones watched them prepare.' : `${Math.round(c.hintSure * 100)}% sure. Better recon, recon drones and drone strikes make the reports surer.`}</div>
            {counter && <Btn small kind={c.plan === counter ? 'ghost' : 'primary'} disabled={c.plan === counter && c.order !== 'auto'} onClick={() => say(store.cmd('setBattleTactic', [b.id, counter]))}>{c.plan === counter && c.order !== 'auto' ? `Countering with ${TACTICS[counter].label}` : `Counter: ${TACTICS[counter].label}`}</Btn>}
          </div>
        ) : <p className="small muted">The first reports arrive after the first day of fighting.</p>}
      </div>
      <div className="bv-col">
        <h4>Support</h4>
        <div className="bv-support">
          {SUPPORTS.map((k) => {
            const why = canSupport(g, b, side, k);
            const queued = c.queued.includes(k);
            const cost = supportCost(g, b, side, k);
            const n = g.nations[g.player];
            return (
              <button key={k} className={cls('bv-sup', queued && 'on')} disabled={!!why} title={`${BATTLE_SUPPORT[k].desc}${why ? `\n\n${why}` : ''}`} onClick={() => { audio.sfx(k === 'barrage' || k === 'air' || k === 'drone' ? 'battle' : 'click'); say(store.cmd('useBattleSupport', [b.id, k])); }}>
                <span className="ic">{BATTLE_SUPPORT[k].icon}</span>
                <b>{BATTLE_SUPPORT[k].label}</b>
                <small>{queued ? 'ordered ✓' : why ? why.replace(/\.$/, '') : k === 'drone' ? (n.arsenal.drone > 0 ? `${n.arsenal.drone} in stock` : `buy 1: ${money(cost)}`) : cost > 0 ? money(cost) : 'free'}</small>
              </button>
            );
          })}
        </div>
      </div>
      <div className="bv-col narrow">
        <h4>Orders</h4>
        <Btn small kind="danger" onClick={() => mine.forEach((a) => say(store.cmd('retreatArmy', [a.id])))}>{attacking ? 'Call off the attack' : 'Retreat'}</Btn>
        {helpers.length > 0 && (
          <select value="" onChange={(e) => { if (e.target.value) say(store.cmd('moveArmy', [+e.target.value, b.province])); }}>
            <option value="">Send reinforcements…</option>
            {helpers.map(({ a, d }) => <option key={a.id} value={a.id}>{a.name} ({num(armyStrength(a))}, {Math.round(d)} km)</option>)}
          </select>
        )}
        <div className="small muted" style={{ marginTop: 6 }}>Why the fighting goes this way:</div>
        {b.factors.slice(0, 4).map((f, i) => {
          const good = (f.side === 'attacker') === attacking ? f.value > 0 : f.value < 0;
          return <div key={i} className={cls('small', good ? 'good' : 'bad')} title={f.detail}>{good ? '▲' : '▼'} {f.label}</div>;
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the battlefield picture
function Scene({ g, b, me, mine, theirs }: { g: GameState; b: Battle; me: 'a' | 'd'; mine: Army[]; theirs: Army[] }) {
  const myN = g.nations[(me === 'a' ? b.attacker : b.defender).nation], thN = g.nations[(me === 'a' ? b.defender : b.attacker).nation];
  const orgOf = (xs: Army[]) => { const t = xs.reduce((s, a) => s + armyStrength(a), 0); return t ? xs.reduce((s, a) => s + armyOrg(a) * armyStrength(a), 0) / t : 0; };
  const shift = Math.max(-170, Math.min(170, (orgOf(mine) - orgOf(theirs)) * 260));
  const front = W / 2 + shift;
  const last = b.timeline[b.timeline.length - 1];
  const hurtMe = last ? (me === 'a' ? last.aDamage : last.dDamage) : 0, hurtThem = last ? (me === 'a' ? last.dDamage : last.aDamage) : 0;
  const used = last?.support ?? [];
  const myUsed = (k: SupportKind) => used.some((u) => u.side === me && u.kind === k);
  const thUsed = (k: SupportKind) => used.some((u) => u.side !== me && u.kind === k);
  const air = b.factors.find((f) => f.label === 'Air superiority');
  const myAir = myUsed('air') || (air && ((air.side === 'attacker') === (me === 'a')) === (air.value > 0));
  const thAir = thUsed('air') || (air && ((air.side === 'attacker') === (me === 'a')) !== (air.value > 0));
  const width = TERRAIN[b.terrain].width;
  const blasts = (n: number) => Math.max(1, Math.min(10, Math.round(n / 4)));
  return (
    <svg className="bv-scene" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice">
      <defs>
        <linearGradient id="bv-sky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={SKY[b.weather][0]} /><stop offset="1" stopColor={SKY[b.weather][1]} /></linearGradient>
        <linearGradient id="bv-ground" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={shade(TERRAIN[b.terrain].color, 0.15)} /><stop offset="1" stopColor={shade(TERRAIN[b.terrain].color, -0.35)} /></linearGradient>
        <radialGradient id="bv-fire"><stop offset="0" stopColor="#fff6c0" /><stop offset="0.35" stopColor="#ffb040" /><stop offset="0.7" stopColor="#d9481c" stopOpacity="0.8" /><stop offset="1" stopColor="#5a1a08" stopOpacity="0" /></radialGradient>
        <pattern id="bv-raintex" width="14" height="28" patternUnits="userSpaceOnUse"><line x1="12" y1="0" x2="5" y2="18" stroke="#d6e4ef" strokeWidth="1.1" /></pattern>
        <pattern id="bv-snowtex" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="6" cy="8" r="1.6" fill="#fff" /><circle cx="26" cy="22" r="1.2" fill="#fff" /><circle cx="15" cy="34" r="1" fill="#fff" /></pattern>
        <radialGradient id="bv-smoke"><stop offset="0" stopColor="#55524c" stopOpacity="0.55" /><stop offset="1" stopColor="#55524c" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width={W} height={HORIZON + 4} fill="url(#bv-sky)" />
      <Backdrop terrain={b.terrain} />
      <rect y={HORIZON} width={W} height={H - HORIZON} fill="url(#bv-ground)" />
      <Ground terrain={b.terrain} />
      {b.river && <path d={`M${front - 30},${HORIZON} C${front - 60},${HORIZON + 90} ${front + 40},${HORIZON + 170} ${front - 10},${H}`} stroke="#4f86b8" strokeWidth={26} fill="none" opacity={0.85} />}
      {b.amphibious && <path d={`M0,${HORIZON} L${me === 'a' ? front - 120 : W} ${HORIZON} L${me === 'a' ? front - 220 : W} ${H} L0 ${H}Z`} fill="#3b74a8" opacity={0.75} transform={me === 'a' ? '' : `translate(${W},0) scale(-1,1)`} />}
      {/* defences on the defender's side */}
      {(b.fort > 0 || theirs.concat(mine).some((a) => a.entrench > 0.1)) && <Trench x={me === 'd' ? front - 26 : front + 26} />}
      {/* smoke drifting over the front */}
      {[0, 1, 2, 3, 4].map((i) => <circle key={i} className="bv-drift" cx={front - 120 + i * 60} cy={HORIZON + 40 + hash(i, 3) * 140} r={60 + hash(i, 4) * 50} fill="url(#bv-smoke)" style={{ animationDelay: `${-i * 2.3}s` }} />)}
      <Formation armies={mine} color={myN?.color ?? '#888'} front={front} dir={1} width={width} widen={myUsed('reserves')} />
      <Formation armies={theirs} color={thN?.color ?? '#888'} front={front} dir={-1} width={width} widen={thUsed('reserves')} />
      {/* small-arms fire across the line */}
      {Array.from({ length: 9 }, (_, i) => {
        const y = LANE0 + (i % 5) * LANE + hash(i, 1) * 10, fromMe = i % 2 === 0;
        return <line key={i} className="bv-tracer" x1={front + (fromMe ? -40 : 40)} y1={y} x2={front + (fromMe ? 60 : -60)} y2={y + (hash(i, 2) - 0.5) * 30} style={{ animationDelay: `${hash(i, 5) * 1.2}s` }} />;
      })}
      {/* explosions on whoever took the punishment today */}
      {Array.from({ length: blasts(hurtThem) }, (_, i) => <Blast key={`t${i}`} x={front + 30 + hash(i, 7) * 220} y={LANE0 + hash(i, 8) * LANE * 4} delay={hash(i, 9) * 2} />)}
      {Array.from({ length: blasts(hurtMe) }, (_, i) => <Blast key={`m${i}`} x={front - 30 - hash(i, 17) * 220} y={LANE0 + hash(i, 18) * LANE * 4} delay={hash(i, 19) * 2} />)}
      {/* artillery shells */}
      {(myUsed('barrage') || mine.some((a) => a.units.some((u) => u.type === 'artillery'))) && [0, 1, 2].map((i) => <path key={`sa${i}`} className={cls('bv-shell', myUsed('barrage') && 'heavy')} d={`M80,${LANE0 + 60 + i * 30} Q${front - 100},${40 + i * 20} ${front + 90 + i * 50},${LANE0 + 20 + i * 40}`} style={{ animationDelay: `${i * 0.7}s` }} />)}
      {(thUsed('barrage') || theirs.some((a) => a.units.some((u) => u.type === 'artillery'))) && [0, 1, 2].map((i) => <path key={`st${i}`} className={cls('bv-shell', thUsed('barrage') && 'heavy')} d={`M${W - 80},${LANE0 + 60 + i * 30} Q${front + 100},${40 + i * 20} ${front - 90 - i * 50},${LANE0 + 20 + i * 40}`} style={{ animationDelay: `${0.35 + i * 0.7}s` }} />)}
      {/* aircraft and drones */}
      {myAir && [0, 1, 2].map((i) => <g key={`ja${i}`} className="bv-jet" style={{ animationDelay: `${i * 1.6}s` }}><GlyphShape g="fighter" cx={0} cy={50 + i * 26} h={22} fill="#e8edf2" /></g>)}
      {thAir && [0, 1].map((i) => <g key={`jt${i}`} className="bv-jet rev" style={{ animationDelay: `${0.8 + i * 1.6}s` }}><GlyphShape g="fighter" cx={0} cy={70 + i * 26} h={20} fill="#2a2f36" /></g>)}
      {myUsed('drone') && [0, 1, 2].map((i) => <g key={`da${i}`} transform={`translate(${front + 120 + i * 70},${120 + i * 18})`}><g className="bv-drone" style={{ animationDelay: `${-i}s` }}><Drone /></g><circle className="bv-reticle" r={16} cy={90} /></g>)}
      {thUsed('drone') && [0, 1].map((i) => <g key={`dt${i}`} transform={`translate(${front - 140 - i * 80},${125 + i * 18})`}><g className="bv-drone" style={{ animationDelay: `${-i * 1.3}s` }}><Drone dark /></g></g>)}
      {(b.weather === 'rain' || b.weather === 'monsoon' || b.weather === 'storm') && <rect y={-28} width={W} height={H + 28} className="bv-rain" />}
      {b.weather === 'snow' && <rect y={-40} width={W} height={H + 40} className="bv-snow" />}
      {b.weather === 'fog' && <rect width={W} height={H} fill="#d8dadb" opacity={0.35} />}
    </svg>
  );
}

function Formation({ armies, color, front, dir, width, widen }: { armies: Army[]; color: string; front: number; dir: 1 | -1; width: number; widen: boolean }) {
  // the same split the battle uses: the best-organised line formations fill the combat width
  const all = armies.flatMap((a) => a.units);
  const line = all.filter((u) => !UNITS[u.type].support && u.strength > 50).sort((x, y) => y.org - x.org);
  const cap = Math.round(width * (widen ? 1.5 : 1));
  const inLine: Unit[] = [], reserve: Unit[] = [];
  let used = 0;
  for (const u of line) { if (u.org >= 0.08 && used + UNITS[u.type].width <= cap) { inLine.push(u); used += UNITS[u.type].width; } else reserve.push(u); }
  const support = all.filter((u) => UNITS[u.type].support && u.strength > 20);
  const lanes = 5;
  const place = (u: Unit, i: number, x0: number, step: number, max: number) => {
    if (i >= max) return null;
    const lane = i % lanes, col = Math.floor(i / lanes);
    const y = LANE0 + lane * LANE + (col % 2) * 10;
    const k = 0.85 + ((y - LANE0) / (LANE * 4)) * 0.6;
    const x = x0 - dir * col * step * k;
    const sp = UNITS[u.type];
    const h = (u.type === 'infantry' || u.type === 'artillery' ? 34 : 26) * k;
    const op = 0.35 + 0.65 * Math.min(1, u.strength / sp.personnel);
    return (
      <g key={u.id} className={cls('bv-unit', u.org < 0.2 && 'shaken')}>
        <ellipse cx={x} cy={y + h * 0.5} rx={h * 0.75} ry={h * 0.16} fill="#000" opacity={0.25} />
        <g transform={dir === -1 ? `translate(${2 * x},0) scale(-1,1)` : undefined}>
          <GlyphShape g={glyphOf(u)} cx={x} cy={y} h={h} fill={color} opacity={op} />
        </g>
        {u.org > 0.08 && i < max && <circle className="bv-flash" cx={x + dir * h * 0.7} cy={y - h * 0.15} r={2.6 * k} style={{ animationDelay: `${hash(u.id, 11) * 1.1}s` }} />}
        <rect x={x - 11 * k} y={y + h * 0.62} width={22 * k} height={2.4} fill="#0008" />
        <rect x={x - 11 * k} y={y + h * 0.62} width={22 * k * u.org} height={2.4} fill={u.org < 0.3 ? '#e2675a' : '#8fd18a'} />
      </g>
    );
  };
  const more = Math.max(0, inLine.length - 20) + Math.max(0, reserve.length - 10);
  return (
    <g>
      {inLine.map((u, i) => place(u, i, front - dir * 50, 58, 20))}
      {reserve.map((u, i) => place(u, i, front - dir * 300, 36, 10))}
      {support.filter((u) => u.type === 'artillery').map((u, i) => place(u, i, dir === 1 ? 70 : W - 70, 40, 10))}
      {support.filter((u) => u.type !== 'artillery').map((u, i) => place(u, i, front - dir * 220, 30, 5))}
      {more > 0 && <text x={dir === 1 ? 16 : W - 16} y={H - 12} textAnchor={dir === 1 ? 'start' : 'end'} className="bv-more">+{more} more formations</text>}
      {reserve.length > 0 && <text x={front - dir * 300} y={LANE0 - 24} textAnchor="middle" className="bv-label">reserve</text>}
    </g>
  );
}

function Blast({ x, y, delay }: { x: number; y: number; delay: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <circle className="bv-blast" r={18} fill="url(#bv-fire)" style={{ animationDelay: `${delay}s` }} />
      <circle className="bv-puff" r={22} fill="url(#bv-smoke)" style={{ animationDelay: `${delay + 0.25}s` }} />
    </g>
  );
}
function Drone({ dark }: { dark?: boolean }) {
  const c = dark ? '#262a30' : '#eef2f5';
  return (
    <g fill={c} stroke={c}>
      <rect x={-5} y={-2.5} width={10} height={5} rx={2} />
      <line x1={-10} y1={-6} x2={10} y2={6} strokeWidth={1.4} /><line x1={-10} y1={6} x2={10} y2={-6} strokeWidth={1.4} />
      {[[-10, -6], [10, 6], [-10, 6], [10, -6]].map(([x, y], i) => <ellipse key={i} cx={x} cy={y} rx={4.5} ry={1.3} opacity={0.7} />)}
    </g>
  );
}
function Trench({ x }: { x: number }) {
  return (
    <g>
      <path d={`M${x},${HORIZON + 30} ${Array.from({ length: 9 }, (_, i) => `L${x + (i % 2 ? 8 : -8)},${HORIZON + 30 + (i + 1) * 28}`).join(' ')}`} stroke="#3a2d1e" strokeWidth={7} fill="none" opacity={0.75} />
      {[0, 1, 2].map((i) => <path key={i} d={`M${x - 14},${LANE0 + 20 + i * 52} h28 v-9 q-14 -9 -28 0Z`} fill="#6b6457" stroke="#3a352c" />)}
    </g>
  );
}

function Backdrop({ terrain }: { terrain: Terrain }) {
  const far = '#7a8794', near = shade(TERRAIN[terrain].color, -0.15);
  if (terrain === 'mountains' || terrain === 'hills' || terrain === 'arctic') {
    const peak = terrain === 'hills' ? 40 : 95;
    const pts = Array.from({ length: 11 }, (_, i) => `${i * 100},${HORIZON - (i % 2 ? peak * (0.6 + hash(i, 21) * 0.4) : peak * 0.2 * hash(i, 22))}`).join(' L');
    return (
      <g>
        <path d={`M0,${HORIZON} L${pts} L${W},${HORIZON}Z`} fill={far} opacity={0.75} />
        {terrain !== 'hills' && Array.from({ length: 5 }, (_, i) => <path key={i} d={`M${100 + i * 200 - 18},${HORIZON - peak * 0.62 - hash(i * 2 + 1, 21) * peak * 0.3 + 18} l18,-18 l18,18Z`} fill="#f1f4f6" opacity={0.85} />)}
      </g>
    );
  }
  if (terrain === 'forest' || terrain === 'jungle' || terrain === 'taiga') {
    return <g fill={near}>{Array.from({ length: 46 }, (_, i) => { const x = i * 22 + hash(i, 23) * 10, h = 22 + hash(i, 24) * 22; return terrain === 'jungle' ? <circle key={i} cx={x} cy={HORIZON - h * 0.4} r={h * 0.55} /> : <path key={i} d={`M${x - h * 0.3},${HORIZON + 2} L${x},${HORIZON - h} L${x + h * 0.3},${HORIZON + 2}Z`} />; })}</g>;
  }
  if (terrain === 'desert') return <path d={`M0,${HORIZON} Q150,${HORIZON - 30} 300,${HORIZON} T600,${HORIZON} T1000,${HORIZON}Z`} fill={shade(TERRAIN.desert.color, 0.08)} />;
  return <path d={`M0,${HORIZON} Q250,${HORIZON - 14} 500,${HORIZON - 4} T1000,${HORIZON - 10} V${HORIZON}Z`} fill={far} opacity={0.5} />;
}
function Ground({ terrain }: { terrain: Terrain }) {
  if (terrain === 'plains') return <g stroke={shade(TERRAIN.plains.color, -0.12)} strokeWidth={1}>{Array.from({ length: 9 }, (_, i) => <line key={i} x1={0} x2={W} y1={HORIZON + 12 + i * i * 3.4} y2={HORIZON + 12 + i * i * 3.4} opacity={0.5} />)}</g>;
  if (terrain === 'desert') return <g fill={shade(TERRAIN.desert.color, -0.08)}>{Array.from({ length: 7 }, (_, i) => <ellipse key={i} cx={hash(i, 31) * W} cy={HORIZON + 40 + hash(i, 32) * 220} rx={90} ry={8} opacity={0.5} />)}</g>;
  if (terrain === 'forest' || terrain === 'taiga' || terrain === 'jungle') return <g fill={shade(TERRAIN[terrain].color, -0.25)}>{Array.from({ length: 14 }, (_, i) => { const x = hash(i, 33) * W, y = HORIZON + 30 + hash(i, 34) * 230, h = 18 + (y - HORIZON) * 0.12; return Math.abs(x - W / 2) < 90 ? null : terrain === 'jungle' ? <circle key={i} cx={x} cy={y} r={h * 0.6} opacity={0.8} /> : <path key={i} d={`M${x - h * 0.3},${y} L${x},${y - h * 1.2} L${x + h * 0.3},${y}Z`} opacity={0.85} />; })}</g>;
  if (terrain === 'arctic') return <g fill="#fff">{Array.from({ length: 8 }, (_, i) => <ellipse key={i} cx={hash(i, 35) * W} cy={HORIZON + 30 + hash(i, 36) * 230} rx={70} ry={6} opacity={0.5} />)}</g>;
  return <g fill={shade(TERRAIN[terrain].color, -0.2)}>{Array.from({ length: 10 }, (_, i) => <circle key={i} cx={hash(i, 37) * W} cy={HORIZON + 30 + hash(i, 38) * 230} r={4 + hash(i, 39) * 8} opacity={0.6} />)}</g>;
}

/** Lighten (amt > 0) or darken a #rrggbb colour. */
function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(Math.max(0, Math.min(255, amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
  const r = f(n >> 16), gg = f((n >> 8) & 255), bb = f(n & 255);
  return `#${((1 << 24) | (r << 16) | (gg << 8) | bb).toString(16).slice(1)}`;
}
