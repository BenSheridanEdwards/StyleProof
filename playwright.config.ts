import { defineConfig, devices } from '@playwright/test';

// Config for the example capture spec. Point BASE_URL at the site to capture
// (a production build — dev servers inject their own styles).
export default defineConfig({
  testDir: './example',
  timeout: 120_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
