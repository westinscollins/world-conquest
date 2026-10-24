import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/** Build id shown in the multiplayer lobby, so players can tell if someone runs an old cached copy. */
function buildId() {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'dev'; }
}

const BUILD = process.env.GITHUB_SHA?.slice(0, 7) || buildId();

export default defineConfig({
  base: './',
  plugins: [react(), {
    // version.json tells an old copy of the page (still in a browser's cache) that a newer build is out
    name: 'version-file',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) }); },
  }],
  define: { __BUILD__: JSON.stringify(BUILD) },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 120000 },
} as never);
