import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { GameState, Army } from '../engine/types';
import { PROV, WORLD } from '../engine/geo';
import { store, useStore, type MapMode } from './store';
import { TERRAIN, UNITS, WEATHER } from '../engine/config';
import { atWar, isFriendly, peekRel, armiesIn } from '../engine/world';
import { supplyMap } from '../engine/supply';
import { armyStrength, armyPower, armyOrg } from '../engine/military';
import { provinceOutput } from '../engine/economy';
import { provinceWeather } from '../engine/weather';
import { num, money } from './format';
import { onMapRightClick } from './commands';
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
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
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
    const d = drag.current;
    drag.current = null;
    if (d?.moved) return;
    if (e.button !== 0) return;
    const t = e.target as Element;
    const armyEl = t.closest?.('[data-army]');
    const fleetEl = t.closest?.('[data-fleet]');
    const battleEl = t.closest?.('[data-battle]');
    audio.sfx('click');
    if (battleEl) { store.setUI({ battleReport: +battleEl.getAttribute('data-battle')! }); return; }
    if (armyEl && ui.moveMode != null) { onMapRightClick(+armyEl.getAttribute('data-loc')!, null); store.setUI({ moveMode: null }); return; }
    if (armyEl) { const id = +armyEl.getAttribute('data-army')!; const a = store.game!.armies[id]; store.setUI({ selectedArmy: id, selectedFleet: null, selectedProvince: a?.location ?? null }); return; }
    if (fleetEl) { store.setUI({ selectedFleet: +fleetEl.getAttribute('data-fleet')!, selectedArmy: null }); return; }
    const seaEl = t.closest?.('[data-sea]');
    if (seaEl) return;
    const p = t.getAttribute?.('data-p');
    if (p != null && ui.moveMode != null && store.game!.armies[ui.moveMode]) { onMapRightClick(+p, null); store.setUI({ moveMode: null }); return; }
    if (p != null) store.setUI({ selectedProvince: +p, selectedArmy: null, selectedNation: store.game!.provinces[+p].owner, selectedFleet: null, moveMode: null });
    else store.setUI({ selectedProvince: null, selectedArmy: null, selectedFleet: null });
  };
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const t = e.target as Element;
    const seaEl = t.closest?.('[data-sea]');
    const p = t.getAttribute?.('data-p') ?? t.closest?.('[data-army]')?.getAttribute('data-loc');
    onMapRightClick(p != null ? +p : null, seaEl ? +seaEl.getAttribute('data-sea')! : null);
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
        <Battles g={g} px={px} />
        <Armies g={g} px={px} k={k} selected={ui.selectedArmy} />
        <rect x={VX - 400} y={VY - 300} width={VW + 800} height={VH + 600} fill="url(#vignette)" pointerEvents="none" opacity={0.35} />
      </svg>
      {hover && <MapTooltip g={g} p={hover.p} x={hover.x} y={hover.y} mode={ui.mapMode} />}
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

function SeaLayer({ g, k, px }: { g: GameState; k: number; px: number }) {
  const show = k > 1.8 || store.ui.selectedFleet != null || store.ui.selectedArmy != null;
  const fleets = Object.values(g.fleets);
  return (
    <g className="sea">
      {show && LANES.map(([a, b]) => <line key={`${a}-${b}`} x1={WORLD.seas[a].x} y1={WORLD.seas[a].y} x2={WORLD.seas[b].x} y2={WORLD.seas[b].y} className="lane" />)}
      {show && WORLD.seas.map((s) => (
        <g key={s.id} data-sea={s.id} className="seanode">
          <circle cx={s.x} cy={s.y} r={5 * px} />
          {k > 2.4 && <text x={s.x} y={s.y + 13 * px} fontSize={9 * px}>{s.name}</text>}
        </g>
      ))}
      {fleets.map((f, i) => {
        const z = WORLD.seas[f.sea];
        const n = g.nations[f.owner];
        const total = Math.round(f.ships.destroyer + f.ships.cruiser + f.ships.battlegroup + f.ships.transport);
        if (!total) return null;
        if (f.owner !== g.player && !atWar(g, f.owner, g.player) && k < 6) return null;
        const off = (i % 3) * 9 * px;
        const sz = 16 * px;
        return (
          <g key={f.id} data-fleet={f.id} transform={`translate(${z.x + off - sz / 2},${z.y - sz * 1.4})`} className={`fleet${store.ui.selectedFleet === f.id ? ' sel' : ''}`} filter="url(#tokshadow)">
            <rect width={sz * 1.5} height={sz} rx={sz * 0.15} fill={n?.color ?? '#555'} stroke={f.owner === g.player ? '#f4d27a' : '#111'} strokeWidth={px * 1.2} />
            <path d={`M${sz * 0.2},${sz * 0.6} L${sz * 1.3},${sz * 0.6} L${sz * 1.1},${sz * 0.85} L${sz * 0.35},${sz * 0.85} Z M${sz * 0.65},${sz * 0.2} L${sz * 0.65},${sz * 0.6} L${sz * 0.95},${sz * 0.6} Z`} fill="#fff" opacity={0.9} />
            <text x={sz * 0.75} y={sz * 1.55} fontSize={sz * 0.55} className="toknum">{total}</text>
          </g>
        );
      })}
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
  const list = Object.values(g.armies).filter((a) => (a.owner === g.player || a === selArmy) && (a.path.length || a.embarked));
  return (
    <g className="paths" pointerEvents="none">
      {list.map((a) => {
        if (a.embarked) {
          const pts = [PROV[a.embarked.from], ...a.embarked.route.map((z) => WORLD.seas[z]), PROV[a.embarked.dest]];
          return <polyline key={a.id} points={pts.map((p) => `${'lx' in p ? p.lx : p.x},${'ly' in p ? p.ly : p.y}`).join(' ')} className="path sea" strokeWidth={2 * px} markerEnd="url(#arrow)" />;
        }
        const pts = [a.location, ...a.path].map((p) => `${PROV[p].lx},${PROV[p].ly}`).join(' ');
        const hostile = a.path.some((p) => atWar(g, g.provinces[p].controller, a.owner));
        return <polyline key={a.id} points={pts} className={`path${hostile ? ' attack' : ''}${a === selArmy ? ' sel' : ''}`} strokeWidth={(a === selArmy ? 2.6 : 1.8) * px} markerEnd={hostile ? 'url(#arrow-red)' : 'url(#arrow)'} />;
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
          </g>
        );
      })}
    </g>
  );
}

function natoSymbol(type: string, w: number, h: number) {
  const s = { stroke: '#fff', strokeWidth: h * 0.07, fill: 'none' } as const;
  switch (type) {
    case 'infantry': return <g {...s}><line x1={0} y1={0} x2={w} y2={h} /><line x1={w} y1={0} x2={0} y2={h} /></g>;
    case 'armored': return <ellipse cx={w / 2} cy={h / 2} rx={w * 0.34} ry={h * 0.28} {...s} />;
    case 'mechanized': return <g {...s}><line x1={0} y1={0} x2={w} y2={h} /><line x1={w} y1={0} x2={0} y2={h} /><ellipse cx={w / 2} cy={h / 2} rx={w * 0.34} ry={h * 0.28} /></g>;
    case 'artillery': return <circle cx={w / 2} cy={h / 2} r={h * 0.14} fill="#fff" />;
    case 'recon': return <line x1={0} y1={h} x2={w} y2={0} {...s} />;
    case 'engineers': return <path d={`M${w * 0.25},${h * 0.65} V${h * 0.35} H${w * 0.75} V${h * 0.65} M${w * 0.5},${h * 0.35} V${h * 0.65}`} {...s} />;
    case 'air': return <path d={`M${w * 0.2},${h * 0.5} Q${w * 0.35},${h * 0.2} ${w * 0.5},${h * 0.5} Q${w * 0.65},${h * 0.2} ${w * 0.8},${h * 0.5}`} {...s} />;
    default: return null;
  }
}

/** Armies drawn as dots: area grows with personnel, ring colour shows side, a red pip flags low supply. */
export function armyDotRadius(strength: number) {
  return Math.min(16, 2.5 + 2 * Math.sqrt(Math.max(0, strength) / 1000)); // screen pixels
}
function Armies({ g, px, k, selected }: { g: GameState; px: number; k: number; selected: number | null }) {
  const byLoc = new Map<number, Army[]>();
  for (const a of Object.values(g.armies)) {
    if (a.embarked) continue;
    (byLoc.get(a.location) || byLoc.set(a.location, []).get(a.location)!).push(a);
  }
  const els: JSX.Element[] = [];
  for (const [loc, list] of byLoc) {
    const p = PROV[loc];
    // show own, enemy and selected armies; allies only when zoomed in (hide neutral clutter)
    const vis = list.filter((a) => a.owner === g.player || atWar(g, a.owner, g.player) || a.id === selected || (k > 7 && isFriendly(g, a.owner, g.player)));
    if (!vis.length) continue;
    vis.sort((a, b) => (a.owner === g.player ? -1 : 1) - (b.owner === g.player ? -1 : 1));
    const radii = vis.map((a) => armyDotRadius(armyStrength(a)) * px);
    const spread = vis.length > 1 ? Math.max(...radii) * 1.15 : 0;
    vis.forEach((a, i) => {
      const n = g.nations[a.owner];
      const str = armyStrength(a);
      const r = radii[i];
      const ang = (i / vis.length) * Math.PI * 2 - Math.PI / 2;
      const cx = p.lx + Math.cos(ang) * spread, cy = p.ly + Math.sin(ang) * spread;
      const sel = a.id === selected;
      const mine = a.owner === g.player;
      const hostile = atWar(g, a.owner, g.player);
      const label = `${mine ? a.name : `${n?.name ?? a.owner} army`} — ${mine ? Math.round(str).toLocaleString() : `~${(Math.round(str / 2000) * 2).toFixed(0)}k`} soldiers${mine ? ` · org ${Math.round(armyOrg(a) * 100)}% · supply ${Math.round(a.lastSupplyRatio * 100)}%` : ''}`;
      els.push(
        <g key={a.id} data-army={a.id} data-loc={loc} className={`army dot${sel ? ' sel' : ''}${hostile ? ' hostile' : ''}${mine ? ' mine' : ''}`}>
          <title>{label}</title>
          {sel && <circle cx={cx} cy={cy} r={r + 3 * px} className="dot-sel" />}
          <circle cx={cx} cy={cy} r={r} fill={n?.color ?? '#555'} stroke={sel ? '#fff' : mine ? '#f4d27a' : hostile ? '#ff5a4a' : '#151515'} strokeWidth={(sel ? 2 : 1.4) * px} />
          {a.lastSupplyRatio < 0.6 && mine && <circle cx={cx + r * 0.75} cy={cy - r * 0.75} r={2.2 * px} fill="#e05a4a" stroke="#000" strokeWidth={0.5 * px} />}
        </g>,
      );
    });
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
    </div>
  );
}

function Legend({ mode }: { mode: MapMode }) {
  const items: Record<MapMode, [string, string][]> = {
    political: [],
    terrain: Object.values(TERRAIN).map((t) => [t.color, t.label]),
    resources: [['#141414', 'Oil'], ['#4a5a6a', 'Steel'], ['#7a4fa0', 'Rare metals'], ['#4f8f3a', 'Fertile']],
    infrastructure: [['#3a2f2a', 'Poor'], ['#b07a2a', 'Moderate'], ['#ffe27a', 'Excellent']],
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
