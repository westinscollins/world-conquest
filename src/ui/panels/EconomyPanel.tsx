import { useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Tip, Stat, Tabs, Bar } from '../common';
import { money, moneyIC, pct, num } from '../format';
import { ECON, RESOURCE, BUILDINGS, MIL, UNITS } from '../../engine/config';
import { setMobilization, setTax, setResearchFunding, takeLoan, repayLoan, setProduction, markTutorial, cancelBuild } from '../../engine/actions';
import { maxDebt, interestFor, collectionEfficiency } from '../../engine/economy';
import { totalFactories, industryBonus, recruitCost, trainDays } from '../../engine/military';
import { ownedBy } from '../../engine/world';
import { PROV } from '../../engine/geo';
import type { UnitType } from '../../engine/types';
import { researchRate } from '../../engine/research';
import { GovernmentTab } from './GovernmentTab';
import { ResearchPanel } from './OtherPanels';

export function EconomyPanel() {
  const g = useGame();
  const [tab, setTab] = useState<'budget' | 'gov' | 'tech' | 'production' | 'resources' | 'projects'>('budget');
  const n = g.nations[g.player];
  if (g.tutorial && !g.tutorial.flags.economy) setTimeout(() => store.act((s) => markTutorial(s, 'economy')), 0);
  const b = n.budget;
  const facs = totalFactories(g, n, ownedBy(g, g.player));
  return (
    <div className="panel-body">
      <Tabs tabs={[['budget', 'Budget'], ['gov', 'Government'], ['tech', 'Technology'], ['production', 'Industry'], ['resources', 'Resources & trade'], ['projects', 'Projects']]} value={tab} onChange={setTab} />
      {tab === 'budget' && (
        <>
          <BudgetAdvisor />
          <div className="grid3">
            <Stat label="National output" value={`${money(b.output)}/yr`} tip="Sum of province output (population × productivity + buildings), reduced by damage, occupation, resistance and instability." />
            <Stat label="Treasury" value={`${money(n.treasury)}`} tone={n.treasury < 0 ? 'bad' : undefined} />
            <Stat label="Net balance" value={`${money(b.net, { sign: true })}/yr`} tone={b.net >= 0 ? 'good' : 'bad'} />
          </div>
          <div className="ledger">
            <div className="ledger-col">
              <h4>Income <span className="good">{money(b.totalIncome)}</span></h4>
              {b.income.map((l) => <LedgerRow key={l.key} label={l.label} amount={l.amount} detail={l.detail} total={b.totalIncome} good />)}
            </div>
            <div className="ledger-col">
              <h4>Expenses <span className="bad">{money(b.totalExpense)}</span></h4>
              {b.expenses.map((l) => <LedgerRow key={l.key} label={l.label} amount={l.amount} detail={l.detail} total={b.totalExpense} />)}
            </div>
          </div>
          <p className="small muted">All figures are annual rates in billions of US dollars (game-scale amounts, not real budgets). Income − expenses = {money(b.totalIncome)} − {money(b.totalExpense)} = <b>{money(b.net, { sign: true })}</b>. The treasury changes by net ÷ 365 each day. One-time purchases (recruitment, construction) are paid immediately. This month so far: +{money(n.ledgerMonth.income)} / −{money(n.ledgerMonth.expense)}.</p>
          <Section title="Taxation" icon="coin">
            <div className="slider-row">
              <input type="range" min={ECON.MIN_TAX * 100} max={ECON.MAX_TAX * 100} value={Math.round(n.taxRate * 100)} onChange={(e) => store.cmd('setTax', [+e.target.value / 100])} />
              <b>{pct(n.taxRate)}</b>
            </div>
            <p className="small muted">Each point above {pct(ECON.BASE_TAX)} costs ~1.3 stability (target) and {pct(ECON.TAX_GROWTH_PENALTY / 100, 2)} annual growth; lower taxes boost growth and stability. Collection efficiency {pct(collectionEfficiency(n))} (stability {n.stability.toFixed(0)}).</p>
          </Section>
          <Section title="Research funding" icon="flask">
            <div className="slider-row">
              <input type="range" min={0} max={Math.max(10, Math.round(b.output * 0.05))} step={0.5} value={n.researchFunding} onChange={(e) => store.cmd('setResearchFunding', [+e.target.value])} />
              <b>{money(n.researchFunding)}/yr</b>
            </div>
            <p className="small muted">Yields {researchRate(g, n).toFixed(1)} research points per year (diminishing returns; research institutes add more).</p>
          </Section>
          <Section title="Debt" icon="stab">
            <div className="grid3">
              <Stat label="Outstanding" value={`${money(n.debt)}`} />
              <Stat label="Rate (new loans)" value={pct(interestFor(n), 1)} tip="Rises with debt-to-output, war exhaustion and instability." />
              <Stat label="Ceiling" value={`${money(maxDebt(n))}`} tip="150% of annual output. Beyond it, deficits mean default." />
            </div>
            <div className="row gap wrap">
              {[ECON.LOAN_STEP, ECON.LOAN_STEP * 4].map((v) => <Btn key={v} small onClick={() => { const r = store.cmd('takeLoan', [v]); r && store.toast(r.message, r.ok ? 'info' : 'bad'); }}>Borrow {money(v)}</Btn>)}
              {n.debt > 0 && [ECON.LOAN_STEP, n.debt].map((v, i) => <Btn key={i} small disabled={n.treasury < Math.min(v, n.debt)} onClick={() => { const r = store.cmd('repayLoan', [v]); r && store.toast(r.message, r.ok ? 'good' : 'bad'); }}>{i ? 'Repay all' : `Repay ${money(v)}`}</Btn>)}
            </div>
            <p className="small muted">If the treasury goes negative, emergency bonds are issued automatically at +{pct(ECON.EMERGENCY_PREMIUM)} interest. Past the ceiling the state defaults: production stops and stability collapses. Large deficits cause inflation (price index {(n.priceIndex * 100).toFixed(0)}).</p>
          </Section>
          <Section title="History" icon="chart"><HistoryChart /></Section>
        </>
      )}
      {tab === 'gov' && <GovernmentTab />}
      {tab === 'tech' && <ResearchPanel embedded />}
      {tab === 'production' && (
        <>
          <div className="grid3">
            <Stat label="Factories" value={facs.toFixed(1)} tip="Factory buildings in controlled provinces (damaged/occupied count less). Build more in a province's Construction tab." />
            <Stat label="Units cheaper by" value={pct(industryBonus(n).discount)} tip={`${pct(MIL.FACTORY_DISCOUNT, 1)} per factory, up to ${pct(MIL.FACTORY_DISCOUNT_MAX)}. Applies to recruiting, refitting and warships.`} />
            <Stat label="Training faster by" value={pct(industryBonus(n).speed)} tip={`${pct(MIL.FACTORY_SPEED)} per factory, up to ${pct(MIL.FACTORY_SPEED_MAX)}.`} />
          </div>
          <p className="small">Your armies get their weapons automatically: the price of a formation includes its equipment, and units in the field re-equip themselves as they rest (paid from the treasury). Factories add to your economy and make every new formation cheaper and quicker to raise.</p>
          <table className="tbl">
            <thead><tr><th>Formation</th><th>Price</th><th>Training</th><th>Strength</th></tr></thead>
            <tbody>
              {(Object.keys(UNITS) as UnitType[]).map((k) => (
                <tr key={k}><td>{UNITS[k].label}</td><td>{money(recruitCost(k, n), { digits: 2 })}</td><td>{trainDays(k, n)} days</td><td>+{UNITS[k].points}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {tab === 'resources' && (
        <>
          <table className="tbl">
            <thead><tr><th>Resource</th><th>Net (units/yr)</th><th>World price</th><th>Status</th></tr></thead>
            <tbody>
              {(['food', 'steel', 'oil', 'rare'] as const).map((r) => (
                <tr key={r}>
                  <td>{RESOURCE[r].label}</td>
                  <td className={n.resourceNet[r] >= 0 ? 'good' : 'bad'}>{n.resourceNet[r] >= 0 ? '+' : ''}{n.resourceNet[r].toFixed(1)}</td>
                  <td>{money(g.market[r].price, { digits: 2 })}</td>
                  <td>{n.shortages[r] > 0 ? <span className="bad">Shortage {pct(n.shortages[r])}</span> : n.resourceNet[r] >= 0 ? <span className="good">Exporting</span> : <span className="warn">Importing</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Surpluses are exported at 80% of world price; deficits are imported at 110% (needs a port or a peaceful land neighbour, and a positive treasury). Unmet shortages: food → instability & slower growth; steel → reduced factory output; oil → vehicle fuel shortages at the front; rare metals → slower advanced production. World prices follow global supply and demand.</p>
          <Section title="Trade agreements" icon="handshake">
            {(() => {
              const partners = Object.entries(g.relations).filter(([k, r]) => r.trade && k.split('|').includes(g.player)).map(([k]) => k.split('|').find((x) => x !== g.player)!);
              return partners.length ? <div className="chips">{partners.map((p) => <span key={p} className="chip">{g.nations[p]?.name}</span>)}</div> : <p className="small muted">None. Propose trade agreements in Diplomacy: each adds revenue proportional to the smaller partner's economy.</p>;
            })()}
          </Section>
        </>
      )}
      {tab === 'projects' && (
        <>
          {n.construction.length === 0 && <p className="muted">No construction projects. Select one of your provinces → Construction.</p>}
          {n.construction.map((c) => (
            <div key={c.id} className="queue-row">
              <span>{c.kind === 'develop' ? 'Development' : c.kind === 'repair' ? 'Repairs' : c.kind === 'integrate' ? 'Integration' : BUILDINGS[c.kind].label} — {PROV[c.province].name}</span>
              <Bar value={1 - c.daysLeft / c.totalDays} />
              <span className="muted">{c.daysLeft}d</span>
              <button className="iconbtn small" title="Cancel (50% of remaining value refunded)" onClick={() => store.setUI({ confirm: { title: 'Cancel project?', body: `Only 50% of the remaining value (${moneyIC(c.cost * 0.5 * (c.daysLeft / c.totalDays))}) is refunded.`, danger: true, onOk: () => store.cmd('cancelBuild', [c.id]) } })}>✕</button>
            </div>
          ))}
          {n.training.length > 0 && <h4>Military training</h4>}
          {n.training.map((t) => <div key={t.id} className="queue-row"><span>{t.type} — {PROV[t.province].name}</span><Bar value={1 - t.daysLeft / t.totalDays} /><span className="muted">{t.daysLeft}d</span></div>)}
          <p className="small muted">Population {num(ownedBy(g, g.player).reduce((t, p) => t + g.provinces[p].pop, 0))}.</p>
        </>
      )}
    </div>
  );
}

function LedgerRow({ label, amount, detail, total, good }: { label: string; amount: number; detail?: string; total: number; good?: boolean }) {
  return (
    <Tip tip={detail ? <div><b>{label}</b><br />{detail}</div> : null}>
      <div className="ledger-row">
        <span>{label}</span>
        <div className="ledger-bar"><div style={{ width: `${Math.min(100, (amount / Math.max(1e-6, total)) * 100)}%`, background: good ? 'var(--good)' : 'var(--bad)' }} /></div>
        <b>{money(amount, { digits: amount < 10 ? 2 : 0 })}</b>
      </div>
    </Tip>
  );
}

function HistoryChart() {
  const g = useGame();
  const h = g.nations[g.player].history;
  if (h.length < 2) return <p className="small muted">Data accumulates monthly.</p>;
  const W = 460, H = 110;
  const series = [
    { k: 'treasury' as const, c: '#e8c36a', l: 'Treasury' },
    { k: 'output' as const, c: '#7fb0e8', l: 'Output' },
  ];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="hist">
      {series.map((s) => {
        const vals = h.map((x) => x[s.k]);
        const mx = Math.max(...vals, 1), mn = Math.min(...vals, 0);
        const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - 12 - ((v - mn) / (mx - mn || 1)) * (H - 24)}`).join(' ');
        return <polyline key={s.k} points={pts} fill="none" stroke={s.c} strokeWidth={1.6} />;
      })}
      {series.map((s, i) => <text key={s.k} x={6 + i * 90} y={10} fill={s.c} fontSize={10}>{s.l}</text>)}
    </svg>
  );
}

/** Shown when the budget is in deficit: the biggest costs and one-click fixes with their effect. */
function BudgetAdvisor() {
  const g = useGame();
  const n = g.nations[g.player];
  const b = n.budget;
  if (b.net >= 0) return null;
  const line = (k: string) => b.expenses.find((l) => l.key === k)?.amount ?? 0;
  const atWar = g.wars.some((w) => w.attackers.includes(g.player) || w.defenders.includes(g.player));
  const top = b.expenses.slice().sort((x, y) => y.amount - x.amount).slice(0, 3);
  const fixes: { label: string; gain: string; run: () => void }[] = [];
  if (n.mobilize && !atWar) fixes.push({ label: 'Demobilise', gain: `≈ +${money(line('military') * (1 - 1 / ECON.MOBILIZED_UPKEEP))}/yr`, run: () => store.cmd('setMobilization', [false]) });
  if (n.researchFunding > 0.5) fixes.push({ label: 'Halve research funding', gain: `+${money(n.researchFunding / 2)}/yr`, run: () => store.cmd('setResearchFunding', [n.researchFunding / 2]) });
  if (n.taxRate < 0.29) fixes.push({ label: 'Raise tax by 2 points', gain: `≈ +${money((b.income.find((l) => l.key === 'tax')?.amount ?? 0) * (0.02 / n.taxRate))}/yr, −2.6 stability`, run: () => store.cmd('setTax', [n.taxRate + 0.02]) });
  return (
    <div className="advisor">
      <b className="bad">You are losing {money(-b.net)} a year.</b>
      <span className="small"> Largest costs: {top.map((l) => `${l.label} (${money(l.amount)})`).join(', ')}.{atWar ? ' War halves trade income and adds field costs.' : ''}</span>
      {fixes.length > 0 && <div className="row gap wrap" style={{ marginTop: 6 }}>{fixes.map((f) => <Btn key={f.label} small onClick={() => { f.run(); store.toast(`${f.label}: ${f.gain}`, 'good'); }}>{f.label} <span className="muted">{f.gain}</span></Btn>)}</div>}
      <div className="small muted" style={{ marginTop: 4 }}>To shrink the army, open an army → Formations → tick one → Disband.</div>
    </div>
  );
}
