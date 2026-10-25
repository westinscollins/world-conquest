// End-to-end UI walkthrough: menu → campaign → panels → orders → war → battle report → save/load.
import { chromium } from 'playwright';
const out = process.argv[2] || '/tmp/claude-0/-home-user/8dcb43f4-76f0-504b-8b6a-1730a5403a56/scratchpad';
const url = process.argv[3] || 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); errors.push(name); await page.screenshot({ path: out + '/fail-' + name.replace(/\W+/g, '_') + '.png' }).catch(() => {}); } };
const st = (fn) => page.evaluate(fn);
await page.goto(url);
await step('start tutorial', async () => { await page.click('text=Tutorial: The Belgrade Accord'); await page.click('text=Begin campaign'); await page.waitForSelector('.topbar'); });
await step('economy panel', async () => { await page.click('.nav-btn:has-text("Economy")'); await page.waitForSelector('.ledger'); await page.screenshot({ path: out + '/p-economy.png' }); });
await step('government tab', async () => { await page.click('.tab:has-text("Government")'); await page.click('.policy-opts button:has-text("Free market")'); const ok = await st(() => window.__wc.game.nations[window.__wc.game.player].gov.policies.economy === 'market'); if (!ok) throw new Error('policy not set'); await page.click('.tab:has-text("Budget")'); });
await step('industry tab', async () => { await page.click('.tab:has-text("Industry")'); await page.waitForSelector('td:has-text("Armored Brigade")'); });
await step('research', async () => { await page.click('.tab:has-text("Technology")'); await page.click('.tech.avail button:has-text("Research") >> nth=0'); await page.screenshot({ path: out + '/p-research.png' }); });
await step('build road', async () => { await page.click('.nav-btn:has-text("Economy")'); await page.click('.tab:has-text("Construction")'); await page.click('.build-item:has-text("Highway") button:has-text("Build")'); });
await step('recruit', async () => { await page.click('.side-panel .tab:has-text("Recruit")'); await page.click('.build-item:has-text("Infantry Brigade") button:has-text("Recruit")'); });
await step('hire general', async () => { await page.click('.nav-btn:has-text("Military")'); await page.click('.tab:has-text("Generals")'); await page.click('button:has-text("Hire") >> nth=0'); await page.screenshot({ path: out + '/p-military.png' }); });
await step('select army & supply', async () => {
  await page.click('.tab:has-text("Forces")'); await page.click('.drawer table.roster tbody tr >> nth=0'); await page.click('.nav-btn:has-text("Military")');
  await page.click('.side-panel .tab:has-text("Supply")'); await page.screenshot({ path: out + '/p-army.png' });
});
await step('move army by right-click', async () => {
  const pt = await st(() => { const g = window.__wc.game; const a = Object.values(g.armies).find(x => x.owner === g.player); const p = g.provinces.find(q => q.owner === g.player && q.id !== a.location); const el = document.querySelector(`path[data-p="${p.id}"]`); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await page.waitForTimeout(300);
  const moving = await st(() => Object.values(window.__wc.game.armies).some(a => a.owner === window.__wc.game.player && a.path.length));
  if (!moving) throw new Error('army not moving');
});
await step('declare war via diplomacy', async () => {
  await page.click('.nav-btn:has-text("Diplomacy")');
  await page.click('.nation-row:has-text("Bosnia")');
  await page.click('button:has-text("Declare war")');
  await page.click('.modal button:has-text("Confirm")');
  await page.waitForTimeout(200);
  const war = await st(() => window.__wc.game.wars.length > 0);
  if (!war) throw new Error('no war');
});
await step('attack with intel report', async () => {
  await page.click('.drawer-h .iconbtn');
  const pt = await st(() => { const g = window.__wc.game; const a = Object.values(g.armies).filter(x => x.owner === g.player).sort((x,y)=>y.units.length-x.units.length)[0]; window.__wc.setUI({ selectedArmy: a.id }); a.path = []; const t = g.provinces.find(q => q.owner === 'BIH'); const el = document.querySelector(`path[data-p="${t.id}"]`); el.scrollIntoView?.(); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: t.id }; });
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('wc-focus', { detail: id })), pt.id);
  await page.waitForTimeout(300);
  const p2 = await st(() => { const t = window.__wc.game.provinces.find(q => q.owner === 'BIH'); const r = document.querySelector(`path[data-p="${t.id}"]`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(p2.x, p2.y, { button: 'right' });
  await page.waitForTimeout(400);
  if (await page.$('.intel')) { await page.screenshot({ path: out + '/p-intel.png' }); await page.click('button:has-text("Launch attack")'); }
  else console.log('     (no defenders: plain move)');
});
await step('run time very fast', async () => { await page.click('.speeds button >> nth=3'); await page.waitForTimeout(9000); await page.click('.speeds button >> nth=0'); await page.screenshot({ path: out + '/p-war.png' }); });
await step('regime panel', async () => {
  await page.click('.nav-btn:has-text("Regime")');
  await page.click('.tab:has-text("Propaganda")');
  await page.click('.decree:has-text("National pride") button');
  const on = await st(() => window.__wc.game.nations[window.__wc.game.player].regime.propaganda.includes('pride'));
  if (!on) throw new Error('campaign not launched');
  await page.screenshot({ path: out + '/p-regime.png' });
  await page.click('.drawer-h .iconbtn');
});
await step('military roster', async () => {
  await page.click('.nav-btn:has-text("Military")');
  await page.click('.tab:has-text("Forces")');
  await page.fill('.range-in', '1-3');
  await page.click('.roster-select button:has-text("Select")');
  const n = await st(() => (window.__wc.ui.selectedArmy != null ? 1 : 0) + window.__wc.ui.group.length);
  if (n < 1) throw new Error('nothing selected');
  await page.click('.bulk button:has-text("Defend")');
  await page.click('.tab:has-text("Command")');
  await page.click('.drawer-h .iconbtn');
});
await step('military command', async () => {
  await page.click('.nav-btn:has-text("Military")');
  try {
    await page.waitForSelector('.orders');
    await page.screenshot({ path: out + '/p-warroom.png' });
    await page.click('.tab:has-text("Build")');
    await page.click('.arsenal button:has-text("Buy 5") >> nth=1');
    const drones = await st(() => window.__wc.game.nations[window.__wc.game.player].arsenal.drone);
    if (drones < 5) throw new Error('drones not bought');
    await page.click('.tab:has-text("Command")');
    await page.click('.orders button:has-text("Defend")');
    const ok = await st(() => Object.values(window.__wc.game.armies).filter(a => a.owner === window.__wc.game.player).every(a => a.stance === 'defend'));
    if (!ok) throw new Error('orders not applied');
  } finally { await page.click('.drawer-h .iconbtn'); }
});
await step('battle report', async () => {
  const id = await st(() => { const g = window.__wc.game; const b = Object.values(g.battles).find(b => b.attacker.nation === g.player || b.defender.nation === g.player) || Object.values(g.battles)[0]; return b?.id; });
  if (!id) throw new Error('no battle yet');
  await st(`window.__wc.setUI({ battleReport: ${id} })`);
  await page.waitForSelector('.battle-modal');
  await page.screenshot({ path: out + '/p-battle.png' });
  await page.click('.modal-h .iconbtn');
});
await step('map modes', async () => { for (const m of ['Supply', 'Terrain', 'Diplomacy']) { await page.click(`.mm:has-text("${m}")`); await page.waitForTimeout(200); await page.screenshot({ path: out + `/m-${m}.png` }); } await page.click('.mm:has-text("Political")'); });
await step('quick save', async () => { await page.click('.menuwrap .iconbtn'); await page.click('text=Quick save'); await page.waitForTimeout(800); });
const dayBefore = await st(() => window.__wc.game.day);
await step('reload & continue', async () => { await page.reload(); await page.waitForSelector('text=Continue last game'); await page.click('text=Continue last game'); await page.waitForSelector('.topbar'); const d = await st(() => window.__wc.game.day); if (Math.abs(d - dayBefore) > 0) throw new Error(`day ${d} vs ${dayBefore}`); });
const perf = await st(async () => { try { const g = window.__wc.game; const { tick } = await import('/src/engine/sim.ts'); const t = performance.now(); for (let i = 0; i < 60; i++) tick(g); return (performance.now() - t) / 60; } catch { return -1; } });
console.log('ms/day in browser:', perf.toFixed(2));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors');
await browser.close();
