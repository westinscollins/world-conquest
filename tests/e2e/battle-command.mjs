// The big military update as a player meets it: the chief of staff's briefing, the invasion
// planner (declare war & invade in one go), the battle alert, troops and fighting on the zoomed-in
// map, commanding a battle on the zoomed-in battlefield
// (manoeuvre, support, "fight next day"), the Forces and Build tabs, and submarines.
//   node tests/e2e/battle-command.mjs [url] [screenshot dir]
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:4173/';
const out = process.argv[3] || '.';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 920 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
let failed = 0;
const ok = (name, c) => { console.log(c ? 'ok  ' : 'FAIL', name); if (!c) failed++; };
const game = (fn, arg) => page.evaluate(fn, arg);

await page.goto(url);
await page.click('text=Sandbox: Any Nation');
await page.fill('#nation-search', 'france');
await page.click('.np-row:has-text("France")');
await page.click('button:has-text("Play as France")');
await page.waitForSelector('.topbar');
await page.keyboard.press('Escape');

// 1. Military panel: no War Room any more, a briefing, and neighbours to invade
ok('no War Room button', (await page.locator('.nav-btn:has-text("War Room")').count()) === 0);
await page.click('.nav-btn:has-text("Military")');
ok('chief of staff briefing shown', await page.locator('.briefing').isVisible());
const tabs = await page.locator('.drawer .tab').allInnerTexts();
console.log('      tabs:', tabs.join(' | '));
ok('tabs are Command, Forces, Build, Generals', tabs.length === 4 && /Command/.test(tabs[0]) && /Forces/.test(tabs[1]) && /Build/.test(tabs[2]) && /Generals/.test(tabs[3]));
ok('neighbours listed with Invade buttons', (await page.locator('.target button:has-text("Invade")').count()) > 0);
await page.screenshot({ path: `${out}/mil-command.png` });

// 2. Invasion planner → declare war & invade
await page.locator('.target').filter({ hasText: 'Belgium' }).locator('button').click();
const planner = page.locator('.invade-modal');
ok('invasion planner opens', await planner.isVisible());
const ptext = await planner.innerText();
ok('planner compares both sides', /Soldiers/.test(ptext) && /Belgium/.test(ptext) && /(Easy win|Favourable|Even fight|Risky|Very hard)/.test(ptext));
await page.screenshot({ path: `${out}/mil-planner.png` });
await planner.locator('button:has-text("Declare war & invade")').click();
await page.waitForTimeout(300);
const st = await game(() => {
  const g = window.__wc.game;
  return { war: g.wars.some((w) => w.attackers.includes('FRA') && w.defenders.includes('BEL')), campaign: Object.values(g.armies).filter((a) => a.owner === 'FRA' && a.campaign === 'BEL').length };
});
ok('war declared on Belgium', st.war);
ok(`armies ordered to invade (${st.campaign})`, st.campaign > 0);

// 3. run until France fights a battle, then command it
await game(() => window.__wc.setSpeed(3));
const fought = await page.waitForFunction(() => { const g = window.__wc.game; return g.activeBattles.some((id) => { const x = g.battles[id]; return x && x.result == null && (x.attacker.nation === 'FRA' || x.defender.nation === 'FRA') && x.timeline.length >= 1; }); }, null, { timeout: 120000 }).then(() => true, () => false);
await game(() => window.__wc.setSpeed(0));
ok('a battle starts', fought);
ok('a battle alert offers to command it', await page.locator('.battle-alert button:has-text("Command it")').isVisible());
// zoom in on the battle: the troops of both sides show on the map, and the fighting
const bprov = await game(() => { const g = window.__wc.game; return g.activeBattles.map((id) => g.battles[id]).find((x) => x && x.result == null && (x.attacker.nation === 'FRA' || x.defender.nation === 'FRA')).province; });
await page.evaluate((p) => window.dispatchEvent(new CustomEvent('wc-focus', { detail: p })), bprov);
await page.waitForSelector('.troops.fight', { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(300);
const troops = await page.locator('.troops').count(), fighting = await page.locator('.troops.fight').count();
ok(`zoomed in: troops on the map (${troops}, ${fighting} fighting) and battle effects`, troops > 0 && fighting > 0 && (await page.locator('.mfx').count()) > 0);
ok('zoomed in: terrain drawn', (await page.locator('.terrain-decor path').count()) > 0);
await page.screenshot({ path: `${out}/map-closeup.png` });
await page.click('.nav-btn:has-text("Military")').catch(() => {});
if (!(await page.locator('.drawer').isVisible())) await page.click('.nav-btn:has-text("Military")');
await page.click('.drawer .tab:has-text("Command")');
const cmdBtn = page.locator('.battle-row button:has-text("Command")').first();
ok('battle listed with a Command button', (await cmdBtn.count()) === 1);
await cmdBtn.click();
await page.waitForSelector('.bv');
ok('battle view open', await page.locator('.bv').isVisible());
const units = await page.locator('.bv-unit').count();
ok(`troops drawn on the battlefield (${units})`, units > 2);
const bid = await game(() => window.__wc.ui.battleView);
const before = await game((id) => { const x = window.__wc.game.battles[id]; return { days: x.timeline.length, side: x.attacker.nation === 'FRA' ? 'a' : 'd' }; }, bid);
await page.locator('.bv-tac b:text-is("Flank")').click();
const plan = await game((x) => window.__wc.game.battles[x.bid].cmd[x.side].plan, { bid, side: before.side });
ok('picking Flank sets tomorrow\'s move', plan === 'flank');
const rally = page.locator('.bv-sup:has-text("Rally")');
await rally.click();
ok('rally ordered', await game((x) => window.__wc.game.battles[x.bid].cmd[x.side].queued.includes('rally'), { bid, side: before.side }));
await page.screenshot({ path: `${out}/battle-view.png` });
await page.click('button:has-text("Fight next day")');
await page.waitForTimeout(300);
const after = await game((id) => { const x = window.__wc.game.battles[id]; return { days: x.timeline.length, over: x.result != null, last: x.timeline[x.timeline.length - 1] }; }, bid);
ok(`one day fought (${before.days} → ${after.days})`, after.days === before.days + 1 || after.over);
ok('the day used the ordered manoeuvre and rally', after.last && after.last[before.side === 'a' ? 'aTactic' : 'dTactic'] === 'flank' && (after.last.support ?? []).some((u) => u.kind === 'rally'));
ok('day result banner or outcome shown', (await page.locator('.bv-banner, .bv-over').count()) > 0);
await page.screenshot({ path: `${out}/battle-view-day2.png` });
await page.keyboard.press('Escape');
ok('Esc closes the battle view', (await page.locator('.bv').count()) === 0);

// 4. Forces and Build tabs
await page.click('.nav-btn:has-text("Military")');
await page.click('.drawer .tab:has-text("Forces")');
ok('army roster shows invading armies', (await page.locator('.roster td:has-text("invading")').count()) > 0 || (await page.locator('.roster td:has-text("fighting")').count()) > 0);
await page.click('.drawer .tab:has-text("Build")');
ok('submarines can be built', (await page.locator('.drawer tr:has-text("Submarine Flotilla")').count()) === 1);
await page.screenshot({ path: `${out}/mil-build.png` });
const sub = await game(() => { const g = window.__wc.game; const port = g.provinces.find((p) => p.owner === 'FRA' && p.controller === 'FRA' && p.buildings.port > 0); return window.__wc.cmd('doOrderShip', ['submarine', port.id]); });
ok('ordering a submarine works', sub?.ok);

ok(`no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' / ') : ''}`, errs.length === 0);
await b.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
