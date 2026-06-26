import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { captureStyleMap, saveStyleMap, trackInflightRequests } from './capture.js';
import { diffStyleMaps, type Finding } from './diff.js';
import { coverageGaps } from './coverage.js';
import { selectCrawlLinks, type LinkMatch } from './crawl.js';
import type { Page } from '@playwright/test';

/**
 * A surface is one deterministic page state worth certifying: a route plus
 * the interactions that reach the state, captured at one viewport width per
 * @media band of its stylesheets.
 */
export type Surface = {
  /** Capture file name prefix; must be unique. */
  key: string;
  /**
   * Navigate and drive the page to the state. Only reach the state — StyleProof
   * settles it for you (waits out in-flight data and fonts, freezes animations)
   * before reading, so you don't hand-roll `networkidle`/`fonts.ready` waits here.
   */
  go: (page: Page) => Promise<void>;
  /** Selectors for nondeterministic regions (live data, third-party embeds); skipped entirely. */
  ignore?: string[];
  /** Viewport widths to sweep — one per @media band, so breakpoint rules are verified too. */
  widths: number[];
  /** Viewport height: a number, or a function of the width (default 800). */
  height?: number | ((width: number) => number);
};

export type DefineOptions = {
  surfaces: Surface[];
  /**
   * The full set of surface keys the app knows it has — its route/view universe,
   * typically derived from a registry (e.g. an app's list of routes or view ids).
   * When set, StyleProof emits a coverage-guard test (in the NORMAL suite, not
   * gated on a capture dir) that fails if any expected key is neither captured (a
   * surface) nor in `exclude`. This is what stops a newly added route from
   * shipping uncaptured: the gate can only diff what a spec lists, so without this
   * a forgotten surface is silently invisible. Omit to opt out (no guard).
   */
  expected?: string[];
  /**
   * Expected keys deliberately NOT captured, each mapped to the reason — a visible,
   * reviewed opt-out ledger. Keeps the coverage guard green for known gaps without
   * letting them hide: an entry whose key isn't in `expected` (a renamed/removed
   * route) also fails the guard, so the ledger can't rot.
   */
  exclude?: Record<string, string>;
  /**
   * Output directory label. Convention: drive it from an env var so the same
   * spec captures `before`, `after`, or a CI label — and skips entirely when
   * unset, keeping the spec inert during normal test runs.
   */
  dir: string | undefined;
  /** Base output directory (default `__stylemaps__` next to the invoking spec's CWD). */
  baseDir?: string;
  /**
   * Also save a full-page screenshot per capture (default true). The report
   * generator crops these to show changed regions side by side; captures
   * without screenshots still diff, but produce text-only reports.
   */
  screenshots?: boolean;
  /**
   * Replay a baseline run's recorded responses so a before/after diff reflects
   * code, not live-data drift. When set (or via STYLEPROOF_REPLAY_FROM), each
   * surface replays `<replayFrom>/<key>@<width>.har` for requests matching
   * `replayUrl`; otherwise the run RECORDS that HAR into its own dir for the
   * comparison run to replay. Only data URLs are intercepted, so the app's own
   * JS/CSS still load live — the captured run renders ITS code against the
   * baseline's data. This is what makes captures deterministic with no per-repo
   * fixtures: record once on the base, replay on the head.
   */
  replayFrom?: string;
  /**
   * URL glob for the data boundary to record/replay (default `**\/api/**`, or
   * STYLEPROOF_REPLAY_URL). Requests outside it (JS/CSS/fonts/images) always
   * load live so the captured code actually runs.
   */
  replayUrl?: string;
  /**
   * Freeze `Date.now()`/`new Date()` to a fixed instant so time-derived styling
   * (relative-age classes, "stale > 1h" flags) can't drift between runs. Timers
   * keep running, so settling/polling still works. Default true.
   */
  freezeClock?: boolean;
  /** Fixed instant for the frozen clock (default `2025-01-01T00:00:00Z`). */
  clockTime?: string | number | Date;
  /**
   * Capture each surface twice and fail if the computed styles differ — proves the
   * capture is deterministic (catches a replay gap falling through to the live
   * backend, or unseeded client randomness) instead of letting it surface as a
   * phantom change on an unrelated diff.
   *
   * Defaults ON for the RECORDING run and OFF for the REPLAY run: live nondeterminism
   * surfaces while recording against the real backend, whereas the replay run renders
   * against the recorded HAR and is deterministic by construction — so self-checking it
   * just doubles the work. `STYLEPROOF_SELFCHECK=1` forces it on for both; pass
   * `selfCheck` explicitly to override.
   */
  selfCheck?: boolean;
  /**
   * Opt-in content layer (default OFF). Record each element's own rendered text
   * so the report's optional content section can surface copy changes (run
   * `styleproof-report --include-content`). Advisory only — never gates. See
   * `CaptureOptions.captureText` and the README's "Optional: content layer".
   */
  captureText?: boolean;
  /**
   * Opt-in React layer (default OFF). Record the component + sanitized props that
   * rendered each element so the report can name `Button (variant=primary)`.
   * Advisory only — never gates. See `CaptureOptions.captureComponent`.
   */
  captureComponent?: boolean;
};

/** Resolved per-capture settings, shared with the helpers below. */
type Settings = Required<Omit<DefineOptions, 'surfaces' | 'replayFrom' | 'expected' | 'exclude'>> & {
  dir: string;
  replayFrom?: string;
};

/** One-line description of the first drift finding, for the self-check error. */
function driftDesc(f: Finding): string {
  if (f.kind === 'dom') return `${f.path} ${f.change}`;
  const p = f.props[0];
  return p ? `${f.path} ${p.prop}: ${p.before} → ${p.after}` : f.path;
}

/**
 * Let SSE (EventSource) requests bypass HAR record/replay and reach the live
 * server. A long-lived stream can't round-trip through a HAR entry: recording
 * captures at most a truncated body, and on replay the connection aborts, so the
 * app drops to its no-stream fallback — a DIFFERENT but STABLE state that
 * settle/volatile can't catch (it isn't moving, so it reads as a real change).
 * Passing the stream through on BOTH record and replay keeps both sides in the
 * same streamed state; the data it pushes must be deterministic at capture time
 * (fixtures/frozen clock), same as any live region. Detected by the
 * `Accept: text/event-stream` header EventSource always sends.
 *
 * Registered AFTER routeFromHAR so it matches first (Playwright runs the most
 * recently added route first); non-stream requests `fallback()` to the HAR.
 */
export async function passLiveStreams(page: Page, url: string): Promise<void> {
  await page.route(url, async (route) => {
    if ((route.request().headers()['accept'] ?? '').includes('text/event-stream')) await route.continue();
    else await route.fallback();
  });
}

/**
 * Pin the surface's inputs: replay the baseline's recorded data (or record ours),
 * scoped to the data URLs so the app's own JS/CSS still load live, then freeze the
 * clock so time-derived styling is stable.
 */
async function pinInputs(page: Page, harName: string, s: Settings): Promise<void> {
  let intercepting = false;
  if (s.replayFrom) {
    const har = path.join(s.replayFrom, harName);
    if (fs.existsSync(har)) {
      // notFound:'abort' — a request the baseline never recorded fails
      // deterministically rather than silently hitting the live backend.
      await page.routeFromHAR(har, { url: s.replayUrl, update: false, notFound: 'abort' });
      intercepting = true;
    } else {
      // eslint-disable-next-line no-console
      console.warn(`styleproof: no replay HAR at ${har} — capturing live (NON-deterministic)`);
    }
  } else {
    await page.routeFromHAR(path.join(s.baseDir, s.dir, harName), {
      url: s.replayUrl,
      update: true,
      updateContent: 'embed', // single portable file, no sidecar resources
    });
    intercepting = true;
  }
  // Streams can't be HAR'd; let them reach the live server so replay doesn't
  // abort them into the app's no-stream fallback (a phantom diff). Only when a
  // HAR route is active — otherwise everything is already live.
  if (intercepting) await passLiveStreams(page, s.replayUrl);
  if (s.freezeClock) await page.clock.setFixedTime(new Date(s.clockTime));
}

/** Capture the surface again and throw if the computed styles drifted from `first`. */
async function assertDeterministic(
  page: Page,
  surface: Surface,
  first: Awaited<ReturnType<typeof captureStyleMap>>,
  captureText: boolean,
  pending: () => number,
): Promise<void> {
  await surface.go(page);
  const again = await captureStyleMap(page, { ignore: surface.ignore ?? [], captureText, pendingRequests: pending });
  const drift = diffStyleMaps(first, again);
  if (drift.length) {
    throw new Error(
      `styleproof self-check failed: ${surface.key} is non-deterministic — ` +
        `${drift.length} computed-style difference(s) between two captures of the same commit. ` +
        `Likely a replay gap (a request not in the baseline HAR) or unseeded randomness. ` +
        `First: ${driftDesc(drift[0])}`,
    );
  }
}

/** Drive one surface at one width to a settled state and save its style map (+ screenshot).
 *  The caller owns the test timeout (one-per-test for explicit surfaces, one budget for
 *  the whole crawl) so a multi-surface crawl can't reset its own deadline mid-loop. */
async function captureSurface(page: Page, surface: Surface, width: number, s: Settings): Promise<void> {
  await pinInputs(page, `${surface.key}@${width}.har`, s);
  const height = typeof surface.height === 'function' ? surface.height(width) : (surface.height ?? 800);
  await page.setViewportSize({ width, height });
  // Arm the in-flight request tracker BEFORE go() so the surface's own load fetches
  // count toward the network-aware settle — a request that starts during navigation
  // fired its event before captureStyleMap could attach a listener of its own.
  const requests = trackInflightRequests(page);
  try {
    await surface.go(page);
    const map = await captureStyleMap(page, {
      ignore: surface.ignore ?? [],
      captureText: s.captureText,
      captureComponent: s.captureComponent,
      pendingRequests: requests.pending,
    });
    if (s.selfCheck) await assertDeterministic(page, surface, map, s.captureText, requests.pending);

    const stem = path.join(s.baseDir, s.dir, `${surface.key}@${width}`);
    saveStyleMap(`${stem}.json.gz`, map);
    if (s.screenshots) {
      // captureStyleMap froze animations/transitions, so this is the same settled
      // state the map describes.
      await page.screenshot({ path: `${stem}.png`, fullPage: true, animations: 'disabled' });
    }
  } finally {
    requests.dispose();
  }
}

/**
 * Default for `selfCheck` when the consumer didn't set it: ON when RECORDING (no
 * `replayFrom`) — that's where live nondeterminism surfaces — and OFF when REPLAYING,
 * since the replay run renders against the recorded HAR and is deterministic by
 * construction, so self-checking it just doubles the work. `STYLEPROOF_SELFCHECK=1`
 * forces it on either way.
 */
export function defaultSelfCheck(
  replayFrom: string | undefined,
  env: string | undefined = process.env.STYLEPROOF_SELFCHECK,
): boolean {
  return env === '1' || !replayFrom;
}

/**
 * Output base dir: explicit `baseDir` wins, then `STYLEPROOF_BASEDIR`, then the
 * default. Lets a pre-push hook redirect capture into a COMMITTED dir (so main
 * always carries a base map and CI just diffs precomputed maps) without editing
 * the spec — same env-wiring philosophy as `STYLEPROOF_REPLAY_*`.
 */
export function resolveBaseDir(
  baseDir: string | undefined,
  env: string | undefined = process.env.STYLEPROOF_BASEDIR,
): string {
  return baseDir ?? env ?? '__stylemaps__';
}

/**
 * Whether to save full-page screenshots: explicit `screenshots` wins, else
 * `STYLEPROOF_SCREENSHOTS=0` turns them off — for committed maps you want the lean
 * `.json.gz` only, never PNGs in git history. On by default otherwise.
 */
export function resolveScreenshots(
  screenshots: boolean | undefined,
  env: string | undefined = process.env.STYLEPROOF_SCREENSHOTS,
): boolean {
  return screenshots ?? env !== '0';
}

/** The capture settings every capturer shares (everything bar the surface set). */
type CaptureConfig = Omit<DefineOptions, 'surfaces' | 'expected' | 'exclude'>;

/**
 * Apply the capture defaults once, so explicit-surface and crawl capture can't
 * drift — the replay boundary, frozen clock and self-check policy resolve to the
 * same thing whichever entry point you use. Env fallbacks (`STYLEPROOF_REPLAY_*`)
 * live here too, so a single spec line keeps the documented behaviour.
 */
function resolveSettings(c: CaptureConfig): Settings {
  const replayFrom = c.replayFrom ?? process.env.STYLEPROOF_REPLAY_FROM;
  return {
    dir: c.dir as string,
    baseDir: resolveBaseDir(c.baseDir),
    screenshots: resolveScreenshots(c.screenshots),
    replayFrom,
    replayUrl: c.replayUrl ?? process.env.STYLEPROOF_REPLAY_URL ?? '**/api/**',
    freezeClock: c.freezeClock ?? true,
    clockTime: c.clockTime ?? '2025-01-01T00:00:00Z',
    selfCheck: c.selfCheck ?? defaultSelfCheck(replayFrom),
    captureText: c.captureText ?? false,
    captureComponent: c.captureComponent ?? false,
  };
}

/**
 * Generate one Playwright test per surface × width that captures the style
 * map to `<baseDir>/<dir>/<key>@<width>.json.gz`. Captures are made
 * deterministic with no per-repo fixtures: the baseline run records each
 * surface's data responses to a HAR, and the comparison run replays them (set
 * STYLEPROOF_REPLAY_FROM=<baseline dir> on the comparison capture), while the
 * clock is frozen so time-derived styling is stable.
 *
 * ```ts
 * // styleproof.spec.ts
 * defineStyleMapCapture({ surfaces: SURFACES, dir: process.env.STYLEMAP_DIR });
 * ```
 */
export function defineStyleMapCapture(options: DefineOptions): void {
  const { surfaces, expected, exclude = {}, dir } = options;
  const settings = resolveSettings(options);

  // Coverage guard. Runs in the NORMAL test suite (NOT gated on a capture dir), so
  // a route added without a surface fails the app's own tests — long before, and
  // independent of, a capture run. This is the one gap captures can't catch: a
  // surface never taken can't be diffed. Only emitted when the spec declares its
  // `expected` universe; otherwise StyleProof keeps its prior behaviour exactly.
  if (expected) {
    test.describe('styleproof coverage', () => {
      test('every expected surface is captured or explicitly excluded', () => {
        const { uncovered, staleExclusions } = coverageGaps(
          surfaces.map((s) => s.key),
          expected,
          exclude,
        );
        expect(
          uncovered,
          `StyleProof coverage gap: ${uncovered.length} expected surface(s) are neither captured ` +
            `nor excluded — add each to \`surfaces\`, or to \`exclude\` with a reason. ` +
            `Missing: ${uncovered.join(', ')}`,
        ).toEqual([]);
        expect(
          staleExclusions,
          `StyleProof: \`exclude\` lists surface(s) absent from \`expected\` ` +
            `(renamed or removed?): ${staleExclusions.join(', ')}`,
        ).toEqual([]);
      });
    });
  }

  test.describe('styleproof capture', () => {
    test.skip(!dir, 'set STYLEMAP_DIR=<label> to capture computed-style maps');
    for (const surface of surfaces) {
      for (const width of surface.widths) {
        test(`${surface.key} @ ${width}`, ({ page }) => {
          test.setTimeout(180_000);
          return captureSurface(page, surface, width, settings);
        });
      }
    }
  });
}

/** Options for {@link defineCrawlCapture}: where to crawl, how to filter/key the
 *  links, and the viewport sweep — plus the shared capture settings. */
export type CrawlOptions = CaptureConfig & {
  /** URL to crawl for surface links (e.g. `/`). Its same-origin `<a href>`s become
   *  the surface set. */
  from: string;
  /** Narrow the discovered links — substring, RegExp, or predicate over the URL
   *  (e.g. `/\?tab=/` to capture only the tab views). Default: every same-origin link. */
  match?: LinkMatch;
  /** Derive a surface key from a link URL. Default: path+query slug (`/?tab=x` → `x`). */
  key?: (url: URL) => string;
  /** Viewport widths swept for every discovered surface — one per @media band. */
  widths: number[];
  /** Viewport height per width (default 800). */
  height?: number | ((width: number) => number);
  /** Selectors skipped on every surface (live regions, third-party embeds). */
  ignore?: string[];
  /** Max ms to wait for the crawl root's links to render before reading them
   *  (an SPA hydrates its nav client-side). Default 15000. */
  linkTimeout?: number;
};

/**
 * Like {@link defineStyleMapCapture}, but the surface set is DISCOVERED at run time
 * by crawling a page's links instead of being hand-listed — for a single-route SPA
 * whose views are `?tab=`/client-routed and so invisible to the filesystem
 * {@link discoverNextRoutes}. It navigates `from`, reads its same-origin `<a href>`s
 * (filtered by `match`), and captures each as a surface keyed by `key`. The app just
 * has to render its nav as real links; nothing to hand-maintain, so the surface list
 * can't drift from the nav.
 *
 * One Playwright test does the whole sweep (the link set isn't known until a browser
 * has rendered the page, so per-surface tests can't be generated at collection time).
 * Per-surface failures are aggregated — one bad surface reports without hiding the
 * rest. Replay/self-check/clock-freeze behave exactly as for explicit surfaces.
 *
 * ```ts
 * // styleproof.spec.ts — capture every tab the nav links to
 * defineCrawlCapture({ from: '/', match: /\?tab=/, widths: [1440, 1024, 768], dir: process.env.STYLEMAP_DIR });
 * ```
 */
export function defineCrawlCapture(options: CrawlOptions): void {
  const { from, match, key, widths, height, ignore, linkTimeout = 15_000, dir } = options;
  const settings = resolveSettings(options);

  test.describe('styleproof crawl-capture', () => {
    test.skip(!dir, 'set STYLEMAP_DIR=<label> to capture computed-style maps');
    test('discover surfaces by crawling links, then capture each', async ({ page }) => {
      // 1. Load the root and wait for its nav links to hydrate — an SPA renders them
      //    client-side, so they aren't in the initial HTML.
      await page.goto(from, { waitUntil: 'load' });
      await page.waitForSelector('a[href]', { timeout: linkTimeout });
      const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href')));
      const links = selectCrawlLinks(hrefs, { base: page.url(), match, key });
      if (links.length === 0) {
        throw new Error(
          `styleproof crawl: no links matched at ${from}. The nav must render same-origin ` +
            `<a href> links (a button-only nav exposes nothing to crawl), and \`match\` must keep them.`,
        );
      }
      // Budget the whole sweep up front: one test captures every surface, and
      // captureSurface no longer sets its own timeout, so size it to the work found.
      test.setTimeout(Math.max(180_000, links.length * widths.length * 60_000));

      // 2. Capture each discovered surface. Aggregate failures so one bad surface
      //    reports without skipping the rest — they're an independent set, not a chain.
      const failures: string[] = [];
      for (const link of links) {
        for (const width of widths) {
          const surface: Surface = {
            key: link.key,
            go: async (p) => {
              await p.goto(link.url, { waitUntil: 'load' });
            },
            widths: [width],
            ignore,
            height,
          };
          try {
            await captureSurface(page, surface, width, settings);
          } catch (e) {
            failures.push(`${link.key} @ ${width}: ${(e as Error).message}`);
          }
        }
      }
      if (failures.length) {
        throw new Error(`styleproof crawl-capture: ${failures.length} surface(s) failed:\n${failures.join('\n')}`);
      }
    });
  });
}
