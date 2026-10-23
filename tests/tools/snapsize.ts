import { newGame } from '../../src/engine/setup';
import { runDays } from '../../src/engine/sim';
import { gzipSync } from 'node:zlib';
const s = newGame('sandbox', { seed: 2, nation: 'POL' });
for (const d of [0, 365, 1500]) {
  if (d) runDays(s, d - s.day);
  const full = JSON.stringify(s);
  const trimmed = JSON.stringify({ ...s, battles: Object.fromEntries(Object.entries(s.battles).filter(([, b]) => b.result == null || s.day - b.startDay < 60)), events: s.events.slice(-80) });
  console.log('day', s.day, 'json', (full.length/1024).toFixed(0), 'KB gzip', (gzipSync(full).length/1024).toFixed(0), 'KB trimmed gzip b64', (gzipSync(trimmed).length*4/3/1024).toFixed(0), 'KB');
}
