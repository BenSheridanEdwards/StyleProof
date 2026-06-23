import { defineConfig, devices } from '@playwright/test';

// The tool's own e2e: a self-contained smoke test (test/smoke.e2e.spec.ts)
// that drives the browser capture path against a file:// HTML fixture — no
// live server needed. The reference example/ spec is for consumers and is not
// run here (it needs a production build of the consuming site).
export default defineConfig({
  testDir: '.',
  testMatch: ['test/**/*.e2e.spec.ts'],
  // Agent worktrees nest a second checkout under .claude/; its copy of the spec
  // matches testMatch too and would double every run. Don't collect it.
  testIgnore: ['**/.claude/**'],
  timeout: 120_000,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
