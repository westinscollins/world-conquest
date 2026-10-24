// Disbanding many units at once, through every place the player can do it: all or some formations
// of an army, a whole army, a group selected on the map, ticked armies in the War Room and in the
// Military panel, a whole air wing, a fleet.
//   node tests/e2e/disband.mjs [url]
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5173/';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
let failed = 0;
const ok = (name, c) => { console.log(c ? 'ok  ' : 'FAIL', name); if (!c) failed++; };
const game = (fn, arg) => page.evaluate(fn, arg);
const confirm = async (label) => { await page.locator('.modal button').filter({ hasText: label }).first().click(); await page.waitForTimeout(250); };
const mine = () => game(() => Object.values(window.__wc.game.armies).filter((a) => a.owner === window.__wc.game.player && !a.battleId && !a.embarked).map((a) => ({ id: a.id, n: a.units.length })));

await page.goto(url);
await page.click('text=Sandbox: Any Nation');
await page.fill('#nation-search', 'china');
await page.click('.np-row:has-text("China")');
await page.click('button:has-text("Play as China")');
await page.waitForSelector('.topbar');
await page.keyboard.press('Escape');
const reserve = () => game(() => window.__wc.game.nations[window.__wc.game.player].manpower);

// 1. tick two formations, disband them together
let list = await mine();
let a = list.find((x) => x.n >= 4);
await game((id) => window.__wc.setUI({ selectedArmy: id, group: [] }), a.id);
await page.waitForTimeout(250);
const rows = page.locator('.side-panel table.units tbody tr');
await rows.nth(0).click(); await rows.nth(1).click();
const mp0 = await reserve();
await page.locator('.side-panel button').filter({ hasText: /^Disband 2$/ }).click();
await confirm('Disband');
ok('two ticked formations disbanded together', (await game((id) => window.__wc.game.armies[id]?.units.length, a.id)) === a.n - 2);
ok('their soldiers went back to the reserve', (await reserve()) > mp0);

// 2. tick all with the header box: the whole army goes
await page.locator('.side-panel table.units thead input[type=checkbox]').click();
await page.locator('.side-panel button').filter({ hasText: /^Disband \d+$/ }).click();
await confirm('Disband');
ok('"select all" + Disband dissolves the army', !(await game((id) => !!window.__wc.game.armies[id], a.id)));

// 3. the Disband army button
list = await mine();
a = list[0];
await game((id) => window.__wc.setUI({ selectedArmy: id, group: [] }), a.id);
await page.waitForTimeout(250);
await page.locator('.side-panel button').filter({ hasText: 'Disband army' }).click();
await confirm('Disband');
ok('"Disband army" removes the whole army', !(await game((id) => !!window.__wc.game.armies[id], a.id)));

// 4. several armies selected on the map
list = await mine();
const grp = list.slice(0, 3).map((x) => x.id);
await game((ids) => window.__wc.setUI({ selectedArmy: ids[0], group: ids.slice(1) }), grp);
await page.waitForTimeout(250);
await page.locator('.side-panel a').filter({ hasText: 'Disband all 3' }).click();
await confirm('Disband');
ok('a map selection of 3 armies disbanded at once', (await game((ids) => ids.filter((id) => window.__wc.game.armies[id]).length, grp)) === 0);

// 5. War Room: tick armies in the roster, Disband
await page.keyboard.press('Escape');
await page.click('.nav-btn:has-text("War Room")');
await page.click('.tabs >> text=/^Armies/');
const roster = page.locator('table.roster tbody tr');
const before5 = (await mine()).length;
await roster.nth(0).click(); await roster.nth(1).click();
await page.locator('.bulk button').filter({ hasText: /^Disband$/ }).click();
await confirm('Disband');
ok(`War Room: 2 ticked armies disbanded (${before5} → ${(await mine()).length})`, (await mine()).length === before5 - 2);

// 6. Military panel: tick armies, Disband selected
await page.keyboard.press('Escape');
await page.click('.nav-btn:has-text("Military")');
await page.click('.tabs >> text=/^Armies/');
const before6 = (await mine()).length;
const mrows = page.locator('.panel-body table.tbl tbody tr');
await mrows.nth(0).locator('td').first().click(); await mrows.nth(1).locator('td').first().click(); await mrows.nth(2).locator('td').first().click();
await page.locator('.bulk button').filter({ hasText: 'Disband selected' }).click();
await confirm('Disband');
ok(`Military panel: 3 ticked armies disbanded (${before6} → ${(await mine()).length})`, (await mine()).length === before6 - 3);

// 7. a whole air wing
await page.keyboard.press('Escape');
const wing = await game(() => Object.values(window.__wc.game.airWings).find((w) => w.owner === window.__wc.game.player)?.id);
await game((id) => window.__wc.setUI({ selectedWing: id, selectedArmy: null }), wing);
await page.waitForTimeout(250);
await page.locator('.side-panel button').filter({ hasText: 'Retire the whole wing' }).click();
await confirm('Retire');
ok('a whole air wing retired', !(await game((id) => !!window.__wc.game.airWings[id], wing)));
ok('the side panel falls back to the province', await page.isVisible('.side-panel .tab:has-text("Construction")'));

// 8. a fleet
const fleet = await game(() => Object.values(window.__wc.game.fleets).find((f) => f.owner === window.__wc.game.player)?.id);
await game((id) => window.__wc.setUI({ selectedFleet: id, selectedArmy: null, selectedWing: null }), fleet);
await page.waitForTimeout(250);
await page.locator('.side-panel button').filter({ hasText: 'Decommission fleet' }).click();
await confirm('Confirm');
ok('a fleet decommissioned', !(await game((id) => !!window.__wc.game.fleets[id], fleet)));

console.log(errs.length ? 'ERRORS ' + errs.slice(0, 5).join(' | ') : 'no errors');
await b.close();
console.log(failed || errs.length ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed || errs.length ? 1 : 0);
