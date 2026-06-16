import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, loadStyleMap } from '../dist/index.js';
import { diffStyleMaps } from '../dist/index.js';

/** Navigate to inline HTML (no waiting past `load`) and run a callback. */
async function withPage<T>(page: Page, html: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `styleproof-e2e-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, html);
  try {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('file://' + file, { waitUntil: 'load' });
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Smoke e2e for the browser-only capture path. Everything in src/capture.ts
 * that runs via page.evaluate / CDP (capturePage, snapSubtree, pathsForSelector,
 * captureForcedStates) is unreachable from node:test; this is the one place it
 * is exercised end to end against a real Chromium.
 *
 * Run separately from the fast unit suite:
 *   npx playwright install chromium   # one-time
 *   npm run test:e2e
 */

function fixture(buttonColor: string, hoverColor: string): string {
  // A deterministic page: one styled button with a :hover rule, no fonts,
  // no animation, no third-party anything.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; }
    .cta {
      background: ${buttonColor};
      color: rgb(255, 255, 255);
      border: 0;
      padding: 12px 20px;
      font-size: 16px;
    }
    .cta:hover { color: ${hoverColor}; }
  </style></head><body>
    <main><button class="cta">Book a call</button></main>
  </body></html>`;
}

async function captureFixture(page: Page, html: string): Promise<ReturnType<typeof loadStyleMap>> {
  return withPage(page, html, () => captureStyleMap(page));
}

test('captures a real page and reports an identical map as unchanged', async ({ page }) => {
  const html = fixture('rgb(0, 0, 0)', 'rgb(0, 255, 0)');
  const a = await captureFixture(page, html);
  const b = await captureFixture(page, html);
  expect(diffStyleMaps(a, b)).toEqual([]);
});

test('captures colour theme tokens from :root, normalised to rgb', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --red-100: #fee2e2; --space-4: 16px; }
    .x { color: var(--red-100); }
  </style></head><body><span class="x">hi</span></body></html>`;
  const map = await captureFixture(page, html);
  expect(map.tokens?.['--red-100']).toBe('rgb(254, 226, 226)'); // hex normalised to rgb
  expect(map.tokens?.['--space-4'], 'non-colour tokens are skipped').toBeUndefined();
});

test('catches a background-color change on a real button', async ({ page }) => {
  const a = await captureFixture(page, fixture('rgb(0, 0, 0)', 'rgb(0, 255, 0)'));
  const b = await captureFixture(page, fixture('rgb(255, 0, 0)', 'rgb(0, 255, 0)'));
  const findings = diffStyleMaps(a, b);
  const bg = findings.find((f) => f.kind === 'style' && f.props.some((p) => p.prop === 'background-color'));
  expect(bg, 'background-color change detected').toBeTruthy();
});

test('catches a dropped :hover variant via forced-state capture (CDP)', async ({ page }) => {
  // before: hover changes color; after: the :hover rule is gone.
  const before = fixture('rgb(0, 0, 0)', 'rgb(0, 255, 0)');
  const afterNoHover = before.replace('.cta:hover { color: rgb(0, 255, 0); }', '');
  const a = await captureFixture(page, before);
  const b = await captureFixture(page, afterNoHover);
  const stateFinding = diffStyleMaps(a, b).find((f) => f.kind === 'state' && f.state === 'hover');
  expect(stateFinding, 'hover delta change detected').toBeTruthy();
});

test('auto-settles for content that paints after load (async fetch/stream)', async ({ page }) => {
  // A div appended 300ms AFTER load — a stand-in for data that renders late. A
  // naive capture at `load` would miss it; the settle pass waits THROUGH the
  // initial quiet gap (it requires a sustained no-change window, not one sample).
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.late{color:rgb(10,20,30)}</style></head><body>
    <main></main>
    <script>setTimeout(function(){var d=document.createElement('div');d.className='late';d.textContent='loaded';document.querySelector('main').appendChild(d);},300)</script>
  </body></html>`;
  const map = await withPage(page, html, () => captureStyleMap(page));
  const hasLate = Object.values(map.elements).some((e) => e.cls === 'late');
  expect(hasLate, 'late-painted element captured after the settle wait').toBe(true);
  expect(map.volatile ?? [], 'a one-shot late load settles — not flagged volatile').toEqual([]);
});

test('auto-excludes a perpetual live region', async ({ page }) => {
  // #live mutates its own layout forever → never settles → flagged volatile and
  // excluded; the static button beside it is still captured.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#live{width:50px;height:50px;background:rgb(1,2,3)}</style></head><body>
    <main><div id="live"></div><button class="cta">ok</button></main>
    <script>var i=0;setInterval(function(){document.getElementById('live').style.marginLeft=((i++%20)+5)+'px';},80)</script>
  </body></html>`;
  const map = await withPage(page, html, () => captureStyleMap(page, { stabilize: { interval: 100, timeout: 800 } }));
  expect((map.volatile ?? []).length, 'live region detected').toBeGreaterThan(0);
  const liveStillCaptured = Object.keys(map.elements).some((p) => p.endsWith('div:nth-child(1)'));
  expect(liveStillCaptured, 'the live region is excluded from elements').toBe(false);
  const buttonCaptured = Object.values(map.elements).some((e) => e.cls === 'cta');
  expect(buttonCaptured, 'the static button is still captured').toBe(true);
});

test('saveStyleMap/loadStyleMap roundtrip a real capture (.json.gz)', async ({ page }) => {
  const map = await captureFixture(page, fixture('rgb(0, 0, 0)', 'rgb(0, 255, 0)'));
  const file = path.join(os.tmpdir(), `styleproof-e2e-rt-${Math.random().toString(36).slice(2)}.json.gz`);
  saveStyleMap(file, map);
  try {
    expect(loadStyleMap(file)).toEqual(map);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
