import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discoverNextRoutes } from '../dist/routes.js';
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
