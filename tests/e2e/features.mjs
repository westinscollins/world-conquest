// Checks the quality-of-life features: move mode, province button, budget advisor, payback estimates, save codes.
import { chromium } from 'playwright';
const out = '/tmp/claude-0/-home-user/8dcb43f4-76f0-504b-8b6a-1730a5403a56/scratchpad';
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1500, height: 880 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const ok = (n, c) => console.log(c ? 'ok  ' : 'FAIL', n);
await page.goto(process.argv[2] || 'http://localhost:5173/');
await page.click('text=Rise from the Balkans'); await page.click('text=Begin campaign'); await page.waitForSelector('.topbar');
// payback estimates in construction
await page.click('.side-panel .tab:has-text("Construction")');
const pb = await page.locator('.build-item:has-text("Power Plant") .bi-cost').innerText();
ok('power plant shows payback: ' + pb.replace(/\n/g, ' '), /pays back/.test(pb));
const farm = await page.locator('.build-item:has-text("Agricultural") .bi-cost').innerText();
ok('farm shows return: ' + farm.replace(/\n/g, ' '), /\/yr/.test(farm));
await page.screenshot({ path: out + '/f-build.png' });
// select army, then Province & construction button
await page.evaluate(() => { const g = window.__wc.game; const a = Object.values(g.armies).find(x => x.owner === g.player); window.__wc.setUI({ selectedArmy: a.id }); });
await page.click('button:has-text("Province & construction")');
ok('province button opens province panel', await page.isVisible('.side-panel .tab:has-text("Construction")'));
// move mode with left click
await page.evaluate(() => { const g = window.__wc.game; const a = Object.values(g.armies).find(x => x.owner === g.player); window.__wc.setUI({ selectedArmy: a.id }); });
await page.click('button:has-text("Move / attack")');
ok('move hint shown', await page.isVisible('.move-hint'));
const pt = await page.evaluate(() => { const g = window.__wc.game; const a = Object.values(g.armies).find(x => x.owner === g.player); const p = g.provinces.find(q => q.owner === g.player && q.id !== a.location); const r = document.querySelector(`path[data-p="${p.id}"]`).getBoundingClientRect(); return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.6 }; });
await page.mouse.click(pt.x, pt.y);
await page.waitForTimeout(200);
ok('left-click move order issued', await page.evaluate(() => Object.values(window.__wc.game.armies).some(a => a.owner === window.__wc.game.player && a.path.length)));
// rename inline
await page.click('.sp-title.editable'); await page.fill('#army-rename', 'Danube Guard'); await page.keyboard.press('Enter');
ok('inline rename', await page.evaluate(() => Object.values(window.__wc.game.armies).some(a => a.name === 'Danube Guard')));
// budget advisor: force a deficit
await page.evaluate(() => window.__wc.act(s => { s.nations[s.player].mobilize = true; s.nations[s.player].mobilization = 1; s.nations[s.player].researchFunding = 8; }));
await page.click('.nav-btn:has-text("Economy")');
ok('advisor appears in deficit', await page.isVisible('.advisor'));
await page.screenshot({ path: out + '/f-advisor.png' });
await page.click('.advisor button:has-text("Demobilise")');
ok('demobilise fix applied', await page.evaluate(() => !window.__wc.game.nations[window.__wc.game.player].mobilize));
// save code round trip
await page.click('.menuwrap .iconbtn'); await page.click('text=Save / Load…');
await page.click('button:has-text("Copy save code")');
const code = await page.inputValue('#save-code-out');
const day = await page.evaluate(() => window.__wc.game.day);
await page.fill('#save-code-in', code); await page.click('button:has-text("Load code")');
await page.waitForTimeout(300);
ok(`save code (${Math.round(code.length / 1024)} KB) loads`, code.startsWith('WC') && (await page.evaluate(() => window.__wc.game.day)) === day);
// smooth running at very fast speed: count redraws
const fps = await page.evaluate(async () => { let n = 0; const un = window.__wc.subscribe(() => n++); window.__wc.setSpeed(3); await new Promise(r => setTimeout(r, 3000)); window.__wc.setSpeed(0); un(); return n / 3; });
ok(`redraws per second at very fast: ${fps.toFixed(1)}`, fps < 15);
console.log(errs.length ? 'ERRORS ' + errs.join(' | ') : 'no errors');
await b.close();
