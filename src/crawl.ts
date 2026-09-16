/**
 * Link-crawl surface discovery for apps whose surfaces aren't filesystem routes (a single-route
 * SPA exposes its views only as the rendered nav's links). Pure: raw hrefs → deduped, keyed,
 * navigable surfaces; `defineCrawlCapture` in `runner.ts` does the navigation.
 */

/** A discovered surface: a filename-safe key and the same-origin path+query to navigate. */
export type CrawlLink = { key: string; url: string };

/** Keep only links whose resolved URL matches a substring, RegExp, or predicate. Omit to keep every same-origin link. */
export type LinkMatch = string | RegExp | ((url: URL) => boolean);

export type SelectLinksOptions = {
  /** Absolute URL of the crawled page. Relative hrefs resolve against it; only same-origin links are kept. */
  base: string;
  match?: LinkMatch;
  /** Derive the surface key from a link URL. Default: {@link defaultLinkKey}. */
  key?: (url: URL) => string;
  /** Also capture the crawled page itself as the first surface (a SPA with no links at all). */
  includeSelf?: boolean;
};

/** Shared frontier state for {@link selectObservedNavs}; `seen` and `usedKeys` are mutated so repeated drains stay deduped. */
export type ObservedNavOptions = Pick<SelectLinksOptions, 'base' | 'match' | 'key'> & {
  seen: Set<string>;
  usedKeys: Set<string>;
};

/**
 * Filename-safe key from a link URL: path segments plus query-param VALUES (the discriminator
 * for a tab SPA — `/?tab=overview` → `overview`; `/blog/post` → `blog-post`). Params are sorted
 * by name first, so the same logical route keys identically whatever order the nav rendered.
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

/** Resolve one href to a same-origin http(s) URL passing `match`, or null (malformed, mailto:/tel:/javascript:, external). */
function resolveLink(href: string, base: URL, match?: LinkMatch): URL | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null; // malformed href — skip, never throw into a spec
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin === base.origin && matches(url, match) ? url : null;
}

function toLink(href: string, base: URL, keyFor: (url: URL) => string, match?: LinkMatch): CrawlLink | null {
  const url = resolveLink(href, base, match);
  if (!url) return null;
  const path = url.pathname + url.search;
  if (url.hash && path === base.pathname + base.search) return null; // a bare fragment of the crawl root is the same page
  url.hash = ''; // navigate the surface, not a scroll anchor within it
  return { key: keyFor(url), url: path };
}

/** A URL the app navigated to PROGRAMMATICALLY (history API). The fragment is KEPT: a pushState
 *  to `/#/route` is a deliberate navigation (hash routers), and in-page anchors never reach here. */
function toObservedLink(href: string, base: URL, keyFor: (url: URL) => string, match?: LinkMatch): CrawlLink | null {
  const url = resolveLink(href, base, match);
  return url ? { key: keyFor(url), url: url.pathname + url.search + url.hash } : null;
}

/** Dedup identity for a navigable path+query, so two forms of one route never capture twice: a
 *  trailing slash is stripped (never from the root `/`, nor from the query) and a trailing
 *  `index.html` collapses to its directory. A real `about.html` stays distinct from `about`. */
export function dedupIdentity(pathAndSearch: string): string {
  const q = pathAndSearch.indexOf('?');
  const path = q === -1 ? pathAndSearch : pathAndSearch.slice(0, q);
  const search = q === -1 ? '' : pathAndSearch.slice(q);
  const withoutIndex = path.replace(/(^|\/)index\.html$/, '$1');
  let end = withoutIndex.length;
  while (end > 1 && withoutIndex.charCodeAt(end - 1) === 47) end--;
  return withoutIndex.slice(0, end) + search;
}

/** First wins bare, the next collider gets `-2`, `-3`, … — deterministic in discovery order. */
export function uniqueKeyFor(key: string, usedKeys: Set<string>): string {
  let k = key;
  for (let i = 2; usedKeys.has(k); i++) k = `${key}-${i}`;
  usedKeys.add(k);
  return k;
}

/** Dedupe by {@link dedupIdentity} (first-seen href wins) and disambiguate colliding keys so two
 *  genuinely different surfaces never overwrite the same `<key>@<width>.json.gz`. */
function collectUnique(links: Iterable<CrawlLink | null>, seen: Set<string>, usedKeys: Set<string>): CrawlLink[] {
  const out: CrawlLink[] = [];
  for (const link of links) {
    if (!link) continue;
    const id = dedupIdentity(link.url);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key: uniqueKeyFor(link.key, usedKeys), url: link.url });
  }
  return out;
}

/** Turn a page's raw `<a href>` values into a deduped, keyed surface list, in nav order. */
export function selectCrawlLinks(hrefs: Iterable<string | null | undefined>, opts: SelectLinksOptions): CrawlLink[] {
  const base = new URL(opts.base);
  const keyFor = opts.key ?? defaultLinkKey;
  const self = opts.includeSelf ? [{ key: keyFor(base), url: base.pathname + base.search }] : [];
  const links = Array.from(hrefs, (href) => (href ? toLink(href, base, keyFor, opts.match) : null));
  return collectUnique([...self, ...links], new Set(), new Set());
}

/** Turn URLs observed through the history API into surface links, deduped against the shared frontier. */
export function selectObservedNavs(hrefs: Iterable<string | null | undefined>, opts: ObservedNavOptions): CrawlLink[] {
  const base = new URL(opts.base);
  const keyFor = opts.key ?? defaultLinkKey;
  const links = Array.from(hrefs, (href) => (href ? toObservedLink(href, base, keyFor, opts.match) : null));
  return collectUnique(links, opts.seen, opts.usedKeys);
}

/** Reconciliation of a rendered nav against a declared `expected` universe, strict in BOTH directions:
 *  `missing` = a nav regression, `unexpected` = a route with no owner, `staleExclusions` = a rotted opt-out. */
export type CrawlCoverageGaps = { missing: string[]; unexpected: string[]; staleExclusions: string[] };

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

/** Render the crawl coverage failure, or `null` when the nav reconciles. `from` names the crawl root. */
export function crawlCoverageError(
  from: string,
  discoveredKeys: Iterable<string>,
  expected: Iterable<string>,
  exclude: Record<string, string> = {},
): string | null {
  const { missing, unexpected, staleExclusions } = crawlCoverageGaps(discoveredKeys, expected, exclude);
  const problems: [string[], string][] = [
    [
      missing,
      `nav regression — expected route(s) no longer linked from ${from}: ${missing.join(', ')}. ` +
        `Restore the link, or move the key to \`exclude\` with a reason.`,
    ],
    [
      unexpected,
      `new route(s) with no owner — link(s) rendered at ${from} but absent from \`expected\`: ` +
        `${unexpected.join(', ')}. Add each to \`expected\`, or to \`exclude\` with a reason.`,
    ],
    [
      staleExclusions,
      `stale \`exclude\` — key(s) in neither \`expected\` nor the rendered nav ` +
        `(renamed or removed?): ${staleExclusions.join(', ')}.`,
    ],
  ];
  const lines = problems.filter(([keys]) => keys.length).map(([, message]) => message);
  return lines.length ? `styleproof crawl coverage gap:\n${lines.join('\n')}` : null;
}
