import { useMemo, useState } from 'react';
import { store, useGame } from '../store';
import { Section, Btn, Tabs, Stat, Tip, Modal, Bar } from '../common';
import { money, moneyIC, num, pct } from '../format';
import { PROV, COUNTRY_GEO } from '../../engine/geo';
import { ownedBy, peekRel, atWar, neighborsOf, alliesOf, livingNations } from '../../engine/world';
import { perceivedPower, checkDeclareWar, termsCost, scoreFor, evaluatePeace, provinceValue } from '../../engine/diplomacy';
import { doDeclareWar, doTreaty, doCancelTreaty, doMission, doUltimatum, proposePeace, concedePeace, answerPeaceOffer, answerProposal, doAnnexSubject } from '../../engine/actions';
import { describeTerms } from '../../engine/ai';
import { fmtDate } from '../../engine/events';
import type { PeaceTerms, War } from '../../engine/types';
import { PERSONALITY } from '../../engine/config';
import { audio } from '../../audio/music';

export function DiplomacyPanel() {
  const g = useGame();
  const ui = store.ui;
  const [tab, setTab] = useState<'nations' | 'wars' | 'offers'>('nations');
  const [filter, setFilter] = useState<'neighbors' | 'all' | 'region'>('neighbors');
  const [q, setQ] = useState('');
  const me = g.nations[g.player];
  const neighbors = neighborsOf(g, g.player);
  const myWars = g.wars.filter((w) => w.attackers.includes(g.player) || w.defenders.includes(g.player));
  const offers = g.peaceOffers.filter((o) => o.to === g.player).length + g.proposals.filter((p) => p.to === g.player).length;
  const list = useMemo(() => {
    let l = livingNations(g).filter((n) => n.id !== g.player);
    if (filter === 'neighbors') l = l.filter((n) => neighbors.includes(n.id) || peekRel(g, n.id, g.player)?.alliance || atWar(g, n.id, g.player));
    if (filter === 'region') l = l.filter((n) => COUNTRY_GEO[n.id].continent === COUNTRY_GEO[g.player].continent);
    if (q) l = l.filter((n) => n.name.toLowerCase().includes(q.toLowerCase()));
    return l.sort((a, b) => b.budget.output - a.budget.output);
  }, [g, filter, q, store.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = ui.selectedNation && ui.selectedNation !== g.player ? g.nations[ui.selectedNation] : null;
  return (
    <div className="panel-body">
      <div className="grid3">
        <Stat label="Infamy" value={me.infamy.toFixed(0)} tone={me.infamy > 40 ? 'bad' : undefined} tip="Aggressive-expansion reputation. Raised by unjustified wars, ultimatums and annexations; makes others hostile and unwilling to sign treaties. Decays ~6/yr." />
        <Stat label="Allies" value={alliesOf(g, g.player).length} />
        <Stat label="Wars" value={myWars.length} tone={myWars.length ? 'bad' : undefined} />
      </div>
      <Tabs tabs={[['nations', 'Nations'], ['wars', `Wars (${myWars.length})`], ['offers', `Proposals${offers ? ` (${offers})` : ''}`]]} value={tab} onChange={setTab} />
      {tab === 'nations' && (
        <div className="diplo">
          <div className="diplo-list">
            <div className="row gap">
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}><option value="neighbors">Neighbours & partners</option><option value="region">My continent</option><option value="all">All nations</option></select>
              <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="nation-list">
              {list.map((n) => {
                const r = peekRel(g, n.id, g.player);
                return (
                  <div key={n.id} className={`nation-row${sel?.id === n.id ? ' on' : ''}`} onClick={() => store.setUI({ selectedNation: n.id })}>
                    <span className="swatch" style={{ background: n.color }} />
                    <span className="nr-name">{n.name}</span>
                    {n.isPlayer && <span className="chip good" title="Controlled by another human player">player</span>}
                    {atWar(g, n.id, g.player) && <span className="chip bad">war</span>}
                    {r?.alliance && <span className="chip good">ally</span>}
                    {n.overlord === g.player && <span className="chip good">subject</span>}
                    <span className={`nr-rel ${(r?.value ?? 0) >= 0 ? 'good' : 'bad'}`}>{(r?.value ?? 0).toFixed(0)}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="diplo-detail">{sel ? <NationDetail id={sel.id} /> : <p className="muted">Select a nation.</p>}</div>
        </div>
      )}
      {tab === 'wars' && (
        <>
          {myWars.length === 0 && <p className="muted">You are at peace.</p>}
          {myWars.map((w) => <WarCard key={w.id} w={w} />)}
          {g.wars.filter((w) => !myWars.includes(w)).length > 0 && (
            <Section title="Other wars in the world" icon="globe">
              {g.wars.filter((w) => !myWars.includes(w)).map((w) => <div key={w.id} className="small">{w.name} — since {fmtDate(g, w.startDay)} · score {w.scoreA.toFixed(0)}</div>)}
            </Section>
          )}
        </>
      )}
      {tab === 'offers' && <Offers />}
      {ui.peaceWar != null && <PeaceDialog warId={ui.peaceWar} />}
    </div>
  );
}

function NationDetail({ id }: { id: string }) {
  const g = useGame();
  const n = g.nations[id];
  const me = g.nations[g.player];
  const r = peekRel(g, id, g.player);
  const theirP = perceivedPower(g, g.player, id);
  const myP = perceivedPower(g, g.player, g.player);
  const war = atWar(g, id, g.player);
  const chk = checkDeclareWar(g, me, id);
  const [ultProv, setUlt] = useState<number[]>([]);
  const border = ownedBy(g, id).filter((p) => PROV[p].neighbors.some((x) => g.provinces[x].owner === g.player));
  const res = (r2: { ok: boolean; message: string } | undefined) => r2 && store.toast(r2.message, r2.ok ? 'good' : 'bad');
  return (
    <>
      <h3><span className="swatch" style={{ background: n.color }} /> {n.name}</h3>
      <div className="small muted">{COUNTRY_GEO[id].subregion} · {PERSONALITY[n.personality].label}: {PERSONALITY[n.personality].desc}</div>
      <div className="grid2">
        <Stat label="Relations" value={(r?.value ?? 0).toFixed(0)} tone={(r?.value ?? 0) < -20 ? 'bad' : (r?.value ?? 0) > 20 ? 'good' : undefined} />
        <Stat label="Est. military" value={`${theirP.toFixed(0)} (you ${myP.toFixed(0)})`} tone={theirP > myP ? 'bad' : 'good'} tip="Intelligence estimate — may be off by 15–45%." />
        <Stat label="Output" value={`${money(n.budget.output)} IC`} />
        <Stat label="Provinces" value={ownedBy(g, id).length} />
        <Stat label="Stability" value={pct(n.stability / 100)} />
        <Stat label="Allies" value={alliesOf(g, id).map((a) => g.nations[a]?.name).join(', ') || 'none'} />
      </div>
      <div className="chips">
        {r?.alliance && <span className="chip good">Defensive alliance</span>}
        {r?.trade && <span className="chip">Trade agreement</span>}
        {(r?.nap ?? 0) > g.day && <span className="chip">Non-aggression pact until {fmtDate(g, r!.nap)}</span>}
        {(r?.truceUntil ?? 0) > g.day && <span className="chip">Truce until {fmtDate(g, r!.truceUntil)}</span>}
        {me.claims[id] > g.day && <span className="chip warn">Casus belli</span>}
      </div>
      {!war && (
        <Section title="Diplomatic actions" icon="handshake">
          <div className="row gap wrap">
            <Btn small onClick={() => res(store.cmd('doMission', [id]))}>Diplomatic mission ({moneyIC(2 * me.priceIndex)})</Btn>
            {!r?.trade ? <Btn small onClick={() => res(store.cmd('doTreaty', [id, 'trade']))}>Propose trade</Btn> : <Btn small kind="ghost" onClick={() => res(store.cmd('doCancelTreaty', [id, 'trade']))}>End trade</Btn>}
            {(r?.nap ?? 0) <= g.day && <Btn small onClick={() => res(store.cmd('doTreaty', [id, 'nap']))}>Non-aggression pact</Btn>}
            {!r?.alliance ? <Btn small onClick={() => res(store.cmd('doTreaty', [id, 'alliance']))}>Propose alliance</Btn> : <Btn small kind="ghost" onClick={() => store.setUI({ confirm: { title: 'Break alliance?', body: 'Relations will drop sharply.', danger: true, onOk: () => res(store.cmd('doCancelTreaty', [id, 'alliance'])) } })}>Break alliance</Btn>}
            {n.overlord === g.player && <Btn small onClick={() => res(store.cmd('doAnnexSubject', [id]))}>Annex subject</Btn>}
          </div>
          <p className="small muted">Alliances commit both sides to defensive wars — you will be called to arms if your ally is attacked.</p>
        </Section>
      )}
      {!war && border.length > 0 && (
        <Section title="Ultimatum" icon="alert">
          <p className="small muted">Demand border provinces. They yield only if they fear your coalition; refusal grants you a casus belli (justified war: smaller stability and infamy penalties).</p>
          <div className="chips">{border.map((p) => <label key={p} className="chip check"><input type="checkbox" checked={ultProv.includes(p)} onChange={(e) => setUlt(e.target.checked ? [...ultProv, p] : ultProv.filter((x) => x !== p))} />{PROV[p].name}</label>)}</div>
          <div className="row gap">
            <Btn small disabled={!ultProv.length} onClick={() => store.setUI({ confirm: { title: 'Issue ultimatum?', body: `Demand ${ultProv.map((p) => PROV[p].name).join(', ')} from ${n.name}. Relations −25, infamy +3.`, onOk: () => { res(store.cmd('doUltimatum', [id, ultProv])); setUlt([]); } } })}>Demand provinces</Btn>
            <Btn small onClick={() => store.setUI({ confirm: { title: 'Demand submission?', body: `Demand that ${n.name} become your subject. Needs overwhelming strength. Relations −25, infamy +6.`, onOk: () => res(store.cmd('doUltimatum', [id, [], true])) } })}>Demand vassalage</Btn>
          </div>
        </Section>
      )}
      {!war && (
        <Section title="War" icon="sword">
          {chk.ok ? (
            <>
              <p className="small">Declaring war costs <b className="bad">−{chk.stabilityCost} stability</b> and <b className="bad">+{chk.infamy} infamy</b>{chk.justified ? ' (justified by your casus belli)' : ' (unjustified!)'}{chk.breaksNap ? ', and breaks your non-aggression pact' : ''}. Trade with them ends.{chk.joiners.length ? <> Their allies will join: <b>{chk.joiners.map((j) => g.nations[j]?.name).join(', ')}</b>.</> : ''}</p>
              <Btn kind="danger" onClick={() => store.setUI({ confirm: { title: `Declare war on ${n.name}?`, body: `This cannot be undone without a peace treaty.\n\nStability −${chk.stabilityCost} · Infamy +${chk.infamy}${chk.joiners.length ? `\nTheir allies join: ${chk.joiners.map((j) => g.nations[j]?.name).join(', ')}` : ''}\nEstimated balance: you ${myP.toFixed(0)} vs them ${theirP.toFixed(0)}.`, danger: true, onOk: () => { const r2 = store.cmd('doDeclareWar', [id]); res(r2); if (r2?.ok) audio.sfx('alarm'); } } })}>Declare war</Btn>
            </>
          ) : <p className="small muted">{chk.reason}</p>}
        </Section>
      )}
      {war && <Btn kind="primary" onClick={() => { const w = g.wars.find((x) => (x.attackers.includes(id) && x.defenders.includes(g.player)) || (x.defenders.includes(id) && x.attackers.includes(g.player))); if (w) store.setUI({ peaceWar: w.id }); }}>Negotiate peace…</Btn>}
    </>
  );
}

function WarCard({ w }: { w: War }) {
  const g = useGame();
  const score = scoreFor(w, g.player);
  const mySide = w.attackers.includes(g.player) ? 'A' : 'D';
  const myCas = mySide === 'A' ? w.casualtiesA : w.casualtiesD;
  const theirCas = mySide === 'A' ? w.casualtiesD : w.casualtiesA;
  const leader = w.leaderA === g.player || w.leaderD === g.player;
  return (
    <div className="war-card">
      <div className="row"><b>{w.name}</b><div style={{ flex: 1 }} /><span className="small muted">since {fmtDate(g, w.startDay)}</span></div>
      <div className="small">{w.attackers.map((x) => g.nations[x]?.name).join(', ')} <b>vs</b> {w.defenders.map((x) => g.nations[x]?.name).join(', ')}</div>
      <div className="score-bar"><div className="sb-neg" style={{ width: `${Math.max(0, -score) / 2}%` }} /><div className="sb-mid" /><div className="sb-pos" style={{ width: `${Math.max(0, score) / 2}%` }} /></div>
      <div className="grid3">
        <Stat label="War score" value={score.toFixed(0)} tone={score >= 0 ? 'good' : 'bad'} tip="From occupied territory (by value) and the casualty balance. −100…+100." />
        <Stat label="Your losses" value={num(myCas)} />
        <Stat label="Enemy losses" value={num(theirCas)} />
      </div>
      <div className="small muted">You occupy {(mySide === 'A' ? w.occupiedByA : w.occupiedByD).length} enemy provinces; they occupy {(mySide === 'A' ? w.occupiedByD : w.occupiedByA).length} of yours. Battles: {w.battles}.</div>
      {leader ? <Btn kind="primary" onClick={() => store.setUI({ peaceWar: w.id })}>Negotiate peace…</Btn> : <p className="small muted">Peace is negotiated by the war leaders.</p>}
    </div>
  );
}

function PeaceDialog({ warId }: { warId: number }) {
  const g = useGame();
  const w = g.wars.find((x) => x.id === warId);
  const [prov, setProv] = useState<number[]>([]);
  const [rep, setRep] = useState(0);
  const [vassal, setVassal] = useState(false);
  const [mode, setMode] = useState<'demand' | 'concede'>('demand');
  if (!w) return null;
  const close = () => store.setUI({ peaceWar: null });
  const enemy = w.leaderA === g.player ? w.leaderD : w.leaderA;
  const occupied = (w.attackers.includes(g.player) ? w.occupiedByA : w.occupiedByD);
  const lost = (w.attackers.includes(g.player) ? w.occupiedByD : w.occupiedByA);
  const options = mode === 'demand' ? occupied : lost.concat(ownedBy(g, g.player).filter((p) => PROV[p].neighbors.some((x) => g.provinces[x].owner === enemy) && !lost.includes(p)));
  const terms: PeaceTerms = { provinces: prov, taker: mode === 'demand' ? g.player : enemy, reparations: rep, vassalize: vassal, annex: false, white: !prov.length && !rep && !vassal };
  const cost = terms.white ? 0 : termsCost(g, w, terms.taker!, terms);
  const score = scoreFor(w, g.player);
  const ev = mode === 'demand' ? evaluatePeace(g, w, g.player, terms) : null;
  const enemyOut = g.nations[enemy].budget.output;
  const send = () => {
    store.cmd(mode === 'demand' || terms.white ? 'proposePeace' : 'concedePeace', [w.id, terms], (res) => { store.toast(res.message, res.ok ? 'good' : 'bad'); if (res.ok) { audio.sfx('fanfare'); close(); } });
  };
  return (
    <Modal title={`Peace negotiations — ${w.name}`} onClose={close} wide>
      <div className="row gap"><Tabs tabs={[['demand', 'Demand terms'], ['concede', 'Offer concessions']]} value={mode} onChange={(m) => { setMode(m); setProv([]); setRep(0); setVassal(false); }} /><div style={{ flex: 1 }} /><span>Your war score: <b className={score >= 0 ? 'good' : 'bad'}>{score.toFixed(0)}</b> · their exhaustion {g.nations[enemy].warExhaustion.toFixed(0)}</span></div>
      <p className="small muted">{mode === 'demand' ? 'Select provinces you occupy to annex. Each demand costs war score proportional to its value; they accept if your score (plus their war-weariness) covers the cost.' : 'Offer territory or reparations to end a war you are losing. Ceding land is permanent.'}</p>
      <div className="peace-grid">
        <div>
          <h4>{mode === 'demand' ? 'Occupied enemy provinces' : 'Your provinces they could take'}</h4>
          <div className="chips">
            {options.length ? options.map((p) => (
              <label key={p} className={`chip check${prov.includes(p) ? ' on' : ''}`}>
                <input type="checkbox" checked={prov.includes(p)} onChange={(e) => setProv(e.target.checked ? [...prov, p] : prov.filter((x) => x !== p))} />
                {PROV[p].name} <span className="muted">({(100 * provinceValue(g, p) / Math.max(1, ownedBy(g, g.provinces[p].owner).reduce((t, q) => t + provinceValue(g, q), 0))).toFixed(0)})</span>
              </label>
            )) : <span className="muted small">None.</span>}
          </div>
          <h4>Reparations ({money(rep)} IC/yr for 5 years)</h4>
          <input type="range" min={0} max={Math.round((mode === 'demand' ? enemyOut : g.nations[g.player].budget.output) * 0.15)} value={rep} onChange={(e) => setRep(+e.target.value)} />
          {mode === 'demand' && <label className="check"><input type="checkbox" checked={vassal} onChange={(e) => setVassal(e.target.checked)} /> Demand they become your subject state (cost 55)</label>}
        </div>
        <div className="peace-sum">
          <h4>Proposed treaty</h4>
          <p>{describeTerms(g, terms)}</p>
          <div className="kv"><span>War-score cost</span><b>{cost.toFixed(0)}</b></div>
          {mode === 'demand' && <><div className="kv"><span>Your war score</span><b>{score.toFixed(0)}</b></div><Bar value={Math.min(1, (score + 1) / Math.max(1, cost))} h={6} /><p className={ev?.accept ? 'good' : 'bad'}>{ev?.accept ? 'They are likely to accept.' : ev?.reason}</p></>}
          <p className="small muted">After peace: a 2-year truce; ceded provinces arrive as occupied territory (integrate them). Unceded occupied land is returned.</p>
          <div className="row gap end">
            <Btn onClick={close}>Cancel</Btn>
            <Btn kind="primary" onClick={() => store.setUI({ confirm: { title: 'Sign this treaty?', body: `${describeTerms(g, terms)}${mode === 'concede' && prov.length ? '\n\nCeded provinces are lost permanently.' : ''}`, danger: mode === 'concede', onOk: send } })}>{terms.white ? 'Propose white peace' : mode === 'demand' ? 'Send demands' : 'Offer concessions'}</Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Offers() {
  const g = useGame();
  const peace = g.peaceOffers.filter((o) => o.to === g.player);
  const props = g.proposals.filter((p) => p.to === g.player);
  if (!peace.length && !props.length) return <p className="muted">No pending proposals.</p>;
  return (
    <>
      {peace.map((o) => (
        <div key={o.id} className="offer">
          <b>{g.nations[o.from]?.name} offers peace</b>
          <p>{describeTerms(g, o.terms)}{o.terms.taker === o.from && !o.terms.white ? ' (to them)' : ''}</p>
          <div className="row gap">
            <Btn kind="primary" onClick={() => store.setUI({ confirm: { title: 'Accept peace?', body: describeTerms(g, o.terms), danger: !o.terms.white && o.terms.taker !== g.player, onOk: () => { const r = store.cmd('answerPeaceOffer', [o.id, true]); r && store.toast(r.message, r.ok ? 'good' : 'bad'); } } })}>Accept</Btn>
            <Btn onClick={() => store.cmd('answerPeaceOffer', [o.id, false])}>Reject</Btn>
          </div>
        </div>
      ))}
      {props.map((p) => (
        <div key={p.id} className="offer">
          <b>{g.nations[p.from]?.name}: {p.kind === 'callToArms' ? 'call to arms!' : `proposes ${p.kind === 'nap' ? 'a non-aggression pact' : p.kind === 'trade' ? 'a trade agreement' : 'a defensive alliance'}`}</b>
          {p.kind === 'callToArms' && <p className="small">Your ally has been attacked. Refusing dissolves the alliance and costs reputation.</p>}
          <div className="row gap">
            <Btn kind="primary" onClick={() => { const r = store.cmd('answerProposal', [p.id, true]); r && store.toast(r.message, 'good'); }}>Accept</Btn>
            <Btn onClick={() => { const r = store.cmd('answerProposal', [p.id, false]); r && store.toast(r.message, 'info'); }}>Decline</Btn>
          </div>
        </div>
      ))}
    </>
  );
}

export { Tip };
