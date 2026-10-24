// Map pieces sit on their province's land, not out at sea: for several coastal and island nations,
// check every own army counter and air wing against its province's outline (the browser's own SVG geometry).
//   node tests/e2e/pieces-on-land.mjs [url] [screenshot dir]
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5173/';
const out = process.argv[3] || '';
const NATIONS = ['Japan', 'United Kingdom', 'Indonesia', 'Philippines', 'Greece', 'Chile', 'Norway', 'China'];
const b = await chromium.launch();
let failed = 0;
for (const name of NATIONS) {
  const page = await b.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url);
  await page.click('text=Sandbox: Any Nation');
  await page.fill('#nation-search', name);
  await page.click(`.np-row:has-text("${name}")`);
  await page.click(`button:has-text("Play as ${name}")`);
  await page.waitForSelector('.topbar');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wc-focus', { detail: window.__wc.game.nations[window.__wc.game.player].capital })));
  await page.waitForTimeout(700);
  const res = [];
  for (const zoom of [0, 2]) {
    if (zoom) { await page.mouse.move(750, 420); for (let i = 0; i < zoom; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(150); } await page.waitForTimeout(600); }
    res.push(await page.evaluate(() => {
      let n = 0, centre = 0, whole = 0;
      const g = window.__wc.game;
      const pieces = [...document.querySelectorAll('g.army.mine[data-loc]'), ...document.querySelectorAll('g.wing.mine[data-wing]')];
      for (const el of pieces) {
        const m = /translate\(([-\d.e]+),([-\d.e]+)\)/.exec(el.getAttribute('transform') || '');
        const loc = el.hasAttribute('data-loc') ? el.getAttribute('data-loc') : g.airWings[+el.getAttribute('data-wing')]?.base;
        const prov = document.querySelector(`path[data-p="${loc}"]`);
        const tok = el.querySelector('.tok');
        if (!m || !prov || !tok) continue;
        const r = tok.tagName === 'circle' ? +tok.getAttribute('r') : 0;
        const x = +m[1], y = +m[2], w = r ? 2 * r : +tok.getAttribute('width'), h = r ? 2 * r : +tok.getAttribute('height');
        const on = (dx, dy) => prov.isPointInFill(new DOMPoint(x + dx, y + dy));
        n++;
        if (on(0, 0)) centre++;
        if (on(0, 0) && on(-w / 2, -h / 2) && on(w / 2, -h / 2) && on(-w / 2, h / 2) && on(w / 2, h / 2)) whole++;
      }
      return { n, centre, whole };
    }));
    if (out) await page.screenshot({ path: `${out}/land-${name.replace(/\s/g, '')}-${zoom}.png` });
  }
  for (const [i, r] of res.entries()) {
    // (zoomed out, a small island can be smaller than its pieces: most, not all, must sit on land)
    const ok = r.n === 0 || r.centre / r.n >= (i ? 0.95 : 0.8);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${i ? 'zoomed in' : 'start view'}): ${r.centre}/${r.n} pieces (armies and jets) centred on land, ${r.whole}/${r.n} wholly on land`);
  }
  if (errs.length) { failed++; console.log('ERRORS', errs.slice(0, 3).join(' | ')); }
  await page.close();
}
await b.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
