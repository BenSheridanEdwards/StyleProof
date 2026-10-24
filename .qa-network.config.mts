import { defineConfig } from '@playwright/test';
import original from './playwright.config.ts';
export default defineConfig({ ...original, testDir: '.', testMatch: ['test/served-rules.e2e.spec.ts'], workers: 1, retries: 0, outputDir: "/Users/chief/StyleProof-factory/b-sr/check/round-3/qa/network/head-test-results", use: { launchOptions: { args: ["--host-resolver-rules=MAP *.test ~NOTFOUND", "--disable-background-networking", "--log-net-log=/Users/chief/StyleProof-factory/b-sr/check/round-3/qa/network/head-chromium-netlog.json", "--net-log-capture-mode=Everything"] } } });
