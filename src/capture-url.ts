/**
 * One-shot capture of a single URL's computed-style map — no spec, no config, no git. Writes
 * `<key>@<width>.json.gz` (+ `.png`) in the same shape as a surface capture, so `styleproof-diff`
 * compares a deployed page, static export, or mockup like any other capture.
 */
import fs from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, captureSurfaceScreenshots, trackInflightRequests } from './capture.js';
import { detectViewportWidths } from './breakpoints.js';
import { runSetup } from './crawl/page.js';
import { CRAWL_DEFAULTS, type SetupStep } from './crawl/types.js';
import { writeCaptureManifest } from './map-store.js';
import { captureArtifactStem } from './surface-keys.js';
import { errorMessage } from './util.js';

/** Raised for bad CLI usage so the bin can print help and exit 2. */
export class UsageError extends Error {}

export type CaptureUrlOptions = {
  url: string;
  /** Capture file name prefix (`<key>@<width>.json.gz`); default `page`. */
  key: string;
  /** Empty = auto-detect from the CSSOM (fails loudly on a cross-origin sheet — pass widths for those). */
  widths: number[];
  out: string;
  ignore: string[];
  waitSelector?: string;
  height: number;
  screenshots: boolean;
  /** Crawl the whole interactive surface instead of capturing one state (see `crawlAndCapture`). */
  crawl: boolean;
  maxDepth: number;
  maxActionsPerState: number;
  maxStates: number;
  resetStorage: boolean;
  /** crawl: exit non-zero unless every stylesheet class rendered in a captured surface. */
  requireFullCoverage: boolean;
  /** crawl: stop once coverage is complete — a fast coverage check, not an exhaustive map. */
  untilCovered: boolean;
  setupFile?: string;
  /** Loaded setup steps; applied in BOTH modes, so a gated page's single state is capturable too. */
  setup?: SetupStep[];
  dataStates: boolean;
  workers: number;
  followLinks: boolean;
  authBoundaryExcludeFile?: string;
  authBoundaryExclude?: Record<string, string>;
  incompleteUiExcludeFile?: string;
  incompleteUiExclude?: Record<string, string>;
};

const DEFAULTS = {
  ...CRAWL_DEFAULTS,
  key: 'page',
  out: 'styleproof-capture',
  height: 800,
  crawl: false,
  requireFullCoverage: false,
  untilCovered: false,
  dataStates: true,
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

// Table-driven: value flags mutate the accumulator with their argument; bool flags take none.
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
  '--auth-boundary-exclude': (o, v) => (o.authBoundaryExcludeFile = v),
  '--incomplete-ui-exclude': (o, v) => (o.incompleteUiExcludeFile = v),
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

// Apply one argv token; returns the index to resume from. Supports `--flag value` and `--flag=value`.
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

/** Parse `styleproof-capture` argv into options. Pure and throwing, so it is testable without a browser. */
export function parseCaptureUrlArgs(argv: string[]): CaptureUrlOptions {
  const o: CaptureUrlOptions = {
    ...DEFAULTS,
    url: '',
    widths: [],
    ignore: [],
    waitSelector: undefined,
    setupFile: undefined,
    authBoundaryExcludeFile: undefined,
    authBoundaryExclude: undefined,
    incompleteUiExcludeFile: undefined,
    incompleteUiExclude: undefined,
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

async function loadReady(page: Page, opts: CaptureUrlOptions): Promise<void> {
  await page.goto(opts.url, { waitUntil: 'load' });
  if (opts.waitSelector) await page.locator(opts.waitSelector).first().waitFor({ state: 'visible' });
  if (opts.setup?.length) await runSetup(page, opts.setup);
}

/** Capture `opts.url` at each width, re-navigating per width so width-dependent rendering is
 *  captured fresh with the in-flight tracker armed — the same contract as a surface capture. */
export async function captureUrlToDir(page: Page, opts: CaptureUrlOptions): Promise<CaptureUrlResult[]> {
  fs.mkdirSync(opts.out, { recursive: true });
  // Before the first goto: animation libraries read prefers-reduced-motion at mount, and their
  // rAF-driven inline styles are beyond FREEZE_CSS's reach. Persists for every navigation below.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let widths = opts.widths;
  if (widths.length === 0) {
    await page.setViewportSize({ width: 1280, height: opts.height });
    await loadReady(page, opts);
    widths = await detectViewportWidths(page);
  }
  const results: CaptureUrlResult[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: opts.height });
    const requests = trackInflightRequests(page);
    try {
      await loadReady(page, opts);
      const capture = { ignore: opts.ignore, pendingRequests: requests.pending, metadata: { surfaceKey: opts.key } };
      const map = await captureStyleMap(page, capture);
      const stem = captureArtifactStem(opts.out, opts.key, width);
      saveStyleMap(`${stem}.json.gz`, map);
      const result: CaptureUrlResult = { width, map: `${stem}.json.gz` };
      if (opts.screenshots) {
        await captureSurfaceScreenshots(page, stem, { ignore: opts.ignore }); // animations already frozen by the map capture
        result.screenshot = `${stem}.png`;
      }
      results.push(result);
    } finally {
      requests.dispose();
    }
  }
  // A manifest gives `styleproof-diff <thisDir> <build>` the same-environment guard on both sides;
  // outside a git repo (a design mockup) the git fields degrade gracefully.
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
    return await captureUrlToDir(await browser.newPage(), opts);
  } finally {
    await browser.close();
  }
}

function readJsonFile(file: string, flag: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`${flag}: cannot read ${file}: ${errorMessage(e)}`);
  }
}

const SETUP_ACTIONS = new Set(['goto', 'fill', 'click', 'waitFor']);

/** Load and validate a `--setup` steps file, interpolating `${ENV_VAR}` in every `value` and `url`
 *  so credentials never live in the file or the maps. Throws {@link UsageError} on a bad file or missing variable. */
export function loadSetupSteps(file: string, env: NodeJS.ProcessEnv = process.env): SetupStep[] {
  const parsed = readJsonFile(file, '--setup');
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

/** Load a `<key> → non-empty reason` JSON object. Empty reasons are rejected so silence cannot clear a fail-closed boundary. */
function loadReasonMap(file: string, flag: string, noun: string, keyNoun: string): Record<string, string> {
  const parsed = readJsonFile(file, flag);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${flag}: the file must be a JSON object of ${noun} → reason`);
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawReason] of Object.entries(parsed as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) throw new UsageError(`${flag}: ${keyNoun} must be a non-empty string`);
    if (typeof rawReason !== 'string' || !rawReason.trim()) {
      throw new UsageError(`${flag}: exclusion for "${key}" needs a non-empty reason`);
    }
    out[key] = rawReason.trim();
  }
  return out;
}

/** Load a `--auth-boundary-exclude` JSON object (`key → reason`). */
export function loadAuthBoundaryExclude(file: string): Record<string, string> {
  return loadReasonMap(file, '--auth-boundary-exclude', 'key', 'exclusion key');
}

/** Load a reasoned incomplete-UI surface exclusion map. */
export function loadIncompleteUiExclude(file: string): Record<string, string> {
  return loadReasonMap(file, '--incomplete-ui-exclude', 'surface', 'surface');
}
