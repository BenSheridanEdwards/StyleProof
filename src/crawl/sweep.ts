/**
 * Surface crawler: deterministically map a URL's WHOLE interactive surface to natural
 * termination. From the base state it drives every visible, non-destructive control, keeps
 * whatever opens a structurally new surface, and recurses. Termination comes from dedup (a
 * control is driven once by identity; a surface is captured once); `max*` options are throttles.
 * The sweep is IN-PLACE with lazy, VERIFIED resets: a no-op click costs nothing, a state-changing
 * click pays a fresh navigation + replay checked against the state's fingerprint, and new
 * surfaces are captured the moment they're reached. Destructive-looking controls are never clicked.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { detectViewportWidths } from '../breakpoints.js';
import { DANGER_SOURCE } from '../danger.js';
import { classifyAuthBoundary, type AuthBoundaryMetadata } from '../auth-boundary.js';
import { resolveCrawlConfidence, redactedRoutePath, shouldRetainAuthRedirects } from '../crawl-confidence.js';
import { uniqueKeyFor } from '../crawl.js';
import { slug } from '../util.js';
import { collectClickable, collectDefinedClasses } from './browser.js';
import {
  armResetStorage,
  captureInPlace,
  fingerprint,
  gotoFresh,
  observeBoundaries,
  pathAndSearch,
  perform,
  resetToState,
  settleDom,
} from './page.js';
import type {
  CrawlReport,
  CrawlState,
  CrawlStep,
  CrawledSurface,
  Fingerprint,
  QueueEntry,
  RawCandidate,
  SurfaceCrawlOptions,
} from './types.js';

type Ctx = { opts: SurfaceCrawlOptions; st: CrawlState };
type Counts = { tried: number; skipped: number };
/** One state's sweep: its queue entry, the child buffer, and the control identities present in it. */
type Sweep = { entry: QueueEntry; sink: QueueEntry[]; presentIds: Set<string> };

/** Observation failed after a surface was recorded — never fail-soft, or the report reads falsely complete. */
class AuthBoundaryObserveError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AuthBoundaryObserveError';
  }
}

/** A prefixed crawl (one page of a multi-page sweep) keys its root as the prefix itself and
 *  namespaces sub-states under it, so two pages never overwrite each other in a shared --out. */
function deriveKey(steps: CrawlStep[], { opts, st }: Ctx): string {
  const bare = steps.length === 0 ? 'base' : slug(steps[steps.length - 1].label);
  const prefix = opts.keyPrefix ?? '';
  return uniqueKeyFor(prefix === '' ? bare : bare === 'base' ? prefix : `${prefix}-${bare}`, st.used);
}

/** Identity of a state for the changer registry: the click-path that defines it. */
const stateKey = (steps: CrawlStep[]): string => steps.map((s) => s.selector + (s.value ?? '')).join(' → ');

/** Observe at every newly recorded state (a password form can mount after an interaction). Auth is
 *  the more specific classifier, so its controls are never double-counted as generic incomplete UI;
 *  `surface` null (a data state) records auth only. */
async function observeInto(page: Page, st: CrawlState, surface: string | null, context: string): Promise<void> {
  let observed;
  try {
    observed = await observeBoundaries(page);
  } catch (err) {
    throw new AuthBoundaryObserveError(`auth-boundary observation failed ${context}`, err);
  }
  if (observed.auth) st.authObservations.push(observed.auth);
  else if (surface && observed.incompleteUi.length) {
    st.incompleteUiObservations.push({ surface, diagnostics: observed.incompleteUi });
  }
}

/** Remove every artifact a failed multi-width capture may have written before a later width
 *  failed. The producer ledger and filesystem must tell one story. */
export function removeSurfaceCaptureArtifacts(out: string, key: string, widths: readonly number[]): void {
  const names = fs.existsSync(out) ? fs.readdirSync(out) : [];
  const prefixes = widths.map((width) => `${key}@${width}.`);
  for (const name of names) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) fs.rmSync(path.join(out, name), { force: true });
  }
}

async function captureAndReport(page: Page, { opts, st }: Ctx, surface: CrawledSurface): Promise<void> {
  let ok = true;
  try {
    await captureInPlace(page, surface.key, opts);
    st.captured++;
  } catch {
    removeSurfaceCaptureArtifacts(opts.out, surface.key, opts.widths);
    st.failed.push(surface.key);
    ok = false;
  }
  opts.onSurface?.(surface, ok);
}

/** Record a newly-found surface, capture it in place, and queue it for its own sweep. Children
 *  buffer in `sink` and enter the shared queue when the parent's sweep completes (family retry
 *  reads the parent's changer registry, which is only complete then). */
async function record(page: Page, ctx: Ctx, entry: QueueEntry, fp: Fingerprint, sink: QueueEntry[]): Promise<void> {
  const { opts, st } = ctx;
  const key = deriveKey(entry.path, ctx);
  const surface: CrawledSurface = { key, depth: entry.depth, path: entry.path, elements: fp.elements };
  st.surfaces.push(surface);
  await observeInto(page, st, key, `after recording surface ${key}`);
  const before = st.classes.size;
  for (const c of fp.classes) st.classes.add(c);
  // --until-covered: a surface adding no new render vocabulary is a structural repeat — neither
  // queued (its subtree repeats too) nor captured (its classes are already counted). Base always seeds.
  if (opts.stopWhenCovered && st.classes.size === before && entry.depth !== 0) return;
  sink.push(entry);
  await captureAndReport(page, ctx, surface);
}

/** Click one candidate where the page stands; classify the outcome. */
async function tryInPlace(page: Page, c: RawCandidate): Promise<'failed' | 'navigated' | 'noop' | 'changed'> {
  const startUrl = pathAndSearch(page.url());
  const before = (await fingerprint(page)).sig;
  try {
    await perform(page, c);
  } catch {
    return 'failed';
  }
  await settleDom(page);
  if (pathAndSearch(page.url()) !== startUrl) return 'navigated';
  return (await fingerprint(page)).sig === before ? 'noop' : 'changed';
}

/** Register a state-changing control for family retry. `persists` = still present after its own
 *  click (a tab survives its switch; an approve row consumes itself). */
function registerChanger(st: CrawlState, from: string, c: RawCandidate, persists: boolean): void {
  const list = st.changersFrom.get(from) ?? [];
  if (!list.some((x) => x.c.identity === c.identity)) list.push({ c, persists });
  st.changersFrom.set(from, list);
}

/** Drive one candidate from where the page stands: `noop` left the page in the swept state (no reset
 *  needed), `skipped` failed or navigated away, `changed` opened a surface (recorded, and descended
 *  in place). */
async function driveCandidate(
  page: Page,
  ctx: Ctx,
  { entry, sink, presentIds }: Sweep,
  c: RawCandidate,
  viaRetry: boolean,
): Promise<'noop' | 'skipped' | 'changed'> {
  const outcome = await tryInPlace(page, c);
  if (outcome !== 'changed') return outcome === 'noop' ? 'noop' : 'skipped';
  const persists = await page
    .locator(c.selector)
    .first()
    .isVisible()
    .catch(() => false);
  registerChanger(ctx.st, stateKey(entry.path), c, persists);
  const fp = await fingerprint(page);
  if (ctx.st.seen.has(fp.sig)) return 'changed'; // same surface reached another way
  ctx.st.seen.add(fp.sig);
  const { action, selector, label, reason, value } = c;
  const step: CrawlStep = { action, selector, label, reason, ...(value ? { value } : {}) };
  // Retry-only lineage is inherited: a consumed state's descendants are mode-switch views only.
  const child: QueueEntry = {
    path: [...entry.path, step],
    depth: entry.depth + 1,
    sig: fp.sig,
    retryOnly: entry.retryOnly || !persists,
    viaRetry,
  };
  await record(page, ctx, child, fp, sink);
  // DESCEND IN PLACE (exhaustive mode): sweep the opened surface's genuinely NEW controls now, via a
  // reliable forward click rather than a fragile deep replay. Controls also present in the parent
  // are breadth, owned by the queued family retry. --until-covered skips this: the breadth-first
  // queue reaches every distinct component faster.
  if (!ctx.opts.stopWhenCovered && persists && child.depth < ctx.opts.maxDepth) {
    await sweepCandidatesHere(page, ctx, child, sink, presentIds).catch((err: unknown) => {
      // Observation failures are fatal (runPool stops the crawl); anything else is fail-soft — the surface was already captured.
      if (err instanceof AuthBoundaryObserveError) throw err;
    });
  }
  return 'changed';
}

/** The parent's persistent mode-switchers visible right now, minus the step that created this
 *  state. Retries do not compound: every PAIRWISE mode combination is captured, N-way products
 *  are not (they multiply states without new vocabulary). */
function familyRetries(entry: QueueEntry, all: RawCandidate[], st: CrawlState): RawCandidate[] {
  if (entry.viaRetry || entry.path.length === 0) return [];
  const parentKey = stateKey(entry.path.slice(0, -1));
  const ownSelector = entry.path[entry.path.length - 1].selector;
  // Match by semantic identity — the mode switch re-rendered the subtree, so positional selectors drifted.
  const byIdentity = new Map(all.map((c) => [c.identity, c]));
  return (st.changersFrom.get(parentKey) ?? [])
    .filter((x) => x.persists && x.c.selector !== ownSelector)
    .map((x) => byIdentity.get(x.c.identity))
    .filter((c): c is RawCandidate => Boolean(c));
}

/** Fresh controls first (the throttle applies to them), then the parent's mode-switchers re-tried
 *  in THIS sibling mode. An in-place descent (`excludeIds` set) drops the retries — that breadth
 *  is owned by the queued sweep, and re-applying it while descending would compound modes. */
function sweepWorkList(
  entry: QueueEntry,
  all: RawCandidate[],
  { opts, st }: Ctx,
  excludeIds?: Set<string>,
): { c: RawCandidate; retry: boolean }[] {
  const fresh = entry.retryOnly
    ? []
    : all.filter((c) => !st.tried.has(c.identity) && !excludeIds?.has(c.identity)).slice(0, opts.maxActionsPerState);
  const retries = excludeIds ? [] : familyRetries(entry, all, st);
  return [...fresh.map((c) => ({ c, retry: false })), ...retries.map((c) => ({ c, retry: true }))];
}

/** Drive one state's work list from where the page ALREADY stands. A state-changing click drives
 *  the child in place, then a verified reset returns here before the next candidate. `excludeIds`
 *  (controls present in the parent) marks an in-place descent that drills only new nested UI. */
async function sweepCandidatesHere(
  page: Page,
  ctx: Ctx,
  entry: QueueEntry,
  sink: QueueEntry[],
  excludeIds?: Set<string>,
): Promise<Counts> {
  const { opts, st } = ctx;
  const all = await page.evaluate(collectClickable, DANGER_SOURCE).catch(() => [] as RawCandidate[]);
  const work = sweepWorkList(entry, all, ctx, excludeIds);
  const sweep: Sweep = { entry, sink, presentIds: new Set(all.map((c) => c.identity)) };
  const counts: Counts = { tried: 0, skipped: 0 };
  let inState = true;
  for (const { c, retry } of work) {
    if (st.surfaces.length >= opts.maxStates) break;
    if (!inState) {
      if (!(await resetToState(page, opts, entry))) break; // abandon the rest, fail-soft
      inState = true;
    }
    if (!retry) st.tried.add(c.identity);
    if (c.unsafe) {
      counts.skipped++;
      continue;
    }
    counts.tried++;
    const outcome = await driveCandidate(page, ctx, sweep, c, retry);
    inState = outcome === 'noop';
    if (outcome === 'skipped') counts.skipped++;
  }
  return counts;
}

/** Capture one synthetic data state of the entry page (data requests stalled or failed) in place,
 *  deduped like any surface but never queued: a stalled app is not a state to crawl deeper from. */
async function recordDataState(page: Page, ctx: Ctx, mode: 'loading' | 'error'): Promise<void> {
  const { opts, st } = ctx;
  // Match by resource TYPE, not URL: apps cache-bust, so the re-load's data URLs never equal the observed ones.
  await page.route('**/*', async (route) => {
    const kind = route.request().resourceType();
    if (kind !== 'fetch' && kind !== 'xhr') return route.continue();
    if (mode === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    // loading: the request stays pending forever — the skeleton IS the state.
  });
  try {
    await page.setViewportSize({ width: opts.widths[0] ?? 1280, height: opts.height });
    await page.goto(opts.url, { waitUntil: 'load' });
    await settleDom(page, 2500); // no networkidle — a stalled request never goes idle
    await observeInto(page, st, null, `during data-state ${mode}`);
    const fp = await fingerprint(page);
    if (st.seen.has(fp.sig)) return; // renders identically to a captured state (e.g. SSR)
    st.seen.add(fp.sig);
    for (const c of fp.classes) st.classes.add(c);
    const key = deriveKey([{ action: 'click', selector: `(data:${mode})`, label: mode, reason: 'data-state' }], ctx);
    const surface: CrawledSurface = { key, depth: 0, path: [], elements: fp.elements };
    st.surfaces.push(surface);
    await captureAndReport(page, ctx, surface);
  } finally {
    await page.unroute('**/*');
  }
}

/** Sweep the queue with N workers, each on its own page. FIFO → breadth-first: shallow surfaces
 *  (nav tabs, opened panels) are exhausted before drilling; dedup is set-based, so order never
 *  changes WHAT is found. Coverage early-stop (opt-in) fires the moment every defined class has
 *  been SEEN — no plateau stop, since a productive deep state can add vocabulary late. */
async function runPool(primary: Page, ctx: Ctx, counters: Counts, defined: string[]): Promise<void> {
  const { opts, st } = ctx;
  const pages: Page[] = [primary];
  while (opts.newPage && pages.length < Math.max(1, opts.workers ?? 1)) {
    const extra = await opts.newPage();
    if (opts.resetStorage) await armResetStorage(extra);
    pages.push(extra);
  }
  const cover = opts.stopWhenCovered && defined.length > 0 ? defined : null;
  let prevSize = st.classes.size;
  let covered = false;
  const converged = (): boolean => {
    if (cover && !covered && st.classes.size > prevSize) {
      prevSize = st.classes.size;
      covered = cover.every((c) => st.classes.has(c));
    }
    return covered;
  };
  let active = 0;
  let fatalError: unknown;
  const sweepEntry = async (page: Page, entry: QueueEntry): Promise<void> => {
    const sink: QueueEntry[] = [];
    active++;
    try {
      if (await resetToState(page, opts, entry)) {
        const r = await sweepCandidatesHere(page, ctx, entry, sink);
        counters.tried += r.tried;
        counters.skipped += r.skipped;
      }
    } catch (err) {
      // Observation failures are never fail-soft; anything else — the state's surface was already captured.
      if (err instanceof AuthBoundaryObserveError) {
        fatalError = err;
        st.queue.length = 0;
      }
    } finally {
      st.queue.push(...sink);
      active--;
    }
  };
  // An idle worker waits while a sibling's sweep may still buffer children into the queue.
  const worker = async (page: Page): Promise<void> => {
    while (!fatalError && st.surfaces.length < opts.maxStates && !converged()) {
      const entry = st.queue.shift();
      if (entry && entry.depth < opts.maxDepth) await sweepEntry(page, entry);
      else if (!entry && active === 0) return;
      else if (!entry) await new Promise((r) => setTimeout(r, 25));
    }
  };
  await Promise.all(pages.map(worker));
  if (fatalError) throw fatalError;
}

/** Navigate fresh and append any auth-boundary observations (redirect + DOM). */
async function gotoFreshObservingAuth(page: Page, opts: SurfaceCrawlOptions, st: CrawlState): Promise<void> {
  const redirectMeta: AuthBoundaryMetadata[] = [];
  await gotoFresh(page, opts, redirectMeta);
  const redirectDiagnostics = classifyAuthBoundary(redirectMeta);
  const { auth: landed } = await observeBoundaries(page);
  const landedPath = redactedRoutePath(page.url());
  // Intermediate 3xx→auth redirects are transit only when setup left the wall onto a non-auth path.
  if (
    redirectDiagnostics.length &&
    shouldRetainAuthRedirects(Boolean(opts.setup?.length), Boolean(landed), landedPath)
  ) {
    const route = redactedRoutePath(opts.url) ?? landedPath;
    st.authObservations.push({ ...(route ? { route } : {}), diagnostics: redirectDiagnostics });
  }
  if (landed) st.authObservations.push(landed);
}

async function discover(page: Page, opts: SurfaceCrawlOptions): Promise<CrawlReport> {
  fs.mkdirSync(opts.out, { recursive: true });
  const st: CrawlState = {
    seen: new Set(),
    used: new Set(),
    tried: new Set(),
    changersFrom: new Map(),
    classes: new Set(),
    surfaces: [],
    queue: [],
    captured: 0,
    failed: [],
    authObservations: [],
    incompleteUiObservations: [],
  };
  // Armed before navigation so the automatic data states know whether the app's boot fetches data at all.
  let dataRequests = 0;
  const onRequest = (req: { resourceType: () => string }): void => {
    if (['fetch', 'xhr'].includes(req.resourceType())) dataRequests++;
  };
  page.on('request', onRequest);
  await gotoFreshObservingAuth(page, opts, st);
  // No widths? Detect the page's real @media bands. Detection THROWS on an unreadable sheet —
  // never a silent single-width sweep; pin --widths for cross-origin CSS.
  if (opts.widths.length === 0) {
    const widths = await detectViewportWidths(page);
    opts = { ...opts, widths };
    if ((widths[0] ?? 1280) !== 1280) await gotoFreshObservingAuth(page, opts, st); // re-pin BEFORE the base fingerprint
  }
  page.off('request', onRequest);
  const ctx: Ctx = { opts, st };
  const { classes: defined, unreadable } = await page.evaluate(collectDefinedClasses);
  const fp = await fingerprint(page);
  st.seen.add(fp.sig);
  await record(page, ctx, { path: [], depth: 0, sig: fp.sig, retryOnly: false, viaRetry: false }, fp, st.queue);
  // The loading skeleton and error render exist in every data-driven app but almost never in a click path.
  if (opts.dataStates !== false && dataRequests > 0) {
    await recordDataState(page, ctx, 'loading');
    await recordDataState(page, ctx, 'error');
  }
  const counters: Counts = { tried: 0, skipped: 0 };
  await runPool(page, ctx, counters, defined);
  const missing = defined.filter((c) => !st.classes.has(c)).sort();
  const renderedClasses = defined.filter((c) => st.classes.has(c)).sort();
  return {
    surfaces: st.surfaces,
    actionsTried: counters.tried,
    skipped: counters.skipped,
    captured: st.captured,
    failed: st.failed,
    coverage: {
      defined: defined.length,
      rendered: defined.length - missing.length,
      missing,
      unreadable,
      renderedClasses,
    },
    confidence: resolveCrawlConfidence({ observations: st.authObservations, exclude: opts.authBoundaryExclude }),
    incompleteUi: st.incompleteUiObservations,
  };
}

/** Crawl `opts.url` and capture every reachable surface at every width, to natural termination. */
export async function crawlAndCapture(page: Page, opts: SurfaceCrawlOptions): Promise<CrawlReport> {
  if (opts.resetStorage) await armResetStorage(page);
  return discover(page, opts);
}
