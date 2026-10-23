// Two-player end-to-end test over the same-browser transport (two tabs, one browser context).
import { chromium } from 'playwright';
const out = process.env.SHOTS || '/tmp/claude-0/-home-user/8dcb43f4-76f0-504b-8b6a-1730a5403a56/scratchpad';
const url = (process.argv[2] || 'http://localhost:5173/') + (process.argv[3] || '?transport=local');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 860 } });
const A = await ctx.newPage(), B = await ctx.newPage();
const errs = [];
for (const [n, p] of [['A', A], ['B', B]]) { p.on('pageerror', (e) => errs.push(`${n}: ${e.message}`)); p.on('console', (m) => m.type() === 'error' && errs.push(`${n}: ${m.text()}`)); }
let fails = 0;
const ok = (name, c) => { console.log(c ? 'ok  ' : 'FAIL', name); if (!c) fails++; };
const hash = (p) => p.evaluate(() => window.__wcHash());

await A.goto(url); await B.goto(url);
// host
await A.click('text=Online multiplayer');
await A.fill('#mp-name', 'Alice');
await A.click('button:has-text("Create room")');
await A.waitForSelector('.lobby-code .code');
const code = await A.locator('.lobby-code .code').innerText();
await A.fill('#nation-search', 'poland'); await A.click('.np-row:has-text("Poland")');
// guest
await B.click('text=Online multiplayer');
await B.fill('#mp-name', 'Bob');
await B.fill('#mp-code', code);
await B.click('button:has-text("Join")');
await B.waitForSelector('text=Connected to Alice', { timeout: 40000 });
{
  const via = await B.evaluate(() => window.__wc.net?.info?.()?.via ?? 'n/a');
  console.log('   guest connected via', via);
  if (process.env.EXPECT_VIA) ok(`connected via ${process.env.EXPECT_VIA}`, via === process.env.EXPECT_VIA);
}
await B.fill('#nation-search', 'poland');
ok('guest cannot pick the host\'s nation', await B.locator('.np-row:has-text("Poland")').isDisabled());
await B.fill('#nation-search', 'germany'); await B.click('.np-row:has-text("Germany")');
await A.waitForSelector('.seats li:has-text("Bob"):has-text("Germany")');
await A.screenshot({ path: out + '/mp-lobby.png' });
await A.click('button:has-text("Start game")');
await A.waitForSelector('.topbar'); await B.waitForSelector('.topbar', { timeout: 30000 });
ok('host plays Poland', (await A.locator('.tb-name').innerText()).toLowerCase().includes('poland'));
ok('guest plays Germany', (await B.locator('.tb-name').innerText()).toLowerCase().includes('germany'));
ok('both nations human', await A.evaluate(() => window.__wc.game.players.join(',')) === 'POL,DEU');
// play: host runs the clock fast
await A.waitForTimeout(3500); // snapshot transfer pause
await A.evaluate(() => window.__wc.setSpeed(3));
await A.waitForTimeout(4000);
// guest gives orders while time runs
await B.evaluate(() => { const g = window.__wc.game; window.__wc.cmd('doRecruit', ['infantry', g.nations.DEU.capital]); window.__wc.cmd('setTax', [0.3]); });
await A.waitForTimeout(1500);
ok('guest order executed on host', await A.evaluate(() => window.__wc.game.nations.DEU.taxRate === 0.3 && window.__wc.game.nations.DEU.training.length > 0));
// guest pauses for everyone
await B.click('.speeds button >> nth=0');
await A.waitForTimeout(1200);
ok('guest pause stops the host clock', await A.evaluate(() => window.__wc.ui.speed === 0));
await A.waitForTimeout(800);
const [ha, hb] = [await hash(A), await hash(B)];
ok(`identical state after play (${ha} vs ${hb})`, ha === hb && !ha.startsWith('0:'));
// human-to-human diplomacy
await A.evaluate(() => window.__wc.cmd('doTreaty', ['DEU', 'trade']));
await B.waitForTimeout(1500);
await B.click('.nav-btn:has-text("Diplomacy")'); await B.click('.tab:has-text("Proposals")');
await B.click('.offer:has-text("Poland"):has-text("trade") button:has-text("Accept")');
for (let i = 0; i < 20 && !(await A.evaluate(() => !!window.__wc.game.relations['DEU|POL']?.trade)); i++) await A.waitForTimeout(250);
ok('trade treaty between the two players', await A.evaluate(() => !!window.__wc.game.relations['DEU|POL']?.trade));
await B.screenshot({ path: out + '/mp-guest.png' });
// guest reconnects over a lossy link (20% of messages dropped)
await B.goto(url + '&netdrop=0.2');
await A.waitForTimeout(3500);
await B.click('text=Online multiplayer'); await B.fill('#mp-name', 'Bob'); await B.fill('#mp-code', code); await B.click('button:has-text("Join")');
await B.waitForSelector('text=Connected to Alice');
await B.fill('#nation-search', 'germany'); await B.click('.np-row:has-text("Germany")');
for (let i = 0; i < 15 && !(await B.$('.topbar')); i++) { await B.waitForTimeout(3000); console.log('   rejoin:', await B.evaluate(() => { const s = window.__wc.net; return s ? JSON.stringify({ phase: s.phase, nation: s.nation, loading: s.loading, status: s.status, host: s.hostPeer, seats: s.seats.map(x => x.name + ':' + x.nation + ':' + x.phase) }) : 'no session'; }), '| host:', await A.evaluate(() => { const s = window.__wc.net; return JSON.stringify({ seats: s.seats.map(x => x.name + ':' + x.nation), speed: window.__wc.ui.speed }); })); }
await B.waitForSelector('.topbar', { timeout: 5000 });
ok('guest rejoined as Germany', (await B.locator('.tb-name').innerText()).toLowerCase().includes('germany'));
await A.waitForTimeout(4000);
await A.evaluate(() => window.__wc.setSpeed(3));
await A.waitForTimeout(6000);
await A.evaluate(() => window.__wc.setSpeed(0));
await A.waitForTimeout(7000); // allow resends to catch up
const [h2a, h2b] = [await hash(A), await hash(B)];
ok(`identical state after lossy play (${h2a} vs ${h2b})`, h2a === h2b);
await A.screenshot({ path: out + '/mp-host.png' });
console.log(fails ? `${fails} FAILED` : 'ALL PASSED', errs.length ? '\nERRORS:\n' + errs.join('\n') : '');
await b.close();
process.exit(fails ? 1 : 0);
