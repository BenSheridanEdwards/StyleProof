import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { captureStyleMap, saveStyleMap, trackInflightRequests } from './capture.js';
import { diffStyleMaps, type Finding } from './diff.js';
import type { Page } from '@playwright/test';

/**
 * A surface is one deterministic page state worth certifying: a route plus
 * the interactions that reach the state, captured at one viewport width per
 * @media band of its stylesheets.
 */
export type Surface = {
  /** Capture file name prefix; must be unique. */
  key: string;
  /** Navigate and drive the page to the state, ending settled (fonts loaded, entrance animations done). */
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
   * Capture each surface twice and fail if the computed styles differ — proves
   * the capture is deterministic (catches a replay gap falling through to the
   * live backend, or unseeded client randomness) instead of letting it surface
   * as a phantom change on an unrelated diff. Default from STYLEPROOF_SELFCHECK=1.
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
type Settings = Required<Omit<DefineOptions, 'surfaces' | 'replayFrom'>> & { dir: string; replayFrom?: string };

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

/** Drive one surface at one width to a settled state and save its style map (+ screenshot). */
async function captureSurface(page: Page, surface: Surface, width: number, s: Settings): Promise<void> {
  test.setTimeout(180_000);
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
export function defineStyleMapCapture({
  surfaces,
  dir,
  baseDir = '__stylemaps__',
  screenshots = true,
  replayFrom = process.env.STYLEPROOF_REPLAY_FROM,
  replayUrl = process.env.STYLEPROOF_REPLAY_URL ?? '**/api/**',
  freezeClock = true,
  clockTime = '2025-01-01T00:00:00Z',
  selfCheck = process.env.STYLEPROOF_SELFCHECK === '1',
  captureText = false,
  captureComponent = false,
}: DefineOptions): void {
  test.skip(!dir, 'set STYLEMAP_DIR=<label> to capture computed-style maps');
  const settings: Settings = {
    dir: dir as string,
    baseDir,
    screenshots,
    replayFrom,
    replayUrl,
    freezeClock,
    clockTime,
    selfCheck,
    captureText,
    captureComponent,
  };
  test.describe('styleproof capture', () => {
    for (const surface of surfaces) {
      for (const width of surface.widths) {
        test(`${surface.key} @ ${width}`, ({ page }) => captureSurface(page, surface, width, settings));
      }
    }
  });
}
