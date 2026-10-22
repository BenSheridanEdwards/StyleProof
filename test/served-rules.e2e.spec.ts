import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  captureStyleMap,
  diffStyleMaps,
  trackServedRules,
  type ServedRule,
  type ServedRuleTracker,
  type StyleMap,
} from '../dist/index.js';
import { loadStyleMap } from '../dist/capture.js';
import { captureSurface } from '../dist/runner/surface-capture.js';
import { resolveSettings } from '../dist/runner/settings.js';

// Change Reach ledger (#991): with `captureReach`, a capture records every served CSS
// rule and whether it matched an element while the map was read, through Chromium's
// rule usage tracking. Off by default, and it never changes what the diff compares.
// Like trackInflightRequests, the tracker is armed before navigation to record linked
// stylesheets as they load, without relying on Chromium's inspector re-fetches.

const PAGE = `<!doctype html><html><head>
  <link rel="stylesheet" href="/assets/app.css?v=3">
  <style>
    .inline-used { color: rgb(1, 2, 3); }
    .inline-unused { color: rgb(4, 5, 6); }
  </style>
</head><body>
  <main>
    <a class="link" href="#docs">Docs</a>
    <span class="badge">ok</span>
    <p class="inline-used">inline</p>
  </main>
  <script>
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.constructed-used { color: rgb(7, 8, 9); } .constructed-unused { color: rgb(9, 8, 7); }');
    document.adoptedStyleSheets = [sheet];
    const p = document.createElement('p');
    p.className = 'constructed-used';
    p.textContent = 'constructed';
    document.querySelector('main').append(p);
  </script>
</body></html>`;

const APP_CSS = `
:root { --warn: rgb(245, 158, 11); }
.link { color: rgb(37, 99, 235); }
.link:hover { color: rgb(124, 58, 237); }
.badge { color: var(--warn); animation: pulse 2s paused; }
.panel--fault .indicator { color: rgb(245, 158, 11); }
@media (min-width: 1440px) { .badge { padding: 20px; } }
@media (prefers-color-scheme: dark) { .badge { background: rgb(17, 24, 39); } }
@keyframes pulse { to { opacity: 0.5; } }`;

async function serve() {
  let sheetAvailable = true;
  const server = http.createServer((req, res) => {
    const css = new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/assets/app.css';
    res.writeHead(css && !sheetAvailable ? 404 : 200, {
      'content-type': css ? 'text/css' : 'text/html',
      'cache-control': 'no-store',
    });
    res.end(css ? (sheetAvailable ? APP_CSS : '') : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    dropSheet: () => {
      sheetAvailable = false;
    },
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

let site: Awaited<ReturnType<typeof serve>>;

test.beforeEach(async () => {
  site = await serve();
});

test.afterEach(() => {
  site.close();
});

async function open(page: Page, url: string): Promise<ServedRuleTracker> {
  await page.setViewportSize({ width: 900, height: 700 });
  const servedRules = await trackServedRules(page);
  await page.goto(url, { waitUntil: 'load' });
  return servedRules;
}

const rule = (map: StyleMap, key: string): ServedRule => {
  const found = map.reach?.rules.find((r) => r.key === key);
  expect(found, `ledger has ${key}`).toBeTruthy();
  return found as ServedRule;
};

test('captureReach records which served rules matched, forced states included', async ({ page }) => {
  const servedRules = await open(page, site.url);
  const map = await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules });

  // Matched at rest, matched only under the forced :hover, and never matched.
  expect(rule(map, '.link').used).toBe(true);
  expect(rule(map, '.link:hover').used).toBe(true);
  expect(rule(map, '.panel--fault .indicator').used).toBeUndefined();
  // A media query the capture's viewport and colour scheme never satisfy.
  expect(rule(map, '@media (min-width: 1440px) > .badge').used).toBeUndefined();
  expect(rule(map, '@media (prefers-color-scheme: dark) > .badge').used).toBeUndefined();
  // Rule usage never reports @keyframes; the referencing rule carries its name instead.
  expect(rule(map, '@keyframes pulse').used).toBeUndefined();
  expect(rule(map, '.badge').refs).toContain('pulse');
  expect(rule(map, '.badge').uses).toEqual(['--warn']);
  expect(Object.keys(rule(map, ':root').vars ?? {})).toEqual(['--warn']);

  // Inline <style> and a constructed stylesheet both enter the ledger.
  expect(rule(map, '.inline-used').used).toBe(true);
  expect(rule(map, '.inline-unused').used).toBeUndefined();
  expect(rule(map, '.constructed-used').used).toBe(true);
  expect(rule(map, '.constructed-unused').used).toBeUndefined();

  // Sheet labels drop the origin and query; StyleProof's own freeze sheet stays out.
  const sheets = map.reach?.sheets ?? [];
  expect(sheets).toEqual(expect.arrayContaining(['/assets/app.css', 'inline', 'constructed']));
  expect(map.reach?.rules.some((r) => r.key.startsWith('*,*::before'))).toBe(false);
  expect(map.reach?.unreadable).toBeUndefined();
});

test('the ledger is stable across captures and never changes the diff', async ({ page }) => {
  const servedRules = await open(page, site.url);
  const first = await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules });
  await page.reload({ waitUntil: 'load' });
  const again = await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules });
  expect(again.reach).toEqual(first.reach);

  await page.reload({ waitUntil: 'load' });
  const plain = await captureStyleMap(page, { stabilize: false });
  expect(plain.reach).toBeUndefined();
  expect(diffStyleMaps(plain, first)).toEqual([]);
  expect(diffStyleMaps(first, plain)).toEqual([]);
});

test('a tracker armed after load counts linked stylesheets unreadable instead of dropping them', async ({ page }) => {
  const early = await open(page, site.url);
  await early.dispose();
  await page.reload({ waitUntil: 'load' });
  // The late tracker's re-fetch must fail so the sheet is genuinely unreadable.
  site.dropSheet();
  // No caller-armed tracker: captureReach arms one now, after app.css has loaded.
  const map = await captureStyleMap(page, { stabilize: false, captureReach: true });
  expect(map.reach?.unreadable).toBe(1);
  expect(map.reach?.sheets).not.toContain('/assets/app.css');
  expect(rule(map, '.inline-used').used).toBe(true);
  expect(rule(map, '.constructed-used').used).toBe(true);
});

test('defineStyleMapCapture surfaces arm the tracker before go(), so the linked stylesheet is read', async ({
  page,
}) => {
  const servedRules = await open(page, site.url); // this test's own tracker is not used
  await servedRules.dispose();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-served-rules-'));
  try {
    const outDir = path.join(root, 'out');
    // selfCheck re-runs go() and captures again on the same tracker.
    const settings = resolveSettings({
      dir: outDir,
      captureReach: true,
      selfCheck: true,
      screenshots: false,
      freezeClock: false,
    });
    const surface = { key: 'home', go: (p: Page) => p.goto(site.url, { waitUntil: 'load' }) };
    await captureSurface(page, surface, 900, settings, { index: 1, total: 1 });
    const map = loadStyleMap(path.join(outDir, 'home@900.json.gz'));
    expect(map.reach?.unreadable).toBeUndefined();
    expect(map.reach?.sheets).toContain('/assets/app.css');
    expect(rule(map, '.link:hover').used).toBe(true);
    expect(rule(map, '.panel--fault .indicator').used).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureReach stays off unless asked for', async ({ page }) => {
  await open(page, site.url);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-served-rules-off-'));
  try {
    const outDir = path.join(root, 'out');
    const settings = resolveSettings({ dir: outDir, selfCheck: false, screenshots: false, freezeClock: false });
    expect(settings.captureReach).toBe(false);
    const surface = { key: 'home', go: (p: Page) => p.goto(site.url, { waitUntil: 'load' }) };
    await captureSurface(page, surface, 900, settings, { index: 1, total: 1 });
    expect(loadStyleMap(path.join(outDir, 'home@900.json.gz')).reach).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
