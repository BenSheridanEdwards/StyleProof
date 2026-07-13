import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, trackInflightRequests } from './capture.js';
import { detectViewportWidths } from './breakpoints.js';
import { runSetup, type SetupStep } from './crawl-surfaces.js';
import { writeCaptureManifest } from './map-store.js';

/**
 * One-shot capture of a single URL's computed-style map — no spec, no config,
 * no git. `defineStyleMapCapture` is the right tool when the surfaces live in
 * your own app and you want the coverage guard, the map store, and record/replay.
 * This is the tool for a page you just want to point at: a deployed URL, a
 * static export, or a standalone HTML mockup. Capture it into a directory of
 * `<key>@<width>.json.gz` maps (+ `.png`) that {@link diffStyleMapDirs} — i.e.
 * `styleproof-diff <a> <b>` — compares like any other capture.
 *
 * The output is deliberately the same shape a surface capture writes, so a
 * mockup's map and your app's committed map are directly diffable: capture the
 * design once, then diff each build against it to measure how close the
 * implementation is (a diff that shrinks toward zero as it converges).
 */

/** Raised for bad CLI usage so the bin can print help and exit 2. */
export class UsageError extends Error {}

export type CaptureUrlOptions = {
  /** Page to capture. */
  url: string;
  /** Capture file name prefix (`<key>@<width>.json.gz`); default `page`. */
  key: string;
  /**
   * Viewport widths to sweep, one per @media band. Empty = auto-detect from the
   * loaded CSSOM (fails loudly on a cross-origin/unreadable stylesheet — pass
   * widths explicitly for a page whose CSS can't be read, e.g. a cross-origin
   * font stylesheet).
   */
  widths: number[];
  /** Output directory for the maps (+ screenshots). */
  out: string;
  /** Selectors for nondeterministic regions to skip (passed through to capture). */
  ignore: string[];
  /** Wait for this selector to be visible before capturing (reach the intended state). */
  waitSelector?: string;
  /** Viewport height (default 800). */
  height: number;
  /** Also write a full-page `.png` per capture (default true). */
  screenshots: boolean;
  /**
   * Crawl the URL's whole interactive surface instead of capturing one state:
   * drive every non-destructive control, recurse into what opens, capture each
   * discovered surface under a derived key. See {@link crawlAndCapture}.
   */
  crawl: boolean;
  /** crawl: recursion depth into opened surfaces (default 16). */
  maxDepth: number;
  /** crawl: fresh controls driven per state (default: unbounded — try them all). */
  maxActionsPerState: number;
  /** crawl: safety backstop on total surfaces (default: unbounded — exhaustive). */
  maxStates: number;
  /** crawl: clear storage on each reset so replay is deterministic (default true). */
  resetStorage: boolean;
  /** crawl: exit non-zero unless every class the page's stylesheets define was
   *  rendered in at least one captured surface (default false — report only). */
  requireFullCoverage: boolean;
  /** crawl: stop as soon as coverage is complete (every defined class seen) or
   *  has converged (no new class for a plateau of surfaces). Turns the crawl
   *  into a FAST coverage check that stops once it has seen everything, instead
   *  of enumerating every combinatorial surface. Default false (exhaustive). */
  untilCovered: boolean;
  /** crawl: JSON file of deterministic setup steps (login, unlock, seed input)
   *  run after every fresh navigation. See {@link loadSetupSteps}. */
  setupFile?: string;
  /** Loaded setup steps (set by the CLI from `setupFile`); applied after every
   *  navigation in BOTH modes, so a gated page's single state is capturable too. */
  setup?: SetupStep[];
  /** crawl: also capture automatic `loading`/`error` data states of the entry
   *  page (default true). */
  dataStates: boolean;
  /** crawl: concurrent sweep workers (default 4). 1 = byte-stable key attribution. */
  workers: number;
  /** crawl: also crawl every same-origin page the nav links to (default true).
   *  Off = the entry page's interactive surface only. */
  followLinks: boolean;
};

const DEFAULTS = {
  key: 'page',
  height: 800,
  screenshots: true,
  crawl: false,
  // Exhaustive by default — these are safety backstops, not budgets.
  // maxDepth mirrors CRAWL_DEFAULTS.maxDepth (crawl-surfaces.ts): 16 is
  // exhaustive for real UI — no human-navigable surface is 16 clicks from load.
  // The cap exists to bound append-generator UIs (a composer that appends a
  // fresh-identity node per click, which dedup can't terminate); a higher value
  // would make it decorative. Raise with --max-depth for a genuinely deeper nest.
  maxDepth: 16,
  maxActionsPerState: 100000,
  maxStates: 100000,
  resetStorage: true,
  requireFullCoverage: false,
  untilCovered: false,
  dataStates: true,
  workers: 4,
  followLinks: true,
};

function positiveNumber(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag}: not a positive number: ${raw}`);
  return n;
}

function parseWidths(raw: string): number[] {
  const widths = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => positiveNumber(s, '--widths'));
  if (widths.length === 0) throw new UsageError('--widths: no widths given');
  return widths;
}

// Table-driven so adding a flag is one entry, not another branch in the loop.
// value flags mutate the accumulator with their argument; bool flags take none.
const VALUE_FLAGS: Record<string, (o: CaptureUrlOptions, v: string) => void> = {
  '--key': (o, v) => (o.key = v),
  '--widths': (o, v) => (o.widths = parseWidths(v)),
  '--out': (o, v) => (o.out = v),
  '--ignore': (o, v) => o.ignore.push(v),
  '--wait': (o, v) => (o.waitSelector = v),
  '--height': (o, v) => (o.height = positiveNumber(v, '--height')),
  '--max-depth': (o, v) => (o.maxDepth = positiveNumber(v, '--max-depth')),
  '--max-actions': (o, v) => (o.maxActionsPerState = positiveNumber(v, '--max-actions')),
  '--max-states': (o, v) => (o.maxStates = positiveNumber(v, '--max-states')),
  '--setup': (o, v) => (o.setupFile = v),
  '--workers': (o, v) => (o.workers = positiveNumber(v, '--workers')),
};
const BOOL_FLAGS: Record<string, (o: CaptureUrlOptions) => void> = {
  '--screenshots': (o) => (o.screenshots = true),
  '--no-screenshots': (o) => (o.screenshots = false),
  '--crawl': (o) => (o.crawl = true),
  '--no-reset-storage': (o) => (o.resetStorage = false),
  '--require-full-coverage': (o) => (o.requireFullCoverage = true),
  '--until-covered': (o) => (o.untilCovered = true),
  '--data-states': (o) => (o.dataStates = true),
  '--no-data-states': (o) => (o.dataStates = false),
  '--follow-links': (o) => (o.followLinks = true),
  '--no-follow-links': (o) => (o.followLinks = false),
};

// Apply one argv token to the accumulator; returns the index to resume from
// (advanced past a consumed `--flag value` pair). Flat early-returns so the
// parse loop stays trivial. Supports `--flag value` and `--flag=value`.
function applyArg(o: CaptureUrlOptions, argv: string[], i: number, positional: string[]): number {
  const a = argv[i];
  const eq = a.startsWith('--') ? a.indexOf('=') : -1;
  const name = eq === -1 ? a : a.slice(0, eq);

  const bool = BOOL_FLAGS[name];
  if (bool) {
    bool(o);
    return i;
  }
  const apply = VALUE_FLAGS[name];
  if (apply) {
    const v = eq === -1 ? argv[i + 1] : a.slice(eq + 1);
    if (v === undefined) throw new UsageError(`${name}: missing value`);
    apply(o, v);
    return eq === -1 ? i + 1 : i;
  }
  if (a.startsWith('--')) throw new UsageError(`unknown flag: ${a}`);
  positional.push(a);
  return i;
}

/**
 * Parse `styleproof-capture` argv into options. Pure and throwing so the CLI
 * flow (help/exit codes) and this parse are testable without a browser.
 */
export function parseCaptureUrlArgs(argv: string[]): CaptureUrlOptions {
  const o: CaptureUrlOptions = {
    url: '',
    key: DEFAULTS.key,
    widths: [],
    out: 'styleproof-capture',
    ignore: [],
    waitSelector: undefined,
    height: DEFAULTS.height,
    screenshots: DEFAULTS.screenshots,
    crawl: DEFAULTS.crawl,
    maxDepth: DEFAULTS.maxDepth,
    maxActionsPerState: DEFAULTS.maxActionsPerState,
    maxStates: DEFAULTS.maxStates,
    resetStorage: DEFAULTS.resetStorage,
    requireFullCoverage: DEFAULTS.requireFullCoverage,
    untilCovered: DEFAULTS.untilCovered,
    setupFile: undefined,
    dataStates: DEFAULTS.dataStates,
    workers: DEFAULTS.workers,
    followLinks: DEFAULTS.followLinks,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) i = applyArg(o, argv, i, positional);

  if (positional.length === 0) throw new UsageError('missing <url>');
  if (positional.length > 1) throw new UsageError(`expected one <url>, got ${positional.length}`);
  o.url = positional[0];
  return o;
}

/** Written artifacts for one width. */
export type CaptureUrlResult = { width: number; map: string; screenshot?: string };

/**
 * Capture `opts.url` at each width using an already-open {@link Page}, writing
 * `<out>/<key>@<width>.json.gz` (+ `.png`). Re-navigates per width so
 * width-dependent rendering (media queries, `matchMedia`) is captured fresh, and
 * arms the in-flight request tracker before each navigation so the page's own
 * load fetches count toward the network-aware settle — same contract as a
 * surface capture. Returns the files written.
 */
export async function captureUrlToDir(page: Page, opts: CaptureUrlOptions): Promise<CaptureUrlResult[]> {
  fs.mkdirSync(opts.out, { recursive: true });

  let widths = opts.widths;
  if (widths.length === 0) {
    await page.setViewportSize({ width: 1280, height: opts.height });
    await page.goto(opts.url, { waitUntil: 'load' });
    if (opts.waitSelector) await page.locator(opts.waitSelector).first().waitFor({ state: 'visible' });
    if (opts.setup?.length) await runSetup(page, opts.setup);
    widths = await detectViewportWidths(page);
  }

  const results: CaptureUrlResult[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: opts.height });
    const requests = trackInflightRequests(page);
    try {
      await page.goto(opts.url, { waitUntil: 'load' });
      if (opts.waitSelector) await page.locator(opts.waitSelector).first().waitFor({ state: 'visible' });
      if (opts.setup?.length) await runSetup(page, opts.setup);
      const map = await captureStyleMap(page, {
        ignore: opts.ignore,
        pendingRequests: requests.pending,
        metadata: { surfaceKey: opts.key },
      });
      const stem = path.join(opts.out, `${opts.key}@${width}`);
      const mapPath = `${stem}.json.gz`;
      saveStyleMap(mapPath, map);
      const result: CaptureUrlResult = { width, map: mapPath };
      if (opts.screenshots) {
        const shot = `${stem}.png`;
        // captureStyleMap froze animations, so the shot matches the mapped state.
        await page.screenshot({ path: shot, fullPage: true, animations: 'disabled' });
        result.screenshot = shot;
      }
      results.push(result);
    } finally {
      requests.dispose();
    }
  }
  // Stamp a manifest so `styleproof-diff <thisDir> <build>` has the same-environment
  // guard on both sides — v4 refuses to compare a manifest-less side. May run outside
  // a git repo (a design mockup); the git fields degrade gracefully.
  writeCaptureManifest({ dir: opts.out, screenshots: opts.screenshots });
  return results;
}

/** Launch Chromium, capture the URL, and close — the whole bin body given parsed options. */
export async function runCaptureUrl(
  opts: CaptureUrlOptions,
  launch: () => Promise<Browser>,
): Promise<CaptureUrlResult[]> {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    return await captureUrlToDir(page, opts);
  } finally {
    await browser.close();
  }
}

const SETUP_ACTIONS = new Set(['goto', 'fill', 'click', 'waitFor']);

/**
 * Load and validate a `--setup` steps file, interpolating `${ENV_VAR}` in every
 * `value` and `url` from the environment — so credentials for an input-gated
 * page live in env vars, never in the file, the shell history, or the maps.
 * Throws {@link UsageError} on a malformed file or a missing variable.
 */
export function loadSetupSteps(file: string, env: NodeJS.ProcessEnv = process.env): SetupStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`--setup: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new UsageError('--setup: the file must be a JSON array of steps');
  const interpolate = (raw: string): string =>
    raw.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
      const v = env[name];
      if (v === undefined) throw new UsageError(`--setup: environment variable ${name} is not set`);
      return v;
    });
  return parsed.map((raw, i) => {
    const step = raw as SetupStep;
    if (!SETUP_ACTIONS.has(step.action))
      throw new UsageError(`--setup: step ${i} has unknown action "${String(step.action)}"`);
    if (step.action === 'goto' && !step.url) throw new UsageError(`--setup: step ${i} (goto) needs a url`);
    if (step.action !== 'goto' && !step.selector)
      throw new UsageError(`--setup: step ${i} (${step.action}) needs a selector`);
    return {
      ...step,
      ...(step.url ? { url: interpolate(step.url) } : {}),
      ...(step.value ? { value: interpolate(step.value) } : {}),
    };
  });
}
