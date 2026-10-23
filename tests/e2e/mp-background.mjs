// The host switches to another tab mid-game: the game must keep running for the guest and both
// stay connected, although the browser throttles the hidden tab (no animation frames, page timers
// once a second). The host runs in a plain Chromium driven over the DevTools protocol, because
// Playwright keeps its own pages "visible". Needs vite (or a preview build) and
// tests/e2e/peer-server.mjs. Usage: node tests/e2e/mp-background.mjs <url> [query] [seconds hidden]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
const base = process.argv[2] || 'http://localhost:5173/';
const q = process.argv[3] || '?peerhost=127.0.0.1:9000&relay=none&net=server&netsim=noice';
const hiddenFor = Number(process.argv[4] || 60) * 1000;
const PORT = 9334;
let fails = 0;
const ok = (n, c, x = '') => { console.log(c ? 'ok  ' : 'FAIL', n, x); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const muted = () => localStorage.setItem('wc-audio', JSON.stringify({ music: 0.5, sfx: 0.5, muted: true })); // a silent tab is throttled harder

// the host's browser: a real tab that can go to the background
const chrome = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wc-bg-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ver;
for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const cdp = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => cdp.once('open', r));
let seq = 0; const waiting = new Map();
cdp.on('message', (m) => { const d = JSON.parse(m); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++seq; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
const { result: { targetId: hostTab } } = await send('Target.createTarget', { url: 'about:blank#host' });

// set up the room with Playwright attached to that tab
const hostBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const A = hostBrowser.contexts()[0].pages().find((p) => p.url() === 'about:blank#host');
await A.addInitScript(muted);
await A.goto(base + q);
const b = await chromium.launch();
const ctxB = await b.newContext(); await ctxB.addInitScript(muted);
const B = await ctxB.newPage();
const errs = [];
B.on('pageerror', (e) => errs.push(`guest: ${e.message}`));
await B.goto(base + q);
await A.click('text=Online multiplayer'); await A.fill('#mp-name', 'Alice'); await A.click('button:has-text("Create room")');
await A.waitForSelector('.lobby-code .code');
const code = await A.locator('.lobby-code .code').innerText();
await A.fill('#nation-search', 'poland'); await A.click('.np-row:has-text("Poland")');
await B.click('text=Online multiplayer'); await B.fill('#mp-name', 'Bob'); await B.fill('#mp-code', code); await B.click('button:has-text("Join")');
await B.waitForSelector('text=Connected to Alice', { timeout: 40000 });
console.log('   guest connected via', await B.evaluate(() => window.__wc.net?.info?.()?.via ?? 'n/a'));
await B.fill('#nation-search', 'germany'); await B.click('.np-row:has-text("Germany")');
await A.waitForSelector('.seats li:has-text("Bob"):has-text("Germany")');
await A.click('button:has-text("Start game")');
await A.waitForSelector('.topbar'); await B.waitForSelector('.topbar', { timeout: 40000 });
await A.waitForTimeout(3000);
await A.evaluate(() => { window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); window.__wc.setSpeed(1); });
await A.waitForTimeout(2000);
await hostBrowser.close(); // detach Playwright (the tab stays open) so the tab can really be hidden

// from here on the host tab is driven over a plain DevTools session
const { result: { sessionId: hs } } = await send('Target.attachToTarget', { targetId: hostTab, flatten: true });
const hostEval = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, hs)).result?.result?.value;
await send('Target.createTarget', { url: 'about:blank' }); // the host opens another tab
await sleep(1500);
ok('host tab is in the background', (await hostEval('document.visibilityState')) === 'hidden');
const rate = () => hostEval('new Promise((r) => { let n = 0; const h = setInterval(() => n++, 100); setTimeout(() => { clearInterval(h); r(n); }, 4000); })');
console.log(`   page timer in the hidden host tab: ${await rate()} of 40 ticks (browser throttling)`);
const statuses = new Set();
const days = [];
const t0 = Date.now();
let ordered = false;
while (Date.now() - t0 < hiddenFor) {
  await B.waitForTimeout(5000);
  days.push(await B.evaluate(() => window.__wc.game?.day ?? -1));
  statuses.add(await B.evaluate(() => `${window.__wc.net?.connected() ? 'up' : 'down'} ${window.__wc.net?.status ?? ''}`.trim()));
  if (!ordered && Date.now() - t0 > 20000) { ordered = true; await B.evaluate(() => window.__wc.cmd('setTax', [0.31])); }
}
console.log('   guest day every 5 s while the host tab was hidden:', days.join(' '));
const grew = days.slice(1).filter((d, i) => d > days[i]).length;
ok('the game kept running for the guest', grew >= days.length - 2, `(${grew}/${days.length - 1} samples advanced)`);
ok('the guest stayed connected', [...statuses].every((s) => s === 'up'), [...statuses].join(' | '));
await sleep(3000);
ok('guest order reached the hidden host', await hostEval('window.__wc.game.nations.DEU.taxRate === 0.31'));
// back to the game tab
await send('Target.activateTarget', { targetId: hostTab });
await sleep(1000);
ok('host tab is in front again', (await hostEval('document.visibilityState')) === 'visible');
await hostEval('window.__wc.setSpeed(0)');
let ha = '', hb = '';
for (let i = 0; i < 20; i++) { await sleep(1000); [ha, hb] = [await hostEval('window.__wcHash()'), await B.evaluate(() => window.__wcHash())]; if (ha === hb) break; }
ok(`identical state afterwards (${ha} vs ${hb})`, ha === hb && !String(ha).startsWith('0:'));
const hostErrs = (await hostEval('window.__errs')) ?? [];
ok('no page errors', errs.length + hostErrs.length === 0, [...errs, ...hostErrs].slice(0, 3).join(' | '));
await b.close(); cdp.close(); chrome.kill();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
