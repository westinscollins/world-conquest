import { store, useGame } from '../store';
import { Section, Btn, Tip, Stat } from '../common';
import { money, pct } from '../format';
import { POLICY_AREAS, POLICY_COOLDOWN, POLICY_CHANGE_STABILITY, DECREES, SERVICES_RANGE, ECON, type GovEffect } from '../../engine/config';
import { decreeState, govMods, policyReadyIn, FUND_RETURN, FUND_FEE } from '../../engine/policy';
import type { PolicyArea } from '../../engine/types';
import { cls } from '../format';

const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');

/** Short readable list of an effect's numbers. */
export function effectText(e: GovEffect | undefined): string {
  if (!e) return '';
  const p = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const parts: string[] = [];
  if (e.output) parts.push(`output ${p(e.output - 1)}`);
  if (e.growth) parts.push(`growth ${e.growth > 0 ? '+' : ''}${(e.growth * 100).toFixed(1)}%/yr`);
  if (e.stability) parts.push(`stability ${e.stability > 0 ? '+' : ''}${e.stability}`);
  if (e.warSupport) parts.push(`war support ${e.warSupport > 0 ? '+' : ''}${e.warSupport}`);
  if (e.services) parts.push(`services ${p(e.services - 1)}`);
  if (e.admin) parts.push(`admin ${p(e.admin - 1)}`);
  if (e.taxEff) parts.push(`taxes ${p(e.taxEff - 1)}`);
  if (e.trade) parts.push(`trade income ${p(e.trade - 1)}`);
  if (e.tariff) parts.push(`tariffs +${(e.tariff * 100).toFixed(1)}% of output`);
  if (e.imports) parts.push(`import prices ${p(e.imports - 1)}`);
  if (e.manpower) parts.push(`manpower ${p(e.manpower - 1)}`);
  if (e.morale) parts.push(`morale +${Math.round(e.morale * 100)}`);
  if (e.upkeep) parts.push(`military wages ${p(e.upkeep - 1)}`);
  if (e.recruit) parts.push(`recruiting ${p(e.recruit - 1)}`);
  if (e.research) parts.push(`research ${p(e.research - 1)}`);
  if (e.construction) parts.push(`construction ${p(e.construction - 1)}`);
  if (e.ops) parts.push(`field ops ${p(e.ops - 1)}`);
  if (e.popGrowth) parts.push(`pop. growth +${(e.popGrowth * 100).toFixed(1)}%`);
  return parts.join(' · ');
}

/** Economy → Government: spending, policies, decrees and the sovereign wealth fund. */
export function GovernmentTab() {
  const g = useGame();
  const n = g.nations[g.player];
  const gov = n.gov;
  const m = govMods(g, n);
  const servicesCost = n.budget.expenses.find((l) => l.key === 'services')?.amount ?? 0;
  return (
    <>
      <div className="grid3">
        <Stat label="Stability" value={`${n.stability.toFixed(0)}%`} tip="Moves toward a target each month. Policies, services, taxes, war and deficits push the target." />
        <Stat label="Policy effects" value={`${m.stability >= 0 ? '+' : ''}${m.stability.toFixed(0)} stab`} tip={`Net from policies, decrees and services: growth ${(m.growth * 100).toFixed(1)}%/yr, output ×${m.output.toFixed(2)}, services ×${m.services.toFixed(2)}`} />
        <Stat label="Wealth fund" value={`${money(gov.fund)} IC`} />
      </div>

      <Section title="Public services" icon="people">
        <div className="slider-row">
          <input type="range" min={SERVICES_RANGE[0] * 100} max={SERVICES_RANGE[1] * 100} step={5} value={Math.round(gov.services * 100)} onChange={(e) => store.cmd('doSetServices', [+e.target.value / 100])} />
          <b>{Math.round(gov.services * 100)}%</b>
        </div>
        <p className="small muted">Health, education and policing currently cost <b>{money(servicesCost)}/yr</b> ({pct(ECON.SERVICES_SHARE)} of output × spending level × policies). Each 10% below normal saves money but costs 2 stability (target) and 0.06%/yr growth; spending more does the opposite.</p>
      </Section>

      <Section title="National policies" icon="flag" right={<span className="small muted">changing costs −{POLICY_CHANGE_STABILITY} stability; {POLICY_COOLDOWN}-day cooldown</span>}>
        {(Object.keys(POLICY_AREAS) as PolicyArea[]).map((area) => {
          const spec = POLICY_AREAS[area];
          const wait = policyReadyIn(g, n, area);
          return (
            <div key={area} className="policy-row">
              <div className="policy-h"><b>{spec.label}</b>{wait > 0 && <span className="small muted"> · can change in {wait}d</span>}</div>
              <div className="policy-opts">
                {Object.entries(spec.options).map(([k, o]) => (
                  <Tip key={k} wide tip={<div><b>{o.label}</b><br />{o.desc}{effectText(o.effect) && <><br /><span className="muted">{effectText(o.effect)}</span></>}</div>}>
                    <button className={cls('posture', gov.policies[area] === k && 'on')} disabled={wait > 0 && gov.policies[area] !== k} onClick={() => gov.policies[area] !== k && say(store.cmd('doSetPolicy', [area, k]))}>
                      {o.label}<span>{effectText(o.effect) || 'no modifiers'}</span>
                    </button>
                  </Tip>
                ))}
              </div>
            </div>
          );
        })}
      </Section>

      <Section title="Decrees" icon="star">
        <div className="decrees">
          {Object.entries(DECREES).map(([id, d]) => {
            const st = decreeState(g, n, id);
            return (
              <div key={id} className={cls('decree', st.active > 0 && 'on')}>
                <div className="row gap"><b>{d.label}</b><div style={{ flex: 1 }} />
                  <Btn small kind={st.active ? undefined : 'primary'} disabled={!!st.blocked} title={st.blocked} onClick={() => say(store.cmd('doDecree', [id]))}>
                    {st.active ? `${st.active}d left` : st.cooldown ? `${st.cooldown}d` : st.cost > 0 ? `Enact (${money(st.cost, { digits: 1 })})` : 'Enact'}
                  </Btn>
                </div>
                <div className="small muted">{d.desc}{d.warOnly ? ' Wartime only.' : ''}{d.days ? ` Lasts ${d.days} days.` : ''} Cooldown {d.cooldown} days.</div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Sovereign wealth fund" icon="chart">
        <p className="small">Park spare cash in a national investment fund. It earns about {pct(FUND_RETURN, 1)} a year (it varies with the world economy, sometimes losing money). Withdrawing costs a {pct(FUND_FEE)} fee. Money in the fund is safe from day-to-day spending but can't pay bills until you withdraw it.</p>
        <div className="row gap wrap">
          {[10, 50].map((v) => <Btn key={v} small disabled={n.treasury < v} onClick={() => say(store.cmd('doInvestFund', [v]))}>Invest {money(v)}</Btn>)}
          <Btn small disabled={n.treasury < 1} onClick={() => say(store.cmd('doInvestFund', [Math.floor(n.treasury * 0.5)]))}>Invest half the treasury</Btn>
          {[10, 50].map((v) => <Btn key={'w' + v} small disabled={gov.fund < 1} onClick={() => say(store.cmd('doWithdrawFund', [v]))}>Withdraw {money(v)}</Btn>)}
          <Btn small disabled={gov.fund < 1} onClick={() => say(store.cmd('doWithdrawFund', [gov.fund]))}>Withdraw all</Btn>
        </div>
      </Section>
    </>
  );
}
