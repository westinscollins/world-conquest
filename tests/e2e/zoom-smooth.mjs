// Zoom smoothness: wheel notches in and out over the map, measuring the browser's frame times
// (long frames are visible stutter).   node tests/e2e/zoom-smooth.mjs [url] [nation]
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5173/', nation = process.argv[3] || 'China';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(url);
await page.click('text=Sandbox: Any Nation');
await page.fill('#nation-search', nation);
await page.click(`.np-row:has-text("${nation}")`);
await page.click(`button:has-text("Play as ${nation}")`);
await page.waitForSelector('.topbar');
await page.keyboard.press('Escape');
if (process.env.CSS) await page.addStyleTag({ content: process.env.CSS });
await page.waitForTimeout(800);
await page.mouse.move(700, 420);
await page.evaluate(() => { window.__frames = []; let last = performance.now(); const f = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 100000) requestAnimationFrame(f); }; requestAnimationFrame(f); });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const met = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
const m0 = await met();
const vb0 = await page.evaluate(() => document.querySelector('svg.map, .map svg, svg')?.getAttribute('viewBox'));
for (const dir of [-1, 1, -1]) for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, dir * 100); await page.waitForTimeout(90); }
await page.waitForTimeout(800);
const vb1 = await page.evaluate(() => document.querySelector('svg.map, .map svg, svg')?.getAttribute('viewBox'));
const m1 = await met();
const d = (k) => (m1[k] - m0[k]).toFixed(2);
console.log(`   main thread: task ${d('TaskDuration')}s script ${d('ScriptDuration')}s layout ${d('LayoutDuration')}s style ${d('RecalcStyleDuration')}s (over ${(m1.Timestamp - m0.Timestamp).toFixed(1)}s)`);
const fr = await page.evaluate(() => window.__frames.slice(2));
fr.sort((a, c) => a - c);
const q = (p) => fr[Math.min(fr.length - 1, Math.floor(fr.length * p))].toFixed(0);
console.log(`${url}: ${fr.length} frames · median ${q(0.5)} ms · p90 ${q(0.9)} ms · p99 ${q(0.99)} ms · worst ${fr[fr.length - 1].toFixed(0)} ms · frames over 50 ms: ${fr.filter((x) => x > 50).length} · zoomed ${vb0 !== vb1 ? 'yes' : 'NO'}`);
if (errs.length) console.log('ERRORS', errs.slice(0, 3).join(' | '));
await b.close();
