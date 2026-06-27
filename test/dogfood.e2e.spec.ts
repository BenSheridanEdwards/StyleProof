import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureStyleMap,
  defineStyleMapCapture,
  diffStyleMaps,
  detectViewportWidths,
  generateStyleMapReport,
  loadStyleMap,
} from '../dist/index.js';

// Dogfood: StyleProof runs on its OWN example page (example/demo/index.html) in CI —
// proving the capture → detect → diff pipeline end to end on a real, multi-element
// page, not just the unit fixtures. The demo is deterministic (no web fonts, no
// animation, only query-driven JS for pinned live states), so these never flake.
const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = 'file://' + path.join(here, '..', 'example', 'demo', 'index.html');
const LIVE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-dogfood-live-'));
const LIVE_WIDTH = 900;

function liveUrl(state: 'loading' | 'loaded', tone: 'base' | 'head'): string {
  return `${DEMO}?state=${state}&tone=${tone}`;
}

function liveSurface(tone: 'base' | 'head') {
  return {
    key: 'demo-live',
    go: async () => {},
    widths: [LIVE_WIDTH],
    liveStates: [
      {
        key: 'loading',
        go: async (page) => {
          await page.goto(liveUrl('loading', tone), { waitUntil: 'load' });
        },
      },
      {
        key: 'loaded',
        go: async (page) => {
          await page.goto(liveUrl('loaded', tone), { waitUntil: 'load' });
        },
      },
    ],
  };
}

test.describe('dogfood live-state base capture', () => {
  defineStyleMapCapture({
    surfaces: [liveSurface('base')],
    dir: 'dogfood-base',
    baseDir: LIVE_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.describe('dogfood live-state head capture', () => {
  defineStyleMapCapture({
    surfaces: [liveSurface('head')],
    dir: 'dogfood-head',
    baseDir: LIVE_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.afterAll(() => {
  fs.rmSync(LIVE_ROOT, { recursive: true, force: true });
});

test('dogfood: detects the demo real @media breakpoints (auto widths)', async ({ page }) => {
  await page.goto(DEMO, { waitUntil: 'load' });
  // The demo declares exactly @media (min-width: 600px) and (min-width: 900px) →
  // one viewport per band, base band represented by 360.
  expect(await detectViewportWidths(page)).toEqual([360, 600, 900]);
});

test('dogfood: StyleProof certifies its own demo unchanged (deterministic capture)', async ({ page }) => {
  await page.goto(DEMO, { waitUntil: 'load' });
  const a = await captureStyleMap(page);
  await page.goto(DEMO, { waitUntil: 'load' });
  const b = await captureStyleMap(page);
  expect(diffStyleMaps(a, b), 'two captures of the demo are identical').toEqual([]);
});

test('dogfood: StyleProof catches a real restyle of the demo', async ({ page }) => {
  await page.goto(DEMO, { waitUntil: 'load' });
  const before = await captureStyleMap(page);
  await page.goto(DEMO, { waitUntil: 'load' });
  await page.addStyleTag({ content: '.btn { background: rgb(220, 38, 38); }' }); // recolour the CTA
  const after = await captureStyleMap(page);
  const recolour = diffStyleMaps(before, after).find(
    (f) => f.kind === 'style' && f.props.some((p) => p.prop === 'background-color'),
  );
  expect(recolour, 'the CTA background change is caught').toBeTruthy();
});

test('dogfood: liveStates split the demo and report only loaded-to-loaded restyle', () => {
  const beforeDir = path.join(LIVE_ROOT, 'dogfood-base');
  const afterDir = path.join(LIVE_ROOT, 'dogfood-head');
  const outDir = path.join(LIVE_ROOT, 'report');
  const loadingSurface = `demo-live-loading@${LIVE_WIDTH}`;
  const loadedSurface = `demo-live-loaded@${LIVE_WIDTH}`;

  const loadingBefore = loadStyleMap(path.join(beforeDir, `${loadingSurface}.json.gz`));
  const loadingAfter = loadStyleMap(path.join(afterDir, `${loadingSurface}.json.gz`));
  const loadedBefore = loadStyleMap(path.join(beforeDir, `${loadedSurface}.json.gz`));
  const loadedAfter = loadStyleMap(path.join(afterDir, `${loadedSurface}.json.gz`));

  expect(loadingBefore.metadata).toEqual({
    surfaceKey: 'demo-live',
    variantKey: 'loading',
    variantKind: 'live-state',
  });
  expect(loadedBefore.metadata).toEqual({
    surfaceKey: 'demo-live',
    variantKey: 'loaded',
    variantKind: 'live-state',
  });
  expect(loadingBefore.liveCandidates).toContainEqual(
    expect.objectContaining({
      tag: 'section',
      cls: 'status-card loading',
      role: 'status',
      ariaLive: 'polite',
      ariaBusy: 'true',
    }),
  );
  expect(loadingAfter.liveCandidates).toContainEqual(
    expect.objectContaining({
      tag: 'section',
      cls: 'status-card loading',
      role: 'status',
      ariaLive: 'polite',
      ariaBusy: 'true',
    }),
  );
  expect(diffStyleMaps(loadingBefore, loadingAfter), 'loading compares to loading with no diff').toEqual([]);

  const loadedDiff = diffStyleMaps(loadedBefore, loadedAfter);
  expect(
    loadedDiff.some((finding) => finding.kind === 'style' && finding.props.some((p) => p.prop === 'background-color')),
    'loaded compares to loaded and catches the deliberate status-card restyle',
  ).toBe(true);

  const report = generateStyleMapReport({ beforeDir, afterDir, outDir });
  expect(report.changedSurfaces).toBe(1);
  expect(report.totalFindings).toBeGreaterThan(0);

  const md = fs.readFileSync(report.reportMdPath, 'utf8');
  expect(md).toContain('demo-live-loaded @ 900 · live state `loaded`');
  expect(md).not.toContain('demo-live-loading @ 900');
  expect(md).toContain('background');
});
