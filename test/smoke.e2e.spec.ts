import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, loadStyleMap, trackInflightRequests } from '../dist/index.js';
import { diffStyleMaps, selectCrawlLinks } from '../dist/index.js';
import { passLiveStreams } from '../src/runner.js'; // src, not dist: dist/ is gitignored so fallow can't resolve it

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
