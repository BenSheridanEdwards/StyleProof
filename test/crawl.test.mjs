import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  selectCrawlLinks,
  defaultLinkKey,
  crawlCoverageGaps,
  crawlCoverageError,
  uniqueKeyFor,
} from '../dist/crawl.js';
import { crawlAndCapture } from '../dist/crawl-surfaces.js';
import { performance } from 'node:perf_hooks';

const BASE = 'https://app.test/';
const pick = (hrefs, opts = {}) => selectCrawlLinks(hrefs, { base: BASE, ...opts });

// Browser-free worker fixture. Only resets of Alpha/Beta are delayed; browser
// operations otherwise finish immediately. Captures deliberately fail because
// this fixture exercises discovery/key allocation, without writing map files.
async function scheduledSurfaceKeys(first, { defined = ['unrendered'], ...overrides } = {}) {
  const candidate = (selector, label) => ({ action: 'click', selector, label, identity: selector, unsafe: false });
  const controls = {
    root: [candidate('alpha', 'Alpha'), candidate('beta', 'Beta')],
    alpha: [candidate('alpha-pricing', 'Pricing'), candidate('alpha-pricing-2', 'Pricing 2')],
    beta: [candidate('beta-pricing', 'Pricing')],
  };
  const arrivals = [];
  const scheduled = new Set();
  const resetOrder = [];
  const keys = [];
  const usedKeys = new Set(['base']);
  const newPage = async () => {
    let state = 'root';
    let fresh = false;
    return {
      on() {},
      off() {},
      url: () => BASE,
      async $$eval() {
        return []; // No nav links: this fixture exercises one page's in-place sweep.
      },
      async setViewportSize() {},
      async waitForTimeout() {},
      async goto() {
        state = 'root';
        fresh = true;
      },
      locator(selector) {
        return {
          first() {
            return this;
          },
          async waitFor() {},
          async scrollIntoViewIfNeeded() {},
          async isVisible() {
            return true;
          },
          async evaluate() {
            state = selector;
            return true;
          },
        };
      },
      async evaluate(fn) {
        if (fn.name === 'collectBoundaryMetadata') return { auth: [], incompleteUi: [] };
        if (fn.name === 'collectDefinedClasses') return { classes: defined, unreadable: [] };
        if (fn.name === 'collectClickable') return controls[state] ?? [];
        if (fn.name === 'domShape') {
          if (fresh && (state === 'alpha' || state === 'beta') && !scheduled.has(state)) {
            scheduled.add(state);
            await new Promise((resolve) => {
              arrivals.push({ state, resolve });
              if (arrivals.length === 2) {
                arrivals.find((a) => a.state === first).resolve();
                setTimeout(() => arrivals.find((a) => a.state !== first).resolve(), 40);
              }
            });
            resetOrder.push(state);
          }
          fresh = false;
          return { shape: state, elements: 10, classes: [state] };
        }
        if (fn.name === 'installHoverSink') throw new Error('capture unavailable in worker fixture');
        return 10; // DOM settle count; other navigation-only browser callbacks are inert.
      },
    };
  };
  const report = await crawlAndCapture(await newPage(), {
    url: BASE,
    out: new URL('../.takeover/', import.meta.url).pathname,
    widths: [1280],
    height: 800,
    ignore: [],
    screenshots: false,
    dataStates: false,
    resetStorage: false,
    stopWhenCovered: true,
    workers: 2,
    newPage,
    maxDepth: 3,
    maxActionsPerState: 10,
    maxStates: 20,
    usedKeys,
    onSurface(surface, ok) {
      assert.equal(ok, false, 'fixture captures must fail explicitly');
      keys.push([surface.path.map((s) => s.selector).join('/'), surface.key]);
    },
    ...overrides,
  });
  assert.deepEqual(resetOrder, [first, first === 'alpha' ? 'beta' : 'alpha']);
  assert.deepEqual(
    report.failed,
    keys.map(([, key]) => key),
  );
  const prefix = uniqueKeyFor(pick(['/pricing-3'])[0].key, usedKeys);
  return { keys, prefix };
}

test('multi-page keys stay identical when worker resets finish in opposite orders', async () => {
  const alphaFirst = await scheduledSurfaceKeys('alpha');
  const betaFirst = await scheduledSurfaceKeys('beta');
  assert.deepEqual(betaFirst, alphaFirst);
  assert.deepEqual(alphaFirst, {
    keys: [
      ['', 'base'],
      ['alpha', 'alpha'],
      ['beta', 'beta'],
      ['alpha/alpha-pricing', 'pricing'],
      ['alpha/alpha-pricing-2', 'pricing-2'],
      ['beta/beta-pricing', 'pricing-3'],
    ],
    prefix: 'pricing-3-2',
  });
});

test('queued workers recheck coverage and state limits in deterministic sweep order', async () => {
  for (const options of [{ defined: ['alpha-pricing'] }, { maxStates: 4 }]) {
    const alphaFirst = await scheduledSurfaceKeys('alpha', options);
    const betaFirst = await scheduledSurfaceKeys('beta', options);
    assert.deepEqual(betaFirst, alphaFirst);
    assert.equal(alphaFirst.keys.length, options.maxStates ?? 5);
    assert.ok(!alphaFirst.keys.some(([selector]) => selector === 'beta/beta-pricing'));
  }
});

// Browser-free unsafe-control fixture: captures fail explicitly while discovery
// visits both the root and an in-place child with a repeated control identity.
async function crawlUnsafeControls(unsafe = true) {
  const candidate = (selector, label, isUnsafe = false) => ({
    action: 'click',
    selector,
    label,
    reason: 'button',
    identity: `button|${label}|`,
    unsafe: isUnsafe,
  });
  const controls = {
    root: [candidate('#payments', 'Payments', unsafe), candidate('#open', 'Open details')],
    '#open': [
      candidate('#payments', 'Payments', unsafe),
      candidate('#open', 'Open details'),
      candidate('button[aria-label="Delete draft"]', 'Delete draft', unsafe),
    ],
  };
  const clicked = [];
  let state = 'root';
  const page = {
    on() {},
    off() {},
    url: () => BASE,
    async $$eval() {
      return []; // No nav links: this fixture exercises one page's in-place sweep.
    },
    async setViewportSize() {},
    async waitForTimeout() {},
    async goto() {
      state = 'root';
    },
    locator(selector) {
      return {
        first() {
          return this;
        },
        async waitFor() {},
        async scrollIntoViewIfNeeded() {},
        async isVisible() {
          return true;
        },
        async evaluate() {
          clicked.push(selector);
          if (controls[selector]) state = selector;
          return true;
        },
      };
    },
    async evaluate(fn) {
      if (fn.name === 'collectBoundaryMetadata') return { auth: [], incompleteUi: [] };
      if (fn.name === 'collectDefinedClasses') return { classes: [], unreadable: [] };
      if (fn.name === 'collectClickable') return controls[state] ?? [];
      if (fn.name === 'domShape') return { shape: state, elements: 10, classes: [state] };
      if (fn.name === 'installHoverSink') throw new Error('capture unavailable in unsafe-control fixture');
      return 10;
    },
  };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-unsafe-'));
  try {
    const report = await crawlAndCapture(page, {
      url: BASE,
      out,
      widths: [1280],
      height: 800,
      ignore: [],
      screenshots: false,
      dataStates: false,
      resetStorage: false,
      stopWhenCovered: false,
      workers: 1,
      maxDepth: 3,
      maxActionsPerState: 10,
      maxStates: 20,
    });
    return { report, clicked };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test('crawl names unsafe skips once on their surfaces and never certifies them as complete', async () => {
  const { report, clicked } = await crawlUnsafeControls();
  assert.equal(clicked.includes('#payments'), false);
  assert.equal(clicked.includes('button[aria-label="Delete draft"]'), false);
  assert.deepEqual(report.incompleteUi, [
    {
      surface: 'base',
      diagnostics: [{ kind: 'unsafe-control', reason: 'destructive-label', selector: '#payments' }],
    },
    {
      surface: 'open-details',
      diagnostics: [{ kind: 'unsafe-control', reason: 'destructive-label' }],
    },
  ]);
  assert.equal(report.actionsTried, 1);
  assert.equal(report.skipped, 2);
  assert.equal(report.confidence.status, 'incomplete-unknown');
  assert.equal(report.confidence.certifiesFully, false);
  const serialized = JSON.stringify({ incompleteUi: report.incompleteUi, confidence: report.confidence });
  assert.equal(serialized.includes('Payments'), false);
  assert.equal(serialized.includes('Delete draft'), false);
});

test('crawl with only safe controls has no unsafe gaps and retains complete confidence', async () => {
  const { report, clicked } = await crawlUnsafeControls(false);
  assert.ok(clicked.includes('#payments'));
  assert.ok(clicked.includes('button[aria-label="Delete draft"]'));
  assert.deepEqual(report.incompleteUi, []);
  assert.equal(report.actionsTried, 3);
  assert.equal(report.skipped, 0);
  assert.equal(report.confidence.status, 'complete');
  assert.equal(report.confidence.certifiesFully, true);
});

// Browser-free navigation fixture. Captures fail explicitly; the crawl still
// exercises link discovery, setup, data-state reloads and their cleanup.
function navigationPage({ reloadError, cleanupError } = {}) {
  const jar = new Set();
  const log = [];
  const gotos = [];
  const requestHandlers = new Set();
  let routed = false;
  let initScripts = 0;
  let reloads = 0;
  let state = 'base';
  const page = {
    on(event, handler) {
      if (event === 'request') requestHandlers.add(handler);
    },
    off(event, handler) {
      if (event === 'request') requestHandlers.delete(handler);
    },
    url: () => BASE,
    async $$eval() {
      return [];
    },
    async setViewportSize() {},
    async waitForTimeout() {},
    async addInitScript() {
      initScripts++;
    },
    context() {
      return {
        async addCookies(cookies) {
          log.push('add');
          for (const cookie of cookies) jar.add(cookie.name);
        },
        async clearCookies({ name }) {
          log.push('clear');
          if (cleanupError) throw cleanupError;
          jar.delete(name);
        },
      };
    },
    async route() {
      routed = true;
    },
    async unroute() {
      log.push('unroute');
      routed = false;
    },
    async goto() {
      for (const handler of requestHandlers) handler({ resourceType: () => 'fetch' });
      gotos.push({ routed, kept: jar.has('styleproof-keep-storage') });
      if (routed && reloadError) throw reloadError;
      state = routed ? `data-${++reloads}` : 'base';
    },
    locator() {
      return {
        first() {
          return this;
        },
        async waitFor() {},
      };
    },
    async evaluate(fn) {
      if (fn.name === 'collectBoundaryMetadata') return { auth: [], incompleteUi: [] };
      if (fn.name === 'collectDefinedClasses') return { classes: [], unreadable: [] };
      if (fn.name === 'collectClickable') return [];
      if (fn.name === 'domShape') return { shape: state, elements: 10, classes: [state] };
      if (fn.name === 'installHoverSink') throw new Error('capture unavailable in navigation fixture');
      return 10;
    },
  };
  return { page, jar, log, gotos, initScripts: () => initScripts, routed: () => routed };
}

function navigationOptions(out, overrides = {}) {
  return {
    url: BASE,
    out,
    widths: [1280],
    height: 800,
    ignore: [],
    screenshots: false,
    dataStates: false,
    resetStorage: false,
    workers: 1,
    maxDepth: 3,
    maxActionsPerState: 10,
    maxStates: 20,
    ...overrides,
  };
}

test('a rejected link read fails the crawl instead of reading as no links', async () => {
  const { page } = navigationPage();
  page.$$eval = async () => {
    throw new Error('Execution context was destroyed');
  };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-links-'));
  try {
    await assert.rejects(crawlAndCapture(page, navigationOptions(out)), /Execution context was destroyed/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('followLinks: false never reads links', async () => {
  const { page } = navigationPage();
  let reads = 0;
  page.$$eval = async () => {
    reads++;
    return ['/about'];
  };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-links-'));
  try {
    const disabled = await crawlAndCapture(page, navigationOptions(out, { followLinks: false }));
    assert.equal(reads, 0);
    assert.deepEqual(disabled.links, []);
    const enabled = await crawlAndCapture(page, navigationOptions(out));
    assert.equal(reads, 1);
    assert.deepEqual(enabled.links, pick(['/about']));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the keep marker spares exactly the data-state reloads and the reset is armed once per page', async () => {
  const fixture = navigationPage();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-storage-'));
  try {
    for (let i = 0; i < 2; i++) {
      const start = fixture.gotos.length;
      fixture.log.length = 0;
      const report = await crawlAndCapture(
        fixture.page,
        navigationOptions(out, {
          resetStorage: true,
          dataStates: true,
          setup: [{ action: 'waitFor', selector: '#app' }],
        }),
      );
      const gotos = fixture.gotos.slice(start);
      assert.ok(
        gotos.some((load) => !load.routed),
        'fresh loads must also be checked',
      );
      assert.equal(gotos.filter((load) => load.routed).length, 2);
      assert.ok(gotos.every((load) => load.kept === load.routed));
      assert.deepEqual(
        report.surfaces.map((surface) => surface.key),
        ['base', 'loading', 'error'],
      );
      assert.equal(fixture.jar.size, 0);
      assert.equal(fixture.routed(), false);
      assert.deepEqual(fixture.log, ['add', 'clear', 'unroute', 'add', 'clear', 'unroute']);
    }
    assert.equal(fixture.initScripts(), 1);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a data-state reload failing before commit leaves no marker and reports its own error', async () => {
  const reloadError = new Error('net::ERR_CONNECTION_RESET');
  const cleanupError = new Error('context closed');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-storage-'));
  try {
    for (const errors of [{ reloadError }, { reloadError, cleanupError }, { cleanupError }]) {
      const fixture = navigationPage(errors);
      await assert.rejects(
        crawlAndCapture(
          fixture.page,
          navigationOptions(out, {
            resetStorage: true,
            dataStates: true,
            setup: [{ action: 'waitFor', selector: '#app' }],
          }),
        ),
        (error) => error === (errors.reloadError ?? errors.cleanupError),
      );
      if (!errors.cleanupError) assert.equal(fixture.jar.size, 0);
      assert.equal(fixture.routed(), false);
      assert.deepEqual(fixture.log, ['add', 'clear', 'unroute']);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- selectCrawlLinks

test('selectCrawlLinks: tab-SPA links — keyed by query value, root-relative url', () => {
  const links = pick(['/?tab=overview', '/?tab=faults']);
  assert.deepEqual(links, [
    { key: 'overview', url: '/?tab=overview' },
    { key: 'faults', url: '/?tab=faults' },
  ]);
});

test('selectCrawlLinks: includeSelf captures the crawl root as the first surface, deduped', () => {
  // A single-page app (no links) or a nav that doesn't link back to '/' still yields
  // the root as a surface — always covered, never doubled.
  assert.deepEqual(pick([], { includeSelf: true }), [{ key: 'index', url: '/' }]);
  assert.deepEqual(
    pick(['/about', '/'], { includeSelf: true }),
    [
      { key: 'index', url: '/' },
      { key: 'about', url: '/about' },
    ],
    'root first, and a nav-linked "/" is not duplicated',
  );
  // Without includeSelf, the root is a surface only if the nav links to it.
  assert.deepEqual(pick(['/about'], {}), [{ key: 'about', url: '/about' }]);
});

test('selectCrawlLinks: resolves relative + absolute same-origin hrefs alike', () => {
  const links = pick(['/?tab=a', 'https://app.test/?tab=b', '?tab=c']);
  assert.deepEqual(
    links.map((l) => l.url),
    ['/?tab=a', '/?tab=b', '/?tab=c'],
  );
});

test('selectCrawlLinks: dedupes by path+query, keeps first-seen order', () => {
  const links = pick(['/?tab=b', '/?tab=a', '/?tab=b']);
  assert.deepEqual(
    links.map((l) => l.key),
    ['b', 'a'],
  );
});

test('selectCrawlLinks: drops external, mailto/tel/javascript, and falsy hrefs', () => {
  const links = pick([
    'https://evil.test/?tab=x', // external origin
    'mailto:a@b.com',
    'tel:+1',
    'javascript:void(0)',
    null,
    '',
    '/?tab=keep',
  ]);
  assert.deepEqual(links, [{ key: 'keep', url: '/?tab=keep' }]);
});

test('selectCrawlLinks: a bare fragment of the crawl root is not a surface', () => {
  // base is "/", so "#main" → "/#main" → same page; but "/?tab=a#top" is a real surface.
  const links = pick(['#main', '/?tab=a#top']);
  assert.deepEqual(links, [{ key: 'a', url: '/?tab=a' }]); // hash stripped from the navigable url
});

test('selectCrawlLinks: match narrows by RegExp, substring, and predicate', () => {
  const hrefs = ['/?tab=a', '/help', '/about'];
  assert.deepEqual(
    pick(hrefs, { match: /\?tab=/ }).map((l) => l.url),
    ['/?tab=a'],
  );
  assert.deepEqual(
    pick(hrefs, { match: 'tab=' }).map((l) => l.url),
    ['/?tab=a'],
  );
  assert.deepEqual(
    pick(hrefs, { match: (u) => u.pathname === '/about' }).map((l) => l.url),
    ['/about'],
  );
});

test('selectCrawlLinks: trailing slash is not a distinct surface — /about and /about/ collapse to one', () => {
  // Before the fix these dedupe by raw url (distinct) yet key identically (`about`),
  // so the second capture silently overwrote the first. First-seen href wins.
  assert.deepEqual(pick(['/about', '/about/']), [{ key: 'about', url: '/about' }]);
  assert.deepEqual(pick(['/about/', '/about']), [{ key: 'about', url: '/about/' }]);
});

test('selectCrawlLinks: a malformed slash-heavy path is handled without blocking the crawl', () => {
  const startedAt = performance.now();
  const links = pick(['/a' + '/'.repeat(40_000) + 'x']);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(links.length, 1);
  assert.ok(elapsedMs < 250, `slash-heavy path took ${elapsedMs.toFixed(1)}ms`);
});

test('selectCrawlLinks: root "/" keeps its slash; the query is never trailing-slash-stripped', () => {
  assert.deepEqual(pick(['/', '/?a=1']), [
    { key: 'index', url: '/' },
    { key: '1', url: '/?a=1' },
  ]);
});

test('selectCrawlLinks: /index.html collapses into / — one surface, first-seen url wins', () => {
  // A static multi-page site whose nav links the .html files: `/` and `/index.html`
  // are the same route, so they must dedupe to ONE surface (else the diff captures and
  // reports every finding twice). First-seen href keeps its original form.
  assert.deepEqual(pick(['/', '/index.html']), [{ key: 'index', url: '/' }]);
  assert.deepEqual(pick(['/index.html', '/']), [{ key: 'index-html', url: '/index.html' }]);
});

test('selectCrawlLinks: nested /dir/index.html collapses into the directory (/dir, /dir/, /dir/index.html are one)', () => {
  assert.deepEqual(pick(['/docs', '/docs/index.html']), [{ key: 'docs', url: '/docs' }]);
  assert.deepEqual(pick(['/docs/', '/docs/index.html']), [{ key: 'docs', url: '/docs/' }]);
  assert.deepEqual(pick(['/docs/index.html', '/docs/']), [{ key: 'docs-index-html', url: '/docs/index.html' }]);
});

test('selectCrawlLinks: a genuine about.html is NOT collapsed into about — only index.html normalizes', () => {
  const links = pick(['/about', '/about.html']);
  assert.equal(links.length, 2);
  assert.deepEqual(
    links.map((l) => l.url),
    ['/about', '/about.html'],
  );
});

test('selectCrawlLinks: genuinely different surfaces with a colliding key both survive via -2 suffix', () => {
  // /a/b, /a-b, /a_b are three distinct routes that all slugify to `a-b` under
  // defaultLinkKey; without disambiguation the later ones overwrite the first's map
  // file. First wins bare, next gets `-2`, then `-3`.
  const links = pick(['/a/b', '/a-b', '/a_b']);
  assert.deepEqual(
    links.map((l) => l.key),
    ['a-b', 'a-b-2', 'a-b-3'],
  );
  assert.deepEqual(
    links.map((l) => l.url),
    ['/a/b', '/a-b', '/a_b'],
  );
});

test('selectCrawlLinks: custom key overrides the default scheme', () => {
  const links = pick(['/?tab=overview'], { key: (u) => `view-${u.searchParams.get('tab')}` });
  assert.deepEqual(links, [{ key: 'view-overview', url: '/?tab=overview' }]);
});

test('selectCrawlLinks: malformed href is skipped, never thrown', () => {
  assert.doesNotThrow(() => pick(['http://[', '/?tab=ok']));
  assert.deepEqual(
    pick(['http://[', '/?tab=ok']).map((l) => l.key),
    ['ok'],
  );
});

// ------------------------------------------------------- defaultLinkKey

test('defaultLinkKey: query value wins for a single-route tab SPA', () => {
  assert.equal(defaultLinkKey(new URL('https://app.test/?tab=overview')), 'overview');
});

test('defaultLinkKey: path segments slugify; root is "index"', () => {
  assert.equal(defaultLinkKey(new URL('https://app.test/')), 'index');
  assert.equal(defaultLinkKey(new URL('https://app.test/blog/post')), 'blog-post');
});

test('defaultLinkKey: path + query values combine', () => {
  assert.equal(defaultLinkKey(new URL('https://app.test/shop?cat=shoes')), 'shop-shoes');
});

test('defaultLinkKey: param order does not flap the key — values join in sorted-by-name order', () => {
  // ?tab=a&x=b and ?x=b&tab=a are the same logical route; before the fix they keyed
  // a-b vs b-a, flapping the coverage guard into phantom regressions.
  assert.equal(defaultLinkKey(new URL('https://app.test/?tab=a&x=b')), 'a-b');
  assert.equal(defaultLinkKey(new URL('https://app.test/?x=b&tab=a')), 'a-b');
  assert.equal(
    defaultLinkKey(new URL('https://app.test/?tab=a&x=b')),
    defaultLinkKey(new URL('https://app.test/?x=b&tab=a')),
  );
});

test('defaultLinkKey: a hash-router route keys by the route, not by discovery position', () => {
  assert.equal(defaultLinkKey(new URL('https://app.test/#/settings')), 'settings');
  assert.equal(defaultLinkKey(new URL('https://app.test/#!/settings')), 'settings');
  assert.equal(defaultLinkKey(new URL('https://app.test/app#/billing/plans')), 'app-billing-plans');
  assert.equal(defaultLinkKey(new URL('https://app.test/#/search?q=shoes')), 'search-shoes');
});

test('defaultLinkKey: a plain fragment stays out of the key', () => {
  assert.equal(defaultLinkKey(new URL('https://app.test/docs#intro')), 'docs');
  assert.equal(defaultLinkKey(new URL('https://app.test/#top')), 'index');
});

// ------------------------------------------------------- crawlCoverageGaps

test('crawlCoverageGaps: rendered nav reconciles clean against a matching expected', () => {
  assert.deepEqual(crawlCoverageGaps(['index', 'pricing'], ['index', 'pricing']), {
    missing: [],
    unexpected: [],
    staleExclusions: [],
  });
});

test('crawlCoverageGaps: a key named like an Object.prototype member is never excluded by inheritance', () => {
  assert.deepEqual(crawlCoverageGaps(['index', 'toString'], ['index', 'constructor']), {
    missing: ['constructor'],
    unexpected: ['toString'],
    staleExclusions: [],
  });
});

test('crawlCoverageGaps: an expected key with no rendered link is a nav regression', () => {
  // `pricing` is in the registry but the nav stopped linking to it.
  assert.deepEqual(crawlCoverageGaps(['index'], ['index', 'pricing']), {
    missing: ['pricing'],
    unexpected: [],
    staleExclusions: [],
  });
});

test('crawlCoverageGaps: a rendered link absent from expected is a route with no owner', () => {
  // A new page shipped in the nav that nobody added to the registry.
  assert.deepEqual(crawlCoverageGaps(['index', 'pricing'], ['index']), {
    missing: [],
    unexpected: ['pricing'],
    staleExclusions: [],
  });
});

test('crawlCoverageGaps: exclude silences a conditional link both directions', () => {
  // A feature-flagged link that may or may not render. Excluding it keeps the guard
  // green whether it appears (not "unexpected") or not (not "missing").
  assert.deepEqual(
    crawlCoverageGaps(['index', 'pricing'], ['index'], { pricing: 'feature-flagged, renders only when flag on' }),
    { missing: [], unexpected: [], staleExclusions: [] },
  );
  assert.deepEqual(
    crawlCoverageGaps(['index'], ['index', 'pricing'], { pricing: 'feature-flagged, renders only when flag on' }),
    { missing: [], unexpected: [], staleExclusions: [] },
  );
});

test('crawlCoverageGaps: an exclude key in neither expected nor the nav is stale', () => {
  assert.deepEqual(crawlCoverageGaps(['index'], ['index'], { gone: 'removed route' }), {
    missing: [],
    unexpected: [],
    staleExclusions: ['gone'],
  });
  // But an exclude key still present in the rendered nav is NOT stale (it's live).
  assert.deepEqual(crawlCoverageGaps(['index', 'beta'], ['index'], { beta: 'flagged' }).staleExclusions, []);
});

test('crawlCoverageError: null when clean, a named message per failing direction', () => {
  assert.equal(crawlCoverageError('/', ['index'], ['index']), null);
  const unowned = crawlCoverageError('/', ['index', 'pricing'], ['index']);
  assert.match(unowned, /styleproof crawl coverage gap:/);
  assert.match(unowned, /new route\(s\) with no owner.*pricing/);
  const regressed = crawlCoverageError('/', ['index'], ['index', 'pricing']);
  assert.match(regressed, /nav regression.*pricing/);
});

// ------------------------------------------------------- selectObservedNavs

import { selectObservedNavs, dedupIdentity } from '../dist/crawl.js';

const observe = (hrefs, opts = {}) => {
  const seen = opts.seen ?? new Set();
  const usedKeys = opts.usedKeys ?? new Set();
  return { links: selectObservedNavs(hrefs, { base: BASE, seen, usedKeys, ...opts }), seen, usedKeys };
};

test('selectObservedNavs: client-route pushStates become keyed surfaces', () => {
  const { links } = observe(['https://app.test/?view=overview', 'https://app.test/settings']);
  assert.deepEqual(links, [
    { key: 'overview', url: '/?view=overview' },
    { key: 'settings', url: '/settings' },
  ]);
});

test('selectObservedNavs: drops external, malformed, and non-http navigations', () => {
  const { links } = observe(['https://evil.test/x', 'http://[::1', 'javascript:void(0)', null, '/keep']);
  assert.deepEqual(links, [{ key: 'keep', url: '/keep' }]);
});

test('selectObservedNavs: dedupes against the rendered-link frontier via shared seen', () => {
  const seen = new Set([dedupIdentity('/?view=overview')]);
  const usedKeys = new Set(['index', 'overview']);
  const { links } = observe(['https://app.test/?view=overview', 'https://app.test/dashboard'], { seen, usedKeys });
  assert.deepEqual(links, [{ key: 'dashboard', url: '/dashboard' }], 'already-linked route is not re-captured');
});

test('selectObservedNavs: disambiguates a key that collides with a link surface', () => {
  // A nav link /a?tab=x already claimed key `a-x`; an observed /a?view=x keys
  // identically (path segments + param values) — it must survive as `a-x-2`,
  // never silently overwrite the first surface's map.
  const seen = new Set([dedupIdentity('/a?tab=x')]);
  const usedKeys = new Set(['a-x']);
  const { links } = observe(['https://app.test/a?view=x'], { seen, usedKeys });
  assert.deepEqual(links, [{ key: 'a-x-2', url: '/a?view=x' }]);
});

test('selectObservedNavs: keeps the fragment — a pushState hash route is a distinct surface', () => {
  const { links } = observe(['https://app.test/#/dashboard']);
  assert.deepEqual(links.length, 1);
  assert.equal(links[0].url, '/#/dashboard', 'hash kept so the route navigates to its content');
});

test('selectObservedNavs: hash routes pair by route on base and head, whatever the discovery order', () => {
  const crawl = (hrefs) => observe(hrefs, { usedKeys: new Set(['index']) }).links;
  const base = crawl(['https://app.test/#/settings', 'https://app.test/#/billing']);
  const head = crawl(['https://app.test/#/new', 'https://app.test/#/settings', 'https://app.test/#/billing']);
  const byUrl = (links) => Object.fromEntries(links.map((l) => [l.url, l.key]));
  assert.deepEqual(byUrl(base), { '/#/settings': 'settings', '/#/billing': 'billing' });
  assert.deepEqual(byUrl(head), { '/#/new': 'new', '/#/settings': 'settings', '/#/billing': 'billing' });
});

test('selectObservedNavs: match filter applies to observed URLs the same as links', () => {
  const { links } = observe(['https://app.test/?view=a', 'https://app.test/other'], { match: /\?view=/ });
  assert.deepEqual(links, [{ key: 'a', url: '/?view=a' }]);
});

test('selectObservedNavs: repeated drains stay deduped across passes', () => {
  const seen = new Set();
  const usedKeys = new Set();
  observe(['https://app.test/one'], { seen, usedKeys });
  const second = observe(['https://app.test/one', 'https://app.test/two'], { seen, usedKeys });
  assert.deepEqual(second.links, [{ key: 'two', url: '/two' }], 'pass-one route is not re-emitted');
});

test('dedupIdentity: query parameter order does not create a second surface', () => {
  assert.equal(dedupIdentity('/shop?cat=shoes&page=2'), dedupIdentity('/shop?page=2&cat=shoes'));
  assert.equal(dedupIdentity('/list?tag=b&tag=a'), '/list?tag=b&tag=a', 'repeated names keep their order');
  assert.notEqual(dedupIdentity('/list?tag=b&tag=a'), dedupIdentity('/list?tag=a&tag=b'));
  // Only the query is sorted: a hash-router fragment (with its own `?…&…`) is kept as-is.
  assert.equal(dedupIdentity('/s?b=1&a=2#/x'), dedupIdentity('/s?a=2&b=1#/x'));
  assert.notEqual(dedupIdentity('/?lang=en#/search?q=x&page=2'), dedupIdentity('/?page=2&lang=en#/search?q=x'));
  assert.equal(dedupIdentity('/p#/route?b=1&a=2'), '/p#/route?b=1&a=2');
});
