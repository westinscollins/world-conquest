// Which messages does the public PeerJS server forward between two real PeerJS clients in a
// browser? Sends variants through peer.socket (as the game's tunnel does) and records what
// arrives on the other side's socket.   node tests/e2e/peerjs-shapes.mjs
import { chromium } from 'playwright';
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const fail = (e) => { console.log(`::error title=PeerJS shapes::${esc([...lines, `CRASH: ${e?.stack || e}`].join('\n'))}`); process.exit(1); };
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
say('## PeerJS message shapes (browser clients, 0.peerjs.com)');
const b = await chromium.launch();
const page = await b.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 200)); });
await page.goto('https://westinscollins.github.io/world-conquest/');
await page.addScriptTag({ url: 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js' });
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const P = window.Peer;
  const mk = () => new Promise((res) => { const p = new P(`wcsh-${Math.random().toString(36).slice(2, 10)}`, { debug: 0 }); p.on('open', () => res(p)); p.on('error', (e) => res(p)); });
  const A = await mk(), B = await mk();
  const got = [], back = [], errs = [];
  B.socket.on('message', (m) => got.push(m));
  A.socket.on('message', (m) => back.push(m));
  A.on('error', (e) => errs.push(`A:${e.type}`)); B.on('error', (e) => errs.push(`B:${e.type}`));
  const pad = (n) => 'x'.repeat(n);
  const cand = (extra) => ({ candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0', sdpMLineIndex: 0, sdpMid: '0' }, type: 'data', connectionId: 'dc_' + Math.random().toString(36).slice(2, 12), ...extra });
  const cases = [
    ['tunnel: CANDIDATE {wct}', 'CANDIDATE', { wct: 'S1' }],
    ['CANDIDATE {wct, connectionId, type}', 'CANDIDATE', { wct: 'S2', connectionId: 'dc_s2abcdefgh', type: 'data' }],
    ['CANDIDATE PeerJS-shaped + wct', 'CANDIDATE', cand({ wct: 'S3' })],
    ['CANDIDATE PeerJS-shaped, data in candidate.candidate', 'CANDIDATE', { ...cand({}), candidate: { candidate: 'S4 ' + pad(40), sdpMLineIndex: 0, sdpMid: '0' } }],
    ['CANDIDATE PeerJS-shaped + wct 2 KB', 'CANDIDATE', cand({ wct: 'S5' + pad(2000) })],
    ['CANDIDATE PeerJS-shaped + wct 8 KB', 'CANDIDATE', cand({ wct: 'S6' + pad(8000) })],
    ['OFFER-shaped + metadata', 'OFFER', { sdp: { type: 'offer', sdp: 'v=0\r\n' }, type: 'data', connectionId: 'dc_s7abcdefgh', label: 'dc_s7abcdefgh', reliable: true, serialization: 'json', metadata: { wct: 'S7' } }],
    ['ANSWER-shaped + wct', 'ANSWER', { sdp: { type: 'answer', sdp: 'v=0\r\n' }, type: 'data', connectionId: 'dc_s8abcdefgh', wct: 'S8' }],
    ['LEAVE + wct', 'LEAVE', { wct: 'S9' }],
  ];
  const res = [];
  for (const [name, type, payload] of cases) {
    const mark = JSON.stringify(payload).match(/S\d/)[0];
    got.length = 0; back.length = 0;
    const t0 = performance.now();
    A.socket.send({ type, dst: B.id, payload });
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) { await sleep(100); hit = got.find((m) => JSON.stringify(m).includes(mark)); }
    res.push(`${hit ? '✅' : '❌'} ${name}${hit ? ` (${Math.round(performance.now() - t0)} ms, as ${hit.type}${hit.payload?.wct ? ', wct intact' : ''})` : ''}${got.length && !hit ? ` [B got ${got.map((m) => m.type).join(',')}]` : ''}${back.length ? ` [A got ${back.map((m) => m.type).join(',')}]` : ''}`);
  }
  // a real data connection between them still works?
  const dc = await new Promise((r) => { const c = A.connect(B.id); const t = setTimeout(() => r('✗'), 15000); c.on('open', () => { clearTimeout(t); r('✓'); }); });
  // raw WebSocket from the page itself, like a third client
  const raw = await new Promise((r) => {
    const id = `wcshr-${Math.random().toString(36).slice(2, 10)}`;
    const ws = new WebSocket(`wss://0.peerjs.com:443/peerjs?key=peerjs&id=${id}&token=${Math.random().toString(36).slice(2)}&version=1.5.4`);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'OPEN') { ws.send(JSON.stringify({ type: 'CANDIDATE', dst: B.id, payload: cand({ wct: 'R1' }) })); } };
    setTimeout(() => r(got.some((m) => JSON.stringify(m).includes('R1')) ? '✓' : '✗'), 6000);
  });
  return { res, dc, raw, errs };
});
await b.close();
for (const r of out.res) say(`- ${r}`);
say(`- a normal PeerJS data connection A→B afterwards: ${out.dc}`);
say(`- raw WebSocket client in the page → B (PeerJS-shaped candidate): ${out.raw}`);
if (out.errs.length) say(`- peer errors: ${out.errs.join(', ')}`);
console.log(`::notice title=PeerJS shapes::${esc(lines.join('\n'))}`);
process.exit(0);
