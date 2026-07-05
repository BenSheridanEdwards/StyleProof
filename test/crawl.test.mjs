import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCrawlLinks, defaultLinkKey, crawlCoverageGaps, crawlCoverageError } from '../dist/crawl.js';

const BASE = 'https://app.test/';
const pick = (hrefs, opts = {}) => selectCrawlLinks(hrefs, { base: BASE, ...opts });

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

// ------------------------------------------------------- crawlCoverageGaps

test('crawlCoverageGaps: rendered nav reconciles clean against a matching expected', () => {
  assert.deepEqual(crawlCoverageGaps(['index', 'pricing'], ['index', 'pricing']), {
    missing: [],
    unexpected: [],
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
