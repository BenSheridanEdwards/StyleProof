/**
 * Link-crawl surface discovery, for apps whose surfaces aren't filesystem routes.
 *
 * {@link discoverNextRoutes} reads the filesystem, so it sees one route per
 * `app/.../page.*` — perfect for multi-page apps, blind to a single-route SPA that
 * expresses every view as a query param (`/?tab=overview`) or client-side push.
 * Those surfaces only exist in the *rendered* DOM, as the nav's links. This module
 * turns that rendered link set into a surface list: navigate the app's root, read
 * its `<a href>`s, and capture each — no hand-maintained `surfaces` array to drift
 * out of sync with the nav (the same drift the coverage guard exists to catch,
 * removed at the source).
 *
 * The DOM read happens at run time inside a Playwright test (a browser is needed to
 * see hydrated links), so this file holds only the PURE part — turning a list of
 * raw href strings into deduped, keyed, navigable surfaces — which is unit-testable
 * with no browser. {@link defineCrawlCapture} in `runner.ts` does the navigation and
 * feeds the hrefs here.
 */

/** A discovered surface: a filename-safe key and the same-origin path to navigate. */
export type CrawlLink = {
  /** Capture file-name prefix, derived from the URL (see {@link defaultLinkKey}). */
  key: string;
  /** Root-relative path+query to navigate (`/?tab=overview`, `/about`). */
  url: string;
};

/**
 * Keep only links whose resolved URL matches: a substring tested against the full
 * href, a RegExp tested against it, or a predicate over the parsed URL. Omit to keep
 * every same-origin link.
 */
export type LinkMatch = string | RegExp | ((url: URL) => boolean);

export type SelectLinksOptions = {
  /** Absolute URL of the crawled page. Relative hrefs resolve against it and only
   *  same-origin links are kept (external nav, mailto:, tel:, javascript: dropped). */
  base: string;
  /** Narrow the kept links. Default: every same-origin link. */
  match?: LinkMatch;
  /** Derive the surface key from a link URL. Default: {@link defaultLinkKey}. */
  key?: (url: URL) => string;
  /** Also capture the crawled page itself as the first surface, so `from` is always
   *  covered — even if the nav doesn't link back to it, or it's a single-page app with
   *  no links at all. Default false. Used for an unfiltered "capture everything" crawl. */
  includeSelf?: boolean;
};

/**
 * Filename-safe, readable key from a link URL. Joins the path segments and the
 * query-param *values* (the discriminator for a tab SPA — `/?tab=overview` →
 * `overview`), so the common single-route-with-`?tab=` case reads cleanly while a
 * multi-segment route (`/blog/post`) still keys as `blog-post`. Param names are
 * dropped (values carry the meaning); pass `key` to {@link selectCrawlLinks} when a
 * project needs a different scheme.
 *
 * Params are sorted by name before their values are joined, so the SAME logical
 * route keys identically regardless of the order the nav happened to render its
 * query string (`/?tab=a&x=b` and `/?x=b&tab=a` both → `a-b`). Without this the
 * key flaps with render order and the coverage guard reports phantom
 * nav-regressions / unowned routes for a route that never changed.
 */
export function defaultLinkKey(url: URL): string {
  const segs = url.pathname.split('/').filter(Boolean);
  const values = [...url.searchParams]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v)
    .filter(Boolean);
  const slug = [...segs, ...values]
    .join('-')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'index';
}

function matches(url: URL, match?: LinkMatch): boolean {
  if (match === undefined) return true;
  if (typeof match === 'string') return url.href.includes(match);
  if (match instanceof RegExp) return match.test(url.href);
  return match(url);
}

/**
 * Resolve one raw href to a navigable same-origin surface, or `null` to skip it
 * (malformed, mailto:/tel:/javascript:, external, a bare fragment of the crawl root,
 * or filtered out by `match`). Pure per-href classification — the loop in
 * {@link selectCrawlLinks} only has to dedupe what this keeps.
 */
function toLink(href: string, base: URL, keyFor: (url: URL) => string, match?: LinkMatch): CrawlLink | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null; // malformed href — skip, never throw into a spec
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null; // mailto:/tel:/javascript:
  if (url.origin !== base.origin) return null; // external link
  const path = url.pathname + url.search;
  // A pure fragment of the crawl root isn't a new surface (it's the same page).
  if (url.hash && path === base.pathname + base.search) return null;
  if (!matches(url, match)) return null;
  url.hash = ''; // navigate the surface, not a scroll anchor within it
  return { key: keyFor(url), url: path };
}

/**
 * Dedup identity for a navigable path+query. Two forms of the same route must share
 * one identity, or a static multi-page site (whose nav links the `.html` files) gets
 * captured twice as byte-near-identical maps, doubling the work and duplicating every
 * finding in the diff:
 *
 * - A trailing slash isn't a distinct surface (`/about` and `/about/` render the same
 *   route), so it's stripped — but never from the root `/` itself, nor from the query.
 * - A trailing `index.html` is the directory's index (`/index.html` IS `/`, and
 *   `/docs/index.html` IS `/docs/`), so it collapses to the directory path. Only the
 *   literal `index.html` filename normalizes — a real `about.html` is left untouched
 *   and stays a distinct surface from `about`.
 *
 * The navigable url the caller returns keeps its original form; only the SET
 * membership test is normalized, so the first-seen href still wins.
 */
export function dedupIdentity(pathAndSearch: string): string {
  const q = pathAndSearch.indexOf('?');
  const path = q === -1 ? pathAndSearch : pathAndSearch.slice(0, q);
  const search = q === -1 ? '' : pathAndSearch.slice(q);
  // `/index.html` → `/`, `/docs/index.html` → `/docs/` (the preceding slash stays so
  // the trailing-slash step below folds it into the same identity as `/docs` / `/docs/`).
  const withoutIndex = path.replace(/(^|\/)index\.html$/, '$1');
  const normPath = withoutIndex.length > 1 ? withoutIndex.replace(/\/+$/, '') || '/' : withoutIndex;
  return normPath + search;
}

/**
 * Turn a page's raw `<a href>` values into a deduped, keyed surface list.
 *
 * Each href is classified by {@link toLink} (resolve against `base`, keep http(s)
 * same-origin, drop a bare in-page fragment of the crawl root, apply `match`); the
 * survivors are deduped by path+query (trailing slash normalized — `/about` and
 * `/about/` are one surface, not two). Order follows first appearance in `hrefs`, so
 * the capture order is the nav's order — stable across runs.
 *
 * Keys are then disambiguated: two GENUINELY different surfaces whose derived keys
 * collide (e.g. `/a?tab=x` and `/b?tab=x` both → `x` under {@link defaultLinkKey})
 * would otherwise both write `<key>@<width>.json.gz` and the second would silently
 * overwrite the first — a captured surface vanishing without a trace. Instead the
 * second gets a `-2` suffix (mirroring the surface crawler's `deriveKey`), so both
 * survive as distinct maps. Trailing-slash duplicates never reach here — they're
 * already deduped to one surface above — so this only fires on real collisions.
 */
export function selectCrawlLinks(hrefs: Iterable<string | null | undefined>, opts: SelectLinksOptions): CrawlLink[] {
  const base = new URL(opts.base);
  const keyFor = opts.key ?? defaultLinkKey;
  const seen = new Set<string>();
  const usedKeys = new Set<string>();
  const out: CrawlLink[] = [];
  // Disambiguate a key against those already emitted, mirroring deriveKey: first
  // wins bare, the next collider gets `-2`, `-3`, … — deterministic in nav order.
  const uniqueKey = (key: string): string => {
    let k = key;
    for (let i = 2; usedKeys.has(k); i++) k = `${key}-${i}`;
    usedKeys.add(k);
    return k;
  };
  const push = (link: CrawlLink): void => {
    out.push({ key: uniqueKey(link.key), url: link.url });
  };
  if (opts.includeSelf) {
    const selfUrl = base.pathname + base.search;
    seen.add(dedupIdentity(selfUrl));
    push({ key: keyFor(base), url: selfUrl });
  }
  for (const href of hrefs) {
    const link = href ? toLink(href, base, keyFor, opts.match) : null;
    if (!link) continue;
    const id = dedupIdentity(link.url);
    if (seen.has(id)) continue;
    seen.add(id);
    push(link);
  }
  return out;
}

/**
 * The reconciliation of a rendered nav (the crawl's discovered link keys) against a
 * declared `expected` universe, both directions. Where the spec guard treats the
 * hand-listed `surfaces` as what's captured, here the crawl's DISCOVERED links are —
 * the nav is the route universe for a link-crawled SPA, so it is the source of truth.
 *
 * - `missing`: an `expected` key with no rendered link and no `exclude` entry — a
 *   nav-regression (a route the app promised is no longer linked).
 * - `unexpected`: a rendered link with no `expected` entry and no `exclude` entry — a
 *   new route/view with no owner in the registry.
 * - `staleExclusions`: an `exclude` key absent from BOTH `expected` and the rendered
 *   set — a rotted opt-out.
 *
 * Unlike {@link CoverageGaps} (which permits captured-not-expected so a spec can
 * tighten its registry over time), the crawl asserts BOTH directions strictly: the
 * rendered link set is complete by construction, so an unowned link is a real gap.
 * Pure and browser-free so it's unit-testable; {@link import('./runner.js')} wraps it
 * in the crawl capture test, where the link set is finally known.
 */
export type CrawlCoverageGaps = {
  /** Expected keys with no rendered link and no `exclude` — a nav regression. */
  missing: string[];
  /** Rendered link keys absent from `expected` and `exclude` — a route with no owner. */
  unexpected: string[];
  /** `exclude` keys in neither `expected` nor the rendered set — a rotted opt-out. */
  staleExclusions: string[];
};

export function crawlCoverageGaps(
  discoveredKeys: Iterable<string>,
  expected: Iterable<string>,
  exclude: Record<string, string> = {},
): CrawlCoverageGaps {
  const discovered = new Set(discoveredKeys);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((k) => !discovered.has(k) && !(k in exclude));
  const unexpected = [...discovered].filter((k) => !expectedSet.has(k) && !(k in exclude));
  const staleExclusions = Object.keys(exclude).filter((k) => !expectedSet.has(k) && !discovered.has(k));
  return { missing, unexpected, staleExclusions };
}

/**
 * Reconcile the crawled link set against `expected` (via {@link crawlCoverageGaps}) and
 * render the failure message, or `null` when the nav reconciles. `from` names the crawl
 * root in the message. Kept pure and out of the capture test so the wording is
 * unit-testable and {@link defineCrawlCapture} just throws what this returns.
 */
export function crawlCoverageError(
  from: string,
  discoveredKeys: Iterable<string>,
  expected: Iterable<string>,
  exclude: Record<string, string> = {},
): string | null {
  const { missing, unexpected, staleExclusions } = crawlCoverageGaps(discoveredKeys, expected, exclude);
  const problems: string[] = [];
  if (missing.length)
    problems.push(
      `nav regression — expected route(s) no longer linked from ${from}: ${missing.join(', ')}. ` +
        `Restore the link, or move the key to \`exclude\` with a reason.`,
    );
  if (unexpected.length)
    problems.push(
      `new route(s) with no owner — link(s) rendered at ${from} but absent from \`expected\`: ` +
        `${unexpected.join(', ')}. Add each to \`expected\`, or to \`exclude\` with a reason.`,
    );
  if (staleExclusions.length)
    problems.push(
      `stale \`exclude\` — key(s) in neither \`expected\` nor the rendered nav ` +
        `(renamed or removed?): ${staleExclusions.join(', ')}.`,
    );
  return problems.length ? `styleproof crawl coverage gap:\n${problems.join('\n')}` : null;
}
