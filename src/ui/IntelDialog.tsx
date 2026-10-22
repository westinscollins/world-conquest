import { useState } from 'react';
import { store, useStore } from './store';
import { Modal, Btn, Tip, Bar } from './common';
import { PROV } from '../engine/geo';
import { POSTURES, TERRAIN, WEATHER, UNITS, COMBAT } from '../engine/config';
import { armiesIn, atWar } from '../engine/world';
import { armyStrength, armyOrg, armyPower, findPath } from '../engine/military';
import { estimateBattle } from '../engine/battle';
import { provinceWeather } from '../engine/weather';
import { supplyMap } from '../engine/supply';
import { moveArmy, setPosture } from '../engine/actions';
import { hashNoise } from '../engine/rng';
import type { Posture } from '../engine/types';
import { num, pct } from './format';
import { audio } from '../audio/music';

export function IntelDialog() {
  const { g, ui } = useStore();
  const [all, setAll] = useState(true);
  if (!g || !ui.intel) return null;
  const a = g.armies[ui.intel.armyId];
  const p = ui.intel.province;
  if (!a) return null;
  const close = () => store.setUI({ intel: null });
  const n = g.nations[g.player];
  const geo = PROV[p];
  const st = g.provinces[p];
  const w = provinceWeather(g, p);
  const enemies = armiesIn(g, p).filter((x) => atWar(g, x.owner, g.player));
  const path = findPath(g, a, p) ?? [];
  const from = path.length > 1 ? path[path.length - 2] : a.location;
  const companions = armiesIn(g, a.location).filter((x) => x.owner === g.player && x.id !== a.id && !x.battleId && !x.embarked);
  const attackers = all ? [a, ...companions] : [a];
  // intelligence quality: national intel × recon tech × recon units present
  const recon = attackers.reduce((t, x) => t + x.units.filter((u) => u.type === 'recon').length, 0);
  const quality = Math.min(0.95, n.intel * n.techMods.recon * 0.75 + recon * 0.08);
  const err = (1 - quality) * 0.6;
  const trueStr = enemies.reduce((t, x) => t + armyStrength(x), 0);
  const bias = hashNoise(g.seed, p, Math.floor(g.day / 10)) * 2 - 1;
  const mid = trueStr * (1 + bias * err * 0.5);
  const low = Math.max(500, mid * (1 - err)), high = mid * (1 + err);
  const formations = enemies.reduce((t, x) => t + x.units.length, 0);
  const armorShare = enemies.reduce((t, x) => t + x.units.filter((u) => u.type === 'armored' || u.type === 'mechanized').length, 0) / Math.max(1, formations);
  const entrench = Math.max(0, ...enemies.map((x) => x.entrench));
  const est = estimateBattle(g, attackers, p, from, enemies, bias * err * 0.5);
  const myStr = attackers.reduce((t, x) => t + armyStrength(x), 0);
  const sm = supplyMap(g, n);
  const supplyThere = Math.max(...geo.neighbors.map((q) => (g.provinces[q].controller === g.player ? sm[q] : 0)), 0) * 0.6;
  const demand = attackers.reduce((t, x) => t + x.units.reduce((s, u) => s + UNITS[u.type].supply + UNITS[u.type].fuel * 0.6, 0), 0);
  const odds = est.odds;
  const verdict = odds > 0.72 ? ['Favourable', 'good'] : odds > 0.5 ? ['Uncertain — slight edge', 'warn'] : odds > 0.3 ? ['Risky', 'warn'] : ['Unfavourable', 'bad'];
  const risks = [...est.notes];
  if (entrench > 0.3) risks.push(`Enemy entrenched (${pct(entrench)}): up to +${pct(COMBAT.ENTRENCH_MAX_BONUS * entrench)} defence. Mobile manoeuvre reduces this.`);
  if (armorShare > 0.3) risks.push('Significant enemy armour detected: bring artillery/armour (hard attack).');
  if (supplyThere < demand) risks.push(`Supply after capture would be thin (~${supplyThere.toFixed(0)}/day vs ${demand.toFixed(0)} needed).`);
  if (attackers.some((x) => armyOrg(x) < 0.5)) risks.push('Some of your formations are disorganised: rest them first.');
  const attack = () => {
    for (const x of attackers) {
      store.act((s) => setPosture(s, x.id, a.posture));
      const r = store.act((s) => moveArmy(s, x.id, p));
      if (r && !r.ok) store.toast(r.message, 'bad');
    }
    store.toast(`Offensive launched on ${geo.name} (${POSTURES[a.posture].label}).`, 'war');
    audio.sfx('battle');
    close();
  };
  return (
    <Modal title={<>Intelligence report — {geo.name}</>} onClose={close} wide>
      <div className="intel">
        <div className="intel-col">
          <h4>Your forces</h4>
          <div className="kv"><span>Formations</span><b>{attackers.reduce((t, x) => t + x.units.length, 0)}</b></div>
          <div className="kv"><span>Personnel</span><b>{num(myStr)}</b></div>
          <div className="kv"><span>Organisation</span><b>{pct(attackers.reduce((t, x) => t + armyOrg(x) * armyStrength(x), 0) / Math.max(1, myStr))}</b></div>
          <div className="kv"><span>Supply</span><b>{pct(Math.min(...attackers.map((x) => x.lastSupplyRatio)))}</b></div>
          <div className="kv"><span>Combat power</span><b>{attackers.reduce((t, x) => t + armyPower(g, x), 0).toFixed(0)}</b></div>
          {companions.length > 0 && <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Attack with all {companions.length + 1} armies in {PROV[a.location].name}</label>}
        </div>
        <div className="intel-col">
          <h4>Enemy (estimated)</h4>
          <div className="kv"><span>Personnel</span><b>{num(low)} – {num(high)}</b></div>
          <div className="kv"><span>Formations</span><b>{quality > 0.6 ? formations : `${Math.max(1, formations - 2)}–${formations + 2}`}</b></div>
          <div className="kv"><span>Armour share</span><b>{quality > 0.5 ? pct(armorShare) : 'unknown'}</b></div>
          <div className="kv"><span>Entrenchment</span><b>{pct(entrench)}</b></div>
          <div className="kv"><span>Fortifications</span><b>{st.buildings.fort ? `level ${st.buildings.fort}` : 'none'}</b></div>
          <div className="kv"><span>Intel quality</span><b>{pct(quality)}</b></div>
          <Tip tip="Improve with recon battalions, the Drones/Signals Intelligence techs."><span className="small muted">How is this estimated?</span></Tip>
        </div>
        <div className="intel-col">
          <h4>Battlefield</h4>
          <div className="kv"><span>Terrain</span><b>{TERRAIN[geo.terrain].label}</b></div>
          <div className="kv"><span>Combat width</span><b>{TERRAIN[geo.terrain].width}</b></div>
          <div className="kv"><span>Weather</span><b>{WEATHER[w].label}</b></div>
          <div className="kv"><span>River</span><b>{geo.river ? 'yes (−15%)' : 'no'}</b></div>
          <div className="kv"><span>Strait crossing</span><b>{PROV[from].straits.includes(p) ? 'yes (−30%)' : 'no'}</b></div>
          <div className="kv"><span>Supply after capture</span><b>{supplyThere.toFixed(0)}/day</b></div>
        </div>
      </div>
      <div className="odds">
        <div>Assessment: <b className={verdict[1]}>{verdict[0]}</b> <span className="muted small">(estimated {pct(odds)} chance of success — based on imperfect intelligence)</span></div>
        <Bar value={odds} h={8} />
      </div>
      {risks.length > 0 && <ul className="causes">{risks.map((r) => <li key={r}>{r}</li>)}</ul>}
      <h4>Operational posture</h4>
      <div className="posture-grid">
        {(Object.keys(POSTURES) as Posture[]).filter((x) => x !== 'defensive').map((x) => (
          <button key={x} className={`posture${a.posture === x ? ' on' : ''}`} onClick={() => store.act((s) => setPosture(s, a.id, x))} title={POSTURES[x].desc}>
            <b>{POSTURES[x].label}</b><span>{POSTURES[x].desc}</span>
          </button>
        ))}
      </div>
      <div className="row gap end">
        <Btn onClick={close}>Cancel</Btn>
        <Btn kind="danger" onClick={attack}>Launch attack</Btn>
      </div>
    </Modal>
  );
}
