// Live check of online multiplayer against the REAL public services (run on a GitHub runner,
// which has internet access): the PeerJS matchmaking server, WebRTC STUN/TURN, each MQTT relay
// broker, and full two-player games over every connection path.
//   node tests/e2e/live.mjs https://westinscollins.github.io/world-conquest/
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const url = process.argv[2] || 'https://westinscollins.github.io/world-conquest/';
const CANDIDATE_BROKERS = ['wss://public:public@public.cloud.shiftr.io:443', 'ws://mqtt.eclipseprojects.io:80/mqtt'];
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
let failed = 0;

say(`## Live multiplayer check: ${url}`);
// 1. probes from inside a real browser on the deployed site
const b = await chromium.launch();
const page = await b.newPage();
// the CDN can serve the previous build for a few minutes after a deploy: wait for this one
for (let i = 0; ; i++) {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now());
  await page.waitForFunction(() => !!window.__wc, null, { timeout: 30000 });
  if (await page.evaluate(() => !!window.__wcNet)) break;
  if (i >= 16) { say('❌ the deployed site is still the old build after 8 minutes'); console.log(`::error title=Live multiplayer report::old build still served`); process.exit(1); }
  await page.waitForTimeout(30000);
}
const probes = await page.evaluate(async (extra) => {
  const out = [];
  const t = () => performance.now();
  for (const [name, cfg, want] of [
    ['STUN (google)', { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }, 'srflx'],
    ['STUN (cloudflare)', { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }, 'srflx'],
    ['TURN udp (peerjs)', { iceServers: [{ urls: 'turn:eu-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' }], iceTransportPolicy: 'relay' }, 'relay'],
    ['TURN tcp (peerjs)', { iceServers: [{ urls: 'turn:eu-0.turn.peerjs.com:3478?transport=tcp', username: 'peerjs', credential: 'peerjsp' }], iceTransportPolicy: 'relay' }, 'relay'],
  ]) {
    const t0 = t();
    const pc = new RTCPeerConnection(cfg);
    pc.createDataChannel('x');
    const kinds = new Set();
    const done = new Promise((r) => { const x = setTimeout(r, 10000); pc.onicecandidate = (e) => { if (!e.candidate) { clearTimeout(x); r(); return; } const m = e.candidate.candidate.match(/ typ (\w+)/); if (m) kinds.add(m[1]); }; });
    await pc.setLocalDescription(await pc.createOffer()); await done; pc.close();
    out.push([name, kinds.has(want), `${[...kinds].join(',') || 'no candidates'} ${Math.round(t() - t0)} ms`]);
  }
  for (const b of extra) { const r = await window.__wcNet.probeBroker(b); out.push([`candidate relay ${b.replace(/\/\/[^@]*@/, '//')}`, r.ok, r.ok ? `${r.ms} ms` : r.error]); }
  return out;
}, CANDIDATE_BROKERS);
for (const [n, ok, d] of probes) say(`- ${ok ? '✅' : '❌'} ${n}: ${d}`);
// broker probes go through the game's own probe in the network check
await page.click('text=Online multiplayer');
await page.click('button:has-text("Check my network")');
await page.waitForSelector('.netcheck p', { timeout: 60000 });
const rows = await page.$$eval('.netcheck tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
say('### In-game network check');
for (const r of rows) say(`- ${r}`);
say(`- verdict: ${await page.locator('.netcheck p').innerText()}`);
await b.close();

// 2. full two-player games over each path against the real services
const scenarios = [
  ['auto (expect direct WebRTC)', '?live=1', 'direct'],
  ['WebRTC blocked (school-style network) → matchmaking-server tunnel', '?netsim=noice', 'server'],
  ['MQTT relay only', '?net=mqtt', 'mqtt'],
  ['WebRTC blocked and matchmaking unreachable → MQTT relay', '?netsim=noice&peerhost=127.0.0.1:9', 'mqtt'],
];
say('### Two-player games');
for (const [name, q, via] of scenarios) {
  const r = spawnSync('node', ['tests/e2e/multiplayer.mjs', url, q], { env: { ...process.env, EXPECT_VIA: via, SHOTS: 'live-shots' }, encoding: 'utf8', timeout: 360000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const ok = r.status === 0;
  if (!ok) failed++;
  say(`- ${ok ? '✅' : '❌'} ${name}${fails.length ? ` — ${fails.join('; ')}` : ''}`);
  const via = out.match(/guest connected via (\w+)/)?.[1];
  if (via) say(`  - connected via ${via}`);
  if (!ok) say(`  - log tail: ${out.split('\n').filter((l) => l.trim() && !l.startsWith('   rejoin')).slice(-6).join(' | ').slice(0, 900)}`);
}
// one annotation with the whole report (readable through the GitHub API)
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
console.log(`::notice title=Live multiplayer report::${esc(lines.join('\n'))}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exit(failed ? 1 : 0);
