// A naval invasion the way a player orders one: China selects two armies, right-clicks Taipei,
// reads the briefing and confirms; the armies march to a port, sail together and land. Also gives
// an air wing a mission from the map and opens the Military panel's Air force tab.
//   node tests/e2e/invasion.mjs [url] [screenshot dir]
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5173/';
const out = process.argv[3] || '.';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
let failed = 0;
const ok = (name, c) => { console.log(c ? 'ok  ' : 'FAIL', name); if (!c) failed++; };
const game = (fn, arg) => page.evaluate(fn, arg);

await page.goto(url);
await page.click('text=Sandbox: Any Nation');
await page.fill('#nation-search', 'china');
await page.click('.np-row:has-text("China")');
await page.click('button:has-text("Play as China")');
await page.waitForSelector('.topbar');
await page.keyboard.press('Escape');
const war = await game(() => window.__wc.cmd('doDeclareWar', ['TWN']));
ok('war declared on Taiwan', war?.ok);
const ids = await game(() => {
  const g = window.__wc.game;
  const taipei = g.provinces.find((p) => p.owner === 'TWN' && window.__wc.game && p.controller === 'TWN');
  const fz = Object.values(g.armies).filter((a) => a.owner === 'CHN').sort((a, b) => b.units.length - a.units.length);
  return { taipei: taipei.id, armies: [fz[0].id, fz[1].id] };
});
// select two armies and right-click Taiwan
await game((x) => window.__wc.setUI({ selectedArmy: x.armies[0], group: [x.armies[1]] }), ids);
await page.evaluate((p) => window.dispatchEvent(new CustomEvent('wc-focus', { detail: p })), ids.taipei);
await page.waitForTimeout(700);
const box = await page.locator(`path[data-p="${ids.taipei}"]`).boundingBox();
ok('Taipei on screen', !!box);
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
await page.waitForTimeout(400);
const dialog = page.locator('.modal, .confirm, [role="dialog"]').filter({ hasText: 'Naval invasion' }).first();
ok('invasion briefing shown', await dialog.isVisible());
const text = (await dialog.innerText()).replace(/\n+/g, ' | ');
console.log('     ', text.slice(0, 400));
ok('briefing covers transport, defenders, sea and air', /Transport/.test(text) && /Defenders|undefended/.test(text) && /fleet|navy|waters/i.test(text) && /air wing/i.test(text));
await page.screenshot({ path: `${out}/inv-briefing.png` });
// "Send the navy, then invade": the warships sail for the landing waters with the same click
const navyBtn = dialog.locator('button').filter({ hasText: /Send the navy/ });
ok('briefing offers to send the navy', (await navyBtn.count()) === 1);
const fleetsBefore = await game(() => Object.values(window.__wc.game.fleets).filter((f) => f.owner === 'CHN').map((f) => f.path.length));
await navyBtn.click();
await page.waitForTimeout(300);
const fleetsAfter = await game(() => Object.values(window.__wc.game.fleets).filter((f) => f.owner === 'CHN').map((f) => f.path.length));
ok(`the fleets sail (${fleetsAfter.filter((x) => x > 0).length} of ${fleetsAfter.length} under way)`, fleetsAfter.some((x, i) => x > 0 && !fleetsBefore[i]));
const orders = await game((x) => x.armies.map((id) => { const a = window.__wc.game.armies[id]; return { seaDest: a.seaDest, sailDay: a.sailDay, path: a.path.length }; }), ids);
ok('both armies have the invasion order', orders.every((o) => o.seaDest === ids.taipei) && orders[0].sailDay === orders[1].sailDay);
// run the clock until they sail
await game(() => window.__wc.setSpeed(3));
const sailed = await page.waitForFunction((x) => x.armies.every((id) => { const a = window.__wc.game.armies[id]; return !a || a.embarked || a.battleId != null || a.location === x.taipei; }), ids, { timeout: 90000 }).then(() => true, () => false);
await game(() => window.__wc.setSpeed(0));
ok('the group sailed', sailed);
await page.screenshot({ path: `${out}/inv-at-sea.png` });

// an air wing: select it on the map, order a bombing raid by right-clicking an enemy province
await page.keyboard.press('Escape');
const wing = await game(() => { const g = window.__wc.game; const w = Object.values(g.airWings).find((x) => x.owner === 'CHN' && x.units.some((u) => u.type === 'bomber')); return w && { id: w.id, base: w.base }; });
ok('China has a bomber wing', !!wing);
if (wing) {
  await game((w) => window.__wc.setUI({ selectedWing: w.id, selectedArmy: null, group: [] }), wing);
  await page.waitForTimeout(300);
  ok('air wing panel open', await page.isVisible('.side-panel:has-text("Mission")'));
  const kaohsiung = await game(() => window.__wc.game.provinces.find((p) => p.owner === 'TWN' && p.controller === 'TWN')?.id);
  await page.evaluate((p) => window.dispatchEvent(new CustomEvent('wc-focus', { detail: p })), kaohsiung);
  await page.waitForTimeout(700);
  const kb = await page.locator(`path[data-p="${kaohsiung}"]`).boundingBox();
  await page.mouse.click(kb.x + kb.width / 2, kb.y + kb.height / 2, { button: 'right' });
  await page.waitForTimeout(300);
  const m = await game((w) => { const x = window.__wc.game.airWings[w.id]; return { mission: x.mission, target: x.target }; }, wing);
  ok(`right-click gives the wing a mission (${m.mission})`, m.mission === 'bombing' || m.mission === 'support');
  await page.screenshot({ path: `${out}/inv-wing.png` });
}
// the Air force tab
await page.keyboard.press('Escape');
await page.click('.nav-btn:has-text("Military")');
await page.click('.tabs >> text=/Air force/');
ok('Air force tab lists wings', (await page.locator('.army-row:has-text("Air Wing")').count()) > 0);
console.log(errs.length ? 'ERRORS ' + errs.slice(0, 5).join(' | ') : 'no errors');
await b.close();
process.exit(failed || errs.length ? 1 : 0);
