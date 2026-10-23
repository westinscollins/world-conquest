// A running game heals itself after the connection drops: the matchmaking server goes away
// mid-game and comes back; the guest reconnects automatically and both copies match again.
// Needs vite on :5173 and nothing else (this test runs its own PeerJS server).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
const base = process.argv[2] || 'http://localhost:5173/';
const q = '?peerhost=127.0.0.1:9000&relay=none&net=server&netsim=noice';
let fails = 0;
const ok = (n, c, x = '') => { console.log(c ? 'ok  ' : 'FAIL', n, x); if (!c) fails++; };
const killPeer = () => { try { execSync("pkill -f '^node tests/e2e/peer-server.mjs'"); } catch { /* not running */ } };
const startPeer = () => { const p = spawn('node', ['tests/e2e/peer-server.mjs'], { detached: true, stdio: 'ignore' }); p.unref(); };
const hash = (p) => p.evaluate(() => window.__wcHash());
killPeer(); startPeer();
await new Promise((r) => setTimeout(r, 1500));
const b = await chromium.launch();
const A = await (await b.newContext()).newPage(), B = await (await b.newContext()).newPage();
await A.goto(base + q); await B.goto(base + q);
await A.click('text=Online multiplayer'); await A.fill('#mp-name', 'Alice'); await A.click('button:has-text("Create room")');
await A.waitForSelector('.lobby-code .code');
const code = await A.locator('.lobby-code .code').innerText();
await A.fill('#nation-search', 'poland'); await A.click('.np-row:has-text("Poland")');
await B.click('text=Online multiplayer'); await B.fill('#mp-name', 'Bob'); await B.fill('#mp-code', code); await B.click('button:has-text("Join")');
await B.waitForSelector('text=Connected to Alice', { timeout: 40000 });
await B.fill('#nation-search', 'germany'); await B.click('.np-row:has-text("Germany")');
await A.waitForSelector('.seats li:has-text("Bob"):has-text("Germany")');
await A.click('button:has-text("Start game")');
await A.waitForSelector('.topbar'); await B.waitForSelector('.topbar', { timeout: 40000 });
await A.waitForTimeout(4000);
await A.evaluate(() => window.__wc.setSpeed(2)); await A.waitForTimeout(3000);
// outage
killPeer();
await A.waitForTimeout(4000);
startPeer();
// the guest notices, reconnects, and receives the game again; meanwhile time keeps running
const state = () => B.evaluate(() => { const s = window.__wc.net; return { up: !!s && s.connected(), status: s?.status ?? '', phase: s?.phase }; });
let noticed = false, healed = false;
const t0 = Date.now();
for (let i = 0; i < 90 && !healed; i++) {
  await B.waitForTimeout(1000);
  const st = await state();
  if (!noticed && (!st.up || st.status)) { noticed = true; console.log(`   guest noticed after ${((Date.now() - t0) / 1000).toFixed(0)} s: "${st.status}"`); }
  if (noticed && st.up && st.status === '' && st.phase === 'playing') { healed = true; console.log(`   healed after ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
}
ok('guest reconnected by itself', healed, await B.evaluate(() => `status="${window.__wc.net?.status}"`));
await A.evaluate(() => window.__wc.setSpeed(0));
let ha = '', hb = '';
for (let i = 0; i < 20; i++) { await A.waitForTimeout(1000); [ha, hb] = [await hash(A), await hash(B)]; if (ha === hb) { console.log(`   in sync ${i + 1} s after pausing`); break; } }
ok(`identical state after the outage (${ha} vs ${hb})`, ha === hb && !ha.startsWith('0:'));
// orders still work
await B.evaluate(() => window.__wc.cmd('setTax', [0.33]));
await A.waitForTimeout(2500);
ok('guest orders reach the host after reconnecting', await A.evaluate(() => window.__wc.game.nations.DEU.taxRate === 0.33));
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
