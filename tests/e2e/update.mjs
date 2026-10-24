// An old copy of the page loads the newest version by itself, exactly once, and the multiplayer
// window says when a newer version is out. Serves a built site (vite build) whose version.json
// claims a newer build than the page.   node tests/e2e/update.mjs <dist dir>
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const dir = process.argv[2] || 'dist';
const NEW = 'zzz9999';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };
let versionHits = 0;
const server = http.createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/version.json') { versionHits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ build: NEW })); return; }
  try { const f = await readFile(join(dir, path === '/' ? 'index.html' : path)); res.writeHead(200, { 'content-type': types[extname(path)] ?? 'text/html' }); res.end(f); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4319, '127.0.0.1', r));
let fails = 0;
const ok = (n, c, x = '') => { console.log(c ? 'ok  ' : 'FAIL', n, x); if (!c) fails++; };
const b = await chromium.launch();
const p = await b.newPage();
let loads = 0;
p.on('load', () => loads++);
await p.goto('http://127.0.0.1:4319/');
await p.waitForTimeout(4000);
ok('an old copy loads the newest version', p.url().includes(`v=${NEW}`), p.url());
ok('only once (no reload loop)', loads === 2, `${loads} page loads`);
await p.click('text=Online multiplayer');
await p.waitForSelector('#mp-name', { timeout: 10000 });
await p.waitForTimeout(1500);
ok('the multiplayer window stays open', await p.locator('#mp-name').isVisible());
ok('and says a newer version is out', await p.locator(`text=A newer version (${NEW}) is out`).isVisible());
await p.click('.modal-h .iconbtn');
ok('the menu shows the version', /Game version \w+/.test(await p.locator('.menu-version').innerText()));
ok('version checked each time', versionHits >= 2, `${versionHits} checks`);
await b.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
