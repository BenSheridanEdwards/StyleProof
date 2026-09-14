import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Playwright config for the store-dogfood workflow: capture the committed
// example app (example/styleproof.spec.ts over example/demo) through
// styleproof-map so the REAL capture→publish→restore chain can be certified in
// CI. Absolute paths keep it independent of the invoking cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
// STYLEPROOF_DEMO_ROOT lets a caller serve another checkout's example/demo
// (the PR-base worktree) while this file still resolves @playwright/test
// from the clean head install. Unset → committed demo next to this config.
const demoRoot = process.env.STYLEPROOF_DEMO_ROOT ?? path.join(here, 'demo');

export default defineConfig({
  testDir: here,
  testMatch: 'styleproof.spec.ts',
  timeout: 120_000,
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: `node ${JSON.stringify(path.join(here, '..', 'scripts', 'serve-static.mjs'))} ${JSON.stringify(demoRoot)} 4173`,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
