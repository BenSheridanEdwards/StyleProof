import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, loadStyleMap, trackInflightRequests, captureUrlToDir } from '../dist/index.js';
import { diffStyleMaps, selectCrawlLinks, detectViewportWidths, crawlAndCapture } from '../dist/index.js';
import { passLiveStreams } from '../src/runner.js'; // src, not dist: dist/ is gitignored so fallow can't resolve it

type PageViewport = Parameters<Page['setViewportSize']>[0];

/** Navigate to inline HTML (no waiting past `load`) and run a callback. */
async function withPage<T>(
  page: Page,
  html: string,
  fn: () => Promise<T>,
  viewport: PageViewport = { width: 800, height: 600 },
): Promise<T> {
  const file = path.join(os.tmpdir(), `styleproof-e2e-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, html);
  try {
    await page.setViewportSize(viewport);
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

test('layout-equivalent centered wrappers do not produce phantom diffs', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; }
    .shell { display: block; min-height: 180px; background: rgb(246, 247, 249); }
    .centered {
      width: 720px;
      height: 96px;
      margin-left: auto;
      margin-right: auto;
      background: rgb(25, 80, 140);
    }
  </style></head><body>
    <main class="shell"><section class="centered">centered content</section></main>
  </body></html>`;
  const baseline = await withPage(page, html, () => captureStyleMap(page), { width: 1366, height: 768 });
  const repeated = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
  const centered = Object.entries(repeated.elements).find(([, element]) => element.cls === 'centered');
  expect(centered, 'centered wrapper captured from a real page').toBeTruthy();
  const [centeredPath] = centered!;
  repeated.elements[centeredPath]!.style['margin-left'] = '40px';
  repeated.elements[centeredPath]!.style['margin-right'] = '40px';
  expect(diffStyleMaps(baseline, repeated)).toEqual([]);
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

test('flags the forced-state layer as not certified when truncated past maxInteractive', async ({ page }) => {
  // The page has interactive elements, but maxInteractive:0 truncates the forced
  // -state capture entirely. statesSkipped must be set so a diff against a fully
  // -captured side reports the layer as uncertified instead of "identical".
  const html = fixture('rgb(0, 0, 0)', 'rgb(0, 255, 0)');
  const truncated = await withPage(page, html, () => captureStyleMap(page, { maxInteractive: 0 }));
  expect(truncated.statesSkipped, 'truncated forced-state layer is flagged').toBe(true);

  const full = await captureFixture(page, html);
  expect(full.statesSkipped, 'a fully-captured layer is not flagged').toBeFalsy();

  const finding = diffStyleMaps(truncated, full).find((f) => f.kind === 'state' && f.state === 'forced-state capture');
  expect(finding, 'the one-sided skip is surfaced as a loud finding').toBeTruthy();
});

test('neutralises real hover so the resting map still yields its forced :hover delta', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    main { padding: 80px; }
    .cta { color: rgb(255, 255, 255); background: rgb(0, 0, 0); border: 0; padding: 8px; }
    .cta:hover { color: rgb(0, 255, 0); }
  </style></head><body>
    <main><button class="cta">go</button></main>
  </body></html>`;
  const map = await withPage(page, html, async () => {
    await page.locator('.cta').hover();
    expect(await page.locator('.cta').evaluate((el) => getComputedStyle(el).color), 'element really is hovered').toBe(
      'rgb(0, 255, 0)',
    );
    return captureStyleMap(page);
  });
  const entry = Object.entries(map.elements).find(([, e]) => e.cls === 'cta');
  expect(entry, 'button captured').toBeTruthy();
  const [btnPath, btn] = entry!;
  expect(btn.style.color, 'resting map is not contaminated by the real cursor hover').toBe('rgb(255, 255, 255)');
  const hoverDelta = map.states[btnPath]?.hover;
  expect(hoverDelta, 'forced :hover delta is still captured').toBeTruthy();
  expect(
    Object.values(hoverDelta!).some((delta) => delta.color === 'rgb(0, 255, 0)'),
    'the :hover colour is in the forced-state delta',
  ).toBe(true);
});

test('forced-state capture keeps CDP and page elements aligned when snapshots reorder', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    .a:hover { color: rgb(255, 0, 0); }
    .b:hover { color: rgb(0, 0, 255); }
  </style></head><body>
    <main><button class="a">A</button><button class="b">B</button></main>
    <script>
      const realQsa = Document.prototype.querySelectorAll;
      Document.prototype.querySelectorAll = function(selector) {
        const result = realQsa.call(this, selector);
        if (typeof selector === 'string' && selector.includes('button') && selector.includes('[tabindex]')) {
          return Array.from(result).reverse();
        }
        return result;
      };
    </script>
  </body></html>`;
  const map = await captureFixture(page, html);
  const hoverDeltas = Object.values(map.states).flatMap((states) => Object.values(states.hover ?? {}));
  expect(
    hoverDeltas.filter((delta) => delta.color === 'rgb(255, 0, 0)' || delta.color === 'rgb(0, 0, 255)').length,
    'both button hover colours are captured even when page querySelectorAll order differs from CDP order',
  ).toBe(2);
});

test('neutralises real focus so a focused element still yields its forced :focus delta', async ({ page }) => {
  // Regression: a really-focused element used to contaminate the capture. The
  // resting snapshot baked in its focus ring, and the forced-state layer computes
  // the :focus delta as (no-force) → (CDP-forced); on an already-focused element
  // forcing :focus changes nothing, so the ring delta vanished — nondeterministic
  // across runs (a self-check failure). captureStyleMap now blurs first.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    .cta { outline: 0; background: rgb(0,0,0); color: rgb(255,255,255); border: 0; padding: 8px; }
    .cta:focus { outline: 3px solid rgb(0, 95, 204); }
  </style></head><body>
    <main><button class="cta">go</button></main>
  </body></html>`;
  const map = await withPage(page, html, async () => {
    await page.evaluate(() => (document.querySelector('.cta') as HTMLElement).focus());
    expect(await page.evaluate(() => document.activeElement?.className), 'element really holds focus').toBe('cta');
    return captureStyleMap(page);
  });
  const entry = Object.entries(map.elements).find(([, e]) => e.cls === 'cta');
  expect(entry, 'button captured').toBeTruthy();
  const [btnPath] = entry!;
  // The forced :focus delta is still captured despite the element being focused…
  const focusDelta = map.states[btnPath]?.focus;
  expect(focusDelta, 'forced :focus delta captured even though the element was really focused').toBeTruthy();
  const props = Object.values(focusDelta!).flatMap((d) => Object.keys(d));
  expect(
    props.some((p) => p.startsWith('outline')),
    'the :focus outline ring is in the delta',
  ).toBe(true);
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

test('declared animation on content that MOUNTS DURING the settle is captured, not frozen to 0s', async ({ page }) => {
  // A pulsing status glyph appended 300ms after load — it mounts DURING the
  // settle, like a live badge gated on a snapshot fetch. Its declared
  // `animation` must be folded back the same as for elements present at load.
  // Reading motion longhands pre-settle missed it, so animation-duration was
  // captured frozen (0s) on the late-mount run but declared (1.6s) on the run
  // where it mounted early — the "animation-duration 0s ↔ 1.6s" self-check flip.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0}
    @keyframes pulse { from { opacity: .4 } to { opacity: 1 } }
    .glyph { animation: pulse 1.6s ease-in-out infinite; }
  </style></head><body>
    <main></main>
    <script>setTimeout(function(){var s=document.createElement('span');s.className='glyph';s.textContent='●';document.querySelector('main').appendChild(s);},300)</script>
  </body></html>`;
  const map = await withPage(page, html, () => captureStyleMap(page));
  const glyph = Object.values(map.elements).find((e) => e.cls === 'glyph');
  expect(glyph, 'late-mounted glyph captured after the settle').toBeTruthy();
  // Folded declared motion, NOT the frozen 0s. Before the fix this was undefined
  // (frozen 0s pruned as the UA default), so the value flipped between runs.
  expect(glyph!.style['animation-duration'], 'declared motion folded for a late mount').toBe('1.6s');
});

test('network-aware settle waits for an in-flight fetch, not just a DOM lull', async ({ browser }) => {
  // The placeholder renders at load, then the DOM sits QUIET while a slow (2s, well
  // past the 600ms quietFor) /api/data fetch is in flight, then swaps in the loaded
  // content. DOM-quiet alone settles on the placeholder before the response arrives;
  // the network-aware settle holds until the fetch resolves and captures loaded —
  // the classic loading-vs-loaded settle flake (settle on the loading state vs the loaded one).
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/data')) {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ label: 'loaded' }));
      }, 2000);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><style>` +
          `body{margin:0}.row{color:rgb(50,50,50)}.row.loaded{color:rgb(0,128,0)}</style></head><body>` +
          `<main><span id="r" class="row">loading…</span></main><script>` +
          `fetch('/api/data').then(function(r){return r.json()}).then(function(d){` +
          `var el=document.getElementById('r');el.textContent=d.label;el.classList.add('loaded');});` +
          `</script></body></html>`,
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const ctx = await browser.newContext();
  try {
    // Default (network-aware): holds for the 2s fetch → captures the loaded state.
    // Arm the tracker BEFORE navigation (the runner's pattern) so the page's own load
    // fetch is counted — exactly how defineStyleMapCapture wires it.
    const awarePage = await ctx.newPage();
    const reqs = trackInflightRequests(awarePage);
    await awarePage.goto(base, { waitUntil: 'load' });
    const aware = await captureStyleMap(awarePage, { pendingRequests: reqs.pending });
    reqs.dispose();
    expect(
      Object.values(aware.elements).some((e) => e.cls.includes('loaded')),
      'network-aware settle waited for the in-flight fetch and captured the loaded state',
    ).toBe(true);

    // Control: opt out → settles on the placeholder lull BEFORE the fetch resolves,
    // proving the wait (not some other effect) is what captured the loaded state.
    const naivePage = await ctx.newPage();
    await naivePage.goto(base, { waitUntil: 'load' });
    const naive = await captureStyleMap(naivePage, { stabilize: { waitForRequests: false } });
    expect(
      Object.values(naive.elements).some((e) => e.cls.includes('loaded')),
      'DOM-quiet-only settle returned before the fetch resolved',
    ).toBe(false);
  } finally {
    await ctx.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
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

test('ignored live regions can still reveal root layout drift', async ({ page }) => {
  // Ignoring the live subtree removes that element from the diff, but it does not
  // freeze the document flow it participates in. If the live state should be
  // certified, capture both states as surface variants instead of expecting
  // `ignore` to hide the ancestor geometry.
  const html = (height: number) => `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; }
    .live { display: block; width: 100%; height: ${height}px; background: rgb(1,2,3); }
    .cta { display: block; color: rgb(0,0,0); }
  </style></head><body>
    <main><div class="live"></div><button class="cta">ok</button></main>
  </body></html>`;

  const short = await withPage(page, html(48), () =>
    captureStyleMap(page, { ignore: ['.live'], stabilize: false, captureStates: false }),
  );
  const tall = await withPage(page, html(180), () =>
    captureStyleMap(page, { ignore: ['.live'], stabilize: false, captureStates: false }),
  );
  expect(
    Object.values(short.elements).some((e) => e.cls === 'live'),
    'ignored live subtree is not captured directly',
  ).toBe(false);

  const findings = diffStyleMaps(short, tall);
  const rootLayout = findings.find(
    (f) =>
      f.kind === 'style' &&
      (f.path === 'html' || f.path === 'body') &&
      f.props.some((p) => p.prop === 'block-size' || p.prop === 'height'),
  );
  expect(rootLayout, 'ancestor/root layout still changes when ignored live content changes size').toBeTruthy();
});

test('auto-detects semantic live-state candidates without excluding stable product UI', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    .status { display: block; color: rgb(0,128,0); }
  </style></head><body>
    <main><div role="status" class="status">Loaded</div></main>
  </body></html>`;

  const map = await withPage(page, html, () => captureStyleMap(page, { captureStates: false }));
  expect(map.liveCandidates).toEqual([
    expect.objectContaining({
      path: 'body > main:nth-child(1) > div:nth-child(1)',
      tag: 'div',
      cls: 'status',
      role: 'status',
      reason: 'role=status',
    }),
  ]);
  expect(
    Object.values(map.elements).some((e) => e.cls === 'status'),
    'stable live-state candidates are still captured and compared',
  ).toBe(true);
  expect(map.volatile ?? [], 'stable live-state candidate is not treated as volatile').toEqual([]);
});

test('a caller-ignored region is not surfaced as a live candidate', async ({ page }) => {
  // The user ignored .ad-slot; its live region must be excluded from liveCandidates
  // too, matching every other capture pass — not just the framework defaults.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
  </style></head><body>
    <main>
      <div role="status" class="status">Loaded</div>
      <aside class="ad-slot"><div aria-live="polite" class="ad-ticker">Ad</div></aside>
    </main>
  </body></html>`;

  const map = await withPage(page, html, () => captureStyleMap(page, { captureStates: false, ignore: ['.ad-slot'] }));
  const classes = (map.liveCandidates ?? []).map((c) => c.cls);
  expect(classes, 'product status UI is still surfaced').toContain('status');
  expect(classes, 'the ignored ad ticker is not surfaced as a live candidate').not.toContain('ad-ticker');
});

test('ignores framework / non-visual DOM noise by default (meta, title, next-route-announcer)', async ({ page }) => {
  // The body carries the kind of noise Next.js streams in / injects: a couple of
  // <meta>, a <title>, a <script>, and the route-announcer live region — none of
  // it visual. `b` drops the streamed meta/title (framework churn between renders)
  // and the route announcer mutates. With the built-in ignore, none of that diffs.
  const body = (extra: string, announce: string) => `<!doctype html><html><head><meta charset="utf-8">
    <style>body{margin:0}.cta{color:rgb(0,0,0)}</style></head><body>
    <main><button class="cta">go</button></main>
    ${extra}
    <next-route-announcer><p>${announce}</p></next-route-announcer>
  </body></html>`;
  const a = await captureFixture(
    page,
    body('<meta name="a" content="1"><title>streamed</title><script>0;</script>', 'on /a'),
  );
  const b = await captureFixture(page, body('', 'navigated to /b'));
  // The streamed meta/title/script and the route-announcer churn are ignored…
  expect(diffStyleMaps(a, b), 'framework / non-visual churn does not register as a change').toEqual([]);
  // …and none of it was captured into elements in the first place.
  const paths = Object.keys(a.elements).join('\n');
  expect(
    /(^|> )(meta|title|script|next-route-announcer)/m.test(paths),
    'no framework/non-visual elements captured',
  ).toBe(false);
  // The real, visible button IS captured.
  expect(
    Object.values(a.elements).some((e) => e.cls === 'cta'),
    'visible elements still captured',
  ).toBe(true);
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
// reports "ok" and amber otherwise — a status chip driven by backend health. The
// served status is mutable so we can simulate the backend drifting between runs.
const DATA_DRIVEN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  .chip { color: rgb(0, 200, 0); }
  .chip.warn { color: rgb(255, 180, 0); }
</style></head><body>
  <span id="chip" class="chip">status</span>
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
    // The backend drifts — the upstream reports unhealthy (chip would go amber).
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

// A page whose styling depends on a live SSE stream: the pulse chip is dim
// until an EventSource connects and pushes a `snapshot`, which brightens it —
// a `.live-pulse` → `.live-pulse.stream` connection-state toggle. A long-lived
// stream cannot round-trip through a HAR, so naive replay aborts it and the chip
// renders its dim no-stream fallback: a phantom diff against the streamed base.
const SSE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  .pulse { opacity: 0.85; }
  .pulse.stream { opacity: 1; }
</style></head><body>
  <span id="pulse" class="pulse">live</span>
  <script>
    var es = new EventSource('/api/stream');
    es.addEventListener('snapshot', function () {
      document.getElementById('pulse').classList.add('stream');
      document.title = 'ready';
    });
    es.onerror = function () { document.title = 'ready'; }; // no-stream fallback: stays dim
  </script>
</body></html>`;

async function captureSSE(
  browser: import('@playwright/test').Browser,
  base: string,
  har: string | null,
  mode: 'record' | 'replay',
  passStreams: boolean,
): Promise<ReturnType<typeof captureStyleMap>> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (har && mode === 'record')
    await page.routeFromHAR(har, { url: '**/api/**', update: true, updateContent: 'embed' });
  if (har && mode === 'replay') await page.routeFromHAR(har, { url: '**/api/**', update: false, notFound: 'abort' });
  if (passStreams) await passLiveStreams(page, '**/api/**'); // after routeFromHAR → matches first
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => document.title === 'ready');
  const map = await captureStyleMap(page);
  await ctx.close();
  return map;
}

test('passLiveStreams keeps an SSE-driven capture stable under replay (a stream cannot be HARed)', async ({
  browser,
}) => {
  const open: import('node:http').ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: snapshot\ndata: {"ok":true}\n\n'); // push once, keep the connection open
      open.push(res);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(SSE_PAGE);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const har = path.join(os.tmpdir(), `styleproof-e2e-sse-${Math.random().toString(36).slice(2)}.har`);
  try {
    // Baseline: stream live, chip brightens to .stream (opacity 1).
    const baseline = await captureSSE(browser, base, har, 'record', true);
    expect(
      Object.values(baseline.elements).some((e) => e.cls.includes('stream')),
      'baseline captured the streamed (.stream) state',
    ).toBe(true);
    // With the fix: replay lets the stream through live → same .stream state, no diff.
    const replayed = await captureSSE(browser, base, har, 'replay', true);
    expect(diffStyleMaps(baseline, replayed), 'replay reproduces the streamed baseline').toEqual([]);
    // Control: plain replay (no passthrough) aborts the stream → dim fallback → phantom diff.
    const broken = await captureSSE(browser, base, har, 'replay', false);
    expect(
      diffStyleMaps(baseline, broken).length,
      'without passthrough the aborted stream surfaces as a phantom change',
    ).toBeGreaterThan(0);
  } finally {
    open.forEach((r) => r.end());
    server.closeAllConnections();
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

// React fiber extraction (Feature: captureComponent) only runs in-browser via
// page.evaluate, so it can't be unit-tested — exercise it here by stamping a fake
// fiber chain (host fiber → component fiber with memoizedProps) on a real node,
// exactly the shape React puts on DOM nodes (__reactFiber$<hash>).
function fiberFixture(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <main><button class="cta">Book</button></main>
    <script>
      var btn = document.querySelector('button');
      function Button() {}
      var compFiber = { type: Button, return: null, memoizedProps: { variant: 'primary', size: 'sm', children: 'Book' } };
      btn['__reactFiber$abc'] = { type: 'button', return: compFiber, memoizedProps: {} };
    </script>
  </body></html>`;
}

test('captureComponent reads the React component name + sanitized props off the fiber', async ({ page }) => {
  const map = await withPage(page, fiberFixture(), () =>
    captureStyleMap(page, { captureComponent: true, captureStates: false }),
  );
  const btn = Object.values(map.elements).find((e) => e.tag === 'button');
  // children dropped (non-primitive intent), variant/size kept.
  expect(btn?.component).toEqual({ name: 'Button', props: { variant: 'primary', size: 'sm' } });
});

test('captureComponent is opt-in: off by default it records no component', async ({ page }) => {
  const map = await withPage(page, fiberFixture(), () => captureStyleMap(page, { captureStates: false }));
  const btn = Object.values(map.elements).find((e) => e.tag === 'button');
  expect(btn?.component).toBeUndefined();
});

test('crawl discovery: reads a rendered nav into a deduped, keyed surface set', async ({ browser }) => {
  // The discovery half of defineCrawlCapture, end to end against real Chromium: serve a
  // nav whose links are the surfaces (tab-SPA + a real page), plus the noise a real nav
  // carries (external, mailto, an in-page fragment, a duplicate). page.$$eval reads the
  // hydrated hrefs exactly as the runner does, then selectCrawlLinks turns them into the
  // capture set. Served over http (not file://) so keys come from the route, not a temp path.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"></head><body><nav>` +
        `<a href="/?tab=overview">Bridge</a>` +
        `<a href="/?tab=faults">Faults</a>` +
        `<a href="/docs">Docs</a>` +
        `<a href="/?tab=overview">Bridge (dup)</a>` +
        `<a href="https://example.com/out">External</a>` +
        `<a href="mailto:ops@x.test">Mail</a>` +
        `<a href="#main">Skip to content</a>` +
        `</nav></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href')));
    const links = selectCrawlLinks(hrefs, { base: page.url() });
    // overview + faults + docs; external/mailto/fragment dropped, duplicate collapsed.
    expect(links).toEqual([
      { key: 'overview', url: '/?tab=overview' },
      { key: 'faults', url: '/?tab=faults' },
      { key: 'docs', url: '/docs' },
    ]);
    // And `match` narrows to just the tab views.
    const tabs = selectCrawlLinks(hrefs, { base: page.url(), match: /\?tab=/ });
    expect(tabs.map((l) => l.key)).toEqual(['overview', 'faults']);
  } finally {
    await ctx.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('detectViewportWidths reads the real @media breakpoints off the loaded page', async ({ page }) => {
  // Mixed mobile-first and desktop-first rules, plus noise that must NOT register:
  // a print query, a height query, and a container query (container-relative, not viewport).
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    @media (min-width: 768px) { .x { color: rgb(1,1,1) } }
    @media (min-width: 1024px) { .x { color: rgb(2,2,2) } }
    @media (max-width: 480px) { .x { color: rgb(3,3,3) } }
    @media print { .x { color: rgb(4,4,4) } }
    @media (min-height: 900px) { .x { color: rgb(5,5,5) } }
    @container (min-width: 555px) { .x { color: rgb(6,6,6) } }
  </style></head><body><main><span class="x">hi</span></main></body></html>`;
  const widths = await withPage(page, html, () => detectViewportWidths(page));
  // boundaries: 481 (max-width:480 + 1), 768, 1024 → base band rep 360, then each boundary.
  // print / min-height / @container contribute nothing.
  expect(widths).toEqual([360, 481, 768, 1024]);
});

test('detectViewportWidths returns a single width when the page has no width @media rules', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.x{color:rgb(0,0,0)}</style></head><body><span class="x">hi</span></body></html>`;
  const widths = await withPage(page, html, () => detectViewportWidths(page));
  expect(widths).toEqual([1280]);
});

test('captureUrlToDir writes diff-compatible <key>@<width> maps (+ screenshots) for a URL', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: sans-serif; }
    .card { background: rgb(240, 240, 245); padding: 24px; }
    .cta { background: rgb(20, 120, 255); color: rgb(255, 255, 255); border: 0; padding: 12px 20px; }
    @media (max-width: 700px) { .card { padding: 12px; } }
  </style></head><body>
    <main class="card"><h1>Pricing</h1><button class="cta">Book a call</button></main>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-cap-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-cap-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  try {
    const results = await captureUrlToDir(page, {
      url: 'file://' + file,
      key: 'pricing',
      widths: [1440, 600], // straddle the 700px breakpoint
      out,
      ignore: [],
      height: 800,
      screenshots: true,
    });

    expect(results.map((r) => r.width)).toEqual([1440, 600]);
    for (const width of [1440, 600]) {
      const map = path.join(out, `pricing@${width}.json.gz`);
      const shot = path.join(out, `pricing@${width}.png`);
      expect(fs.existsSync(map), `${map} written`).toBe(true);
      expect(fs.existsSync(shot), `${shot} written`).toBe(true);
      // A written map is valid and self-consistent (the diff a fidelity check runs).
      expect(diffStyleMaps(loadStyleMap(map), loadStyleMap(map)), 'self-diff is clean').toEqual([]);
    }

    // The breakpoint actually took effect: .card padding differs across the two widths.
    const pad = (width: number) =>
      Object.values(loadStyleMap(path.join(out, `pricing@${width}.json.gz`)).elements).find((e) => e.cls === 'card')
        ?.style['padding-top'];
    expect(pad(1440)).toBe('24px');
    expect(pad(600)).toBe('12px');
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('crawlAndCapture drives interactions and maps a modal + its nested tab', async ({ page }) => {
  // A page whose real surface is behind clicks: a hidden dialog opened by a button,
  // with two tabs inside. A one-shot capture sees only the base; the crawler must
  // open the dialog (depth 1) and switch to the second tab (depth 2).
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .modal { display: none; position: fixed; inset: 20% 25%; background: rgb(240,240,245); padding: 20px; }
    .modal.open { display: block; }
    .panel { display: none; }
    .panel.on { display: block; }
    button { cursor: pointer; }
  </style></head><body>
    <main><button id="open">Open dialog</button></main>
    <div class="modal" id="m">
      <button class="tab" data-t="1">Tab one</button>
      <button class="tab" data-t="2">Tab two</button>
      <div class="panel on" data-c="1">Panel one</div>
      <div class="panel" data-c="2"><p>Panel two differs</p><ul><li>a</li><li>b</li></ul></div>
    </div>
    <script>
      document.getElementById('open').onclick = () => document.getElementById('m').classList.add('open');
      for (const t of document.querySelectorAll('.tab')) t.onclick = () => {
        for (const c of document.querySelectorAll('.panel')) c.classList.toggle('on', c.dataset.c === t.dataset.t);
      };
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-crawl-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-crawl-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  try {
    const report = await crawlAndCapture(page, {
      url: 'file://' + file,
      out,
      widths: [900],
      ignore: [],
      height: 700,
      screenshots: false,
      waitSelector: '#open',
      maxDepth: 3,
      maxActionsPerState: 20,
      maxStates: 20,
      resetStorage: true,
    });

    const keys = report.surfaces.map((s) => s.key);
    // base + the opened dialog + the second tab, all reached by driving.
    expect(keys).toContain('base');
    expect(
      report.surfaces.some((s) => s.depth === 1),
      'opened the dialog (depth 1)',
    ).toBe(true);
    expect(
      report.surfaces.some((s) => s.depth === 2),
      'reached a nested tab (depth 2)',
    ).toBe(true);
    expect(report.captured).toBeGreaterThanOrEqual(3);

    // Every captured surface wrote a diff-compatible map at the requested width.
    for (const s of report.surfaces) {
      if (report.failed.includes(s.key)) continue;
      const map = path.join(out, `${s.key}@900.json.gz`);
      expect(fs.existsSync(map), `${s.key} map written`).toBe(true);
      expect(diffStyleMaps(loadStyleMap(map), loadStyleMap(map))).toEqual([]);
    }
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('crawl family-retry re-tries a persistent mode-switcher in each sibling tab', async ({ page }) => {
  // A dialog with two tabs and one EDIT toggle that persists across tabs: the
  // toggle's effect depends on which tab is open, so after being driven once
  // (from tab one), it must be re-tried in tab two — four dialog states total.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .modal { display: none; position: fixed; inset: 15% 20%; background: rgb(245,245,250); padding: 16px; }
    .modal.open { display: block; }
    .panel { display: none; } .panel.on { display: block; }
    .modal.editing .panel.on { outline: 3px solid rgb(200,30,30); }
    .modal.editing .pen { background: rgb(200,30,30); color: rgb(255,255,255); }
    button { cursor: pointer; }
  </style></head><body>
    <main><button id="open">Open dialog</button></main>
    <div class="modal" id="m">
      <button class="tab" data-t="1">Tab one</button>
      <button class="tab" data-t="2">Tab two</button>
      <button class="pen" id="pen">Edit</button>
      <div class="panel on" data-c="1">Panel one <input value="a"></div>
      <div class="panel" data-c="2">Panel two <ul><li>x</li><li>y</li></ul></div>
    </div>
    <script>
      document.getElementById('open').onclick = () => document.getElementById('m').classList.add('open');
      document.getElementById('pen').onclick = () => document.getElementById('m').classList.toggle('editing');
      for (const t of document.querySelectorAll('.tab')) t.onclick = () => {
        for (const c of document.querySelectorAll('.panel')) c.classList.toggle('on', c.dataset.c === t.dataset.t);
      };
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-fam-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-fam-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  try {
    const report = await crawlAndCapture(page, {
      url: 'file://' + file,
      out,
      widths: [900],
      ignore: [],
      height: 700,
      screenshots: false,
      maxDepth: 1000,
      maxActionsPerState: 100000,
      maxStates: 100000,
      resetStorage: true,
    });
    expect(report.failed).toEqual([]);
    // Count captured dialog states where the EDIT toggle is active: the pen was
    // driven from tab one AND family-retried from tab two → two editing states.
    let editingStates = 0;
    for (const s of report.surfaces) {
      const map = loadStyleMap(path.join(out, `${s.key}@900.json.gz`));
      if (Object.values(map.elements).some((e) => String(e.cls).split(/\s+/).includes('editing'))) editingStates++;
    }
    expect(editingStates, 'editing captured in both tabs via family retry').toBeGreaterThanOrEqual(2);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
