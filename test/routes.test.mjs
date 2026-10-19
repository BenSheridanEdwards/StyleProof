import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discoverNextRoutes } from '../dist/routes.js';
import { assertUniqueExpandedKeys } from '../dist/runner/variants.js';
import { mkTmp, rmTmp } from './helpers.mjs';

/** Write an empty file, creating parent dirs. */
function touch(root, rel) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
}

const paths = (routes) => routes.map((r) => r.path);
const keyOf = (routes, p) => routes.find((r) => r.path === p)?.key;
const dynamicPaths = (routes) => routes.filter((r) => r.dynamic).map((r) => r.path);

// ------------------------------------------------------- App Router

test('discoverNextRoutes: App Router — page.* dirs become routes, groups stripped', () => {
  const root = mkTmp();
  try {
    touch(root, 'app/page.tsx'); // /
    touch(root, 'app/about/page.tsx'); // /about
    touch(root, 'app/(marketing)/pricing/page.tsx'); // /pricing (group stripped)
    touch(root, 'app/blog/[slug]/page.tsx'); // /blog/[slug] (dynamic)
    touch(root, 'app/layout.tsx'); // not a page → ignored
    const routes = discoverNextRoutes(root);
    assert.deepEqual(paths(routes), ['/', '/about', '/blog/[slug]', '/pricing']);
    assert.equal(keyOf(routes, '/'), 'index');
    assert.equal(keyOf(routes, '/blog/[slug]'), 'blog-slug');
    assert.deepEqual(dynamicPaths(routes), ['/blog/[slug]']);
  } finally {
    rmTmp(root);
  }
});

test('discoverNextRoutes: App Router skips private folders and intercepting routes', () => {
  const root = mkTmp();
  try {
    touch(root, 'app/feed/page.tsx'); // /feed
    touch(root, 'app/photo/page.tsx'); // /photo
    touch(root, 'app/feed/@modal/(.)photo/page.tsx'); // intercepts /photo — not a URL
    touch(root, 'app/(..)settings/page.tsx'); // intercepting — not a URL
    touch(root, 'app/(...)help/page.tsx'); // intercepting — not a URL
    touch(root, 'app/_drafts/page.tsx'); // private folder — not routable
    touch(root, 'app/docs/_parts/intro/page.tsx'); // under a private folder — not routable
    assert.deepEqual(paths(discoverNextRoutes(root)), ['/feed', '/photo']);
  } finally {
    rmTmp(root);
  }
});

test('discoverNextRoutes: App Router under src/, catch-all is dynamic', () => {
  const root = mkTmp();
  try {
    touch(root, 'src/app/page.tsx');
    touch(root, 'src/app/docs/[...path]/page.mdx');
    const routes = discoverNextRoutes(root);
    assert.deepEqual(paths(routes), ['/', '/docs/[...path]']);
    assert.equal(keyOf(routes, '/docs/[...path]'), 'docs-all-path');
    assert.deepEqual(dynamicPaths(routes), ['/docs/[...path]']);
  } finally {
    rmTmp(root);
  }
});

// ------------------------------------------------------- Pages Router

test('discoverNextRoutes: Pages Router — index collapses, _app/_document/api excluded', () => {
  const root = mkTmp();
  try {
    touch(root, 'pages/index.tsx'); // /
    touch(root, 'pages/about.tsx'); // /about
    touch(root, 'pages/blog/index.tsx'); // /blog
    touch(root, 'pages/blog/[id].tsx'); // /blog/[id] (dynamic)
    touch(root, 'pages/_app.tsx'); // excluded
    touch(root, 'pages/_document.tsx'); // excluded
    touch(root, 'pages/api/hook.ts'); // excluded (api)
    const routes = discoverNextRoutes(root);
    assert.deepEqual(paths(routes), ['/', '/about', '/blog', '/blog/[id]']);
    assert.deepEqual(dynamicPaths(routes), ['/blog/[id]']);
  } finally {
    rmTmp(root);
  }
});

// ------------------------------------------------------- key collisions (#874)

/** Keys by path for a temp App Router tree holding exactly these route dirs. */
function appKeys(routeDirs) {
  const root = mkTmp();
  try {
    for (const d of routeDirs) touch(root, path.join('app', d, 'page.tsx'));
    return Object.fromEntries(discoverNextRoutes(root).map((r) => [r.path, r.key]));
  } finally {
    rmTmp(root);
  }
}

test('discoverNextRoutes: routes whose keys collide get distinct keys, and the generated spec loads', () => {
  const root = mkTmp();
  try {
    for (const d of ['', 'about-us', 'about_us', 'blog/[slug]', 'blog/slug'])
      touch(root, path.join('app', d, 'page.tsx'));
    const routes = discoverNextRoutes(root);
    const keys = routes.map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, `keys must be distinct: ${keys}`);
    const staticRoutes = routes.filter((r) => !r.dynamic);
    assert.doesNotThrow(() => assertUniqueExpandedKeys(staticRoutes.map((r) => ({ key: r.key }))));
    const staticKeys = new Set(staticRoutes.map((r) => r.key));
    for (const r of routes.filter((x) => x.dynamic))
      assert.ok(!staticKeys.has(r.key), `exclude key '${r.key}' names a surface`);
    assert.equal(keyOf(routes, '/'), 'index');
  } finally {
    rmTmp(root);
  }
});

test("discoverNextRoutes: adding a route to a collision does not change the existing colliders' keys", () => {
  const before = appKeys(['about-us', 'about_us']);
  const after = appKeys(['about-us', 'about_us', 'about--us']);
  assert.equal(after['/about-us'], before['/about-us']);
  assert.equal(after['/about_us'], before['/about_us']);
  assert.equal(new Set(Object.values(after)).size, 3);
});

test('discoverNextRoutes: keys without a collision are unchanged', () => {
  assert.deepEqual(appKeys(['', 'about', 'blog/[slug]', 'docs/[...path]', 'About_Us/Team']), {
    '/': 'index',
    '/about': 'about',
    '/blog/[slug]': 'blog-slug',
    '/docs/[...path]': 'docs-all-path',
    '/About_Us/Team': 'about-us-team',
  });
});

// ------------------------------------------------------- mixed / empty

test('discoverNextRoutes: App + Pages merge, dedupe by path (App wins)', () => {
  const root = mkTmp();
  try {
    touch(root, 'app/page.tsx'); // / (App)
    touch(root, 'pages/index.tsx'); // / (Pages) — deduped
    touch(root, 'pages/legacy.tsx'); // /legacy
    const routes = discoverNextRoutes(root);
    assert.deepEqual(paths(routes), ['/', '/legacy']);
  } finally {
    rmTmp(root);
  }
});

test('discoverNextRoutes: no app/ or pages/ dir → empty (not a Next project)', () => {
  const root = mkTmp();
  try {
    touch(root, 'src/components/Button.tsx');
    assert.deepEqual(discoverNextRoutes(root), []);
  } finally {
    rmTmp(root);
  }
});
