import { useState } from 'react';
import { Btn } from './common';
import { netConfig } from './net/config';
import { probeBroker } from './net/relay';

type Row = { name: string; ok: boolean | null; detail: string };

/** "What does this network allow?" — tests each way the game can connect, from this browser. */
export function NetCheck() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const cfg = netConfig();
    const out: Row[] = [
      { name: 'Matchmaking server (HTTPS)', ok: null, detail: 'testing…' },
      { name: 'Direct connections (WebRTC)', ok: null, detail: 'testing…' },
      ...cfg.brokers.map((b) => ({ name: `Relay ${host(b)}`, ok: null, detail: 'testing…' }) as Row),
    ];
    setRows([...out]);
    const set = (i: number, r: Partial<Row>) => { out[i] = { ...out[i], ...r }; setRows([...out]); };
    await Promise.all([
      probeMatchmaking(cfg.peerOptions).then((r) => set(0, r)),
      probeWebRtc(cfg.ice).then((r) => set(1, r)),
      ...cfg.brokers.map((b, i) => probeBroker(b).then((r) => set(2 + i, { ok: r.ok, detail: r.ok ? `ok (${r.ms} ms)` : `blocked or down (${r.error})` }))),
    ]);
    setBusy(false);
  };
  const verdict = rows && !busy ? summary(rows) : null;
  return (
    <div className="netcheck">
      <div className="row gap"><Btn small onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Check my network'}</Btn><span className="small muted">Run this on each computer if joining fails.</span></div>
      {rows && (
        <table className="tbl small"><tbody>
          {rows.map((r) => <tr key={r.name}><td>{r.ok == null ? '…' : r.ok ? <span className="good">✓</span> : <span className="bad">✗</span>}</td><td>{r.name}</td><td className="muted">{r.detail}</td></tr>)}
        </tbody></table>
      )}
      {verdict && <p className={`small ${verdict.ok ? 'good' : 'bad'}`}>{verdict.text}</p>}
    </div>
  );
}

function summary(rows: Row[]): { ok: boolean; text: string } {
  const mm = rows[0].ok, rtc = rows[1].ok, relays = rows.slice(2).filter((r) => r.ok).length;
  if (mm && rtc) return { ok: true, text: 'Everything works: you can host or join, with the fastest direct connection.' };
  if (mm || relays) return { ok: true, text: `You can play: ${!rtc ? 'this network blocks direct connections, so the game will route through ' : 'the game can route through '}${mm ? 'the matchmaking server' : ''}${mm && relays ? ' or ' : ''}${relays ? `${relays} relay server${relays > 1 ? 's' : ''}` : ''}. Expect a little extra delay.` };
  return { ok: false, text: 'This network blocks every way the game can connect (it probably only allows approved websites). Try another network, such as a phone hotspot.' };
}
const host = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

async function probeMatchmaking(opts: Record<string, unknown>): Promise<Partial<Row>> {
  const t0 = performance.now();
  try {
    const { Peer } = await import('peerjs');
    const p = new Peer(opts);
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 10000);
      p.on('open', () => { clearTimeout(t); resolve(true); });
      p.on('error', () => { clearTimeout(t); resolve(false); });
    });
    p.destroy();
    return ok ? { ok: true, detail: `ok (${Math.round(performance.now() - t0)} ms)` } : { ok: false, detail: 'blocked or down' };
  } catch (e) { return { ok: false, detail: String((e as Error).message) }; }
}
/** Gathers ICE candidates: a public (srflx) or relay candidate means direct connections can work. */
async function probeWebRtc(ice: RTCConfiguration): Promise<Partial<Row>> {
  if (typeof RTCPeerConnection === 'undefined') return { ok: false, detail: 'not supported by this browser' };
  try {
    const pc = new RTCPeerConnection(ice);
    pc.createDataChannel('probe');
    const kinds = new Set<string>();
    const done = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 8000);
      pc.onicecandidate = (e) => { if (!e.candidate) { clearTimeout(t); resolve(); return; } const m = e.candidate.candidate.match(/ typ (\w+)/); if (m) kinds.add(m[1]); };
    });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
    pc.close();
    if (kinds.has('relay')) return { ok: true, detail: 'ok (relayed connections possible)' };
    if (kinds.has('srflx')) return { ok: true, detail: 'ok (may still fail on some networks)' };
    return { ok: false, detail: 'blocked (no route out for WebRTC)' };
  } catch (e) { return { ok: false, detail: String((e as Error).message) }; }
}
