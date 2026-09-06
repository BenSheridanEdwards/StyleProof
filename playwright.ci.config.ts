import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config.js';

export default defineConfig({
  ...baseConfig,
  projects: [
    ...(baseConfig.projects ?? []),
    {
      name: 'firefox-unsupported-state',
      testMatch: /cross-element-state\.e2e\.spec\.ts$/,
      grep: /non-Chromium capture persists unsupported forced-state evidence$/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
});
