// Which pairs of peers on the public PeerJS server can reach each other? Raw WebSockets (8 peers,
// every pair) and real PeerJS clients in a browser (6 peers, data connections). Plus the server's
// "location" across repeated requests.   node tests/e2e/peerjs-matrix.mjs
import WebSocket from 'ws';
import { chromium } from 'playwright';
const host = '0.peerjs.com';
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 12);
const fail = (e) => { console.log(`::error title=PeerJS matrix::${esc([...lines, `CRASH: ${e?.stack || e}`].join('\n'))}`); process.exit(1); };
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);

say(`## PeerJS matrix: ${host}`);
// 1. the root document, several times
const locs = [];
for (let i = 0; i < 8; i++) {
  try { const r = await fetch(`https://${host}/?n=${i}`); const j = await r.json(); locs.push(JSON.stringify(j.location ?? j)); } catch (e) { locs.push(`err ${e.message}`); }
}
say(`- GET / "location" over 8 requests: ${[...new Set(locs)].join(' | ')}`);
try { const r = await fetch(`https://${host}/`); say(`- full root document: ${(await r.text()).slice(0, 400)}`); } catch { /* shown above */ }

// 2. raw sockets: 8 peers, everyone sends to everyone
const N = 8;
const peers = [];
for (let i = 0; i < N; i++) {
  const id = `wcmx-${i}-${rnd()}`, token = rnd();
  const ws = new WebSocket(`wss://${host}:443/peerjs?key=peerjs&id=${id}&token=${token}&version=1.5.4`, { headers: { Origin: 'https://westinscollins.github.io' } });
  const got = new Set();
  ws.on('message', (d) => { try { const m = JSON.parse(String(d)); if (m.payload?.wct) got.add(m.payload.wct); } catch { /* */ } });
  peers.push({ id, ws, got, open: new Promise((r) => ws.once('open', r)) });
}
await Promise.all(peers.map((p) => p.open));
await sleep(1500);
for (const a of peers) for (const [j, b] of peers.entries()) if (a !== b) a.ws.send(JSON.stringify({ type: 'CANDIDATE', dst: b.id, payload: { wct: `${peers.indexOf(a)}>${j}` } }));
await sleep(5000);
let ok = 0;
const rows = peers.map((b, j) => peers.map((a, i) => (i === j ? '·' : b.got.has(`${i}>${j}`) ? (ok++, '✓') : '✗')).join(''));
say(`- raw sockets: ${ok} of ${N * (N - 1)} directed pairs delivered`);
say('```\n' + rows.map((r, j) => `to ${j}: ${r}`).join('\n') + '\n```');
for (const p of peers) p.ws.close();

// 3. real PeerJS clients in a browser page: data connections between every pair
const b = await chromium.launch();
const page = await b.newPage();
await page.goto('https://westinscollins.github.io/world-conquest/');
await page.addScriptTag({ url: 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js' });
const res = await page.evaluate(async () => {
  const P = window.Peer;
  const n = 6, ps = [];
  for (let i = 0; i < n; i++) ps.push(new P(`wcmxb-${i}-${Math.random().toString(36).slice(2, 10)}`, { debug: 0 }));
  await Promise.all(ps.map((p) => new Promise((r) => { if (p.open) r(); else { p.on('open', r); p.on('error', r); } })));
  const opened = ps.map((p) => p.open);
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    out.push(new Promise((r) => {
      const c = ps[i].connect(ps[j].id, { reliable: true });
      const t = setTimeout(() => r(`${i}>${j}:✗`), 15000);
      c.on('open', () => { clearTimeout(t); r(`${i}>${j}:✓`); });
      c.on('error', () => { clearTimeout(t); r(`${i}>${j}:err`); });
    }));
  }
  ps.forEach((p, i) => p.on('error', (e) => out.push(Promise.resolve(`peer ${i} error ${e.type}`))));
  const all = await Promise.all(out);
  return { opened, all };
});
await b.close();
const good = res.all.filter((x) => x.endsWith('✓')).length;
say(`- browser PeerJS clients registered: ${res.opened.map((o) => (o ? '✓' : '✗')).join('')}; data connections opened: ${good} of ${res.all.filter((x) => x.includes('>')).length}`);
say(`  - ${res.all.join(' ')}`);
console.log(`::notice title=PeerJS matrix::${esc(lines.join('\n'))}`);
process.exit(0);
