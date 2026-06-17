import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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

// A page whose styling depends on a live API: the chip is green when the backend
// reports "ok" and amber otherwise — the exact shape of FLEET's vault chip. The
// served status is mutable so we can simulate the backend drifting between runs.
const DATA_DRIVEN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  .chip { color: rgb(0, 200, 0); }
  .chip.warn { color: rgb(255, 180, 0); }
</style></head><body>
  <span id="chip" class="chip">vault</span>
  <script>
    fetch('/api/state').then(r => r.json()).then(d => {
      if (d.status !== 'ok') document.getElementById('chip').classList.add('warn');
      document.title = 'ready';
    });
  </script>
</body></html>`;

async function captureServed(
  browser: import('@playwright/test').Browser,
  base: string,
  har: string | null,
  mode: 'record' | 'replay',
): Promise<ReturnType<typeof captureStyleMap>> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (har && mode === 'record')
    await page.routeFromHAR(har, { url: '**/api/**', update: true, updateContent: 'embed' });
  if (har && mode === 'replay') await page.routeFromHAR(har, { url: '**/api/**', update: false, notFound: 'abort' });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => document.title === 'ready');
  const map = await captureStyleMap(page);
  await ctx.close(); // flushes the HAR in record mode
  return map;
}

test('record→replay keeps a data-driven capture stable when the backend drifts', async ({ browser }) => {
  let served = 'ok';
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/state')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: served }));
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(DATA_DRIVEN_PAGE);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const har = path.join(os.tmpdir(), `styleproof-e2e-har-${Math.random().toString(36).slice(2)}.har`);
  try {
    // Baseline: record the "ok" responses (chip green).
    const baseline = await captureServed(browser, base, har, 'record');
    // The backend drifts — containers down, vault unreachable (chip would go amber).
    served = 'crit';
    // Head replays the baseline's data → renders green again, so no phantom diff.
    const replayed = await captureServed(browser, base, har, 'replay');
    expect(diffStyleMaps(baseline, replayed), 'replay reproduces the baseline despite backend drift').toEqual([]);
    // Control: without replay the same drift DOES show up — proving the styling is
    // genuinely data-driven and the test isn't trivially passing.
    const live = await captureServed(browser, base, null, 'record');
    expect(diffStyleMaps(baseline, live).length, 'without replay the drift surfaces as a change').toBeGreaterThan(0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(har, { force: true });
  }
});

test('page.clock.setFixedTime pins time-derived rendering without breaking settle', async ({ browser }) => {
  // The chip text is the current year; freezing the clock makes it deterministic
  // and (crucially) leaves in-page timers running, so a settle wait still resolves.
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <span id="y"></span>
    <script>
      setTimeout(() => { document.getElementById('y').textContent = String(new Date().getFullYear()); document.title = 'ready'; }, 50);
    </script></body></html>`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.clock.setFixedTime(new Date('2025-01-01T00:00:00Z'));
    await page.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'load' });
    await page.waitForFunction(() => document.title === 'ready'); // proves timers still fire
    expect(await page.locator('#y').textContent()).toBe('2025');
  } finally {
    await ctx.close();
  }
});
