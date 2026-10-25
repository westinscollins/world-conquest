// Invasion planner: pick a country, see both sides at a glance, choose the armies, go.
import { useEffect, useState } from 'react';
import { store, useStore } from './store';
import { Modal, Btn } from './common';
import { num, money, cls } from './format';
import { PROV, isCoastal } from '../engine/geo';
import { neighborsOf, warBetween, playerEdge } from '../engine/world';
import { checkDeclareWar, truePower } from '../engine/diplomacy';
import { armyStrength, militaryStrength } from '../engine/military';
import { wingsOf } from '../engine/air';
import { nationTransportCapacity } from '../engine/naval';
import type { Army, GameState } from '../engine/types';
import { audio } from '../audio/music';

/** Open the planner for a nation. */
export const planInvasion = (id: string) => store.setUI({ invade: id, panel: null });

export function InvasionPlanner() {
  const { g, ui } = useStore();
  const target = ui.invade;
  const [picked, setPicked] = useState<number[] | null>(null);
  useEffect(() => setPicked(null), [target]);
  if (!g || !target || !g.nations[target]) return null;
  const me = g.nations[g.player], t = g.nations[target];
  const close = () => store.setUI({ invade: null });
  const war = warBetween(g, g.player, target);
  const chk = war ? null : checkDeclareWar(g, me, target);
  const mineSide = war ? (war.attackers.includes(g.player) ? war.attackers : war.defenders) : [g.player];
  const theirSide = war ? (war.attackers.includes(g.player) ? war.defenders : war.attackers) : [target, ...(chk?.joiners ?? [])];
  const armies = Object.values(g.armies).filter((a) => a.owner === g.player && !a.embarked);
  const ids = picked ?? armies.filter((a) => a.battleId == null).map((a) => a.id);
  const sel = new Set(ids);
  const power = (side: string[]) => side.reduce((s, n) => s + truePower(g, n) * playerEdge(g, n), 0);
  const pMine = power(mineSide), pTheirs = power(theirSide);
  const share = pMine + pTheirs > 0 ? pMine / (pMine + pTheirs) : 0.5;
  const verdict = share > 0.75 ? ['Easy win', 'good'] : share > 0.6 ? ['Favourable', 'good'] : share > 0.45 ? ['Even fight', 'warn'] : share > 0.3 ? ['Risky', 'bad'] : ['Very hard', 'bad'];
  const border = neighborsOf(g, g.player).includes(target);
  const coastal = PROV.some((p) => g.provinces[p.id].controller === target && isCoastal(p.id));
  const tc = nationTransportCapacity(g, me);
  const brigades = ids.reduce((s, id) => s + (g.armies[id]?.units.length ?? 0), 0);
  const soldiers = ids.reduce((s, id) => s + (g.armies[id] ? armyStrength(g.armies[id]) : 0), 0);
  const blocked = chk && !chk.ok;
  const go = () => {
    const r = store.cmd('doInvade', [target, ids]);
    if (r) store.toast(r.message, r.ok ? 'war' : 'bad');
    if (!r || r.ok) { audio.sfx('warhorn'); close(); }
  };
  return (
    <Modal title={<>Invade {t.name}</>} onClose={close} wide className="invade-modal">
      <div className="inv-vs">
        <SideCol g={g} side={mineSide} title={war ? 'Your side' : 'You'} />
        <div className="inv-mid">
          <div className={cls('inv-verdict', verdict[1])}>{verdict[0]}</div>
          <div className="bv-tug"><div style={{ width: `${share * 100}%` }} /></div>
          <div className="small muted">military power {Math.round(share * 100)}% vs {Math.round((1 - share) * 100)}%{playerEdge(g, g.player) > 1 ? ' (with your difficulty bonus)' : ''}</div>
          <div className="small" style={{ marginTop: 8 }}>{border ? '🗺 You share a border: your armies march straight in.' : coastal ? `⛴ No shared border: your armies sail there (${Math.max(0, tc.cap - tc.used)} brigades of shipping free).` : 'No border and no coast: you need an ally’s land to cross.'}</div>
        </div>
        <SideCol g={g} side={theirSide} title={war ? 'Enemy side' : chk?.joiners.length ? `${t.name} and the allies who would join` : t.name} right />
      </div>

      <h4>Armies to send <span className="small muted">({sel.size} of {armies.length} · {num(soldiers)} soldiers · {brigades} brigades)</span></h4>
      <div className="row gap small" style={{ marginBottom: 4 }}>
        <Btn small onClick={() => setPicked(armies.filter((a) => a.battleId == null).map((a) => a.id))}>All free armies</Btn>
        <Btn small onClick={() => setPicked(nearest(g, armies, target).slice(0, Math.ceil(armies.length / 2)).map((a) => a.id))}>Nearest half</Btn>
        <Btn small onClick={() => setPicked([])}>None</Btn>
      </div>
      <div className="inv-armies">
        {nearest(g, armies, target).map((a) => (
          <label key={a.id} className={cls('inv-army', sel.has(a.id) && 'on')}>
            <input type="checkbox" checked={sel.has(a.id)} onChange={() => setPicked(sel.has(a.id) ? ids.filter((x) => x !== a.id) : [...ids, a.id])} />
            <b>{a.name}</b><span className="small muted">{PROV[a.location].name} · {num(armyStrength(a))}{a.battleId != null ? ' · in battle' : a.campaign ? ` · invading ${g.nations[a.campaign]?.name}` : ''}</span>
          </label>
        ))}
        {!armies.length && <p className="muted small">You have no armies. Recruit some in Military → Build first.</p>}
      </div>
      <p className="small muted">The armies take {t.name}'s provinces one after another — the nearest and weakest first, by sea if they must — and keep going until {t.name} makes peace or falls. Each fight opens on the map with a ⚔ marker: click it to command the battle yourself. Armies you keep home defend the borders{theirSide.length > 1 ? ' — worth it when their allies join' : ''}.</p>
      {chk && chk.ok && <p className="small">Declaring war: <b className="bad">stability −{chk.stabilityCost}</b>, <b className="bad">infamy +{chk.infamy}</b>{chk.justified ? ' (you have a casus belli)' : ' (no casus belli)'}{chk.breaksNap ? ', breaks your non-aggression pact' : ''}.</p>}
      {blocked && <p className="bad small">{chk!.reason}</p>}
      <div className="row gap" style={{ justifyContent: 'flex-end' }}>
        <Btn onClick={close}>Cancel</Btn>
        <Btn kind={war ? 'primary' : 'danger'} disabled={!!blocked || !sel.size} onClick={go}>{war ? `Send ${sel.size} armies to invade` : `Declare war & invade with ${sel.size} armies`}</Btn>
      </div>
    </Modal>
  );
}

function SideCol({ g, side, title, right }: { g: GameState; side: string[]; title: string; right?: boolean }) {
  const soldiers = Object.values(g.armies).filter((a) => side.includes(a.owner)).reduce((s, a) => s + armyStrength(a), 0);
  const wings = side.reduce((s, n) => s + wingsOf(g, n).length, 0);
  const ships = Object.values(g.fleets).filter((f) => side.includes(f.owner)).reduce((s, f) => s + f.ships.destroyer + f.ships.cruiser + f.ships.battlegroup + (f.ships.submarine ?? 0), 0);
  const out = side.reduce((s, n) => s + (g.nations[n]?.budget.output ?? 0), 0);
  return (
    <div className={cls('inv-side', right && 'r')}>
      <h4>{title}</h4>
      <div className="inv-flags">{side.map((n) => <span key={n} className="chip"><span className="swatch" style={{ background: g.nations[n]?.color }} />{g.nations[n]?.name}</span>)}</div>
      <div className="inv-stats">
        <span>Soldiers</span><b>{num(soldiers)}</b>
        <span>Strength</span><b>{side.reduce((s, n) => s + militaryStrength(g, n), 0).toLocaleString()}</b>
        <span>Air wings</span><b>{wings}</b>
        <span>Warships</span><b>{Math.round(ships)}</b>
        <span>Economy</span><b>{money(out)}/yr</b>
      </div>
    </div>
  );
}

function nearest(g: GameState, armies: Army[], target: string): Army[] {
  const theirs = PROV.filter((p) => g.provinces[p.id].controller === target);
  const d = (a: Army) => Math.min(...theirs.map((p) => Math.hypot(p.x - PROV[a.location].x, p.y - PROV[a.location].y)));
  return armies.map((a) => ({ a, d: d(a) })).sort((x, y) => x.d - y.d).map((x) => x.a);
}

