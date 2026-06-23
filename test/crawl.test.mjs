import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCrawlLinks, defaultLinkKey } from '../dist/crawl.js';

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
