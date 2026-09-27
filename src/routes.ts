import fs from 'node:fs';
import path from 'node:path';

/**
 * Best-effort Next.js route discovery from the filesystem (App Router `app/` / `src/app/` page
 * directories, Pages Router `pages/` / `src/pages/` minus `_app`/`_document`/`api`), so a generated
 * spec's `expected` reflects the app's CURRENT routes. A heuristic, not a router.
 */

export type DiscoveredRoute = {
  /** Filename-safe surface key (`/` → `index`, `/blog/[slug]` → `blog-slug`). */
  key: string;
  /** URL path to navigate (`/`, `/about`, `/blog/[slug]`). */
  path: string;
  /** True when a segment is a `[param]` / `[...catchall]` — can't be navigated as-is. */
  dynamic: boolean;
};

const APP_PAGE_RE = /^page\.(?:js|jsx|ts|tsx|mdx)$/;
const PAGES_EXT_RE = /\.(?:js|jsx|ts|tsx)$/;

const isGroupOrSlot = (seg: string): boolean => /^\(.*\)$/.test(seg) || seg.startsWith('@');
const isDynamicSeg = (seg: string): boolean => /\[.*\]/.test(seg);
/** App Router folders that are never URL segments: private `_folder`s and intercepting `(.)x` / `(..)x` / `(...)x`. */
const isUnroutableAppDir = (seg: string): boolean => seg.startsWith('_') || /^\(\.+\)/.test(seg);

/** Filename-safe, readable key from a route path. */
function toKey(routePath: string): string {
  if (routePath === '/') return 'index';
  const k = routePath
    .replace(/^\//, '')
    .replace(/\[\[?\.\.\.([^\]]+)\]\]?/g, 'all-$1') // [...x] / [[...x]] → all-x
    .replace(/\[([^\]]+)\]/g, '$1') // [x] → x
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return k || 'index';
}

function makeRoute(segs: string[]): DiscoveredRoute {
  const routePath = segs.length ? '/' + segs.join('/') : '/';
  return { key: toKey(routePath), path: routePath, dynamic: segs.some(isDynamicSeg) };
}

function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable dir → no routes, never throw into a spec
  }
}

/** App Router: a directory holding a `page.*` is a route; nest by sub-directory. */
function appRoutes(appDir: string): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const walk = (dir: string, segs: string[]): void => {
    const entries = readDir(dir);
    if (entries.some((e) => e.isFile() && APP_PAGE_RE.test(e.name))) {
      out.push(makeRoute(segs.filter((s) => !isGroupOrSlot(s))));
    }
    for (const e of entries) {
      if (e.isDirectory() && !isUnroutableAppDir(e.name)) walk(path.join(dir, e.name), [...segs, e.name]);
    }
  };
  walk(appDir, []);
  return out;
}

/** Pages Router: each page file is a route; `index` collapses to its directory. */
function pagesRoutes(pagesDir: string): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const walk = (dir: string, segs: string[]): void => {
    for (const e of readDir(dir)) {
      if (e.isDirectory()) {
        if (segs.length === 0 && e.name === 'api') continue; // API routes aren't pages
        walk(path.join(dir, e.name), [...segs, e.name]);
      } else if (e.isFile() && PAGES_EXT_RE.test(e.name)) {
        const base = e.name.replace(PAGES_EXT_RE, '');
        if (base.startsWith('_')) continue; // _app, _document, _error
        out.push(makeRoute(base === 'index' ? segs : [...segs, base]));
      }
    }
  };
  walk(pagesDir, []);
  return out;
}

const firstExisting = (cwd: string, candidates: string[]): string | undefined =>
  candidates.map((d) => path.join(cwd, d)).find((p) => fs.existsSync(p));

/** Discover a Next.js project's routes under `cwd`, deduped by path (App Router wins) and sorted.
 *  Empty when no `app/` or `pages/` dir is found. */
export function discoverNextRoutes(cwd: string = process.cwd()): DiscoveredRoute[] {
  const appDir = firstExisting(cwd, ['app', 'src/app']);
  const pagesDir = firstExisting(cwd, ['pages', 'src/pages']);
  const found = [...(appDir ? appRoutes(appDir) : []), ...(pagesDir ? pagesRoutes(pagesDir) : [])];
  const byPath = new Map<string, DiscoveredRoute>();
  for (const r of found) if (!byPath.has(r.path)) byPath.set(r.path, r);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
