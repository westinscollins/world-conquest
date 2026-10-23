// What does the public PeerJS server (0.peerjs.com) relay between two registered peers? Raw
// WebSockets, no browser. Prints a report and a GitHub annotation.
//   node tests/e2e/peerjs-probe.mjs [host=0.peerjs.com | ws://127.0.0.1:9000]
import WebSocket from 'ws';
const host = process.argv[2] || '0.peerjs.com';
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 12);
const fail = (e) => { console.log(`::error title=PeerJS probe::${esc([...lines, `CRASH: ${e?.stack || e}`].join('\n'))}`); process.exit(1); };
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);

function peer(name) {
  const id = `wcprobe-${name}-${rnd()}`, token = rnd();
  const base = /^wss?:\/\//.test(host) ? host : `wss://${host}:443`;
  const url = `${base}/peerjs?key=peerjs&id=${id}&token=${token}&version=1.5.4`;
  const ws = new WebSocket(url, { headers: { Origin: 'https://westinscollins.github.io' } });
  const got = [];
  ws.on('message', (d) => { let m; try { m = JSON.parse(String(d)); } catch { m = { raw: String(d).slice(0, 80) }; } got.push({ t: Date.now(), m }); });
  const opened = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 15000); });
  const hb = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'HEARTBEAT' })); }, 5000);
  return { id, token, ws, got, opened, close: () => { clearInterval(hb); ws.close(); }, send: (m) => ws.send(JSON.stringify(m)) };
}

say(`## PeerJS probe: ${host}`);
const A = peer('a'), B = peer('b');
await Promise.all([A.opened, B.opened]);
await sleep(1500);
say(`- A registered: ${A.got.map((x) => x.m.type).join(',') || 'nothing'}; B: ${B.got.map((x) => x.m.type).join(',') || 'nothing'}`);
B.got.length = 0; A.got.length = 0;

const pad = (n) => 'x'.repeat(n);
const cases = [
  ['CANDIDATE {wct} 60 B (our tunnel)', { type: 'CANDIDATE', payload: { wct: 'M1' + pad(60) } }],
  ['CANDIDATE {wct} 2 KB', { type: 'CANDIDATE', payload: { wct: 'M2' + pad(2000) } }],
  ['CANDIDATE {wct} 8 KB', { type: 'CANDIDATE', payload: { wct: 'M3' + pad(8000) } }],
  ['CANDIDATE {wct} 20 KB', { type: 'CANDIDATE', payload: { wct: 'M4' + pad(20000) } }],
  ['CANDIDATE {wct, connectionId}', { type: 'CANDIDATE', payload: { wct: 'M5', connectionId: 'dc_probe5', type: 'data' } }],
  ['CANDIDATE PeerJS-shaped', { type: 'CANDIDATE', payload: { candidate: { candidate: 'M6', sdpMLineIndex: 0, sdpMid: '0' }, type: 'data', connectionId: 'dc_probe6' } }],
  ['CANDIDATE PeerJS-shaped + 2 KB extra', { type: 'CANDIDATE', payload: { candidate: { candidate: 'M7', sdpMLineIndex: 0, sdpMid: '0' }, type: 'data', connectionId: 'dc_probe7', wct: pad(2000) } }],
  ['OFFER PeerJS-shaped (metadata)', { type: 'OFFER', payload: { sdp: { type: 'offer', sdp: 'M8' }, type: 'data', connectionId: 'dc_probe8', label: 'dc_probe8', reliable: true, serialization: 'json', metadata: { wct: 'M8' } } }],
  ['ANSWER PeerJS-shaped', { type: 'ANSWER', payload: { sdp: { type: 'answer', sdp: 'M9' }, type: 'data', connectionId: 'dc_probe9' } }],
  ['CANDIDATE payload as a string', { type: 'CANDIDATE', payload: 'M10' }],
  ['unknown type WCT', { type: 'WCT', payload: { wct: 'M11' } }],
];
say('### A → B');
for (const [name, m] of cases) {
  const marker = JSON.stringify(m.payload).match(/M\d+/)[0];
  const t0 = Date.now();
  try { A.send({ ...m, dst: B.id }); } catch (e) { say(`- ❌ ${name}: send threw ${e.message}`); continue; }
  let hit = null;
  for (let i = 0; i < 30 && !hit; i++) { await sleep(100); hit = B.got.find((x) => JSON.stringify(x.m).includes(`"${marker}`) || JSON.stringify(x.m).includes(marker + 'x')); }
  const back = A.got.splice(0).map((x) => x.m.type + (x.m.payload?.msg ? `(${x.m.payload.msg})` : '')).join(',');
  say(`- ${hit ? '✅' : '❌'} ${name}${hit ? ` — arrived as ${hit.m.type} in ${hit.t - t0} ms, src ${hit.m.src === A.id ? 'ok' : hit.m.src}` : ' — not delivered'}${back ? `; A got back: ${back}` : ''}`);
  B.got.length = 0;
}
// burst: 30 small tunnel messages at once
for (let i = 0; i < 30; i++) A.send({ type: 'CANDIDATE', dst: B.id, payload: { wct: `B${i}` } });
await sleep(3000);
const burst = B.got.filter((x) => typeof x.m.payload?.wct === 'string' && x.m.payload.wct.startsWith('B')).length;
say(`- burst of 30 small tunnel messages: ${burst} arrived${A.got.length ? `; A got back: ${A.got.map((x) => x.m.type).join(',')}` : ''}`);
A.got.length = 0; B.got.length = 0;
// to a peer that does not exist
A.send({ type: 'CANDIDATE', dst: `wcprobe-nobody-${rnd()}`, payload: { wct: 'N1' } });
await sleep(8000);
say(`- to an unknown peer: A got back ${A.got.map((x) => x.m.type).join(',') || 'nothing'} within 8 s`);
// B → A too (both directions)
B.send({ type: 'CANDIDATE', dst: A.id, payload: { wct: 'R1' } });
await sleep(2000);
say(`- B → A small tunnel message: ${A.got.some((x) => x.m.payload?.wct === 'R1') ? '✅ arrived' : '❌ not delivered'}`);
A.close(); B.close();
console.log(`::notice title=PeerJS probe::${esc(lines.join('\n'))}`);
process.exit(0);
