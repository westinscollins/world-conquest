// Which messages does the public PeerJS server forward between two real PeerJS clients in a
// browser, and which get the sender cut off? Each variant uses a fresh pair of clients and is sent
// through peer.socket (as the game's tunnel does).   node tests/e2e/peerjs-shapes.mjs
import { chromium } from 'playwright';
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const fail = (e) => { console.log(`::error title=PeerJS shapes::${esc([...lines, `CRASH: ${e?.stack || e}`].join('\n'))}`); process.exit(1); };
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
say('## PeerJS message shapes (browser clients, 0.peerjs.com)');
const b = await chromium.launch();
const page = await b.newPage();
await page.goto('https://westinscollins.github.io/world-conquest/');
await page.addScriptTag({ url: 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js' });
const pad = (n) => 'x'.repeat(n);
const cid = () => 'dc_' + Math.random().toString(36).slice(2, 12);
const cand = (extra = {}) => ({ candidate: { candidate: 'candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag abcd network-cost 999', sdpMLineIndex: 0, sdpMid: '0', usernameFragment: 'abcd' }, type: 'data', connectionId: cid(), ...extra });
const cases = [
  ['control: PeerJS-shaped CANDIDATE', 'CANDIDATE', cand()],
  ['tunnel as sent today: CANDIDATE {wct}', 'CANDIDATE', { wct: 'S1' }],
  ['CANDIDATE {wct, connectionId, type}', 'CANDIDATE', { wct: 'S2', connectionId: cid(), type: 'data' }],
  ['PeerJS-shaped CANDIDATE + wct field', 'CANDIDATE', cand({ wct: 'S3' })],
  ['PeerJS-shaped, data in candidate.candidate', 'CANDIDATE', { ...cand(), candidate: { candidate: 'S4' + pad(60), sdpMLineIndex: 0, sdpMid: '0' } }],
  ['PeerJS-shaped + wct 3 KB', 'CANDIDATE', cand({ wct: 'S5' + pad(3000) })],
  ['PeerJS-shaped + wct 9 KB', 'CANDIDATE', cand({ wct: 'S6' + pad(9000) })],
  ['OFFER-shaped, data in metadata', 'OFFER', { sdp: { type: 'offer', sdp: 'v=0\r\n' }, type: 'data', connectionId: cid(), label: 'x', reliable: true, serialization: 'json', metadata: { wct: 'S7' } }],
  ['ANSWER-shaped + wct', 'ANSWER', { sdp: { type: 'answer', sdp: 'v=0\r\n' }, type: 'data', connectionId: cid(), wct: 'S8' }],
];
for (const [name, type, payload] of cases) {
  const mark = (JSON.stringify(payload).match(/S\d/) ?? ['dc_'])[0];
  const r = await page.evaluate(async ({ type, payload, mark }) => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const P = window.Peer;
    const mk = () => new Promise((res) => { const p = new P(`wcsh-${Math.random().toString(36).slice(2, 10)}`, { debug: 0 }); const t = setTimeout(() => res(p), 10000); p.on('open', () => { clearTimeout(t); res(p); }); });
    const [A, B] = await Promise.all([mk(), mk()]);
    const got = [], back = [], errs = [];
    B.socket.on('message', (m) => got.push(m));
    A.socket.on('message', (m) => back.push(m));
    A.on('error', (e) => errs.push(`A:${e.type}`)); B.on('error', (e) => errs.push(`B:${e.type}`));
    let aDisc = false; A.on('disconnected', () => { aDisc = true; });
    const t0 = performance.now();
    A.socket.send({ type, dst: B.id, payload });
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) { await sleep(100); hit = got.find((m) => JSON.stringify(m).includes(mark)); }
    await sleep(1500);
    const aOpen = !!A.socket._wsOpen?.();
    // does A still work afterwards? a second, normal-shaped message
    const ctl = 'K' + Math.random().toString(36).slice(2, 8);
    if (aOpen) A.socket.send({ type: 'CANDIDATE', dst: B.id, payload: { candidate: { candidate: ctl, sdpMLineIndex: 0, sdpMid: '0' }, type: 'data', connectionId: 'dc_' + ctl } });
    await sleep(2000);
    const after = got.some((m) => JSON.stringify(m).includes(ctl));
    const res = { hit: !!hit, ms: hit ? Math.round(performance.now() - t0) : 0, wct: hit ? typeof hit.payload?.wct === 'string' : false, aOpen, aDisc, after, back: back.map((m) => m.type).join(','), errs: errs.join(',') };
    A.destroy(); B.destroy();
    return res;
  }, { type, payload, mark });
  say(`- ${r.hit ? '✅' : '❌'} ${name}${r.hit ? ` (${r.ms} ms${r.wct ? ', wct intact' : ''})` : ''} · sender ${r.aOpen ? 'still connected' : '**disconnected**'}${r.aDisc ? ' (disconnected event)' : ''} · next normal message ${r.after ? 'delivered' : 'lost'}${r.back ? ` · sender got ${r.back}` : ''}${r.errs ? ` · errors ${r.errs}` : ''}`);
}
// latency of the tunnel shape: a series of messages, each timed
const lat = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const P = window.Peer;
  const mk = () => new Promise((res) => { const p = new P(`wcsl-${Math.random().toString(36).slice(2, 10)}`, { debug: 0 }); p.on('open', () => res(p)); });
  const [A, B] = await Promise.all([mk(), mk()]);
  const sent = new Map(), arr = [];
  B.socket.on('message', (m) => { const k = m.payload?.wct; if (sent.has(k)) arr.push([k, Math.round(performance.now() - sent.get(k))]); });
  for (let i = 0; i < 12; i++) {
    const k = `L${i}-` + 'y'.repeat(i % 3 === 0 ? 7000 : 300);
    sent.set(k, performance.now());
    A.socket.send({ type: 'CANDIDATE', dst: B.id, payload: { candidate: { candidate: 'candidate:0 1 udp 1 0.0.0.0 9 typ host', sdpMLineIndex: 0, sdpMid: '0' }, type: 'data', connectionId: 'dc_wctunnel', wct: k } });
    await sleep(300);
  }
  await sleep(6000);
  A.destroy(); B.destroy();
  return arr.map(([k, ms]) => `${k.split('-')[0]}:${ms}ms`);
});
say(`- tunnel-shaped series (12 messages, 300 ms apart, every third 7 KB): ${lat.length}/12 arrived — ${lat.join(' ')}`);
await b.close();
console.log(`::notice title=PeerJS shapes::${esc(lines.join('\n'))}`);
process.exit(0);
