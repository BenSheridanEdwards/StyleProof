import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, loadStyleMap, trackInflightRequests, captureUrlToDir } from '../dist/index.js';
import { diffStyleMaps, selectCrawlLinks, detectViewportWidths, crawlAndCapture } from '../dist/index.js';
import { passLiveStreams } from '../src/runner.js'; // src, not dist: dist/ is gitignored so fallow can't resolve it

// Every test here builds its own fixture (mkdtemp / own page); none reads another
// test's output. Declare the file parallel so its tests spread across workers —
// serial-in-one-worker made this file the long pole of the e2e wall time.
test.describe.configure({ mode: 'parallel' });

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

test('capture persists zero own-text length without persisting rendered copy', async ({ page }) => {
  const html = '<!doctype html><html><body><span class="empty"></span><span class="filled">test</span></body></html>';
  const map = await captureFixture(page, html);
  const empty = Object.values(map.elements).find((entry) => entry.cls === 'empty');
  const filled = Object.values(map.elements).find((entry) => entry.cls === 'filled');
  expect(empty?.ownTextLength).toBe(0);
  expect(filled?.ownTextLength).toBe(4);
  expect(empty?.text).toBeUndefined();
  expect(filled?.text).toBeUndefined();
});

test('capture declares prefers-reduced-motion so JS animation libraries render final states', async ({ page }) => {
  // FREEZE_CSS only reaches CSS-declared motion; framer-motion et al. write
  // inline styles from rAF loops and gate them on prefers-reduced-motion. The
  // capture must DECLARE reduced motion, or a short entrance animation races
  // the settle and two same-commit captures read different mid-flight frames
  // (the self-check's "non-deterministic" failure). The fixture pins the
  // declared media state the way those libraries read it, deterministically in
  // both directions: green iff reduce is declared at capture time.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    .card { padding: 20px; background: rgb(10, 20, 30); color: rgb(255, 255, 255); }
  </style></head><body>
    <main><div class="card" id="card">Reveal</div></main>
    <script>
      document.getElementById('card').style.color = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches
        ? 'rgb(0, 128, 0)'
        : 'rgb(255, 0, 0)';
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-rm-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-rm-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  try {
    await captureUrlToDir(page, {
      url: 'file://' + file,
      key: 'reveal',
      widths: [800],
      out,
      ignore: [],
      height: 600,
      screenshots: false,
    });
    const map = loadStyleMap(path.join(out, 'reveal@800.json.gz'));
    const card = Object.values(map.elements).find((e) => e.cls === 'card');
    expect(card?.style?.color, 'the mount-time media read saw reduce').toBe('rgb(0, 128, 0)');
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
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

test('re-capturing the SAME page without navigation leaves no freeze tag and reads motion identically', async ({
  page,
}) => {
  // BUG: captureStyleMap re-applies FREEZE_CSS for its base/forced-state reads but
  // used to leave that <style> in the DOM. On a page reused WITHOUT a reload (an SPA
  // go() that doesn't navigate, multi-surface reuse, the self-check's re-run), the
  // second capture's motion pass then read this run's still-frozen transition/animation
  // longhands (none/0s) as the baseline → phantom drift → a FALSE "non-deterministic"
  // self-check failure. Every other e2e masks this by navigating between captures
  // (withPage reloads); this one deliberately does NOT navigate.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    @keyframes pulse { from { opacity: .4 } to { opacity: 1 } }
    .glyph { animation: pulse 1.6s ease-in-out infinite; }
    .btn { transition: color 240ms ease; color: rgb(0,0,0); }
  </style></head><body>
    <main><span class="glyph">●</span><button class="btn">go</button></main>
  </body></html>`;

  const countFreezeTags = () =>
    page.evaluate(
      (css) => Array.from(document.querySelectorAll('style')).filter((s) => s.textContent === css).length,
      '*,*::before,*::after{animation:none!important;transition:none!important}',
    );

  await withPage(page, html, async () => {
    // First capture. No freeze tag must survive it.
    const first = await captureStyleMap(page);
    expect(await countFreezeTags(), 'no freeze <style> tag leaks after the first capture').toBe(0);

    // Second capture on the SAME page — no navigation, no reload in between.
    const second = await captureStyleMap(page);
    expect(await countFreezeTags(), 'freeze tags do not accumulate across captures').toBe(0);

    // The motion longhands must read identically across the two captures — before the
    // fix the leaked freeze nulled them to 0s/none on the second read, producing drift.
    const motionOf = (map: Awaited<ReturnType<typeof captureStyleMap>>, cls: string) => {
      const el = Object.values(map.elements).find((e) => e.cls === cls);
      return {
        animationDuration: el?.style['animation-duration'],
        transitionDuration: el?.style['transition-duration'],
      };
    };
    expect(motionOf(first, 'glyph')).toEqual(motionOf(second, 'glyph'));
    expect(motionOf(first, 'btn')).toEqual(motionOf(second, 'btn'));
    // And the declared motion actually survived (not silently frozen on BOTH runs).
    expect(motionOf(second, 'glyph').animationDuration, 'declared animation preserved on the reused page').toBe('1.6s');

    // The whole point: a self-check style re-diff of the reused page is clean.
    expect(diffStyleMaps(first, second), 'no phantom drift on a page recaptured in place').toEqual([]);
  });
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

test('crawl coverage verifier: full coverage passes, exactly the dead CSS is flagged', async ({ page }) => {
  // The quality lock: every class the page's stylesheets define must be seen
  // rendered in some captured surface. This fixture's whole surface is reachable
  // by driving (dialog, two tabs, an edit toggle, a popover) EXCEPT one
  // deliberately dead rule — coverage.missing must name exactly that class.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .card { background: rgb(240,240,245); padding: 20px; }
    .modal { display: none; position: fixed; inset: 15% 20%; background: rgb(250,250,255); padding: 16px; }
    .modal.open { display: block; }
    .panel { display: none; } .panel.on { display: block; }
    .modal.editing .panel.on { outline: 3px solid rgb(200,30,30); }
    .pop { display: none; position: fixed; right: 8px; top: 8px; background: rgb(230,240,255); padding: 8px; }
    .pop.open { display: block; }
    .never-rendered { color: rgb(1,2,3); } /* dead CSS — nothing ever has this class */
    button { cursor: pointer; }
  </style></head><body>
    <main class="card">
      <button id="open">Open dialog</button>
      <button id="more">More info</button>
    </main>
    <div class="pop" id="p">popover content</div>
    <div class="modal" id="m">
      <button class="tab" data-t="1">Tab one</button>
      <button class="tab" data-t="2">Tab two</button>
      <button id="pen">Edit</button>
      <div class="panel on" data-c="1">Panel one</div>
      <div class="panel" data-c="2">Panel two <em>differs</em></div>
    </div>
    <script>
      document.getElementById('open').onclick = () => document.getElementById('m').classList.add('open');
      document.getElementById('more').onclick = () => document.getElementById('p').classList.toggle('open');
      document.getElementById('pen').onclick = () => document.getElementById('m').classList.toggle('editing');
      for (const t of document.querySelectorAll('.tab')) t.onclick = () => {
        for (const c of document.querySelectorAll('.panel')) c.classList.toggle('on', c.dataset.c === t.dataset.t);
      };
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-cov-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-cov-out-${Math.random().toString(36).slice(2)}`);
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
    // The crawl reached every real surface, so the ONLY unrendered class is the
    // deliberately dead one — this is the machine check that nothing was missed.
    expect(report.coverage.missing).toEqual(['never-rendered']);
    expect(report.coverage.rendered).toBe(report.coverage.defined - 1);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('crawl discovery breadth: cursor:grab cards and <select> options are driven; duplicate paths dedup', async ({
  page,
}) => {
  // A draggable (cursor:grab) card that opens a panel on click, a select that
  // restyles on change, and TWO buttons opening the SAME panel — the crawler must
  // find the grab card (not just cursor:pointer), drive the select, and capture
  // the shared panel once.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .card { cursor: grab; background: rgb(240,240,245); padding: 16px; width: 200px; }
    .detail { display: none; background: rgb(220,235,255); padding: 10px; }
    .detail.open { display: block; }
    .shared { display: none; background: rgb(255,240,220); padding: 10px; }
    .shared.open { display: block; }
    body.alt .card { background: rgb(200,220,200); }
    button { cursor: pointer; }
  </style></head><body>
    <div class="card" id="c">Draggable card (click opens detail)</div>
    <div class="detail" id="d">detail panel</div>
    <button id="a">Open shared</button><button id="b">Also open shared</button>
    <div class="shared" id="s">shared panel</div>
    <select id="sel"><option value="x">x</option><option value="alt">alt</option></select>
    <script>
      document.getElementById('c').onclick = () => document.getElementById('d').classList.add('open');
      for (const id of ['a','b']) document.getElementById(id).onclick = () => document.getElementById('s').classList.add('open');
      document.getElementById('sel').onchange = (e) => document.body.classList.toggle('alt', e.target.value === 'alt');
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-breadth-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-breadth-out-${Math.random().toString(36).slice(2)}`);
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
    // grab card, select restyle, and the shared panel all reached; nothing missing.
    expect(report.coverage.missing).toEqual([]);
    // Three persistent modes (detail, shared, alt): base + each single mode +
    // every PAIRWISE combination = 7. Retries don't compound, so the 3-way
    // product is deliberately not walked — it adds no render vocabulary, and
    // anything class-visible only at 3-way depth would be named by the
    // verifier. The second button opening the same panel adds nothing.
    expect(report.surfaces.length, 'pairwise mode lattice, deduped').toBe(7);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('crawl never clicks destructive-looking controls, and the verifier names what stays unreached', async ({
  page,
}) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; } .card { padding: 16px; background: rgb(240,240,245); }
    .boom { display: none; background: rgb(255,0,0); } body.nuked .boom { display: block; }
    button { cursor: pointer; }
  </style></head><body>
    <main class="card"><button id="del">Delete everything</button></main>
    <div class="boom">irreversible result</div>
    <script>document.getElementById('del').onclick = () => document.body.classList.add('nuked');</script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-danger-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-danger-out-${Math.random().toString(36).slice(2)}`);
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
    expect(report.skipped, 'the delete button was skipped, not clicked').toBeGreaterThanOrEqual(1);
    expect(report.surfaces.length, 'no nuked state was ever created').toBe(1);
    // The guard is SAFE because the verifier is honest: the state class the
    // destructive click would have added is named as never-seen.
    expect(report.coverage.missing).toContain('nuked');
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('multi-width crawl: discovery stays at widths[0] while every surface is captured at every width', async ({
  page,
}) => {
  // The trigger is HIDDEN below 600px. If discovery leaked to the narrow width
  // (the old viewport bug), the modal would never be found — it must be found at
  // 900 and still captured at both 900 AND 500.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; } .card { padding: 16px; background: rgb(240,240,245); }
    .modal { display: none; position: fixed; inset: 20% 25%; background: rgb(250,250,255); }
    .modal.open { display: block; }
    @media (max-width: 600px) { #open { display: none; } }
    button { cursor: pointer; }
  </style></head><body>
    <main class="card"><button id="open">Open dialog</button></main>
    <div class="modal" id="m">modal content</div>
    <script>document.getElementById('open').onclick = () => document.getElementById('m').classList.add('open');</script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-widths-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-widths-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  try {
    const report = await crawlAndCapture(page, {
      url: 'file://' + file,
      out,
      widths: [900, 500],
      ignore: [],
      height: 700,
      screenshots: false,
      maxDepth: 1000,
      maxActionsPerState: 100000,
      maxStates: 100000,
      resetStorage: true,
    });
    const modal = report.surfaces.find((s) => s.key !== 'base');
    expect(modal, 'modal discovered despite trigger hidden at 500px').toBeTruthy();
    for (const width of [900, 500]) {
      expect(fs.existsSync(path.join(out, `${modal!.key}@${width}.json.gz`)), `captured @${width}`).toBe(true);
    }
    expect(report.coverage.missing).toEqual([]);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('bare crawl of a client-rendered page: the app mounts AFTER load and is still fully mapped', async ({ page }) => {
  // The UI does not exist at `load` — it mounts 350ms later (async framework
  // boot). With no waitSelector and no hints, the crawl must settle, find the
  // mounted button, and map the dialog behind it.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; } .app { padding: 16px; background: rgb(240,240,245); }
    .modal { display: none; position: fixed; inset: 20% 25%; background: rgb(250,250,255); }
    .modal.open { display: block; }
    button { cursor: pointer; }
  </style></head><body>
    <div id="root"></div>
    <script>
      setTimeout(() => {
        document.getElementById('root').innerHTML =
          '<main class="app"><button id="open">Open dialog</button></main><div class="modal" id="m">modal content</div>';
        document.getElementById('open').onclick = () => document.getElementById('m').classList.add('open');
      }, 350);
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-async-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-async-out-${Math.random().toString(36).slice(2)}`);
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
    expect(report.surfaces.length, 'base + mounted dialog').toBeGreaterThanOrEqual(2);
    expect(report.coverage.missing).toEqual([]);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('setup steps unlock an input-gated state; without them the verifier names the gap', async ({ page }) => {
  // A client-side password gate: the vault section renders only after the right
  // passphrase. Without setup, the crawl cannot type — the verifier must NAME the
  // gated classes. With setup steps (fill + click, run on every reset), the vault
  // is crawled like any surface and coverage is complete.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .gate { padding: 20px; background: rgb(240,240,245); }
    .vault { display: none; padding: 20px; background: rgb(220,245,220); }
    .vault.open { display: block; }
    .vault-detail { display: none; background: rgb(200,235,200); padding: 10px; }
    .vault-detail.open { display: block; }
    button { cursor: pointer; }
  </style></head><body>
    <main class="gate">
      <input id="pw" type="password" placeholder="passphrase">
      <button id="unlock">Unlock</button>
    </main>
    <div class="vault" id="v">
      vault content
      <button id="more">Show detail</button>
      <div class="vault-detail" id="vd">secret detail</div>
    </div>
    <script>
      document.getElementById('unlock').onclick = () => {
        if (document.getElementById('pw').value === 'open-sesame')
          document.getElementById('v').classList.add('open');
      };
      document.getElementById('more').onclick = () => document.getElementById('vd').classList.add('open');
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-gate-${Math.random().toString(36).slice(2)}.html`);
  const outA = path.join(os.tmpdir(), `styleproof-gate-a-${Math.random().toString(36).slice(2)}`);
  const outB = path.join(os.tmpdir(), `styleproof-gate-b-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  const base = {
    url: 'file://' + file,
    ignore: [],
    widths: [900],
    height: 700,
    screenshots: false,
    maxDepth: 1000,
    maxActionsPerState: 100000,
    maxStates: 100000,
    resetStorage: true,
  };
  try {
    // WITHOUT setup: honest failure — the gated classes are named, not silently missed.
    const blind = await crawlAndCapture(page, { ...base, out: outA });
    expect(blind.coverage.missing).toContain('open'); // the state class the unlock adds

    // WITH setup: the gate is re-established on every reset, so even the vault's
    // own nested control (detail) is crawled behind it.
    const steps = [
      { action: 'fill', selector: '#pw', value: 'open-sesame' },
      { action: 'click', selector: '#unlock' },
      { action: 'waitFor', selector: '.vault.open' },
    ];
    const unlocked = await crawlAndCapture(page, { ...base, out: outB, setup: steps });
    expect(unlocked.coverage.missing).toEqual([]);
    expect(
      unlocked.surfaces.some((s) => s.key.includes('detail')),
      'nested control behind the gate crawled',
    ).toBe(true);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(outA, { recursive: true, force: true });
    fs.rmSync(outB, { recursive: true, force: true });
  }
});

test('automatic data states: loading (stalled) and error (500) captured out of the box', async ({ page }) => {
  // A data-driven page: skeleton until the fetch resolves, error render on 500.
  // The crawl must capture loaded (base), loading, and error — with no config.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-data-'));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ items: ['a', 'b'] }));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; font-family: sans-serif; }
      .loading { padding: 20px; background: rgb(240,240,245); }
      .loaded { padding: 20px; background: rgb(220,245,220); }
      .error { padding: 20px; background: rgb(250,220,220); }
    </style></head><body>
      <main id="root"><div class="loading">loading…</div></main>
      <script>
        fetch('data.json?t=' + Date.now())
          .then((r) => { if (!r.ok) throw new Error('bad'); return r.json(); })
          .then((d) => { document.getElementById('root').innerHTML = '<div class="loaded">' + d.items.join(', ') + '</div>'; })
          .catch(() => { document.getElementById('root').innerHTML = '<div class="error">could not load</div>'; });
      </script>
    </body></html>`,
  );
  const server = http.createServer((req, res) => {
    const clean = (req.url ?? '').split('?')[0]; // the fetch cache-busts — serve by pathname
    const f = path.join(dir, clean === '/' ? 'index.html' : clean);
    if (!fs.existsSync(f)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': f.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(fs.readFileSync(f));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const out = path.join(os.tmpdir(), `styleproof-data-out-${Math.random().toString(36).slice(2)}`);
  try {
    const report = await crawlAndCapture(page, {
      url: `http://127.0.0.1:${port}/index.html`,
      out,
      ignore: [],
      widths: [900],
      height: 700,
      screenshots: false,
      maxDepth: 1000,
      maxActionsPerState: 100000,
      maxStates: 100000,
      resetStorage: true,
    });
    const keys = report.surfaces.map((s) => s.key);
    expect(keys).toContain('loading');
    expect(keys).toContain('error');
    expect(report.coverage.missing, 'loaded + loading + error all rendered somewhere').toEqual([]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('neutral inputs are auto-filled; credential-semantic fields never are', async ({ page }) => {
  // Typing needs no secrets when the input is a search box: the crawl fills a
  // deterministic value and captures what renders. The password unlock stays
  // untouched — and the verifier names its state class.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .box { padding: 20px; background: rgb(240,240,245); }
    .results { display: none; background: rgb(220,235,255); padding: 10px; }
    body.searching .results { display: block; }
    .secret { display: none; } .secret.unlocked { display: block; }
  </style></head><body>
    <main class="box">
      <input id="q" type="search" placeholder="search">
      <input id="pw" type="password" autocomplete="current-password" placeholder="password">
    </main>
    <div class="results">results list</div>
    <div class="secret">secret area</div>
    <script>
      document.getElementById('q').addEventListener('input', (e) =>
        document.body.classList.toggle('searching', e.target.value.length > 0));
      document.getElementById('pw').addEventListener('input', (e) => {
        if (e.target.value === 'hunter2') document.querySelector('.secret').classList.add('unlocked');
      });
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-fill-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-fill-out-${Math.random().toString(36).slice(2)}`);
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
    expect(report.coverage.missing, 'search state reached; password state named').toEqual(['unlocked']);
    expect(report.surfaces.length).toBeGreaterThanOrEqual(2); // base + searching
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('scroll-revealed content is mapped with zero config', async ({ page }) => {
  // A section that mounts only when scrolled into view (IntersectionObserver):
  // the deterministic scroll pass reveals it on every load, so it is part of the
  // base surface and its classes are covered.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .top { height: 1600px; background: rgb(240,240,245); }
    .lazy { min-height: 40px; }
    .revealed { background: rgb(220,245,220); padding: 20px; }
  </style></head><body>
    <div class="top">above the fold</div>
    <div class="lazy" id="lazy"></div>
    <script>
      new IntersectionObserver((entries, obs) => {
        if (entries.some((e) => e.isIntersecting)) {
          document.getElementById('lazy').innerHTML = '<div class="revealed">revealed content</div>';
          obs.disconnect();
        }
      }).observe(document.getElementById('lazy'));
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-scroll-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-scroll-out-${Math.random().toString(36).slice(2)}`);
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
    expect(report.coverage.missing).toEqual([]);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('crawl auto-detects breakpoint widths when none are given', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; } .card { padding: 24px; background: rgb(240,240,245); }
    @media (max-width: 700px) { .card { padding: 12px; } }
  </style></head><body><main class="card">content</main></body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-bp-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-bp-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  try {
    await crawlAndCapture(page, {
      url: 'file://' + file,
      out,
      widths: [],
      ignore: [],
      height: 700,
      screenshots: false,
      maxDepth: 1000,
      maxActionsPerState: 100000,
      maxStates: 100000,
      resetStorage: true,
    });
    const widths = new Set(fs.readdirSync(out).map((f) => f.split('@')[1]?.replace('.json.gz', '')));
    expect(widths.size, 'one width per detected @media band').toBeGreaterThanOrEqual(2);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('one-shot capture honours setup steps for a gated page', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; } .gate { padding: 20px; }
    .inside { display: none; padding: 20px; background: rgb(220,245,220); }
    .inside.open { display: block; }
    button { cursor: pointer; }
  </style></head><body>
    <main class="gate"><input id="pw" type="password"><button id="go">Enter</button></main>
    <div class="inside" id="i">inside content</div>
    <script>document.getElementById('go').onclick = () => {
      if (document.getElementById('pw').value === 'sesame') document.getElementById('i').classList.add('open');
    };</script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-oneshot-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-oneshot-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  try {
    await captureUrlToDir(page, {
      url: 'file://' + file,
      key: 'gated',
      widths: [900],
      out,
      ignore: [],
      height: 700,
      screenshots: false,
      crawl: false,
      maxDepth: 1000,
      maxActionsPerState: 100000,
      maxStates: 100000,
      resetStorage: true,
      requireFullCoverage: false,
      dataStates: true,
      setup: [
        { action: 'fill', selector: '#pw', value: 'sesame' },
        { action: 'click', selector: '#go' },
        { action: 'waitFor', selector: '.inside.open' },
      ],
    });
    const map = loadStyleMap(path.join(out, 'gated@900.json.gz'));
    expect(
      Object.values(map.elements).some((e) => String(e.cls) === 'inside open'),
      'the gated state was captured in one-shot mode',
    ).toBe(true);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('consuming actions never spawn a decision lattice; their mode-views stay reachable', async ({ page }) => {
  // Two resolvable rows that REMOVE themselves when actioned (sibling selectors
  // shift — the classic drift that makes consumed controls look "fresh" again),
  // plus a persistent Done tab. The crawl must: action each row once, re-try the
  // persistent tab inside the resolved states (reaching the done-item render),
  // and never explore the resolved-subset lattice.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .inbox { padding: 16px; background: rgb(240,240,245); }
    .row { padding: 8px; background: rgb(250,250,255); }
    .donetab { display: none; padding: 12px; background: rgb(230,230,240); }
    body.show-done .donetab { display: block; }
    .done-item { background: rgb(220,245,220); padding: 6px; }
    button { cursor: pointer; }
  </style></head><body>
    <main class="inbox">
      <button id="tab">Done tab</button>
      <div class="row">item one <button class="resolve">Resolve item one</button></div>
      <div class="row">item two <button class="resolve">Resolve item two</button></div>
    </main>
    <div class="donetab" id="done"></div>
    <script>
      document.getElementById('tab').onclick = () => document.body.classList.toggle('show-done');
      for (const b of document.querySelectorAll('.resolve')) b.onclick = (e) => {
        const row = e.target.closest('.row');
        const item = document.createElement('div');
        item.className = 'done-item';
        item.textContent = row.textContent;
        document.getElementById('done').appendChild(item);
        row.remove(); // selectors of remaining rows SHIFT — the drift trap
      };
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-consume-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-consume-out-${Math.random().toString(36).slice(2)}`);
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
    // done-item is renderable ONLY as a mode-view of a consumed state
    // (resolve → done tab) — it must be covered, with nothing missing.
    expect(report.coverage.missing).toEqual([]);
    // and the crawl CONVERGES: no resolved-subset lattice, no drift re-clicks.
    // base, tab-open, resolve×2, tab-inside-resolved views — single digits, not 2^n.
    expect(report.surfaces.length).toBeLessThanOrEqual(8);
    expect(report.surfaces.length).toBeGreaterThanOrEqual(4); // the two resolved-states share one structure — they dedup
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('parallel workers produce the same surface set as a serial crawl', async ({ page, browser }) => {
  // Same fixture as the mode-lattice test: three persistent modes = 7 pairwise
  // states. With 3 workers on separate contexts the SET must be identical
  // (shared dedup), coverage complete, nothing failed — parallelism buys
  // wall-clock, never coverage.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .card { cursor: grab; background: rgb(240,240,245); padding: 16px; width: 200px; }
    .detail { display: none; background: rgb(220,235,255); padding: 10px; }
    .detail.open { display: block; }
    .shared { display: none; background: rgb(255,240,220); padding: 10px; }
    .shared.open { display: block; }
    body.alt .card { background: rgb(200,220,200); }
    button { cursor: pointer; }
  </style></head><body>
    <div class="card" id="c">Draggable card (click opens detail)</div>
    <div class="detail" id="d">detail panel</div>
    <button id="a">Open shared</button><button id="b">Also open shared</button>
    <div class="shared" id="s">shared panel</div>
    <select id="sel"><option value="x">x</option><option value="alt">alt</option></select>
    <script>
      document.getElementById('c').onclick = () => document.getElementById('d').classList.add('open');
      for (const id of ['a','b']) document.getElementById(id).onclick = () => document.getElementById('s').classList.add('open');
      document.getElementById('sel').onchange = (e) => document.body.classList.toggle('alt', e.target.value === 'alt');
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-par-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-par-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  const contexts: import('@playwright/test').BrowserContext[] = [];
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
      workers: 3,
      newPage: async () => {
        const ctx = await browser.newContext();
        contexts.push(ctx);
        return ctx.newPage();
      },
    });
    expect(report.surfaces.length, 'identical pairwise lattice under parallelism').toBe(7);
    expect(report.coverage.missing).toEqual([]);
    expect(report.failed).toEqual([]);
  } finally {
    for (const ctx of contexts) await ctx.close();
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('reset-replay reaches depth >= 2: a pairwise mode-combo behind a depth-2 reset is captured, not lost to fingerprint pollution', async ({
  page,
}) => {
  // A panel (depth 1) holds two tabs and an EDIT toggle. The `.yedit` class only
  // renders in the tabY × edit COMBINATION — reachable only by resetting to the
  // tabY state (DEPTH 2: open panel → tab Y) and re-driving edit as a family
  // retry (the in-place descent excludes the parent-present edit button, so it
  // never reaches the combo forward). That reset is verified by fingerprint.
  // StyleProof injects a hover-sink <div> during a capture; if it is counted in
  // the fingerprint, the tabY state captured IN PLACE (sink present) never equals
  // the same state reached by reset+replay from a fresh load (sink absent), so the
  // depth-2 reset FAILS and `.yedit` is never rendered. Excluding the sink makes
  // the reset verify, so full coverage requires the fix.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    .hidden { display: none; } .on { display: block; }
    button:hover { outline: 1px solid red; } /* forces the hover-sink to be injected during capture */
    .xview { color: rgb(10,10,10); } .yview { color: rgb(20,20,20); }
    .xedit { color: rgb(30,30,30); } .yedit { color: rgb(40,40,40); }
  </style></head><body>
    <button id="a">open outer</button>
    <div class="hidden" id="outer"><button id="o">open panel</button>
      <div class="hidden" id="panel">
        <button id="tx">tab X</button><button id="ty">tab Y</button><button id="ed">edit</button>
        <div id="content"></div>
      </div>
    </div>
    <script>
      let tab = 'x', edit = false;
      const render = () => { content.innerHTML = '<div class="' + tab + (edit ? 'edit' : 'view') + '">' + tab + (edit ? ' editing' : ' viewing') + '</div>'; };
      a.onclick = () => { outer.classList.add('on'); };
      o.onclick = () => { panel.classList.add('on'); render(); };
      tx.onclick = () => { tab = 'x'; render(); };
      ty.onclick = () => { tab = 'y'; render(); };
      ed.onclick = () => { edit = true; render(); };
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-reset-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-reset-out-${Math.random().toString(36).slice(2)}`);
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
    // `.yedit` is reachable only by a verified reset back to the tabY state and
    // re-driving edit; with the hover-sink counted in the fingerprint that reset
    // fails, so `.yedit` goes missing. Empty missing => the fix holds.
    expect(report.coverage.missing).toEqual([]);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
