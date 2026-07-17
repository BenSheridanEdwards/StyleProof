import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The tool's own e2e: a self-contained smoke test (test/smoke.e2e.spec.ts)
// that drives the browser capture path against a file:// HTML fixture — no
// live server needed. The reference example/ spec is for consumers and is not
// run here (it needs a production build of the consuming site).
export default defineConfig({
  testDir: '.',
  testMatch: ['test/**/*.e2e.spec.ts'],
  // Agent worktrees nest a second checkout under .claude/; its copy of the spec
  // matches testMatch too and would double every run. Don't collect it — but
  // anchor the ignore to THIS config's directory: a path-wide '**/.claude/**'
  // also matches every spec when the suite itself runs from inside a worktree
  // (cwd like .claude/worktrees/<name>/), collecting 0 tests there.
  // Regression-tested by test/playwright-config.test.mjs.
  testIgnore: [new RegExp('^' + escapeRegExp(path.join(configDir, '.claude') + path.sep))],
  timeout: 120_000,
  // CI runners are dedicated to this suite — use every core (default is 50%).
  // Local stays at the default so a dev machine remains usable during a run.
  workers: process.env.CI ? '100%' : undefined,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
