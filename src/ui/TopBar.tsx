import { useState } from 'react';
import { store, useStore } from './store';
import { fmtDate } from '../engine/events';
import { Icon } from './icons';
import { Tip } from './common';
import { money, num, pct, cls } from './format';
import { SPEEDS, ECON } from '../engine/config';
import { isAtWar } from '../engine/world';
import { saveGame, exportSave } from './storage';
import { markTutorial } from '../engine/actions';
import { audio } from '../audio/music';
import { SaveLoadDialog } from './SaveLoad';

export function TopBar() {
  const { g, ui } = useStore();
  const [menu, setMenu] = useState(false);
  const [saveDlg, setSaveDlg] = useState(false);
  if (!g) return null;
  const n = g.nations[g.player];
  const b = n.budget;
  const civ = b.expenses.filter((l) => ['services', 'admin', 'occupation', 'buildings'].includes(l.key)).reduce((t, l) => t + l.amount, 0);
  const mil = b.expenses.filter((l) => ['military', 'naval', 'ops', 'generals'].includes(l.key)).reduce((t, l) => t + l.amount, 0);
  const war = isAtWar(g, g.player);
  const quickSave = async () => {
    try { await saveGame('quick', g); store.act((s) => markTutorial(s, 'saved')); store.toast('Game saved (quick slot).', 'good'); } catch (e) { store.toast(`Save failed: ${(e as Error).message}`, 'bad'); }
  };
  return (
    <div className="topbar">
      <div className="tb-nation" onClick={() => store.setUI({ selectedNation: g.player, selectedProvince: n.capital })}>
        <span className="flag" style={{ background: n.color }} />
        <div>
          <div className="tb-name">{n.name}</div>
          <div className="tb-sub">{war ? <span className="war">AT WAR</span> : 'At peace'} · {g.settings.difficulty}</div>
        </div>
      </div>
      <div className="tb-stats">
        <Tip wide tip={<div><b>Treasury</b><br />Cash on hand. Daily change = annual net ÷ 365.<br />Debt: {money(n.debt)} at {pct(n.interestRate, 1)}{n.bankrupt ? <><br /><span className="bad">BANKRUPT: production and construction halted.</span></> : null}</div>}>
          <div className={cls('tb-stat', n.treasury < 0 && 'bad')}><Icon name="coin" color="#e8c36a" /><div><b>{money(n.treasury)}</b><span>Treasury</span></div></div>
        </Tip>
        <Tip wide tip={<div className="tt-ledger"><b>Annual budget</b>
          <div><span>Income</span><b className="good">{money(b.totalIncome)}</b></div>
          <div><span>  of which taxes</span><b>{money(b.income.find((l) => l.key === 'tax')?.amount ?? 0)}</b></div>
          <div><span>Civilian spending</span><b className="bad">{money(-civ)}</b></div>
          <div><span>Military spending</span><b className="bad">{money(-mil)}</b></div>
          <div><span>Other (research, debt, imports…)</span><b className="bad">{money(-(b.totalExpense - civ - mil))}</b></div>
          <div className="tot"><span>Net</span><b className={b.net >= 0 ? 'good' : 'bad'}>{money(b.net, { sign: true })}</b></div>
          <i>Open Economy for the full breakdown.</i></div>}>
          <div className="tb-stat" onClick={() => store.setUI({ panel: 'economy' })}><Icon name="chart" color={b.net >= 0 ? '#7fd17f' : '#e86a5a'} /><div><b className={b.net >= 0 ? 'good' : 'bad'}>{money(b.net, { sign: true })}</b><span>Net / year</span></div></div>
        </Tip>
        <Tip tip={<div><b>Income {money(b.totalIncome)}/yr</b><br />Expenses {money(b.totalExpense)}/yr<br />National output {money(b.output)}/yr</div>}>
          <div className="tb-stat small"><div><b>{money(b.totalIncome)}</b><span>Income</span></div><div><b>{money(b.totalExpense)}</b><span>Expenses</span></div></div>
        </Tip>
        <Tip wide tip={<div><b>Stability {n.stability.toFixed(0)}%</b><br />Raises tax collection and output. Lowered by high taxes (base {pct(ECON.BASE_TAX)}), war exhaustion ({n.warExhaustion.toFixed(0)}), deficits, food shortages, inflation and occupied land.</div>}>
          <div className={cls('tb-stat', n.stability < 40 && 'bad')}><Icon name="stab" color="#9fc0e8" /><div><b>{n.stability.toFixed(0)}%</b><span>Stability</span></div></div>
        </Tip>
        <Tip wide tip={<div><b>Manpower {num(n.manpower)}</b><br />Recruits available for new formations and replacements. Regenerates with population; mobilisation raises the cap.<br />Mobilisation: {pct(n.mobilization)}</div>}>
          <div className="tb-stat"><Icon name="manpower" color="#c8d0d8" /><div><b>{num(n.manpower)}</b><span>Manpower</span></div></div>
        </Tip>
        {(war || n.warExhaustion > 1) && (
          <Tip tip={<div><b>War exhaustion {n.warExhaustion.toFixed(0)}</b><br />Rises with casualties and lost territory; lowers stability and war support; makes enemies more willing to demand peace.</div>}>
            <div className={cls('tb-stat', n.warExhaustion > 50 && 'bad')}><Icon name="alert" color="#e8a05a" /><div><b>{n.warExhaustion.toFixed(0)}</b><span>Exhaustion</span></div></div>
          </Tip>
        )}
        {n.priceIndex > 1.01 && <Tip tip="Price index: inflation raises the cost of everything you buy. Caused by large deficits and debt."><div className="tb-stat bad"><div><b>{(n.priceIndex * 100).toFixed(0)}</b><span>Prices</span></div></div></Tip>}
      </div>
      <div className="tb-time">
        <div className="tb-date">{fmtDate(g, g.day)}</div>
        <div className="speeds">
          <button className={cls('iconbtn', ui.speed === 0 && 'on')} onClick={() => store.setSpeed(0)} title="Pause (Space)"><Icon name="pause" /></button>
          {[1, 2, 3].map((i) => (
            <button key={i} className={cls('iconbtn', ui.speed === i && 'on')} onClick={() => store.setSpeed(i)} title={`${['', 'Normal', 'Fast', 'Very fast'][i]} — ${SPEEDS[i]} days/s (key ${i})`}>
              <Icon name={i === 1 ? 'play' : 'ff'} />{i === 3 && <Icon name="ff" size={12} style={{ marginLeft: -6 }} />}
            </button>
          ))}
        </div>
        <div className="menuwrap">
          <button className="iconbtn" onClick={() => setMenu(!menu)} title="Menu"><Icon name="menu" /></button>
          {menu && (
            <div className="dropdown" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { quickSave(); setMenu(false); }}><Icon name="save" /> Quick save</button>
              <button onClick={() => { setSaveDlg(true); setMenu(false); }}><Icon name="book" /> Save / Load…</button>
              <button onClick={() => { exportSave(g); setMenu(false); }}><Icon name="arrow" /> Export save file (local only)</button>
              <button onClick={() => { audio.setMuted(!audio.muted); setMenu(false); store.emit(); }}><Icon name={audio.muted ? 'music' : 'mute'} /> {audio.muted ? 'Unmute' : 'Mute'} audio</button>
              <button onClick={() => { store.setUI({ panel: 'help' }); setMenu(false); }}><Icon name="info" /> Help & tutorial</button>
              <button onClick={() => { setMenu(false); store.setUI({ confirm: { title: 'Quit to main menu?', body: 'Unsaved progress since the last save will be lost. (Autosave runs every 30 days.)', danger: true, onOk: () => store.quitToMenu() } }); }}><Icon name="close" /> Quit to menu</button>
            </div>
          )}
        </div>
      </div>
      {saveDlg && <SaveLoadDialog onClose={() => setSaveDlg(false)} />}
    </div>
  );
}
