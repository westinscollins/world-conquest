// What does the public PeerJS server (0.peerjs.com) relay between two registered peers? Raw
// WebSockets, no browser. Tests whether peers on different server addresses (DNS round-robin)
// can reach each other. Prints a report and a GitHub annotation.
//   node tests/e2e/peerjs-probe.mjs [host=0.peerjs.com | ws://127.0.0.1:9000]
import WebSocket from 'ws';
import dns from 'node:dns/promises';
const host = process.argv[2] || '0.peerjs.com';
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 12);
const fail = (e) => { console.log(`::error title=PeerJS probe::${esc([...lines, `CRASH: ${e?.stack || e}`].join('\n'))}`); process.exit(1); };
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
const local = /^wss?:\/\//.test(host);

function peer(name, ip) {
  const id = `wcprobe-${name}-${rnd()}`, token = rnd();
  const base = local ? host : `wss://${host}:443`;
  const url = `${base}/peerjs?key=peerjs&id=${id}&token=${token}&version=1.5.4`;
  const opts = { headers: { Origin: 'https://westinscollins.github.io' } };
  if (ip) opts.lookup = (_h, o, cb) => (o && o.all ? cb(null, [{ address: ip, family: ip.includes(':') ? 6 : 4 }]) : cb(null, ip, ip.includes(':') ? 6 : 4));
  const ws = new WebSocket(url, opts);
  const got = [];
  let remote = '';
  ws.on('upgrade', (res) => { remote = res.socket?.remoteAddress ?? ''; });
  ws.on('message', (d) => { let m; try { m = JSON.parse(String(d)); } catch { m = { raw: String(d).slice(0, 80) }; } got.push({ t: Date.now(), m }); });
  const opened = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 15000); });
  const hb = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'HEARTBEAT' })); }, 5000);
  return { id, ws, got, opened, remote: () => remote, close: () => { clearInterval(hb); ws.close(); }, send: (m) => ws.send(JSON.stringify(m)) };
}
async function trial(label, ipA, ipB) {
  const A = peer('a', ipA), B = peer('b', ipB);
  try { await Promise.all([A.opened, B.opened]); } catch (e) { say(`- ${label}: could not connect (${e.message})`); return; }
  await sleep(1200);
  const reg = `A ${A.got.map((x) => x.m.type).join(',') || '-'} via ${A.remote()}, B ${B.got.map((x) => x.m.type).join(',') || '-'} via ${B.remote()}`;
  A.got.length = 0; B.got.length = 0;
  const res = [];
  for (const [name, m] of [
    ['tunnel', { type: 'CANDIDATE', payload: { wct: 'T1' } }],
    ['offer', { type: 'OFFER', payload: { sdp: { type: 'offer', sdp: 'T2' }, type: 'data', connectionId: 'dc_t2', label: 'dc_t2', reliable: true, serialization: 'json', metadata: {} } }],
  ]) {
    const mark = JSON.stringify(m.payload).match(/T\d/)[0];
    A.send({ ...m, dst: B.id });
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) { await sleep(100); hit = B.got.find((x) => JSON.stringify(x.m).includes(mark)); }
    res.push(`${name} ${hit ? `✅ ${hit.t - (Date.now() - 4000) > 0 ? '' : ''}` : '❌'}`);
  }
  B.send({ type: 'CANDIDATE', dst: A.id, payload: { wct: 'T3' } });
  await sleep(2500);
  res.push(`B→A ${A.got.some((x) => JSON.stringify(x.m).includes('T3')) ? '✅' : '❌'}`);
  say(`- ${label}: ${res.join(', ')} (${reg})`);
  A.close(); B.close();
}

say(`## PeerJS probe: ${host}`);
let v4 = [], v6 = [];
if (!local) {
  try { v4 = await dns.resolve4(host); } catch (e) { say(`- resolve4 failed: ${e.code}`); }
  try { v6 = await dns.resolve6(host); } catch { /* none */ }
  say(`- ${host} resolves to ${v4.length} IPv4 [${v4.join(', ')}] and ${v6.length} IPv6 [${v6.join(', ')}]`);
  try { const c = await dns.resolveCname(host); say(`- CNAME: ${c.join(', ')}`); } catch { /* none */ }
}
say('### Two peers');
await trial('default DNS (each socket resolves on its own)', null, null);
await trial('default DNS, again', null, null);
if (v4.length) {
  await trial(`both on ${v4[0]}`, v4[0], v4[0]);
  if (v4.length > 1) {
    await trial(`both on ${v4[1]}`, v4[1], v4[1]);
    await trial(`A on ${v4[0]}, B on ${v4[1]}`, v4[0], v4[1]);
  }
}
// unknown destination: how long until EXPIRE?
{
  const A = peer('x', v4[0] ?? null);
  await A.opened; await sleep(1000); A.got.length = 0;
  A.send({ type: 'CANDIDATE', dst: `wcprobe-nobody-${rnd()}`, payload: { wct: 'N1' } });
  const t0 = Date.now();
  let e = null;
  for (let i = 0; i < 300 && !e; i++) { await sleep(100); e = A.got.find((x) => x.m.type === 'EXPIRE'); }
  say(`- message to an unknown peer: ${e ? `EXPIRE after ${((e.t - t0) / 1000).toFixed(1)} s` : 'no EXPIRE within 30 s'}${A.got.length && !e ? ` (got ${A.got.map((x) => x.m.type).join(',')})` : ''}`);
  A.close();
}
// the HTTP side
if (!local) {
  for (const path of ['/', '/peerjs/id', '/peerjs/peers']) {
    try { const r = await fetch(`https://${host}${path}`, { headers: { Origin: 'https://westinscollins.github.io' } }); const t = (await r.text()).slice(0, 120).replace(/\s+/g, ' '); say(`- GET ${path}: ${r.status} ${t}${r.headers.get('server') ? ` [server: ${r.headers.get('server')}]` : ''}${r.headers.get('via') ? ` [via: ${r.headers.get('via')}]` : ''}`); } catch (e) { say(`- GET ${path}: ${e.message}`); }
  }
}
console.log(`::notice title=PeerJS probe::${esc(lines.join('\n'))}`);
process.exit(0);
