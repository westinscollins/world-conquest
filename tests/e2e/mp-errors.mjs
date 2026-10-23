// Multiplayer error paths and lobby behaviour: wrong code, the lobby surviving a click outside
// it, invite links, and the network check. Usage: node tests/e2e/mp-errors.mjs <url> '<query>'
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:5173/';
const q = process.argv[3] || '?peerhost=127.0.0.1:9000&relay=ws://127.0.0.1:8090/mqtt';
const b = await chromium.launch();
let fails = 0;
const ok = (name, c, extra = '') => { console.log(c ? 'ok  ' : 'FAIL', name, extra); if (!c) fails++; };

// 1. wrong code: a clear "no open game" message, reasonably fast
{
  const ctx = await b.newContext(); const p = await ctx.newPage();
  await p.goto(base + q);
  await p.click('text=Online multiplayer');
  await p.fill('#mp-name', 'Zed'); await p.fill('#mp-code', 'zzzzzz');
  const t0 = Date.now();
  await p.click('button:has-text("Join")');
  await p.waitForSelector('.error', { timeout: 40000 });
  const msg = await p.locator('.error').innerText();
  ok('wrong code says there is no open game', /No open game/.test(msg), `(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  ok('wrong code answers within 25 s', Date.now() - t0 < 25000);
  await ctx.close();
}
// 2. the host's lobby survives clicks outside it and closing the window; invite links prefill the code
{
  const ctx = await b.newContext(); const A = await ctx.newPage();
  await A.goto(base + q);
  await A.click('text=Online multiplayer');
  await A.fill('#mp-name', 'Host'); await A.click('button:has-text("Create room")');
  await A.waitForSelector('.lobby-code .code');
  const code = await A.locator('.lobby-code .code').innerText();
  await A.mouse.click(5, 5); // the dimmed backdrop
  ok('clicking outside keeps the lobby open', await A.locator('.lobby-code .code').isVisible());
  await A.click('.modal-h .iconbtn');
  ok('closing the window keeps the room', await A.evaluate(() => !!window.__wc.net && window.__wc.net.phase === 'lobby'));
  ok('menu offers a way back', await A.locator(`button:has-text("Return to room ${code}")`).isVisible());
  await A.click(`button:has-text("Return to room ${code}")`);
  ok('same code after reopening', (await A.locator('.lobby-code .code').innerText()) === code);
  // invite link
  const ctx2 = await b.newContext(); const B = await ctx2.newPage();
  await B.goto(`${base}${q}#join=${code}`);
  await B.waitForSelector('#mp-code');
  ok('invite link opens the join box with the code', (await B.inputValue('#mp-code')) === code);
  await B.fill('#mp-name', 'Guest'); await B.click('button:has-text("Join")');
  await B.waitForSelector('text=Connected to Host', { timeout: 40000 });
  ok('guest joined from the invite link', true);
  await A.waitForSelector('.seats li:has-text("Guest")', { timeout: 10000 });
  ok('host sees the guest', true, await A.locator('.lobby').innerText().then((t) => (t.match(/Reachable via:[^\n]*/) ?? [''])[0]));
  // 3. network check
  await B.click('button:has-text("Check my network")');
  await B.waitForSelector('.netcheck p', { timeout: 30000 });
  const verdict = await B.locator('.netcheck p').innerText();
  ok('network check gives a verdict', verdict.length > 10, `"${verdict}"`);
  await ctx.close(); await ctx2.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
