import { useEffect, useState } from 'react';
import { store } from './store';
import { CAMPAIGNS, newGame } from '../engine/setup';
import { Btn, Modal } from './common';
import { SaveLoadDialog } from './SaveLoad';
import { listSaves, loadGame } from './storage';
import { COUNTRY_GEO, WORLD } from '../engine/geo';
import type { GameSettings, VictoryConfig } from '../engine/types';
import { NationPicker } from './NationPicker';
import { MultiplayerDialog } from './MultiplayerDialog';
import { audio } from '../audio/music';
import { Icon } from './icons';
import { updateIfStale } from './update';
import { BUILD } from './net/session';

const SUBREGIONS = [...new Set(WORLD.countries.map((c) => c.subregion))].sort();
export function MainMenu() {
  const [camp, setCamp] = useState('tutorial');
  const [load, setLoad] = useState(false);
  // an invite link (…#join=code) opens the multiplayer dialog straight away
  // (…#mp: reopened after loading the newest version)
  const [mp, setMp] = useState(() => typeof location !== 'undefined' && /join=|^#mp$/.test(location.hash));
  const [custom, setCustom] = useState(false);
  const [hasAuto, setHasAuto] = useState(false);
  const [vol, setVol] = useState(audio.musicVolume);
  const [nation, setNation] = useState('SRB');
  useEffect(() => { listSaves().then((s) => setHasAuto(s.length > 0)).catch(() => {}); audio.setMood('menu'); }, []);
  // an old copy of the page (cached by the browser) loads the newest version
  useEffect(() => {
    if (location.hash === '#mp') history.replaceState(null, '', location.pathname + location.search);
    if (!store.net) void updateIfStale();
  }, []);
  const c = CAMPAIGNS.find((x) => x.id === camp)!;
  const start = (opts: Partial<GameSettings> & { seed?: number; nation?: string } = {}) => {
    audio.init();
    const g = newGame(camp, camp === 'sandbox' ? { nation, ...opts } : opts);
    store.start(g);
  };
  const cont = async () => {
    audio.init();
    const saves = await listSaves();
    if (!saves.length) return;
    try { store.start(await loadGame(saves[0].slot)); } catch (e) { store.toast((e as Error).message, 'bad'); }
  };
  return (
    <div className="menu" onPointerDown={() => audio.init()}>
      <div className="menu-bg" style={{ backgroundImage: "url(img/basemap.jpg)" }} />
      <div className="menu-inner">
        <div className="title">
          <div className="t1">WORLD CONQUEST</div>
          <div className="t2">Rise of an Empire</div>
          <div className="t3">The year is 2040. The old order has fractured. Every nation fends for itself.</div>
        </div>
        <div className="menu-grid">
          <div className="camp-list">
            {CAMPAIGNS.map((x) => (
              <button key={x.id} className={`camp${camp === x.id ? ' on' : ''}`} onClick={() => { setCamp(x.id); audio.sfx('click'); }}>
                <span className="flag" style={{ background: 'var(--gold)' }} />
                <div><b>{x.title}</b><span>{x.id === 'sandbox' ? x.role : `${COUNTRY_GEO[x.nation].name} · ${x.role}`}</span></div>
                <span className={`diff d-${x.difficulty}`}>{x.difficulty}</span>
              </button>
            ))}
          </div>
          <div className="camp-detail">
            <h2>{c.title}</h2>
            <div className="muted">{camp === 'sandbox' ? `Playing as ${COUNTRY_GEO[nation].name}` : `${COUNTRY_GEO[c.nation].name} — ${c.role}`}</div>
            <p>{c.blurb}</p>
            {camp === 'sandbox' ? <NationPicker value={nation} onChange={setNation} /> : (
            <div className="sw">
              <div><h4>Strengths</h4><ul>{c.strengths.map((s) => <li key={s} className="good">{s}</li>)}</ul></div>
              <div><h4>Weaknesses</h4><ul>{c.weaknesses.map((s) => <li key={s} className="bad">{s}</li>)}</ul></div>
            </div>)}
            <div className="row gap">
              <Btn kind="primary" onClick={() => start()}>{camp === 'sandbox' ? `Play as ${COUNTRY_GEO[nation].name}` : 'Begin campaign'}</Btn>
              <Btn onClick={() => setCustom(true)}>Custom setup…</Btn>
            </div>
            <p className="small muted">All economic and military figures are fictional game-balance values for an alternate-history setting; borders and names come from public-domain Natural Earth data.</p>
          </div>
        </div>
        <div className="menu-foot">
          {hasAuto && <Btn kind="primary" onClick={cont}>Continue last game</Btn>}
          <Btn onClick={() => setLoad(true)}>Load game</Btn>
          <Btn kind="primary" onClick={() => { audio.init(); setMp(true); }}>{store.net && store.net.phase !== 'playing' ? `Return to room ${store.net.code}` : 'Online multiplayer'}</Btn>
          <div className="vol"><Icon name="music" /> <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => { audio.init(); audio.setMusicVolume(+e.target.value); setVol(+e.target.value); }} /></div>
        </div>
        <div className="menu-version small muted">Game version {BUILD}</div>
      </div>
      {load && <SaveLoadDialog loadOnly onClose={() => setLoad(false)} />}
      {mp && <MultiplayerDialog onClose={() => setMp(false)} />}
      {custom && <CustomSetup camp={camp} nation={camp === 'sandbox' ? nation : undefined} onClose={() => setCustom(false)} onStart={start} />}
    </div>
  );
}

function CustomSetup({ camp, nation, onClose, onStart }: { camp: string; nation?: string; onClose: () => void; onStart: (o: Partial<GameSettings> & { seed?: number }) => void }) {
  const c0 = CAMPAIGNS.find((x) => x.id === camp)!;
  const c = nation ? { ...c0, nation } : c0;
  const [diff, setDiff] = useState<GameSettings['difficulty']>(c.difficulty === 'tutorial' ? 'standard' : c.difficulty);
  const [kind, setKind] = useState<VictoryConfig['kind']>('domination');
  const [share, setShare] = useState(35);
  const [region, setRegion] = useState(COUNTRY_GEO[c.nation].subregion);
  const [years, setYears] = useState(10);
  const [cp, setCp] = useState(30);
  const [co, setCo] = useState(2000);
  const [alt, setAlt] = useState<GameSettings['alternateHistory']>('fractured');
  const [treasury, setTreasury] = useState(0);
  const [seed, setSeed] = useState('');
  const victory: VictoryConfig = kind === 'domination' ? { kind, provinceShare: share / 100 } : kind === 'economic' ? { kind, outputShare: share / 100 } : kind === 'hegemony' ? { kind, region, regionShare: share / 100 } : kind === 'survival' ? { kind, years } : { kind, customProvinces: cp, customOutput: co, customYears: years };
  return (
    <Modal title="Custom campaign" onClose={onClose}>
      <div className="form">
        <label>Nation<span>{COUNTRY_GEO[c.nation].name}</span></label>
        <label>Difficulty<select value={diff} onChange={(e) => setDiff(e.target.value as never)}><option value="standard">Standard</option><option value="hard">Hard (aggressive AI)</option></select></label>
        <label>Setting<select value={alt} onChange={(e) => setAlt(e.target.value as never)}><option value="fractured">Fractured Age — volatile, many ambitious states</option><option value="blocs">Bloc World — great-power alliances</option><option value="balanced">Balanced — no starting blocs</option></select></label>
        <label>Victory<select value={kind} onChange={(e) => setKind(e.target.value as never)}>
          <option value="domination">Global dominance (share of provinces)</option>
          <option value="economic">Economic supremacy (share of world output)</option>
          <option value="hegemony">Regional hegemony</option>
          <option value="survival">Survival</option>
          <option value="custom">Custom objective</option>
        </select></label>
        {(kind === 'domination' || kind === 'economic' || kind === 'hegemony') && <label>Target share<input type="number" min={5} max={100} value={share} onChange={(e) => setShare(+e.target.value)} />%</label>}
        {kind === 'hegemony' && <label>Region<select value={region} onChange={(e) => setRegion(e.target.value)}>{SUBREGIONS.map((s) => <option key={s}>{s}</option>)}</select></label>}
        {(kind === 'survival' || kind === 'custom') && <label>{kind === 'custom' ? 'Deadline (years)' : 'Years'}<input type="number" min={1} max={100} value={years} onChange={(e) => setYears(+e.target.value)} /></label>}
        {kind === 'custom' && <><label>Provinces to own<input type="number" min={1} value={cp} onChange={(e) => setCp(+e.target.value)} /></label><label>Annual output ($M)<input type="number" min={1} value={co} onChange={(e) => setCo(+e.target.value)} /></label></>}
        <label>Starting treasury (0 = default)<input type="number" min={0} value={treasury} onChange={(e) => setTreasury(+e.target.value)} />$M</label>
        <label>World seed (blank = random)<input value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} /></label>
      </div>
      <div className="row gap end">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" onClick={() => onStart({ difficulty: diff, victory, alternateHistory: alt, aiAggression: diff === 'hard' ? 1.3 : 1, customTreasury: treasury || undefined, seed: seed ? +seed : undefined })}>Start</Btn>
      </div>
    </Modal>
  );
}
