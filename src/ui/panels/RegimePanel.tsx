import { useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Bar, Tabs, Stat, Tip } from '../common';
import { money, pct, cls } from '../format';
import { GROUPS, PROPAGANDA, PROPAGANDA_MEDIA, PROPAGANDA_SATURATION, SECURITY, INTERIOR, STAGES, REVOLT_AT } from '../../engine/config';
import { avgApproval, groupTargets, stageOf, regimeType, propagandaPower, interiorState, GROUP_IDS, coreUnrestTarget } from '../../engine/regime';
import { ownedBy, isAtWar } from '../../engine/world';
import { PROV } from '../../engine/geo';
import { focusProvince } from '../commands';

const say = (r?: { ok: boolean; message: string }) => r && store.toast(r.message, r.ok ? 'info' : 'bad');
const tone = (v: number) => (v >= 60 ? 'var(--good)' : v >= 40 ? 'var(--warn)' : 'var(--bad)');

/** Regime: the population, the opposition, and the tools to keep power. */
export function RegimePanel() {
  const g = useGame();
  const [tab, setTab] = useState<'people' | 'propaganda' | 'security' | 'unrest'>('people');
  const n = g.nations[g.player];
  const r = n.regime;
  const st = stageOf(r.opposition);
  const rt = regimeType(n);
  const revolts = ownedBy(g, g.player).filter((p) => g.provinces[p].status === 'core' && g.provinces[p].resistance >= REVOLT_AT).length;
  return (
    <div className="panel-body">
      <div className="grid4">
        <Stat label="Stability" value={`${n.stability.toFixed(0)}%`} tone={n.stability < 35 ? 'bad' : undefined} />
        <Stat label="Approval" value={`${avgApproval(n).toFixed(0)}%`} tip="Weighted average of the six social groups." tone={avgApproval(n) < 40 ? 'bad' : undefined} />
        <Stat label="Legitimacy" value={`${r.legitimacy.toFixed(0)}`} tip="The ruler's standing: propaganda, victories and referendums raise it; defeats, lost land, deficits and humiliations lower it." tone={r.legitimacy < 35 ? 'bad' : undefined} />
        <Stat label="Regime" value={rt.label} tip="From your media policy, police, bans, rigged elections and personality cult." />
      </div>
      <div className={cls('opp-meter', st.index >= 3 && 'hot')}>
        <div className="row gap"><b>Opposition: {st.label}</b><span className="small muted">{r.opposition.toFixed(0)}/100 — {st.desc}</span></div>
        <div className="opp-bar">
          <div style={{ width: `${r.opposition}%` }} />
          {STAGES.slice(1).map((s) => <span key={s.at} style={{ left: `${s.at}%` }} title={s.label} />)}
        </div>
        {revolts > 0 && <p className="bad small">{revolts} province{revolts > 1 ? 's are' : ' is'} in open revolt. See the Unrest tab.</p>}
        {r.banUntil > g.day && <p className="warn small">The opposition is banned and organising underground (grows 50% faster until {Math.ceil((r.banUntil - g.day) / 30)} months from now).</p>}
      </div>
      <Tabs tabs={[['people', 'Population'], ['propaganda', `Propaganda${r.propaganda.length ? ` (${r.propaganda.length})` : ''}`], ['security', 'Security & control'], ['unrest', `Unrest${revolts ? ` (${revolts})` : ''}`]]} value={tab} onChange={setTab} />
      {tab === 'people' && <People />}
      {tab === 'propaganda' && <Propaganda />}
      {tab === 'security' && <Security />}
      {tab === 'unrest' && <Unrest />}
    </div>
  );
}

function People() {
  const g = useGame();
  const n = g.nations[g.player];
  const targets = groupTargets(g, n);
  return (
    <>
      {GROUP_IDS.map((k) => {
        const v = n.regime.groups[k], t = targets[k].value;
        return (
          <div key={k} className="group-row">
            <Tip wide tip={<div><b>{GROUPS[k].label}</b> (weight {pct(GROUPS[k].weight)})<br />{GROUPS[k].desc}<br /><br />Heading toward <b>{t.toFixed(0)}</b>:<br />{targets[k].why.length ? targets[k].why.map((w) => <div key={w}>· {w}</div>) : 'no strong feelings'}</div>}>
              <span className="g-name">{GROUPS[k].label}</span>
            </Tip>
            <div className="g-bar"><div style={{ width: `${v}%`, background: tone(v) }} /><span className="g-target" style={{ left: `${t}%` }} /></div>
            <b>{v.toFixed(0)}</b>
            <span className={cls('small', t > v + 1 ? 'good' : t < v - 1 ? 'bad' : 'muted')}>{t > v + 1 ? '▲' : t < v - 1 ? '▼' : '='}</span>
          </div>
        );
      })}
      <p className="small muted">Approval drifts each month toward the marker (hover a group to see why). Unhappy groups feed the opposition; happy ones raise stability. The officer corps decides coups: keep it above 25.</p>
    </>
  );
}

function Propaganda() {
  const g = useGame();
  const n = g.nations[g.player];
  const pw = propagandaPower(n);
  const atWar = isAtWar(g, g.player);
  return (
    <>
      <p className="small">Effectiveness <b>{pct(pw)}</b> — media policy {n.gov.policies.press} (×{PROPAGANDA_MEDIA[n.gov.policies.press] ?? 1}){n.regime.propaganda.length > PROPAGANDA_SATURATION ? ', and people are tired of slogans (more than three campaigns)' : ''}. Change the media policy in Economy → Government.</p>
      <div className="decrees">
        {Object.entries(PROPAGANDA).map(([id, c]) => {
          const on = n.regime.propaganda.includes(id);
          const groups = Object.entries(c.groups).map(([k, v]) => `${GROUPS[k as keyof typeof GROUPS].label} ${v! > 0 ? '+' : ''}${Math.round(v! * pw)}`).join(', ');
          return (
            <div key={id} className={cls('decree', on && 'on')}>
              <div className="row gap"><b>{c.label}</b><div style={{ flex: 1 }} /><Btn small kind={on ? undefined : 'primary'} disabled={!on && !!c.warOnly && !atWar} onClick={() => say(store.cmd('doToggleCampaign', [id]))}>{on ? 'Stop' : `Launch · ${money(c.cost * n.budget.output)}/yr`}</Btn></div>
              <div className="small muted">{c.desc}</div>
              <div className="small">{groups}{c.legitimacy ? ` · legitimacy +${(c.legitimacy * pw).toFixed(1)}/month` : ''}{c.opposition ? ` · opposition ${(c.opposition * pw).toFixed(1)}/month` : ''}{c.warSupport ? ` · war support +${Math.round(c.warSupport * pw * 0.5)}` : ''}{c.warOnly ? ' · wartime only' : ''}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Security() {
  const g = useGame();
  const n = g.nations[g.player];
  return (
    <>
      <Section title="Internal security" icon="shield">
        <div className="policy-opts four">
          {SECURITY.map((s, i) => (
            <button key={i} className={cls('posture', n.regime.security === i && 'on')} title={s.desc} onClick={() => n.regime.security !== i && say(store.cmd('doSetSecurity', [i]))}>
              {s.label}<span>{s.cost ? `${money(s.cost * n.budget.output)}/yr · ` : ''}opposition −{s.opposition}/mo · unrest −{s.unrest}</span>
            </button>
          ))}
        </div>
        <p className="small muted">{SECURITY[n.regime.security].desc}</p>
      </Section>
      <Section title="Interior ministry" icon="star">
        <div className="decrees">
          {Object.entries(INTERIOR).map(([id, a]) => {
            const st = interiorState(g, n, id);
            return (
              <div key={id} className="decree">
                <div className="row gap"><b>{a.label}</b><div style={{ flex: 1 }} />
                  <Btn small kind="primary" disabled={!!st.blocked} title={st.blocked} onClick={() => {
                    const run = () => say(store.cmd('doInterior', [id]));
                    if (['arrests', 'ban', 'rig', 'purge', 'crackdown'].includes(id)) store.setUI({ confirm: { title: `${a.label}?`, body: a.desc, danger: true, onOk: run } }); else run();
                  }}>{st.cooldown ? `${st.cooldown}d` : st.cost > 0 ? money(st.cost, { digits: 1 }) : 'Order'}</Btn>
                </div>
                <div className="small muted">{a.desc}</div>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}

function Unrest() {
  const g = useGame();
  const list = ownedBy(g, g.player).map((p) => g.provinces[p]).filter((st) => st.status === 'core').sort((a, b) => b.resistance - a.resistance);
  return (
    <>
      <p className="small muted">Unrest in each region follows the national opposition, war damage and food shortages, and falls with garrisons, police and martial law. At {REVOLT_AT} a province revolts: output collapses, recruiting stops, damage spreads and rebels attack the garrison. Switch the map to <a onClick={() => store.setUI({ mapMode: 'unrest' })}>Unrest mode</a>.</p>
      <table className="tbl clickable">
        <thead><tr><th>Province</th><th>Unrest</th><th>Heading</th><th>Martial law</th></tr></thead>
        <tbody>
          {list.map((st) => (
            <tr key={st.id} onClick={() => { focusProvince(st.id); store.setUI({ selectedProvince: st.id, selectedArmy: null }); }}>
              <td>{PROV[st.id].name}{st.resistance >= REVOLT_AT ? <span className="bad"> 🔥 revolt</span> : ''}</td>
              <td><Bar value={st.resistance / 100} h={6} color={st.resistance >= REVOLT_AT ? 'var(--bad)' : st.resistance > 40 ? 'var(--warn)' : 'var(--good)'} /></td>
              <td className="small">{Math.round(coreUnrestTarget(g, st.id))}</td>
              <td onClick={(e) => e.stopPropagation()}><Btn small kind={st.martialLaw ? 'danger' : undefined} onClick={() => say(store.cmd('doMartialLaw', [st.id]))}>{st.martialLaw ? 'Lift' : 'Declare'}</Btn></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Martial law: unrest −40 target, but the province's output falls 30% and stability −1 per province each month.</p>
    </>
  );
}
