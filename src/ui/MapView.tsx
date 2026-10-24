import { live } from './live';
import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { GameState, Army } from '../engine/types';
import { PROV, WORLD, seaRoute } from '../engine/geo';
import { store, useStore, type MapMode } from './store';
import { TERRAIN, UNITS, WEATHER, STRIKES, AIR, AIR_MISSION_INFO, MIL } from '../engine/config';
import { wingPlanes } from '../engine/air';
import { GlyphShape, type Glyph } from './glyphs';
import { checkStrike, interceptRate, strikeDistance, type StrikeKind } from '../engine/strikes';
import { armyNumbers, ctrlGroup, groupOf, selectedIds } from './selection';
import { estimateBattle } from '../engine/battle';
import { atWar, isFriendly, peekRel, armiesIn } from '../engine/world';
import { supplyMap } from '../engine/supply';
import { armyStrength, armyPower, armyOrg, findPath, pathDays } from '../engine/military';
import { provinceOutput } from '../engine/economy';
import { provinceWeather } from '../engine/weather';
import { num, money } from './format';
import { onMapRightClick, strikeAt } from './commands';
import { audio } from '../audio/music';

const [VX, VY, VW, VH] = WORLD.meta.view;
interface Decor { rivers: string[]; lakes: string[]; borders: { id: string; d: string }[] }

function mix(hex: string, to: string, t: number) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return `rgb(${r},${g},${bl})`;
}
function ramp(t: number, stops: [number, string][]) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      return mix(c0, c1, (t - t0) / (t1 - t0 || 1));
    }
  }
  return stops[stops.length - 1][1];
}

function fillsFor(g: GameState, mode: MapMode): string[] {
  const out: string[] = new Array(PROV.length);
  const player = g.player;
  if (mode === 'supply') {
    const sm = supplyMap(g, g.nations[player]);
    for (let i = 0; i < PROV.length; i++) {
      const v = sm[i];
      out[i] = v < 0 ? 'rgb(40,40,48)' : ramp(v / 40, [[0, '#7a1e1e'], [0.35, '#c9a227'], [1, '#2f8f4f']]);
    }
    return out;
  }
  let power: Map<number, number> | null = null;
  if (mode === 'military') {
    power = new Map();
    for (const a of Object.values(g.armies)) {
      if (a.embarked) continue;
      const sign = a.owner === player || isFriendly(g, a.owner, player) ? 1 : atWar(g, a.owner, player) ? -1 : 0.001;
      power.set(a.location, (power.get(a.location) ?? 0) + armyPower(g, a) * sign);
    }
  }
  for (let i = 0; i < PROV.length; i++) {
    const st = g.provinces[i];
    const n = g.nations[st.owner];
    switch (mode) {
      case 'political': {
        const base = n?.color ?? '#777';
        out[i] = mix(base, '#ffffff', st.owner === player ? 0.0 : 0.08);
        break;
      }
      case 'terrain': out[i] = TERRAIN[PROV[i].terrain].color; break;
      case 'unrest': out[i] = st.resistance < 1 ? '#3f6f4f' : ramp(st.resistance / 100, [[0, '#6f9f5f'], [0.4, '#d9b44a'], [0.7, '#d0602a'], [1, '#7a0f0f']]); break;
      case 'resources': {
        const r = PROV[i].resources;
        out[i] = r.oil ? ramp(r.oil / 3, [[0, '#6b6b6b'], [1, '#141414']]) : r.rare ? '#7a4fa0' : r.steel ? ramp(r.steel / 2, [[0, '#8a9aa8'], [1, '#4a5a6a']]) : ramp(r.food / 4, [[0, '#d8cfa0'], [1, '#4f8f3a']]);
        break;
      }
      case 'infrastructure': out[i] = ramp((st.infra - 1) / 8, [[0, '#3a2f2a'], [0.5, '#b07a2a'], [1, '#ffe27a']]); break;
      case 'military': {
        const v = power!.get(i) ?? 0;
        out[i] = v > 0 ? ramp(v / 150, [[0, '#cfd6e0'], [1, '#1f4fa0']]) : v < -0.01 ? ramp(-v / 150, [[0, '#e8c8c0'], [1, '#a01f1f']]) : st.owner === player ? '#d8dce4' : '#9a9a9a';
        break;
      }
      case 'diplomacy': {
        if (st.owner === player) { out[i] = '#d9b44a'; break; }
        if (atWar(g, st.owner, player)) { out[i] = '#b02a2a'; break; }
        const r = peekRel(g, st.owner, player);
        if (r?.alliance) { out[i] = '#3f9f5f'; break; }
        if (n?.overlord === player) { out[i] = '#8fcf7f'; break; }
        const v = r?.value ?? 0;
        out[i] = ramp((v + 100) / 200, [[0, '#a04a3a'], [0.5, '#8a8a8a'], [1, '#5a9a6a']]);
        break;
      }
    }
  }
  return out;
}

const ProvincePath = memo(function ProvincePath({ id, d, fill }: { id: number; d: string; fill: string }) {
  return <path d={d} fill={fill} data-p={id} />;
});

const FillLayer = memo(function FillLayer({ fills, blend }: { fills: string[]; blend: boolean }) {
  return (
    <g className="fills" style={{ mixBlendMode: blend ? 'multiply' : 'normal', opacity: blend ? 1 : 0.8 }}>
      {PROV.map((p, i) => <ProvincePath key={i} id={i} d={p.path} fill={fills[i]} />)}
    </g>
  );
});
const TintLayer = memo(function TintLayer({ fills }: { fills: string[] }) {
  return <g className="fills tint" style={{ opacity: 0.42 }} pointerEvents="none">{PROV.map((p, i) => <path key={i} d={p.path} fill={fills[i]} />)}</g>;
});
const ProvinceBorders = memo(function ProvinceBorders() {
  return <g className="pborders">{PROV.map((p, i) => <path key={i} d={p.path} />)}</g>;
});

/** Occupied provinces: hatched with the occupier's colour. */
const OccupationLayer = memo(function OccupationLayer({ occ }: { occ: string }) {
  const g = store.game!;
  const list = occ ? occ.split(',').map(Number) : [];
  const occupiers = [...new Set(list.map((p) => g.provinces[p].controller))];
  return (
    <g>
      <defs>
        {occupiers.map((o) => (
          <pattern key={o} id={`hatch-${o}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="transparent" />
            <rect width="1.8" height="4" fill={g.nations[o]?.color ?? '#000'} opacity="0.9" />
          </pattern>
        ))}
      </defs>
      {list.map((p) => <path key={p} d={PROV[p].path} fill={`url(#hatch-${g.provinces[p].controller})`} className="occupied" />)}
    </g>
  );
});

const LANES = (() => {
  const out: [number, number][] = [];
  for (const s of WORLD.seas) for (const n of s.neighbors) if (n > s.id && Math.abs(WORLD.seas[n].x - s.x) < 900) out.push([s.id, n]);
  return out;
})();

export function MapView() {
  const { g, ui } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cam = useRef({ x: VX, y: VY, w: VW, h: VH });
  const [zoom, setZoom] = useState(1);
  const [decor, setDecor] = useState<Decor | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{ p: number; x: number; y: number } | null>(null);
  const boxRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => { fetch('geo/decor.json').then((r) => r.json()).then(setDecor).catch(() => setDecor({ rivers: [], lakes: [], borders: [] })); }, []);

  const applyCam = useCallback(() => {
    const c = cam.current;
    svgRef.current?.setAttribute('viewBox', `${c.x} ${c.y} ${c.w} ${c.h}`);
  }, []);
  const zoomRaf = useRef(0);
  const scheduleZoomState = useCallback(() => {
    cancelAnimationFrame(zoomRaf.current);
    zoomRaf.current = requestAnimationFrame(() => setZoom(VW / cam.current.w));
  }, []);

  const fitAspect = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ar = el.clientWidth / Math.max(1, el.clientHeight);
    const c = cam.current;
    c.h = c.w / ar;
    clamp();
    applyCam();
  }, [applyCam]);
  function clamp() {
    const c = cam.current;
    c.w = Math.max(60, Math.min(VW * 1.0, c.w));
    const el = wrapRef.current;
    const ar = el ? el.clientWidth / Math.max(1, el.clientHeight) : 2;
    c.h = c.w / ar;
    if (c.h > VH * 1.15) { c.h = VH * 1.15; c.w = c.h * ar; }
    c.x = Math.max(VX - c.w * 0.1, Math.min(VX + VW - c.w * 0.9, c.x));
    c.y = Math.max(VY - c.h * 0.08, Math.min(VY + VH - c.h * 0.92, c.y));
  }

  // initial focus on the player's capital
  useEffect(() => {
    if (!g) return;
    const cap = PROV[g.nations[g.player].capital];
    const c = cam.current;
    c.w = 420;
    fitAspect();
    c.x = cap.x - c.w / 2; c.y = cap.y - c.h / 2;
    clamp(); applyCam(); scheduleZoomState();
    const ro = new ResizeObserver(() => { fitAspect(); scheduleZoomState(); });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g?.player]);

  // focus requests (e.g. clicking an event)
  useEffect(() => {
    const h = (e: Event) => {
      const p = (e as CustomEvent<number>).detail;
      const c = cam.current;
      c.w = Math.min(c.w, 360); clamp();
      c.x = PROV[p].x - c.w / 2; c.y = PROV[p].y - c.h / 2;
      clamp(); applyCam(); scheduleZoomState();
    };
    window.addEventListener('wc-focus', h);
    return () => window.removeEventListener('wc-focus', h);
  }, [applyCam, scheduleZoomState]);

  const toMap = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const c = cam.current;
    return { x: c.x + ((clientX - r.left) / r.width) * c.w, y: c.y + ((clientY - r.top) / r.height) * c.h };
  };
  const onWheel = (e: React.WheelEvent) => {
    const c = cam.current;
    const m = toMap(e.clientX, e.clientY);
    const f = Math.exp(e.deltaY * 0.0015);
    const nw = Math.max(60, Math.min(VW, c.w * f));
    const k = nw / c.w;
    c.x = m.x - (m.x - c.x) * k; c.y = m.y - (m.y - c.y) * k; c.w = nw;
    clamp(); applyCam(); scheduleZoomState();
  };
  // wheel / pinch must be a non-passive listener so it zooms the map rather than the whole page
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => { e.preventDefault(); wheelRef.current(e as unknown as React.WheelEvent); };
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', h, { passive: false });
    el.addEventListener('gesturestart', stop);
    el.addEventListener('gesturechange', stop);
    return () => { el.removeEventListener('wheel', h); el.removeEventListener('gesturestart', stop); el.removeEventListener('gesturechange', stop); };
  }, [g?.player]);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey && !(e.target as Element).closest?.('[data-army]')) {
      // shift-drag draws a box that selects your armies inside it
      boxRef.current = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setBox({ ...boxRef.current });
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    if (boxRef.current) { boxRef.current.x1 = e.clientX; boxRef.current.y1 = e.clientY; setBox({ ...boxRef.current }); return; }
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) { d.moved = true; (e.target as Element).setPointerCapture?.(e.pointerId); }
      if (d.moved) {
        const r = svgRef.current!.getBoundingClientRect();
        cam.current.x = d.cx - (dx / r.width) * cam.current.w;
        cam.current.y = d.cy - (dy / r.height) * cam.current.h;
        clamp(); applyCam();
        return;
      }
    }
    const t = e.target as Element;
    const p = t.getAttribute?.('data-p');
    if (p != null) setHover({ p: +p, x: e.clientX, y: e.clientY }); else if (hover) setHover(null);
  };
  const onUp = (e: React.PointerEvent) => {
    const bx = boxRef.current;
    if (bx) {
      boxRef.current = null; setBox(null);
      const [l, r, tp, b] = [Math.min(bx.x0, bx.x1), Math.max(bx.x0, bx.x1), Math.min(bx.y0, bx.y1), Math.max(bx.y0, bx.y1)];
      if (r - l > 6 || b - tp > 6) {
        const ids: number[] = [];
        document.querySelectorAll('.army.mine').forEach((el) => { const q = el.getBoundingClientRect(); const cx = q.x + q.width / 2, cy = q.y + q.height / 2; if (cx >= l && cx <= r && cy >= tp && cy <= b) ids.push(+el.getAttribute('data-army')!); });
        if (ids.length) { const a = store.game!.armies[ids[0]]; store.setUI({ selectedArmy: ids[0], group: ids.slice(1), selectedFleet: null, selectedProvince: a?.location ?? null }); store.toast(`${ids.length} ${ids.length === 1 ? 'army' : 'armies'} selected — right-click a province to move them all.`, 'info'); }
        return;
      }
    }
    const d = drag.current;
    drag.current = null;
    if (d?.moved) return;
    if (e.button !== 0) return;
    const t = e.target as Element;
    const armyEl = t.closest?.('[data-army]');
    const fleetEl = t.closest?.('[data-fleet]');
    const battleEl = t.closest?.('[data-battle]');
    audio.sfx('click');
    if (ui.pickOperation) {
      const sp = t.getAttribute?.('data-p') ?? armyEl?.getAttribute('data-loc');
      if (sp != null) { const r = store.cmd('doOperation', [selectedIds(), +sp]); if (r) store.toast(r.message, r.ok ? 'good' : 'bad'); }
      store.setUI({ pickOperation: false });
      return;
    }
    if (ui.strike) {
      const sp = t.getAttribute?.('data-p') ?? armyEl?.getAttribute('data-loc') ?? (battleEl ? String(store.game!.battles[+battleEl.getAttribute('data-battle')!]?.province) : null);
      if (sp != null) strikeAt(+sp);
      return;
    }
    if (battleEl) { store.setUI({ battleReport: +battleEl.getAttribute('data-battle')! }); return; }
    if (armyEl && ui.moveMode != null) { onMapRightClick(+armyEl.getAttribute('data-loc')!, null); store.setUI({ moveMode: null }); return; }
    if (armyEl) {
      const id = +armyEl.getAttribute('data-army')!;
      const a = store.game!.armies[id];
      // shift-click adds your own armies to a group that moves together
      if (e.shiftKey && a?.owner === store.game!.player && ui.selectedArmy != null && ui.selectedArmy !== id && store.game!.armies[ui.selectedArmy]?.owner === store.game!.player) {
        store.setUI({ group: ui.group.includes(id) ? ui.group.filter((x) => x !== id) : [...ui.group, id] });
        return;
      }
      store.setUI({ selectedArmy: id, selectedFleet: null, selectedWing: null, selectedProvince: a?.location ?? null, group: [] });
      return;
    }
    if (fleetEl) { store.setUI({ selectedFleet: +fleetEl.getAttribute('data-fleet')!, selectedArmy: null, selectedWing: null, group: [] }); return; }
    const wingEl = t.closest?.('[data-wing]');
    if (wingEl) { store.setUI({ selectedWing: +wingEl.getAttribute('data-wing')!, selectedArmy: null, selectedFleet: null, group: [] }); return; }
    const seaEl = t.closest?.('[data-sea]');
    if (seaEl) return;
    const p = t.getAttribute?.('data-p');
    if (p != null && ui.moveMode != null && store.game!.armies[ui.moveMode]) { onMapRightClick(+p, null); store.setUI({ moveMode: null }); return; }
    if (p != null) store.setUI({ selectedProvince: +p, selectedArmy: null, selectedNation: store.game!.provinces[+p].owner, selectedFleet: null, selectedWing: null, moveMode: null, group: [] });
    else store.setUI({ selectedProvince: null, selectedArmy: null, selectedFleet: null, selectedWing: null, group: [] });
  };
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const t = e.target as Element;
    const seaEl = t.closest?.('[data-sea]');
    const p = t.getAttribute?.('data-p') ?? t.closest?.('[data-army]')?.getAttribute('data-loc') ?? (t.closest?.('[data-wing]') ? String(store.game!.airWings[+t.closest!('[data-wing]')!.getAttribute('data-wing')!]?.base ?? '') || null : null);
    if (ui.strike || ui.pickOperation) { store.setUI({ strike: null, pickOperation: false }); return; } // right-click cancels targeting
    onMapRightClick(p != null ? +p : null, seaEl ? +seaEl.getAttribute('data-sea')! : null, e.shiftKey);
  };

  // ---- derived layers
  const ownersKey = g ? g.provinces.map((p) => p.owner).join(',') : '';
  const fills = useMemo(() => (g ? fillsFor(g, ui.mapMode) : []),
    // political fills only change with ownership; other modes refresh each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ui.mapMode === 'political' ? ownersKey : store.version, ui.mapMode, g]);
  const occKey = g ? g.provinces.filter((p) => p.controller !== p.owner).map((p) => p.id).join(',') : '';
  const labels = useMemo(() => (g ? nationLabels(g) : []), [ownersKey, g]); // eslint-disable-line react-hooks/exhaustive-deps
  const playerProv = useMemo(() => (g ? g.provinces.filter((p) => p.owner === g.player).map((p) => p.id) : []), [ownersKey, g]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!g) return null;
  const k = zoom; // zoom factor relative to whole world
  const px = (VW / k) / (wrapRef.current?.clientWidth || 1600); // map units per screen pixel
  const selArmy = ui.selectedArmy != null ? g.armies[ui.selectedArmy] : null;

  return (
    <div className="map-wrap" ref={wrapRef}>
      {ui.moveMode != null && <div className="move-hint">Click a province to send {g.armies[ui.moveMode]?.name ?? 'the army'} there · <a onClick={() => store.setUI({ moveMode: null })}>cancel</a></div>}
      <svg ref={svgRef} className={`map mode-${ui.mapMode}${ui.moveMode != null ? ' moving' : ''}`} viewBox={`${VX} ${VY} ${VW} ${VH}`} preserveAspectRatio="xMidYMid slice"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onContextMenu={onContext} onPointerLeave={() => setHover(null)}>
        <defs>
          <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
            <stop offset="60%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
          </radialGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="tokshadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="0.6" stdDeviation="0.6" floodColor="#000" floodOpacity="0.7" />
          </filter>
          <linearGradient id="tokshade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity="0.35" />
          </linearGradient>
          <marker id="arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#f4d27a" />
          </marker>
          <marker id="arrow-red" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#ff6a5a" />
          </marker>
        </defs>
        <rect x={VX - 400} y={VY - 300} width={VW + 800} height={VH + 600} fill="#0b1a2e" />
        <image href="img/basemap.jpg" x={0} y={VY} width={VW} height={807.5} preserveAspectRatio="none" style={{ imageRendering: 'auto' }} />
        <FillLayer fills={fills} blend={ui.mapMode === 'political'} />
        {ui.mapMode === 'political' && <TintLayer fills={fills} />}
        <OccupationLayer occ={occKey} />
        <FlashLayer />
        {decor && <path className="lakes" d={decor.lakes.join('')} />}
        {decor && k > 1.6 && <g className="rivers">{decor.rivers.map((r, i) => { const [d, rank] = r.split('|'); return <path key={i} d={d} strokeWidth={Math.max(0.15, 0.9 - +rank * 0.12)} />; })}</g>}
        <ProvinceBorders />
        {decor && <g className="cborders">{decor.borders.map((b) => <path key={b.id} d={b.d} />)}</g>}
        <g className="player-outline">{playerProv.map((p) => <path key={p} d={PROV[p].path} />)}</g>
        {ui.selectedProvince != null && <path className="sel-prov" d={PROV[ui.selectedProvince].path} />}
        {hover && <path className="hover-prov" d={PROV[hover.p].path} />}
        <SeaLayer g={g} k={k} px={px} />
        <FrontLines g={g} px={px} />
        <Paths g={g} px={px} selArmy={selArmy} />
        <Labels labels={labels} k={k} px={px} g={g} />
        {ui.strike && <StrikeTargets g={g} kind={ui.strike.kind} />}
        <ProvinceMarkers g={g} px={px} k={k} />
        <Battles g={g} px={px} />
        <Blasts px={px} />
        <Armies g={g} px={px} k={k} selected={ui.selectedArmy} group={ui.group} />
        <AirLayer g={g} k={k} px={px} />
        <LiveLayer px={px} />
        <rect x={VX - 400} y={VY - 300} width={VW + 800} height={VH + 600} fill="url(#vignette)" pointerEvents="none" opacity={0.35} />
      </svg>
      {hover && <MapTooltip g={g} p={hover.p} x={hover.x} y={hover.y} mode={ui.mapMode} />}
      {box && <div className="select-box" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
      {ui.pickOperation && <div className="strike-banner">Coordinated operation: click the enemy province {selectedIds().length} armies should attack together · right-click or Esc to cancel</div>}
      {ui.strike && <div className="strike-banner">{ui.strike.kind === 'nuke' ? '☢ NUCLEAR STRIKE: click a target province' : `Click an enemy province to fire ${Math.min(ui.strike.count, g.nations[g.player].arsenal[ui.strike.kind])} ${STRIKES[ui.strike.kind].plural}`} · highlighted = in range · right-click or Esc to cancel</div>}
      <Legend mode={ui.mapMode} />
    </div>
  );
}

function nationLabels(g: GameState) {
  const acc = new Map<string, { x: number; y: number; w: number; minx: number; maxx: number }>();
  for (const st of g.provinces) {
    const p = PROV[st.id];
    const w = Math.max(1, p.areaKm / 1000);
    const a = acc.get(st.owner) ?? { x: 0, y: 0, w: 0, minx: Infinity, maxx: -Infinity };
    a.x += p.x * w; a.y += p.y * w; a.w += w; a.minx = Math.min(a.minx, p.x); a.maxx = Math.max(a.maxx, p.x);
    acc.set(st.owner, a);
  }
  const out: { id: string; x: number; y: number; size: number; name: string }[] = [];
  for (const [id, a] of acc) {
    const n = g.nations[id];
    if (!n) continue;
    // labels at the area-weighted centroid; size grows with territory
    const x = a.x / a.w, y = a.y / a.w;
    // snap to the nearest owned province centre so labels don't drift into the sea
    let best = 0, bd = Infinity;
    for (const st of g.provinces) if (st.owner === id) { const d = (PROV[st.id].x - x) ** 2 + (PROV[st.id].y - y) ** 2; if (d < bd) { bd = d; best = st.id; } }
    const size = Math.max(3.2, Math.min(28, Math.sqrt(a.w) * 0.42));
    out.push({ id, x: (PROV[best].x + x) / 2, y: (PROV[best].y + y) / 2, size, name: n.name });
  }
  return out;
}

function Labels({ labels, k, px, g }: { labels: ReturnType<typeof nationLabels>; k: number; px: number; g: GameState }) {
  return (
    <g className="labels" pointerEvents="none">
      {labels.map((l) => {
        const screen = l.size / px;
        if (screen < 9) return null;
        const size = Math.min(l.size, 34 * px); // cap on-screen size when zoomed in
        return <text key={l.id} x={l.x} y={l.y} fontSize={size} className={`nlabel${l.id === g.player ? ' me' : ''}`} letterSpacing={size * 0.12} opacity={screen > 60 ? 0.55 : 1}>{l.name.toUpperCase()}</text>;
      })}
      {k > 3.2 && PROV.map((p) => (p.cityPop > (k > 6 ? 0 : 6e5) ? (
        <g key={p.id}>
          <circle cx={p.lx} cy={p.ly} r={(p.capital ? 2.6 : 1.6) * px} className={p.capital ? 'city cap' : 'city'} />
          <text x={p.lx + 3.5 * px} y={p.ly + 3.2 * px} fontSize={10.5 * px} className="plabel">{p.name}</text>
        </g>
      ) : null))}
    </g>
  );
}

function fleetGlyph(f: GameState['fleets'][number]): Glyph {
  if (f.ships.battlegroup >= 0.5) return 'carrier';
  if (f.ships.destroyer + f.ships.cruiser < 0.5) return 'transport';
  return 'warship';
}
const shipCount = (f: GameState['fleets'][number]) => Math.round(f.ships.destroyer + f.ships.cruiser + f.ships.battlegroup + f.ships.transport);

function SeaLayer({ g, k, px }: { g: GameState; k: number; px: number }) {
  const ui = store.ui;
  const wingSel = ui.selectedWing != null && g.airWings?.[ui.selectedWing]?.owner === g.player;
  const show = k > 1.8 || ui.selectedFleet != null || ui.selectedArmy != null || wingSel;
  const fleets = Object.values(g.fleets).filter((f) => shipCount(f) > 0 && (f.owner === g.player || atWar(g, f.owner, g.player) || f.id === ui.selectedFleet || k >= 6));
  const byZone = new Map<number, typeof fleets>();
  for (const f of fleets) (byZone.get(f.sea) || byZone.set(f.sea, []).get(f.sea)!).push(f);
  const sc = pieceScale(k);
  const W = 34 * px * sc, H = 18 * px * sc;
  return (
    <g className="sea">
      {show && LANES.map(([a, b]) => <line key={`${a}-${b}`} x1={WORLD.seas[a].x} y1={WORLD.seas[a].y} x2={WORLD.seas[b].x} y2={WORLD.seas[b].y} className="lane" />)}
      {show && WORLD.seas.map((s) => (
        <g key={s.id} data-sea={s.id} className="seanode">
          <circle cx={s.x} cy={s.y} r={(ui.selectedFleet != null || wingSel ? 7 : 5) * px} />
          {(k > 2.4 || ui.selectedFleet != null) && <text x={s.x} y={s.y + 13 * px} fontSize={9 * px}>{s.name}</text>}
        </g>
      ))}
      {/* routes of your fleets */}
      {fleets.filter((f) => f.owner === g.player && f.path.length).map((f) => (
        <polyline key={`r${f.id}`} points={[f.sea, ...f.path].map((z) => `${WORLD.seas[z].x},${WORLD.seas[z].y}`).join(' ')} className={`path sea${f.id === ui.selectedFleet ? ' sel' : ''}`} strokeWidth={2 * px} markerEnd="url(#arrow)" pointerEvents="none" />
      ))}
      {[...byZone].map(([zone, list]) => {
        const z = WORLD.seas[zone];
        const fighting = list.some((a) => list.some((b) => atWar(g, a.owner, b.owner)));
        return list.map((f, i) => {
          const n = g.nations[f.owner];
          const x = z.x + (i - (list.length - 1) / 2) * (W + 3 * px), y = z.y - H * 1.1;
          const mine = f.owner === g.player, sel = f.id === ui.selectedFleet;
          const glyph = fleetGlyph(f);
          return (
            <g key={f.id} data-fleet={f.id} className={`fleet${sel ? ' sel' : ''}${mine ? ' mine' : ''}`} transform={`translate(${x},${y})`}>
              <title>{`${f.name} (${n?.name}) — ${shipCount(f)} ships in the ${z.name}${f.path.length ? `, sailing to the ${WORLD.seas[f.path[f.path.length - 1]].name}` : ''}`}</title>
              {sel && <rect className="tok-sel" x={-W / 2 - 2.5 * px} y={-H / 2 - 2.5 * px} width={W + 5 * px} height={H + 5 * px} rx={H / 2 + 2 * px} />}
              <rect className="tok" x={-W / 2} y={-H / 2} width={W} height={H} rx={H / 2} fill={n?.color ?? '#555'} stroke={pieceStroke(sel, atWar(g, f.owner, g.player))} strokeWidth={(sel ? 1.8 : 1.4) * px} />
              <rect x={-W / 2} y={-H / 2} width={W} height={H} rx={H / 2} fill="url(#tokshade)" pointerEvents="none" />
              <GlyphShape g={glyph} cx={0} cy={0.5 * px} h={8.5 * px * sc} />
              <text className="tok-label" x={0} y={H / 2 + 8 * px * sc} fontSize={9 * px * sc} strokeWidth={2.6 * px}>{shipCount(f)} ships</text>
              {fighting && <text x={W / 2 - 2 * px} y={-H / 2 + 2 * px} fontSize={10 * px * sc} className="tok-badge">💥</text>}
            </g>
          );
        });
      })}
    </g>
  );
}

/** Air wings: jets at their airbase, mission lines to their targets, range when selected. */
function AirLayer({ g, k, px }: { g: GameState; k: number; px: number }) {
  const sel = store.ui.selectedWing;
  const wings = Object.values(g.airWings ?? {}).filter((w) => w.units.length && (w.owner === g.player || w.id === sel || (atWar(g, w.owner, g.player) && k > 2.2)));
  const byBase = new Map<number, typeof wings>();
  for (const w of wings) (byBase.get(w.base) || byBase.set(w.base, []).get(w.base)!).push(w);
  const sc = pieceScale(k);
  const R = 10.5 * px * sc;
  const { width: MW, height: MH } = WORLD.meta;
  const rangeEllipse = (base: number, km: number, cls: string) => {
    const pb = PROV[base];
    const ry = (km / 111.2) * (MH / 180), rx = (km / (111.2 * Math.max(0.2, Math.cos((pb.lat * Math.PI) / 180)))) * (MW / 360);
    return <ellipse key={cls} cx={pb.lx} cy={pb.ly} rx={rx} ry={ry} className={`air-range ${cls}`} strokeWidth={1.4 * px} />;
  };
  return (
    <g className="air">
      {sel != null && g.airWings?.[sel] && (() => {
        const w = g.airWings[sel];
        const kinds = [...new Set(w.units.map((u) => u.type))];
        return <g pointerEvents="none">{kinds.map((t) => rangeEllipse(w.base, AIR.RANGE[t], t))}</g>;
      })()}
      {wings.map((w) => {
        const b = PROV[w.base];
        const lines: JSX.Element[] = [];
        if (w.rebase) lines.push(<line key="r" x1={b.lx} y1={b.ly} x2={PROV[w.rebase.to].lx} y2={PROV[w.rebase.to].ly} className="air-line rebase" strokeWidth={1.6 * px} markerEnd="url(#arrow)" />);
        if (w.mission === 'bombing' && w.target != null) lines.push(<line key="b" x1={b.lx} y1={b.ly} x2={PROV[w.target].lx} y2={PROV[w.target].ly} className="air-line bomb" strokeWidth={1.8 * px} markerEnd="url(#arrow-red)" />);
        if (w.mission === 'naval' && w.target != null) lines.push(<line key="n" x1={b.lx} y1={b.ly} x2={WORLD.seas[w.target].x} y2={WORLD.seas[w.target].y} className="air-line naval" strokeWidth={1.8 * px} markerEnd="url(#arrow)" />);
        return lines.length && (w.owner === g.player || w.id === sel) ? <g key={`l${w.id}`} pointerEvents="none">{lines}</g> : null;
      })}
      {[...byBase].map(([base, list]) => list.map((w, i) => {
        const b = PROV[base];
        const n = g.nations[w.owner];
        // to the left of the city marker (its name is written to the right)
        const x = b.lx - 15 * px * sc - i * (2 * R + 3 * px), y = b.ly - 3 * px * sc;
        const mine = w.owner === g.player, isSel = w.id === sel;
        const bombers = w.units.filter((u) => u.type === 'bomber').length;
        const glyph: Glyph = bombers * 2 > w.units.length ? 'bomber' : 'fighter';
        const planes = wingPlanes(w);
        return (
          <g key={w.id} data-wing={w.id} className={`wing${isSel ? ' sel' : ''}${mine ? ' mine' : ''}`} transform={`translate(${x},${y})`}>
            <title>{`${w.name} (${n?.name}) — ${planes} aircraft at ${b.name} · ${AIR_MISSION_INFO[w.mission].label}${w.mission === 'bombing' && w.target != null ? `: ${PROV[w.target].name}` : w.mission === 'naval' && w.target != null ? `: ${WORLD.seas[w.target].name}` : ''}${w.rebase ? ` · moving to ${PROV[w.rebase.to].name}` : ''}`}</title>
            {isSel && <circle className="tok-sel" r={R + 2.5 * px} />}
            <circle className="tok" r={R} fill={n?.color ?? '#555'} stroke={pieceStroke(isSel, !mine && atWar(g, w.owner, g.player))} strokeWidth={(isSel ? 1.8 : 1.4) * px} />
            <circle r={R} fill="url(#tokshade)" pointerEvents="none" />
            <GlyphShape g={glyph} cx={0} cy={0} h={R * 1.45} />
            {(mine || isSel) && (k > 2.6 || isSel) && <text className="tok-label" x={0} y={-R - 3 * px * sc} fontSize={8.5 * px * sc} strokeWidth={2.6 * px}>{planes}✈{w.mission === 'idle' ? ' zz' : ''}</text>}
          </g>
        );
      }))}
    </g>
  );
}

function FrontLines({ g, px }: { g: GameState; px: number }) {
  const segs: { x1: number; y1: number; x2: number; y2: number; mine: boolean }[] = [];
  if (g.wars.length) {
    for (let a = 0; a < PROV.length; a++) {
      const ca = g.provinces[a].controller;
      for (const b of PROV[a].neighbors) {
        if (b < a) continue;
        const cb = g.provinces[b].controller;
        if (ca === cb || !atWar(g, ca, cb)) continue;
        const pa = PROV[a], pb = PROV[b];
        if (Math.abs(pa.x - pb.x) > 500) continue;
        const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const len = Math.hypot(dx, dy) || 1;
        const h = Math.min(len * 0.35, 18);
        const nx = (-dy / len) * h, ny = (dx / len) * h;
        segs.push({ x1: mx - nx, y1: my - ny, x2: mx + nx, y2: my + ny, mine: ca === g.player || cb === g.player || isFriendly(g, ca, g.player) || isFriendly(g, cb, g.player) });
      }
    }
  }
  return (
    <g className="fronts" pointerEvents="none">
      {segs.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className={s.mine ? 'front mine' : 'front'} strokeWidth={(s.mine ? 3 : 2) * px} />)}
    </g>
  );
}

function Paths({ g, px, selArmy }: { g: GameState; px: number; selArmy: Army | null }) {
  const list = Object.values(g.armies).filter((a) => (a.owner === g.player || a === selArmy) && (a.path.length || a.embarked || a.seaDest != null));
  return (
    <g className="paths" pointerEvents="none">
      {list.map((a) => {
        if (a.seaDest != null && !a.embarked) {
          // naval invasion: march to the port, then the sea leg
          const port = a.path.length ? a.path[a.path.length - 1] : a.location;
          const route = seaRoute(PROV[port].seas, PROV[a.seaDest].seas) ?? [];
          const land = [a.location, ...a.path].map((p) => `${PROV[p].lx},${PROV[p].ly}`).join(' ');
          const sea = [`${PROV[port].lx},${PROV[port].ly}`, ...route.map((z) => `${WORLD.seas[z].x},${WORLD.seas[z].y}`), `${PROV[a.seaDest].lx},${PROV[a.seaDest].ly}`].join(' ');
          return <g key={a.id}>{a.path.length > 0 && <polyline points={land} className={`path${a === selArmy ? ' sel' : ''}`} strokeWidth={1.8 * px} />}<polyline points={sea} className="path sea attack" strokeWidth={2.2 * px} markerEnd="url(#arrow-red)" /></g>;
        }
        if (a.embarked) {
          const pts = [PROV[a.embarked.from], ...a.embarked.route.map((z) => WORLD.seas[z]), PROV[a.embarked.dest]];
          return <polyline key={a.id} points={pts.map((p) => `${'lx' in p ? p.lx : p.x},${'ly' in p ? p.ly : p.y}`).join(' ')} className="path sea" strokeWidth={2 * px} markerEnd="url(#arrow)" />;
        }
        const pts = [a.location, ...a.path].map((p) => `${PROV[p].lx},${PROV[p].ly}`).join(' ');
        const hostile = a.path.some((p) => atWar(g, g.provinces[p].controller, a.owner));
        const line = <polyline key={a.id} points={pts} className={`path${hostile ? ' attack' : ''}${a === selArmy ? ' sel' : ''}`} strokeWidth={(a === selArmy ? 2.6 : 1.8) * px} markerEnd={hostile ? 'url(#arrow-red)' : 'url(#arrow)'} />;
        if (a !== selArmy) return line;
        const end = PROV[a.path[a.path.length - 1]];
        return <g key={a.id}>{line}<text className="eta-label" x={end.lx + 6 * px} y={end.ly - 6 * px} fontSize={11 * px} strokeWidth={3 * px}>~{Math.ceil(pathDays(g, a, a.path))}d</text></g>;
      })}
    </g>
  );
}

function Battles({ g, px }: { g: GameState; px: number }) {
  return (
    <g className="battles">
      {g.activeBattles.map((id) => {
        const b = g.battles[id];
        if (!b) return null;
        const p = PROV[b.province];
        const mine = b.attacker.nation === g.player || b.defender.nation === g.player;
        const r = (mine ? 11 : 8) * px;
        return (
          <g key={id} data-battle={id} transform={`translate(${p.lx},${p.ly - 14 * px})`} className={`battle${mine ? ' mine' : ''}`}>
            <circle r={r} className="pulse" />
            <circle r={r * 0.85} className="core" />
            <path transform={`scale(${r / 12}) translate(-12,-12)`} d="M6.2 2.6L4.8 4l4.4 4.4-1.4 1.4-2.1-2.1-1.4 1.4 2.1 2.1L2 15.6V20h4.4l4.4-4.4 2.1 2.1 1.4-1.4-2.1-2.1 1.4-1.4 4.4 4.4 1.4-1.4L6.2 2.6zM20 2l-6.3 6.3 2 2L22 4V2h-2z" fill="#fff" />
            {mine && (() => {
              const ours = b.attacker.nation === g.player ? b.attacker : b.defender;
              const theirs = ours === b.attacker ? b.defender : b.attacker;
              const lost = (x: typeof ours) => x.losses.killed + x.losses.wounded;
              return (
                <g transform={`scale(${px})`} className="battle-tally">
                  <rect x={-38} y={14} width={76} height={15} rx={3} />
                  <text x={-3} y={25} textAnchor="end" className="t-mine">−{short(lost(ours))}</text>
                  <text x={3} y={25} className="t-enemy">−{short(lost(theirs))}</text>
                </g>
              );
            })()}
          </g>
        );
      })}
    </g>
  );
}

const short = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toString());

/** Provinces that just changed hands pulse green (gained) or red (lost). */
function FlashLayer() {
  return <g className="flashes" pointerEvents="none">{live.flashes.map((f) => <path key={f.id} d={PROV[f.province].path} className={`flash ${f.gained ? 'gained' : 'lost'}`} />)}</g>;
}
/** Casualty numbers rising from battles: yours in red, the enemy's in white. */
function LiveLayer({ px }: { px: number }) {
  return (
    <g className="live-floats" pointerEvents="none">
      {live.floats.map((f) => {
        const p = PROV[f.province];
        return (
          <g key={f.id} transform={`translate(${p.lx},${p.ly - 26 * px}) scale(${px})`}>
            <text className={`float ${f.mine ? 'mine' : 'enemy'}`} x={f.mine ? -6 : 6} textAnchor={f.mine ? 'end' : 'start'}>{f.text}</text>
          </g>
        );
      })}
    </g>
  );
}

/** Strike mode: provinces you can hit right now. */
function StrikeTargets({ g, kind }: { g: GameState; kind: StrikeKind }) {
  const n = g.nations[g.player];
  const list = useMemo(() => g.provinces.filter((st) => !checkStrike(g, { ...n, arsenal: { drone: 1, missile: 1, nuke: 1, ballistic: 1, recon: 1 } }, kind, st.id, 1)).map((st) => st.id),
    [g, kind, store.version]); // eslint-disable-line react-hooks/exhaustive-deps
  return <g className={`strike-targets ${kind}`}>{list.map((p) => <path key={p} d={PROV[p].path} data-p={p} />)}</g>;
}
/** Explosions where strikes land. */
function Blasts({ px }: { px: number }) {
  return (
    <g className="blasts" pointerEvents="none">
      {live.blasts.map((b) => {
        const p = PROV[b.province];
        const r = (b.kind === 'nuke' ? 60 : b.kind === 'missile' ? 18 : 12) * px;
        return (
          <g key={b.id} transform={`translate(${p.lx},${p.ly})`} className={`blast ${b.kind}`}>
            <circle r={r} className="ring" />
            <circle r={r * 0.55} className="core" />
            {b.kind === 'nuke' && <circle r={r * 1.8} className="shock" />}
          </g>
        );
      })}
    </g>
  );
}

/** Revolts, martial law, partisans and scorched earth. */
function ProvinceMarkers({ g, px, k }: { g: GameState; px: number; k: number }) {
  const els: JSX.Element[] = [];
  for (const st of g.provinces) {
    const p = PROV[st.id];
    const revolt = st.status === 'core' && st.controller === st.owner && st.resistance >= 70;
    const mineOrNear = st.owner === g.player || st.controller === g.player || k > 3;
    if (!mineOrNear) continue;
    const icons: [string, string][] = [];
    if (revolt) icons.push(['🔥', 'In revolt']);
    if (st.martialLaw) icons.push(['⛔', 'Martial law']);
    if ((st.partisansUntil ?? 0) > g.day) icons.push(['✊', 'Partisans active']);
    if ((st.scorchedUntil ?? 0) > g.day) icons.push(['♨', 'Scorched earth']);
    if (!icons.length) continue;
    els.push(<g key={st.id} transform={`translate(${p.lx},${p.ly + 12 * px}) scale(${px})`} className="prov-marker">{icons.map(([ic, title], i) => <text key={i} x={(i - (icons.length - 1) / 2) * 13} y={0} textAnchor="middle" fontSize={11}><title>{title}</title>{ic}</text>)}</g>);
  }
  return <g className="prov-markers" pointerEvents="none">{els}</g>;
}

const GLYPH_OF: Record<string, Glyph> = { infantry: 'infantry', armored: 'armored', mechanized: 'mechanized', artillery: 'artillery', recon: 'recon', engineers: 'engineers' };
const TALL = new Set<Glyph>(['infantry', 'fighter', 'bomber']);
/** Size of map pieces on screen: a little smaller when the whole world is in view. */
const pieceScale = (k: number) => (k < 1.4 ? 0.78 : k < 2.6 ? 0.9 : k < 5 ? 1.05 : 1.25);
/** Outline of a map piece: selection white, enemies red, everything else dark so it stands out on any territory. */
const pieceStroke = (sel: boolean, hostile: boolean) => (sel ? '#fff' : hostile ? '#ff5a4a' : '#0c0d10');
const orgColor = (v: number) => (v > 0.6 ? '#7fe08a' : v > 0.35 ? '#f0c75e' : '#ff6a55');

/** Armies drawn as counters: nation colour, an icon of what they mostly are (soldiers, tanks…), strength and readiness. */
function Armies({ g, px, k, selected, group }: { g: GameState; px: number; k: number; selected: number | null; group: number[] }) {
  const byLoc = new Map<number, Army[]>();
  for (const a of Object.values(g.armies)) {
    if (a.embarked) continue;
    (byLoc.get(a.location) || byLoc.set(a.location, []).get(a.location)!).push(a);
  }
  const els: JSX.Element[] = [];
  const nums = armyNumbers(g);
  const sc = pieceScale(k);
  const W = 30 * px * sc, H = 20 * px * sc, gap = 3 * px * sc;
  for (const [loc, list] of byLoc) {
    const p = PROV[loc];
    // show own, enemy and selected armies; allies only when zoomed in (hide neutral clutter)
    const vis = list.filter((a) => a.owner === g.player || atWar(g, a.owner, g.player) || a.id === selected || (k > 7 && isFriendly(g, a.owner, g.player)));
    if (!vis.length) continue;
    vis.sort((a, b) => (a.owner === g.player ? -1 : 1) - (b.owner === g.player ? -1 : 1) || a.id - b.id);
    const perRow = Math.min(3, vis.length);
    vis.forEach((a, i) => {
      const n = g.nations[a.owner];
      const str = armyStrength(a);
      const row = Math.floor(i / perRow), col = i % perRow;
      const inRow = Math.min(perRow, vis.length - row * perRow);
      // a row of counters just below the city marker (so its name stays readable)
      const x = p.lx + (col - (inRow - 1) / 2) * (W + gap), y = p.ly + H * 0.5 + 9 * px * sc + row * (H + gap + 9 * px * sc);
      const sel = a.id === selected || group.includes(a.id);
      const mine = a.owner === g.player;
      const hostile = atWar(g, a.owner, g.player);
      const org = armyOrg(a);
      const glyph = GLYPH_OF[dominantType(a)] ?? 'infantry';
      const label = `${mine ? a.name : `${n?.name ?? a.owner} army`} — ${mine ? Math.round(str).toLocaleString() : `~${(Math.round(str / 2000) * 2).toFixed(0)}k`} soldiers${mine ? ` · org ${Math.round(org * 100)}% · supply ${Math.round(a.lastSupplyRatio * 100)}%` : ''}`;
      const showStr = (mine && (k > 2.2 || sel)) || (hostile && k > 3.5);
      const showNum = mine && (k > 1.6 || sel);
      els.push(
        <g key={a.id} data-army={a.id} data-loc={loc} className={`army${sel ? ' sel' : ''}${hostile ? ' hostile' : ''}${mine ? ' mine' : ''}`} transform={`translate(${x},${y})`}>
          <title>{label}</title>
          {sel && <rect className="tok-sel" x={-W / 2 - 2.5 * px} y={-H / 2 - 2.5 * px} width={W + 5 * px} height={H + 5 * px} rx={5 * px * sc} />}
          <rect className="tok" x={-W / 2} y={-H / 2} width={W} height={H} rx={4 * px * sc} fill={n?.color ?? '#555'} stroke={pieceStroke(sel, hostile)} strokeWidth={(sel || hostile ? 1.8 : 1.4) * px} />
          <rect x={-W / 2} y={-H / 2} width={W} height={H} rx={4 * px * sc} fill="url(#tokshade)" pointerEvents="none" />
          <GlyphShape g={glyph} cx={0} cy={mine ? -1.2 * px * sc : 0} h={(TALL.has(glyph) ? 15 : 10) * px * sc} />
          {mine && <rect x={-W / 2 + 3 * px} y={H / 2 - 3.6 * px * sc} width={(W - 6 * px) * Math.max(0.04, org)} height={2 * px * sc} rx={1 * px} fill={orgColor(org)} pointerEvents="none" />}
          {a.lastSupplyRatio < 0.6 && mine && <circle cx={W / 2 - 1 * px} cy={-H / 2 + 1 * px} r={3 * px * sc} className="tok-warn"><title>Low supply</title></circle>}
          {a.battleId != null && <text x={W / 2 - 1 * px} y={H / 2 + 1 * px} fontSize={9 * px * sc} className="tok-badge">⚔</text>}
          {showNum && (
            <g className="tok-num" transform={`translate(${-W / 2},${-H / 2})`}>
              <rect x={-4 * px * sc} y={-5 * px * sc} width={(String(nums.get(a.id)).length * 5 + 9 + (groupOf(a.id) != null ? 8 : 0)) * px * sc} height={9 * px * sc} rx={2.5 * px * sc} />
              <text x={-1 * px * sc} y={2 * px * sc} fontSize={7.5 * px * sc}>#{nums.get(a.id)}{groupOf(a.id) != null ? ` ${groupOf(a.id)}` : ''}</text>
            </g>
          )}
          {showStr && <text className="tok-label" x={0} y={H / 2 + 8 * px * sc} fontSize={9 * px * sc} strokeWidth={2.6 * px}>{mine ? '' : '~'}{Math.max(1, Math.round(str / 1000))}k</text>}
        </g>,
      );
    });
  }
  // armies at sea: a troopship part-way along its route
  for (const a of Object.values(g.armies)) {
    const e = a.embarked;
    if (!e) continue;
    const mine = a.owner === g.player, hostile = atWar(g, a.owner, g.player), sel = a.id === selected || group.includes(a.id);
    if (!mine && !hostile && !sel) continue;
    const pts = [[PROV[e.from].lx, PROV[e.from].ly], ...e.route.map((z) => [WORLD.seas[z].x, WORLD.seas[z].y]), [PROV[e.dest].lx, PROV[e.dest].ly]];
    const f = Math.min(1, e.progress / Math.max(1, e.route.length * MIL.TRANSPORT_DAYS_PER_ZONE)) * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(f)), t = f - i;
    const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
    const n = g.nations[a.owner];
    const str = armyStrength(a);
    els.push(
      <g key={a.id} data-army={a.id} className={`army${sel ? ' sel' : ''}${hostile ? ' hostile' : ''}${mine ? ' mine' : ''}`} transform={`translate(${x},${y})`}>
        <title>{`${mine ? a.name : `${n?.name ?? a.owner} troopships`} at sea for ${PROV[e.dest].name} — ${mine ? Math.round(str).toLocaleString() : `~${Math.round(str / 1000)}k`} soldiers`}</title>
        {sel && <rect className="tok-sel" x={-W / 2 - 2.5 * px} y={-H / 2 - 2.5 * px} width={W + 5 * px} height={H + 5 * px} rx={5 * px * sc} />}
        <rect className="tok" x={-W / 2} y={-H / 2} width={W} height={H} rx={H / 2} fill={n?.color ?? '#555'} stroke={pieceStroke(sel, hostile)} strokeWidth={(sel || hostile ? 1.8 : 1.4) * px} />
        <rect x={-W / 2} y={-H / 2} width={W} height={H} rx={H / 2} fill="url(#tokshade)" pointerEvents="none" />
        <GlyphShape g="transport" cx={0} cy={0} h={9 * px * sc} />
        {(mine ? k > 1.6 || sel : k > 3.5) && <text className="tok-label" x={0} y={H / 2 + 8 * px * sc} fontSize={9 * px * sc} strokeWidth={2.6 * px}>{mine ? '' : '~'}{Math.max(1, Math.round(str / 1000))}k</text>}
      </g>,
    );
  }
  return <g className="armies">{els}</g>;
}
function dominantType(a: Army) {
  const c: Record<string, number> = {};
  for (const u of a.units) if (!UNITS[u.type].support) c[u.type] = (c[u.type] ?? 0) + 1;
  let best = 'infantry', bv = -1;
  for (const k in c) if (c[k] > bv) { bv = c[k]; best = k; }
  if (bv < 0 && a.units.length) return a.units[0].type;
  return best;
}

function MapTooltip({ g, p, x, y, mode }: { g: GameState; p: number; x: number; y: number; mode: MapMode }) {
  const geo = PROV[p];
  const st = g.provinces[p];
  const owner = g.nations[st.owner];
  const ctrl = g.nations[st.controller];
  const w = provinceWeather(g, p);
  const armies = armiesIn(g, p);
  let extra = '';
  if (mode === 'supply') { const sm = supplyMap(g, g.nations[g.player]); extra = sm[p] < 0 ? 'Supply: not reachable' : `Supply capacity: ${sm[p].toFixed(0)}/day`; }
  if (mode === 'infrastructure') extra = `Infrastructure: ${st.infra} (roads ${st.buildings.road}, rail ${st.buildings.railway})`;
  if (mode === 'resources') extra = `Food ${geo.resources.food} · Steel ${geo.resources.steel} · Oil ${geo.resources.oil} · Rare ${geo.resources.rare}`;
  if (mode === 'unrest') extra = st.status === 'core' && st.owner === st.controller ? `Unrest: ${Math.round(st.resistance)}${st.resistance >= 70 ? ' — IN REVOLT' : ''}${st.martialLaw ? ' · martial law' : ''}` : `Resistance to occupation: ${Math.round(st.resistance)}`;
  if (mode === 'diplomacy' && st.owner !== g.player) extra = `Relations with you: ${(peekRel(g, st.owner, g.player)?.value ?? 0).toFixed(0)}`;
  return (
    <div className="tooltip map-tip" style={{ left: x + 16, top: y + 12 }}>
      <div className="tt-title">{geo.name}{geo.capital ? ' ★' : ''}</div>
      <div className="tt-sub"><span className="swatch" style={{ background: owner?.color }} />{owner?.name}{st.controller !== st.owner ? <> — occupied by <b>{ctrl?.name}</b></> : null}{st.status !== 'core' ? ` (${st.status})` : ''}</div>
      <div className="tt-grid">
        <span>Terrain</span><b>{TERRAIN[geo.terrain].label}{geo.river ? ' · river' : ''}</b>
        <span>Weather</span><b>{WEATHER[w].label}</b>
        <span>Population</span><b>{num(st.pop)}</b>
        <span>Output</span><b>{money(provinceOutput(g, st, owner))} IC/yr</b>
        {armies.length > 0 && <><span>Armies</span><b>{armies.map((a) => `${g.nations[a.owner]?.name ?? a.owner} ${num(armyStrength(a))}`).join(', ')}</b></>}
      </div>
      {extra && <div className="tt-extra">{extra}</div>}
      <OrderPreview g={g} p={p} />
    </div>
  );
}

/** What an order would do here: attack odds for the selected army, or strike details in strike mode. */
function OrderPreview({ g, p }: { g: GameState; p: number }) {
  const ui = store.ui;
  const me = g.nations[g.player];
  if (ui.strike) {
    const err = checkStrike(g, me, ui.strike.kind, p, 1);
    if (err) return <div className="tt-extra bad">{err}</div>;
    const d = strikeDistance(g, g.player, p);
    const ic = interceptRate(g, g.player, p, ui.strike.kind);
    const foes = armiesIn(g, p).filter((a) => atWar(g, a.owner, g.player)).reduce((t, a) => t + armyStrength(a), 0);
    return <div className="tt-extra good">In range{d.fleet ? ' (fleet offshore)' : isFinite(d.km) ? ` · ${Math.round(d.km)} km` : ''} · {Math.round(ic * 100)}% shot down · {foes ? `${num(foes)} enemy troops here` : 'no troops: hits buildings'}</div>;
  }
  const sel = ui.selectedArmy != null ? g.armies[ui.selectedArmy] : null;
  if (!sel || sel.owner !== g.player || sel.location === p || sel.battleId != null) return null;
  const ctrl0 = g.provinces[p].controller;
  if (ctrl0 !== g.player && !isFriendly(g, g.player, ctrl0) && !atWar(g, g.player, ctrl0)) return <div className="tt-extra muted">Neutral: no military access (declare war or ally first)</div>;
  const path = findPath(g, sel, p);
  if (!path) return <div className="tt-extra muted">No land route for {sel.name}{PROV[p].seas.length ? ' (try naval transport from a port)' : ''}</div>;
  const days = Math.ceil(pathDays(g, sel, path));
  const ctrl = g.provinces[p].controller;
  const hostile = armiesIn(g, p).filter((a) => atWar(g, a.owner, g.player));
  const group = [sel, ...ui.group.map((id) => g.armies[id]).filter((a): a is Army => !!a && a.owner === g.player)];
  if (!hostile.length && !atWar(g, ctrl, g.player)) return <div className="tt-extra">Right-click: march {group.length > 1 ? `${group.length} armies` : sel.name} here · ~{days} days{sel.path.length ? ' · shift+right-click adds a waypoint' : ''}</div>;
  if (!hostile.length) return <div className="tt-extra good">Undefended — right-click to capture · ~{days} days</div>;
  const from = path.length > 1 ? path[path.length - 2] : sel.location;
  const est = estimateBattle(g, group, p, from, hostile, 0);
  const pct = Math.round(est.odds * 100);
  return <div className={`tt-extra ${pct >= 60 ? 'good' : pct >= 40 ? 'warn' : 'bad'}`}>Attack odds {pct}% · your {num(group.reduce((t, a) => t + armyStrength(a), 0))} vs ~{num(Math.round(hostile.reduce((t, a) => t + armyStrength(a), 0) / 1000) * 1000)} · ~{days} days</div>;
}

function Legend({ mode }: { mode: MapMode }) {
  const items: Record<MapMode, [string, string][]> = {
    political: [],
    terrain: Object.values(TERRAIN).map((t) => [t.color, t.label]),
    resources: [['#141414', 'Oil'], ['#4a5a6a', 'Steel'], ['#7a4fa0', 'Rare metals'], ['#4f8f3a', 'Fertile']],
    infrastructure: [['#3a2f2a', 'Poor'], ['#b07a2a', 'Moderate'], ['#ffe27a', 'Excellent']],
    unrest: [['#3f6f4f', 'Calm'], ['#d9b44a', 'Restless'], ['#d0602a', 'Revolt (70+)'], ['#7a0f0f', 'Insurrection']],
    supply: [['#2f8f4f', 'Well supplied'], ['#c9a227', 'Limited'], ['#7a1e1e', 'Critical'], ['#282830', 'Unreachable']],
    military: [['#1f4fa0', 'Your / allied forces'], ['#a01f1f', 'Enemy forces'], ['#9a9a9a', 'Neutral']],
    diplomacy: [['#d9b44a', 'You'], ['#3f9f5f', 'Ally'], ['#8fcf7f', 'Subject'], ['#b02a2a', 'At war'], ['#5a9a6a', 'Friendly'], ['#a04a3a', 'Hostile']],
  };
  if (!items[mode].length) return null;
  return (
    <div className="legend">
      {items[mode].map(([c, l]) => <div key={l}><span className="swatch" style={{ background: c }} />{l}</div>)}
    </div>
  );
}
