import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, trackInflightRequests } from './capture.js';

/**
 * Surface crawler: deterministically map a single URL's WHOLE interactive
 * surface — not just the state it loads in — and run to natural termination.
 *
 * A one-shot capture records the page as it lands, so a design that's mostly
 * modals, drawers, and popovers has most of its surface behind clicks it never
 * reaches. This crawls it instead: from the base state it finds every visible,
 * non-destructive control (semantic controls AND anything the page styles as
 * clickable — `cursor: pointer`) and drives each one, keeping whatever opens a
 * structurally new surface. It then recurses depth-first into each new surface,
 * so a modal's tabs, a drawer's sub-views, and a popover's panels are all mapped.
 *
 * EXHAUSTIVE by default: the crawl stops when the queue drains and every control
 * has been driven once — not at a budget. Termination is guaranteed by dedup
 * (a control is driven once by selector; a structural surface is captured once;
 * both sets are finite). The `--max-*` options exist only as throttles.
 *
 * The sweep is IN-PLACE with lazy resets, which is what makes exhaustive
 * affordable: standing in a state, each candidate is clicked where the page
 * already is, and a cheap DOM fingerprint (tag+class in document order — no
 * computed styles) decides what happened. A no-op click costs nothing; only a
 * state-changing click pays a reset (fresh navigation + path replay), and every
 * reset is VERIFIED against the state's fingerprint before the sweep continues,
 * so children are never attributed to the wrong parent. New surfaces are
 * captured in place the moment they're reached — a deep or animated click-path
 * is never re-driven to capture, so it can't be the thing that drops a surface.
 *
 * Destructive-looking controls (delete, deploy, pay, revoke…) are never clicked —
 * mapping must not mutate. States gated behind such an action need a spec.
 */

export type CrawlStep = {
  action: 'click' | 'select-option';
  selector: string;
  label: string;
  reason: string;
  value?: string;
};

export type CrawledSurface = { key: string; depth: number; path: CrawlStep[]; elements: number };

/** Did the crawl SEE everything the design styles? `missing` lists classes the
 *  page's own stylesheets select on that never appeared in any captured surface —
 *  dead CSS, or a state the crawl could not reach. Empty missing = full coverage. */
export type CrawlCoverage = { defined: number; rendered: number; missing: string[] };

export type CrawlReport = {
  surfaces: CrawledSurface[];
  actionsTried: number;
  skipped: number;
  /** Surfaces successfully captured to disk at every width. */
  captured: number;
  /** Keys of surfaces discovered but whose full capture failed. */
  failed: string[];
  coverage: CrawlCoverage;
};

export type SurfaceCrawlOptions = {
  url: string;
  out: string;
  widths: number[];
  ignore: string[];
  height: number;
  screenshots: boolean;
  waitSelector?: string;
  /** Throttle: recursion depth into opened surfaces (base = 0). Default: unbounded. */
  maxDepth: number;
  /** Throttle: fresh controls driven per state. Default: unbounded — try them all. */
  maxActionsPerState: number;
  /** Throttle: total surfaces. Default: unbounded — run to natural termination. */
  maxStates: number;
  /** Clear localStorage/sessionStorage on each reset so replay is deterministic. Default true. */
  resetStorage: boolean;
  /** Called as each surface is recorded (captured=false when its full capture failed).
   *  Lets CLIs stream progress instead of reporting only at the end. */
  onSurface?: (surface: CrawledSurface, captured: boolean) => void;
};

// Exhaustive by default — these ceilings are safety backstops, not budgets.
export const CRAWL_DEFAULTS = {
  height: 900,
  screenshots: true,
  maxDepth: 1000,
  maxActionsPerState: 100000,
  maxStates: 100000,
  resetStorage: true,
};

type RawCandidate = {
  action: 'click' | 'select-option';
  selector: string;
  label: string;
  reason: string;
  value?: string;
  unsafe: boolean;
};

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'state'
  );
}

function pathAndSearch(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function deriveKey(steps: CrawlStep[], used: Set<string>): string {
  const base = steps.length === 0 ? 'base' : slug(steps[steps.length - 1].label);
  let key = base;
  for (let i = 2; used.has(key); i++) key = `${base}-${i}`;
  used.add(key);
  return key;
}

/** Runs in the browser: every visible, enabled, non-navigating control worth trying. */
/* c8 ignore start */ // fallow-ignore-next-line complexity
function collectClickable(): RawCandidate[] {
  const SEMANTIC = 'button,summary,[role="button"],[role="tab"],[role="menuitem"],[role="combobox"],select,form';
  const DANGER =
    /\b(delete|remove|destroy|logout|log ?out|sign ?out|publish|deploy|pay|purchase|buy|checkout|archive|disconnect|revoke|reset|wipe|drop)\b/i;
  const esc = (v: string): string => CSS.escape(v);
  const quote = (v: string): string => JSON.stringify(v);
  const visible = (el: Element): boolean => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none'
    );
  };
  const unique = (s: string): boolean => document.querySelectorAll(s).length === 1;
  const pathSelector = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      let i = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling)
        if (sib.tagName === cur.tagName) i++;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${i})`);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const selectorFor = (el: Element): string => {
    const id = el.getAttribute('id');
    if (id && unique(`#${esc(id)}`)) return `#${esc(id)}`;
    for (const attr of ['data-testid', 'data-test', 'aria-label', 'name']) {
      const v = el.getAttribute(attr);
      if (v && unique(`${el.tagName.toLowerCase()}[${attr}=${quote(v)}]`))
        return `${el.tagName.toLowerCase()}[${attr}=${quote(v)}]`;
    }
    return pathSelector(el);
  };
  const labelFor = (el: Element): string =>
    (el.getAttribute('aria-label') || el.getAttribute('name') || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || el.tagName.toLowerCase();

  // Semantic controls first (stable, meaningful), then anything styled clickable.
  // `grab` counts too: a draggable card is routinely ALSO a click target (open on
  // click, drag to move), and we never drag — el.click() fires no drag gesture.
  const pool = new Set<Element>([...document.querySelectorAll(SEMANTIC)]);
  for (const el of document.querySelectorAll('body *')) {
    if (pool.has(el)) continue;
    const cursor = getComputedStyle(el).cursor;
    if (cursor === 'pointer' || cursor === 'grab') pool.add(el);
  }

  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const el of pool) {
    if (el instanceof HTMLAnchorElement && el.href) continue; // links navigate — handled by link crawl, not here
    if (el.closest(':disabled,[aria-disabled="true"]')) continue;
    if (!visible(el)) continue;
    const selector = selectorFor(el);
    if (seen.has(selector)) continue;
    seen.add(selector);
    const label = labelFor(el);
    const unsafe = DANGER.test(label);
    if (el instanceof HTMLSelectElement) {
      const next = [...el.options].find((o) => !o.disabled && o.value !== el.value);
      if (next)
        out.push({ action: 'select-option', selector, label, reason: 'select-option', value: next.value, unsafe });
    } else {
      out.push({
        action: 'click',
        selector,
        label,
        reason: el.getAttribute('role') === 'tab' ? 'tab' : 'click',
        unsafe,
      });
    }
  }
  return out;
}
/* c8 ignore stop */

/** Runs in the browser: the DOM's structural shape — every element's tag + class
 *  in document order (scripts/styles/meta skipped). Text and computed styles are
 *  deliberately excluded, so a ticking clock or animated opacity never reads as a
 *  new state, while any mount/unmount/class flip does. ~30ms vs the full
 *  computed-style walk it replaces for change detection. */
/* c8 ignore start */
function domShape(): { shape: string; elements: number; classes: string[] } {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE']);
  const parts: string[] = [];
  const classes = new Set<string>();
  for (const el of document.body.getElementsByTagName('*')) {
    if (SKIP.has(el.tagName)) continue;
    const cls = el.getAttribute('class') ?? '';
    parts.push(`${el.tagName}.${cls}`);
    for (const c of cls.split(/\s+/)) if (c) classes.add(c);
  }
  return { shape: parts.join('\n'), elements: parts.length, classes: [...classes] };
}
/* c8 ignore stop */

/** Runs in the browser: every class name the page's OWN stylesheets select on —
 *  the design's defined vocabulary, read from the parsed CSSOM (inline and
 *  same-origin sheets; unreadable cross-origin sheets are skipped). Coverage is
 *  checked against this, so "fully covered" means every class the design styles
 *  was seen rendered in at least one captured surface. */
/* c8 ignore start */
function collectDefinedClasses(): string[] {
  const out = new Set<string>();
  const scan = (rules?: CSSRuleList): void => {
    if (!rules) return;
    for (const rule of rules) {
      const r = rule as CSSStyleRule & CSSGroupingRule;
      if (r.selectorText) {
        const re = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;
        for (let m = re.exec(r.selectorText); m; m = re.exec(r.selectorText)) out.add(m[1]);
      }
      if (r.cssRules) scan(r.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      scan(sheet.cssRules);
    } catch {
      /* cross-origin sheet — not the design's own vocabulary */
    }
  }
  return [...out];
}
/* c8 ignore stop */

/** Structural fingerprint of the page's CURRENT state. Dedup key for surfaces. */
async function fingerprint(page: Page): Promise<{ sig: string; elements: number; classes: string[] }> {
  const fp = await page.evaluate(domShape);
  return {
    sig: createHash('sha256').update(fp.shape).digest('hex').slice(0, 16),
    elements: fp.elements,
    classes: fp.classes,
  };
}

/** Wait for the DOM to stop changing (element count stable) — a cheap post-click
 *  settle that also covers content painted by a click-triggered fetch. */
async function settleDom(page: Page, maxMs = 1200): Promise<void> {
  let prev = -1;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => document.body.getElementsByTagName('*').length);
    if (n === prev) return;
    prev = n;
    await page.waitForTimeout(90);
  }
}

/** Wait for an async-rendered app to finish mounting: the DOM stops growing and is
 *  non-trivial. Generic — no app-specific selector needed, so a bare crawl of a
 *  Babel/React/Vue page that boots after `load` still captures the mounted UI. */
async function waitSettled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => document.body.getElementsByTagName('*').length);
    if (n > 5 && n === prev) return;
    prev = n;
    await page.waitForTimeout(100);
  }
}

/**
 * Load the URL from a clean slate (storage cleared by the init script armed in
 * crawlAndCapture — one navigation, no clear-then-reload) and wait for the app to
 * mount. Pins the viewport to widths[0] so DISCOVERY always happens at one
 * consistent width — captureInPlace sweeps the other widths and would otherwise
 * leave the viewport wherever it finished (e.g. a mobile band where half the
 * controls are hidden).
 */
async function gotoFresh(page: Page, opts: SurfaceCrawlOptions): Promise<void> {
  await page.setViewportSize({ width: opts.widths[0] ?? 1280, height: opts.height });
  await page.goto(opts.url, { waitUntil: 'load' });
  // Tolerant wait: the generic settle below is the real readiness signal; an
  // optional waitSelector just accelerates it and must not fail the crawl.
  const ready = opts.waitSelector ? page.locator(opts.waitSelector).first() : null;
  if (ready) await ready.waitFor({ state: 'visible' }).catch(() => {});
  await waitSettled(page);
}

async function perform(page: Page, s: { action: string; selector: string; value?: string }): Promise<void> {
  const target = page.locator(s.selector).first();
  if (s.action === 'select-option') {
    await target.selectOption(s.value ?? '');
    return;
  }
  await target.waitFor({ state: 'attached', timeout: 5000 });
  await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  // Dispatch the click IN-PAGE rather than through Playwright's actionability
  // pipeline. `el.click()` fires the app's real (delegated) click handler but
  // skips the stability/visibility/hit-testing waits that make Playwright's own
  // click flake on an opening modal — the intermittent failure that silently
  // dropped deep states on re-drive. We only need to REACH the state to map it.
  const dispatched = await target
    .evaluate((el) => {
      if (el instanceof HTMLElement) {
        el.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (!dispatched) await target.click({ timeout: 3000 }); // non-HTMLElement (SVG etc.)
}

async function replay(page: Page, steps: CrawlStep[]): Promise<void> {
  for (const s of steps) {
    await perform(page, s);
    await settleDom(page);
  }
}

/** Reset to a known state and VERIFY arrival by fingerprint (retry once). A false
 *  return means the path won't reproduce right now — the caller abandons the rest
 *  of that state's sweep (fail-soft) rather than mis-attributing children. */
async function resetToState(
  page: Page,
  opts: SurfaceCrawlOptions,
  steps: CrawlStep[],
  wantSig: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await gotoFresh(page, opts);
      await replay(page, steps);
      if ((await fingerprint(page)).sig === wantSig) return true;
    } catch {
      /* retry */
    }
  }
  return false;
}

/** Capture the page's CURRENT state (already driven to) at every width, resizing
 *  in place. Capturing where discovery already stands means a fragile click-path
 *  is never replayed a second time — the failure mode of re-driving deep, animated
 *  controls. */
async function captureInPlace(page: Page, key: string, opts: SurfaceCrawlOptions): Promise<void> {
  for (const width of opts.widths) {
    await page.setViewportSize({ width, height: opts.height });
    const requests = trackInflightRequests(page);
    try {
      const map = await captureStyleMap(page, {
        ignore: opts.ignore,
        pendingRequests: requests.pending,
        metadata: { surfaceKey: key },
      });
      const stem = path.join(opts.out, `${key}@${width}`);
      saveStyleMap(`${stem}.json.gz`, map);
      if (opts.screenshots) await page.screenshot({ path: `${stem}.png`, fullPage: true, animations: 'disabled' });
    } finally {
      requests.dispose();
    }
  }
}

type QueueEntry = { path: CrawlStep[]; depth: number; sig: string };

/** Identity of a state for the changer registry: the click-path that defines it. */
function stateKey(steps: CrawlStep[]): string {
  return steps.map((s) => s.selector + (s.value ?? '')).join(' → ');
}

type CrawlState = {
  /** Structural fingerprints already captured — a surface is captured once. */
  seen: Set<string>;
  used: Set<string>;
  /** Control selectors already driven — a control is driven once, from the
   *  shallowest state it appears in, so recursion maps a surface's OWN controls
   *  rather than re-opening the global chrome from inside every state (which
   *  would explode into state combinations, not distinct surfaces). */
  tried: Set<string>;
  /** FAMILY RETRY registry: state-changing controls, keyed by the state they were
   *  first driven from. A mode-switcher's effect depends on which sibling mode the
   *  shared overlay is in (a RESOLVED tab shows different content after an approval;
   *  an EDIT pen edits whichever tab is open), so each sibling surface re-tries its
   *  parent's changers once. `persists` guards the explosion: only controls still
   *  present after their own click (tabs, pens, toggles) qualify — consuming
   *  actions (approve/deny rows) disappear and are never re-tried, so decision
   *  chains don't multiply. */
  changersFrom: Map<string, { c: RawCandidate; persists: boolean }[]>;
  /** Union of class names rendered in captured surfaces — the coverage numerator. */
  classes: Set<string>;
  surfaces: CrawledSurface[];
  queue: QueueEntry[];
  captured: number;
  failed: string[];
};

/** Record a newly-found surface, capture it in place (page is already there), and
 *  queue it for its own sweep. Streams progress via onSurface. */
async function record(
  page: Page,
  opts: SurfaceCrawlOptions,
  newPath: CrawlStep[],
  depth: number,
  fp: { sig: string; elements: number; classes: string[] },
  st: CrawlState,
): Promise<void> {
  const key = deriveKey(newPath, st.used);
  const surface: CrawledSurface = { key, depth, path: newPath, elements: fp.elements };
  st.surfaces.push(surface);
  st.queue.push({ path: newPath, depth, sig: fp.sig });
  for (const c of fp.classes) st.classes.add(c);
  let ok = true;
  try {
    await captureInPlace(page, key, opts);
    st.captured++;
  } catch {
    st.failed.push(key);
    ok = false;
  }
  opts.onSurface?.(surface, ok);
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

/** Drive one candidate from where the page stands. Returns whether the page is
 *  still in the swept state (no-op click) and whether the action was a skip. */
async function driveCandidate(
  page: Page,
  opts: SurfaceCrawlOptions,
  entry: QueueEntry,
  c: RawCandidate,
  st: CrawlState,
): Promise<{ inState: boolean; skipped: boolean }> {
  const outcome = await tryInPlace(page, c);
  if (outcome === 'noop') return { inState: true, skipped: false }; // still in the state — no reset needed
  if (outcome === 'failed' || outcome === 'navigated') return { inState: false, skipped: true };
  // Register the changer for family retry — persistence checked in the state its
  // own click produced (a tab survives its switch; an approve row consumes itself).
  const persists = await page
    .locator(c.selector)
    .first()
    .isVisible()
    .catch(() => false);
  const from = stateKey(entry.path);
  const list = st.changersFrom.get(from) ?? [];
  if (!list.some((x) => x.c.selector === c.selector)) list.push({ c, persists });
  st.changersFrom.set(from, list);

  const fp = await fingerprint(page);
  if (st.seen.has(fp.sig)) return { inState: false, skipped: false }; // same surface reached another way
  st.seen.add(fp.sig);
  const step: CrawlStep = {
    action: c.action,
    selector: c.selector,
    label: c.label,
    reason: c.reason,
    ...(c.value ? { value: c.value } : {}),
  };
  await record(page, opts, [...entry.path, step], entry.depth + 1, fp, st);
  return { inState: false, skipped: false };
}

/**
 * Sweep one state: drive every not-yet-tried control reachable from it, IN PLACE.
 * A no-op click leaves the page in the state, so the sweep just continues; only a
 * state-changing click (new surface, dup, navigation, or failure) pays a verified
 * reset before the next candidate.
 */
/** The family-retry list for a state: its parent's persistent mode-switchers that
 *  are visible right now — minus the step that created this state itself. */
function familyRetries(entry: QueueEntry, all: RawCandidate[], st: CrawlState): RawCandidate[] {
  if (entry.path.length === 0) return [];
  const parentKey = stateKey(entry.path.slice(0, -1));
  const ownSelector = entry.path[entry.path.length - 1].selector;
  const visibleNow = new Set(all.map((c) => c.selector));
  return (st.changersFrom.get(parentKey) ?? [])
    .filter((x) => x.persists && x.c.selector !== ownSelector && visibleNow.has(x.c.selector))
    .map((x) => x.c);
}

async function sweepState(
  page: Page,
  opts: SurfaceCrawlOptions,
  entry: QueueEntry,
  st: CrawlState,
): Promise<{ tried: number; skipped: number }> {
  if (!(await resetToState(page, opts, entry.path, entry.sig))) return { tried: 0, skipped: 0 };
  const all = await page.evaluate(collectClickable).catch(() => [] as RawCandidate[]);
  // Fresh controls first (already-driven global chrome would otherwise starve a
  // deep surface's own controls; the throttle applies to fresh ones), then the
  // parent's persistent mode-switchers re-tried in THIS sibling mode.
  const fresh = all.filter((c) => !st.tried.has(c.selector)).slice(0, opts.maxActionsPerState);
  const work = [
    ...fresh.map((c) => ({ c, retry: false })),
    ...familyRetries(entry, all, st).map((c) => ({ c, retry: true })),
  ];

  let tried = 0;
  let skipped = 0;
  let inState = true;
  for (const { c, retry } of work) {
    if (st.surfaces.length >= opts.maxStates) break;
    if (!inState) {
      if (!(await resetToState(page, opts, entry.path, entry.sig))) break; // abandon rest, fail-soft
      inState = true;
    }
    if (!retry) st.tried.add(c.selector);
    if (c.unsafe) {
      skipped++;
      continue;
    }
    tried++;
    const r = await driveCandidate(page, opts, entry, c, st);
    inState = r.inState;
    if (r.skipped) skipped++;
  }
  return { tried, skipped };
}

/** Depth-first discovery + in-place capture of every reachable surface. Depth-first
 *  so a surface's OWN sub-states (a modal's tab → its toggles) are mapped while the
 *  branch is fresh; with no budget, order affects time-to-depth, not coverage. */
async function discover(page: Page, opts: SurfaceCrawlOptions): Promise<CrawlReport> {
  fs.mkdirSync(opts.out, { recursive: true });
  await gotoFresh(page, opts);
  const defined = await page.evaluate(collectDefinedClasses).catch(() => [] as string[]);
  const fp = await fingerprint(page);
  const st: CrawlState = {
    seen: new Set([fp.sig]),
    used: new Set(),
    tried: new Set(),
    changersFrom: new Map(),
    classes: new Set(),
    surfaces: [],
    queue: [],
    captured: 0,
    failed: [],
  };
  await record(page, opts, [], 0, fp, st);

  let actionsTried = 0;
  let skipped = 0;
  while (st.queue.length > 0 && st.surfaces.length < opts.maxStates) {
    const entry = st.queue.pop()!; // LIFO → depth-first
    if (entry.depth >= opts.maxDepth) continue;
    const r = await sweepState(page, opts, entry, st);
    actionsTried += r.tried;
    skipped += r.skipped;
  }
  const missing = defined.filter((c) => !st.classes.has(c)).sort();
  return {
    surfaces: st.surfaces,
    actionsTried,
    skipped,
    captured: st.captured,
    failed: st.failed,
    coverage: { defined: defined.length, rendered: defined.length - missing.length, missing },
  };
}

/**
 * Crawl `opts.url` and capture every reachable surface at every width — runs to
 * natural termination by default. Returns the surfaces mapped (with the click-path
 * that reached each), how many actions were tried/skipped, and captured/failed.
 */
export async function crawlAndCapture(page: Page, opts: SurfaceCrawlOptions): Promise<CrawlReport> {
  if (opts.resetStorage) {
    // Clear storage before the app's code runs on EVERY load, so each gotoFresh is
    // a clean slate in one navigation (no clear-then-reload round trip).
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* storage unavailable (e.g. file://) — ignore */
      }
    });
  }
  return discover(page, opts);
}
