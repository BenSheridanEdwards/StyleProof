import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, trackInflightRequests, type StyleMap } from './capture.js';

/**
 * Surface crawler: deterministically map a single URL's whole interactive
 * surface — not just the state it loads in.
 *
 * A one-shot capture records the page as it lands, so a design that's mostly
 * modals, drawers, and popovers has most of its surface behind clicks it never
 * reaches. This crawls it instead: from the base state it finds every visible,
 * non-destructive control (semantic controls AND anything the page styles as
 * clickable — `cursor: pointer`), drives each, and keeps the result if it opened
 * a structurally new surface. Then it recurses breadth-first into each new
 * surface — replaying the path that reached it — so a modal's tabs, a drawer's
 * sub-views, and a popover's panels are all mapped too. Deterministic order,
 * bounded by depth/actions/states, deduped by a STRUCTURAL signature so the same
 * surface reached different ways (or filled with different data) is captured once.
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
export type CrawlReport = {
  surfaces: CrawledSurface[];
  actionsTried: number;
  skipped: number;
  /** Surfaces successfully captured to disk at every width. */
  captured: number;
  /** Keys of surfaces discovered but not capturable (path wouldn't replay). */
  failed: string[];
};

export type SurfaceCrawlOptions = {
  url: string;
  out: string;
  widths: number[];
  ignore: string[];
  height: number;
  screenshots: boolean;
  waitSelector?: string;
  /** How deep to recurse into opened surfaces (base = 0). Default 3. */
  maxDepth: number;
  /** Controls tried per state. Default 30. */
  maxActionsPerState: number;
  /** Total surfaces to capture before stopping. Default 60. */
  maxStates: number;
  /** Clear localStorage/sessionStorage on each reset so replay is deterministic. Default true. */
  resetStorage: boolean;
};

export const CRAWL_DEFAULTS = {
  height: 900,
  screenshots: true,
  maxDepth: 3,
  maxActionsPerState: 30,
  maxStates: 60,
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

/** Structural fingerprint: element paths + tag + class, ignoring computed values.
 *  Two states with the same DOM shape (same surface, different data) collapse to
 *  one; a new modal/tab/panel adds elements and gets its own signature. */
function structuralSignature(map: StyleMap): string {
  const keys = Object.keys(map.elements)
    .map((p) => `${p}|${map.elements[p].tag}.${map.elements[p].cls ?? ''}`)
    .sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
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
  const pool = new Set<Element>([...document.querySelectorAll(SEMANTIC)]);
  for (const el of document.querySelectorAll('body *')) {
    if (pool.has(el)) continue;
    if (getComputedStyle(el).cursor === 'pointer') pool.add(el);
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
 * Load the URL from a clean slate with the in-flight request tracker armed BEFORE
 * navigation — so an async app's own boot fetches count toward the settle — then
 * wait for it to render. Returns the tracker; the caller passes `pending` to
 * captureStyleMap and disposes it. No hints needed: `waitSelector` is optional.
 */
async function gotoFresh(
  page: Page,
  opts: SurfaceCrawlOptions,
): Promise<{ pending: () => number; dispose: () => void }> {
  if (opts.resetStorage) {
    await page.goto(opts.url, { waitUntil: 'load' });
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* storage may be unavailable; ignore */
      }
    });
  }
  const tracker = trackInflightRequests(page);
  await page.goto(opts.url, { waitUntil: 'load' });
  if (opts.waitSelector)
    await page
      .locator(opts.waitSelector)
      .first()
      .waitFor({ state: 'visible' })
      .catch(() => {});
  await waitSettled(page);
  return tracker;
}

async function perform(page: Page, s: { action: string; selector: string; value?: string }): Promise<void> {
  const target = page.locator(s.selector).first();
  await target.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  if (s.action === 'select-option') await target.selectOption(s.value ?? '');
  else await target.click({ timeout: 6000 });
}

async function replay(page: Page, steps: CrawlStep[]): Promise<void> {
  for (const s of steps) {
    await perform(page, s);
    await page.waitForTimeout(120);
  }
}

/** Try one control from the given parent path; leaves the page IN the resulting
 *  state and returns its (cheap) map if it opened a structurally new surface. */
async function probe(
  page: Page,
  opts: SurfaceCrawlOptions,
  parent: CrawlStep[],
  c: RawCandidate,
): Promise<StyleMap | null> {
  const tracker = await gotoFresh(page, opts);
  try {
    await replay(page, parent);
    const startUrl = pathAndSearch(page.url());
    await perform(page, c);
    await page.waitForTimeout(160);
    if (pathAndSearch(page.url()) !== startUrl) return null; // navigated away — not an in-page surface
    return await captureStyleMap(page, { ignore: opts.ignore, captureStates: false, pendingRequests: tracker.pending });
  } finally {
    tracker.dispose();
  }
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

type CrawlState = {
  seen: Set<string>;
  used: Set<string>;
  /** Control selectors already explored — a control is driven once, from the
   *  shallowest state it appears in, so recursion maps a modal's OWN controls
   *  rather than re-opening the global chrome from inside every surface (which
   *  would explode into state combinations, not distinct surfaces). */
  tried: Set<string>;
  surfaces: CrawledSurface[];
  queue: { path: CrawlStep[]; depth: number }[];
  captured: number;
  failed: string[];
};

/** Record a newly-found surface and capture it in place (page is already here). */
async function record(
  page: Page,
  opts: SurfaceCrawlOptions,
  newPath: CrawlStep[],
  depth: number,
  elements: number,
  st: CrawlState,
): Promise<void> {
  const key = deriveKey(newPath, st.used);
  st.surfaces.push({ key, depth, path: newPath, elements });
  st.queue.push({ path: newPath, depth });
  try {
    await captureInPlace(page, key, opts);
    st.captured++;
  } catch {
    st.failed.push(key);
  }
}

/** Probe one candidate; on a structurally-new surface, capture and queue it. */
async function expand(
  page: Page,
  opts: SurfaceCrawlOptions,
  parent: CrawlStep[],
  depth: number,
  c: RawCandidate,
  st: CrawlState,
): Promise<'skip' | 'dup' | 'new'> {
  let map: StyleMap | null;
  try {
    map = await probe(page, opts, parent, c);
  } catch {
    return 'skip';
  }
  if (!map) return 'skip';
  const sig = structuralSignature(map);
  if (st.seen.has(sig)) return 'dup'; // same surface reached another way, or a no-op click
  st.seen.add(sig);
  const step: CrawlStep = {
    action: c.action,
    selector: c.selector,
    label: c.label,
    reason: c.reason,
    ...(c.value ? { value: c.value } : {}),
  };
  await record(page, opts, [...parent, step], depth + 1, Object.keys(map.elements).length, st);
  return 'new';
}

/** Drive every not-yet-tried control reachable from one dequeued state. */
async function crawlOne(
  page: Page,
  opts: SurfaceCrawlOptions,
  parent: CrawlStep[],
  depth: number,
  st: CrawlState,
): Promise<{ tried: number; skipped: number }> {
  const tracker = await gotoFresh(page, opts);
  let candidates: RawCandidate[];
  try {
    await replay(page, parent);
    candidates = (await page.evaluate(collectClickable)).slice(0, opts.maxActionsPerState);
  } catch {
    // The path to this state won't replay (a deep/animated control) — its surface
    // was already captured in place when first reached; we just can't go deeper here.
    return { tried: 0, skipped: 0 };
  } finally {
    tracker.dispose();
  }
  let tried = 0;
  let skipped = 0;
  for (const c of candidates) {
    if (st.surfaces.length >= opts.maxStates) break;
    if (st.tried.has(c.selector)) continue; // driven already from a shallower state
    st.tried.add(c.selector);
    if (c.unsafe) {
      skipped++;
      continue;
    }
    tried++;
    if ((await expand(page, opts, parent, depth, c, st)) === 'skip') skipped++;
  }
  return { tried, skipped };
}

/** Breadth-first discovery + in-place capture of every reachable surface. */
async function discover(page: Page, opts: SurfaceCrawlOptions): Promise<CrawlReport> {
  fs.mkdirSync(opts.out, { recursive: true });
  const tracker = await gotoFresh(page, opts);
  let base: StyleMap;
  try {
    base = await captureStyleMap(page, { ignore: opts.ignore, captureStates: false, pendingRequests: tracker.pending });
  } finally {
    tracker.dispose();
  }
  const used = new Set<string>();
  const st: CrawlState = {
    seen: new Set([structuralSignature(base)]),
    used,
    tried: new Set(),
    surfaces: [],
    queue: [],
    captured: 0,
    failed: [],
  };
  await record(page, opts, [], 0, Object.keys(base.elements).length, st);

  let actionsTried = 0;
  let skipped = 0;
  while (st.queue.length > 0 && st.surfaces.length < opts.maxStates) {
    const { path: parent, depth } = st.queue.shift()!;
    if (depth >= opts.maxDepth) continue;
    const r = await crawlOne(page, opts, parent, depth, st);
    actionsTried += r.tried;
    skipped += r.skipped;
  }
  return { surfaces: st.surfaces, actionsTried, skipped, captured: st.captured, failed: st.failed };
}

/**
 * Crawl `opts.url` and capture every reachable surface at every width. Returns
 * the surfaces mapped (with the click-path that reached each), how many actions
 * were tried/skipped, and how many captured/failed.
 */
export async function crawlAndCapture(page: Page, opts: SurfaceCrawlOptions): Promise<CrawlReport> {
  return discover(page, opts);
}
