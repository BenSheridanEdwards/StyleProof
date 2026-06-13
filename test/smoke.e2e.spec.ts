import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStyleMap, saveStyleMap, loadStyleMap } from '../dist/index.js';
import { diffStyleMaps } from '../dist/index.js';

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

async function captureFixture(
  page: import('@playwright/test').Page,
  html: string,
): Promise<ReturnType<typeof loadStyleMap>> {
  const file = path.join(os.tmpdir(), `stylemap-e2e-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, html);
  try {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('file://' + file, { waitUntil: 'load' });
    return await captureStyleMap(page);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

test('captures a real page and reports an identical map as unchanged', async ({ page }) => {
  const html = fixture('rgb(0, 0, 0)', 'rgb(0, 255, 0)');
  const a = await captureFixture(page, html);
  const b = await captureFixture(page, html);
  expect(diffStyleMaps(a, b)).toEqual([]);
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

test('saveStyleMap/loadStyleMap roundtrip a real capture (.json.gz)', async ({ page }) => {
  const map = await captureFixture(page, fixture('rgb(0, 0, 0)', 'rgb(0, 255, 0)'));
  const file = path.join(os.tmpdir(), `stylemap-e2e-rt-${Math.random().toString(36).slice(2)}.json.gz`);
  saveStyleMap(file, map);
  try {
    expect(loadStyleMap(file)).toEqual(map);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
