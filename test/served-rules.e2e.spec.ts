import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
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
// Like trackInflightRequests, the tracker is armed before navigation: Chromium keeps a
// linked stylesheet's text only when the CSS domain was enabled before it loaded.

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

async function open(page: Page): Promise<ServedRuleTracker> {
  await page.route('http://reach.test/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/assets/app.css') return route.fulfill({ contentType: 'text/css', body: APP_CSS });
    return route.fulfill({ contentType: 'text/html', body: PAGE });
  });
  await page.setViewportSize({ width: 900, height: 700 });
  const servedRules = await trackServedRules(page);
  await page.goto('http://reach.test/', { waitUntil: 'load' });
  return servedRules;
}

const rule = (map: StyleMap, key: string): ServedRule => {
  const found = map.reach?.rules.find((r) => r.key === key);
  expect(found, `ledger has ${key}`).toBeTruthy();
  return found as ServedRule;
};

test('captureReach records which served rules matched, forced states included', async ({ page }) => {
  const servedRules = await open(page);
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
  const servedRules = await open(page);
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
  const early = await open(page);
  await early.dispose();
  await page.reload({ waitUntil: 'load' });
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
  const servedRules = await open(page); // installs the routes; this test's own tracker is not used
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
    const surface = { key: 'home', go: (p: Page) => p.goto('http://reach.test/', { waitUntil: 'load' }) };
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
  await open(page);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-served-rules-off-'));
  try {
    const outDir = path.join(root, 'out');
    const settings = resolveSettings({ dir: outDir, selfCheck: false, screenshots: false, freezeClock: false });
    expect(settings.captureReach).toBe(false);
    const surface = { key: 'home', go: (p: Page) => p.goto('http://reach.test/', { waitUntil: 'load' }) };
    await captureSurface(page, surface, 900, settings, { index: 1, total: 1 });
    expect(loadStyleMap(path.join(outDir, 'home@900.json.gz')).reach).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
