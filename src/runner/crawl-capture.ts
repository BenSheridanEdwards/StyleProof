import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { detectViewportWidths } from '../breakpoints.js';
import { crawlCoverageError, dedupIdentity, selectCrawlLinks, selectObservedNavs, type CrawlLink } from '../crawl.js';
import { captureTestBudgetMs } from '../surface-progress.js';
import { NAV_OBSERVER_FN, NAV_OBSERVER_SNIPPET } from './browser.js';
import { withSurfaceFailureTolerance } from './self-check.js';
import { resolveSettings } from './settings.js';
import {
  captureSurface,
  heartbeatUnitCount,
  writeBrowserBuildTest,
  recordCaptureTestOutcomes,
  writeCoverageLedgerTest,
} from './surface-capture.js';
import type { CrawlOptions, ExpandedSurface, HeartbeatOrdinal, Settings } from './types.js';
import { assertUniqueExpandedKeys, expandSurfaceVariants } from './variants.js';

// Discovery is bounded so a runaway app (scroll-position URL updates, a router loop)
// cannot spin the crawl forever.
const OBSERVED_NAV_MAX_PASSES = 3;
const OBSERVED_NAV_MAX_ROUTES = 64;

/** Load the crawl root, wait for its nav links to hydrate, and read them into a keyed surface list. */
async function discoverCrawlLinks(
  page: Page,
  { from, match, key, linkTimeout }: Pick<CrawlOptions, 'from' | 'match' | 'key'> & { linkTimeout: number },
): Promise<CrawlLink[]> {
  await page.goto(from, { waitUntil: 'load' });
  // A link-less page is fine for an unfiltered crawl (it still captures `from` itself).
  await page.waitForSelector('a[href]', { timeout: linkTimeout }).catch((e) => {
    if (match !== undefined) throw e;
  });
  const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href')));
  const links = selectCrawlLinks(hrefs, { base: page.url(), match, key, includeSelf: match === undefined });
  if (links.length === 0) {
    throw new Error(
      `styleproof crawl: no links matched at ${from}. The nav must render same-origin ` +
        `<a href> links (a button-only nav exposes nothing to crawl), and \`match\` must keep them.`,
    );
  }
  return links;
}

/** Capture every discovered surface, aggregating per-surface failures so one bad surface does not hide the rest. */
async function sweepCrawlSurfaces(page: Page, captureSurfaces: ExpandedSurface[], settings: Settings): Promise<void> {
  const failures: string[] = [];
  const aggregate = (line: string): void => {
    failures.push(line);
  };
  const total = heartbeatUnitCount(captureSurfaces);
  let unit = 0;
  for (const surface of captureSurfaces) {
    // One ordinal per declared surface×width; an auto-width surface is one unit for its whole sweep.
    let widths = surface.widths ?? [];
    const autoOrdinal: HeartbeatOrdinal | undefined = widths.length ? undefined : { index: ++unit, total };
    if (autoOrdinal) {
      await withSurfaceFailureTolerance(
        settings,
        `${surface.key}@auto`,
        async () => {
          await surface.go(page);
          widths = await detectViewportWidths(page);
        },
        aggregate,
      );
    }
    for (const width of widths) {
      const ordinal = autoOrdinal ?? { index: ++unit, total };
      await withSurfaceFailureTolerance(
        settings,
        `${surface.key}@${width}`,
        () => captureSurface(page, surface, width, settings, ordinal),
        aggregate,
      );
    }
  }
  if (failures.length) {
    throw new Error(`styleproof crawl-capture: ${failures.length} surface(s) failed:\n${failures.join('\n')}`);
  }
}

function reportObservedRoutes(fresh: CrawlLink[]): void {
  process.stderr.write(
    `styleproof: navigation observer discovered ${fresh.length} route(s): ${fresh.map((l) => l.key).join(', ')}\n`,
  );
}

async function installNavObserver(page: Page, observed: Set<string>): Promise<void> {
  await page.exposeFunction(NAV_OBSERVER_FN, (href: string) => {
    observed.add(href);
  });
  await page.addInitScript(NAV_OBSERVER_SNIPPET);
}

/** Merges routes the app itself landed on into the crawl frontier, bounded and named. */
function navObserver(
  page: Page,
  links: CrawlLink[],
  observed: Set<string>,
  options: Pick<CrawlOptions, 'match' | 'key'>,
) {
  const seen = new Set(links.map((l) => dedupIdentity(l.url)));
  const usedKeys = new Set(links.map((l) => l.key));
  let observedCount = 0;
  return {
    /** Take the routes observed since the last call (bounded), append them to `links`, and name them. */
    merge(): CrawlLink[] {
      if (!observed.size) return [];
      const fresh = selectObservedNavs([...observed], { base: page.url(), ...options, seen, usedKeys });
      observed.clear();
      const take = fresh.slice(0, Math.max(0, OBSERVED_NAV_MAX_ROUTES - observedCount));
      if (fresh.length > take.length) {
        process.stderr.write(
          `styleproof: navigation observer capped at ${OBSERVED_NAV_MAX_ROUTES} discovered route(s); ` +
            `${fresh.length - take.length} further route(s) observed but not captured\n`,
        );
      }
      observedCount += take.length;
      links.push(...take);
      if (take.length) reportObservedRoutes(take);
      return take;
    },
    finish(): void {
      if (!observed.size) return;
      observed.clear();
      process.stderr.write(
        `styleproof: navigation observer stopped after ${OBSERVED_NAV_MAX_PASSES} discovery passes — later-observed route(s) not captured\n`,
      );
    },
  };
}

/**
 * Like `defineStyleMapCapture`, but the surface set is DISCOVERED at run time by crawling
 * a page's links (plus routes observed through the history API). One Playwright test does
 * the whole sweep; per-surface failures are aggregated.
 */
export function defineCrawlCapture(options: CrawlOptions): void {
  const {
    from,
    match,
    key,
    linkTimeout = 15_000,
    dir,
    settle,
    expected,
    exclude = {},
    observeNavigation = true,
  } = options;
  const { widths, height, ignore, variants, liveStates, stateRecipes, popups } = options;
  if (!dir) return;

  const settings = resolveSettings(options);
  // Title opens with "styleproof capture" so CAPTURE_TEST_GREP selects crawl specs too.
  test.describe('styleproof capture (crawl)', () => {
    // The crawl applies the SAME variants to every link, so an `expected` key's expansion is knowable up front.
    const ledgerSurfaces = (expected ?? []).flatMap((key) =>
      expandSurfaceVariants({ key, go: async () => {}, variants, liveStates, stateRecipes }),
    );
    recordCaptureTestOutcomes();
    writeCoverageLedgerTest(settings, expected ?? null, exclude, ledgerSurfaces);
    writeBrowserBuildTest(settings);
    test('discover surfaces by crawling links, then capture each', async ({ page }) => {
      const testStart = Date.now();
      const observed = new Set<string>();
      if (observeNavigation) await installNavObserver(page, observed);
      const links = await discoverCrawlLinks(page, { from, match, key, linkTimeout });
      // A same-origin href can still 302 off-origin (SSO); external content is never captured.
      const entryOrigin = new URL(page.url()).origin;
      const observer = navObserver(page, links, observed, { match, key });
      observer.merge(); // router redirect / default tab during hydration
      const expandLink = (link: CrawlLink): ExpandedSurface[] =>
        expandSurfaceVariants({
          key: link.key,
          go: async (p) => {
            await p.goto(link.url, { waitUntil: 'load' });
            const landed = new URL(p.url()).origin;
            if (landed !== entryOrigin) {
              throw new Error(
                `styleproof crawl: ${link.url} redirected off-origin to ${landed} — external content is never captured`,
              );
            }
            if (settle) await settle(p);
          },
          widths,
          ignore,
          height,
          variants,
          liveStates,
          stateRecipes,
          popups,
        });
      // Navigation observed while a surface settles expands the frontier for another bounded pass.
      let frontier = [...links];
      for (let pass = 0; frontier.length && pass < OBSERVED_NAV_MAX_PASSES; pass++) {
        const captureSurfaces = frontier.flatMap(expandLink);
        assertUniqueExpandedKeys(captureSurfaces);
        // Budget per pass, sized to the work found (auto-width assumes up to 4 bands), extended
        // from test start; a breach is still reported by the NAMED per-surface timeout.
        const units = captureSurfaces.reduce((sum, surface) => sum + (surface.widths?.length ?? 4), 0);
        test.setTimeout(Date.now() - testStart + captureTestBudgetMs(settings.surfaceTimeoutMs, units));
        await sweepCrawlSurfaces(page, captureSurfaces, settings);
        frontier = observer.merge();
      }
      observer.finish();
      // Reconcile the rendered link set (plus observed routes) against `expected`, both directions.
      const gap = expected
        ? crawlCoverageError(
            from,
            links.map((l) => l.key),
            expected,
            exclude,
          )
        : null;
      if (gap) throw new Error(gap);
    });
  });
}
