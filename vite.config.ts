import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/** Build id shown in the multiplayer lobby, so players can tell if someone runs an old cached copy. */
function buildId() {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'dev'; }
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __BUILD__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) || buildId()) },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 120000 },
} as never);
