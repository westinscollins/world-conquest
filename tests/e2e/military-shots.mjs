// Screenshots of the map pieces (armies, fleets, air wings) in a China–Taiwan setting.
//   node tests/e2e/military-shots.mjs [url] [out dir]
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5173/';
const out = process.argv[3] || '.';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.goto(url);
await page.click('text=Sandbox: Any Nation');
await page.fill('#nation-search', 'china');
await page.click('.np-row:has-text("China")');
await page.click('button:has-text("Play as China")');
await page.waitForSelector('.topbar');
await page.waitForTimeout(1500);
await page.keyboard.press('Escape');
// focus on the Taiwan Strait and zoom in
await page.evaluate(() => window.dispatchEvent(new CustomEvent('wc-focus', { detail: window.__wc.game.nations.TWN.capital })));
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/mil-taiwan.png` });
// zoom in a step
await page.mouse.move(750, 450);
for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(150); }
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/mil-taiwan-zoom.png` });
// select an air wing
const visible = async (sel) => { for (const el of await page.$$(sel)) { const bb = await el.boundingBox(); if (bb && bb.x > 80 && bb.y > 60 && bb.x < 1100 && bb.y < 640) return el; } return null; };
await page.screenshot({ path: `${out}/mil-zoom2.png` });
for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(150); }
await page.waitForTimeout(500);
const wing = await visible('.wing.mine');
if (wing) { await wing.click(); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/mil-wing.png` }); } else console.log('no wing on screen');
// select a fleet
await page.keyboard.press('Escape');
const fleet = await visible('.fleet.mine');
if (fleet) { await fleet.click(); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/mil-fleet.png` }); } else console.log('no fleet on screen');
// whole world
await page.keyboard.press('Escape');
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(100); }
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/mil-world.png` });
console.log(errs.length ? errs.slice(0, 5).join('\n') : 'no errors');
await b.close();
