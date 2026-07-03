import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { captureStyleMap, saveStyleMap, trackInflightRequests } from './capture.js';
import { detectViewportWidths } from './breakpoints.js';

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
  action: 'click' | 'select-option' | 'fill-input';
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

/**
 * One deterministic step run after every fresh navigation, BEFORE the crawl
 * looks at the page — how input-gated states (a login form, a search box)
 * become crawlable. Values come from the caller with `${ENV_VAR}` interpolation
 * done at load time, so secrets live in the environment, never in files or maps.
 * `optional: true` skips the step silently when its selector isn't present
 * (e.g. a cookie-session app that only shows the login form once).
 */
export type SetupStep = {
  action: 'goto' | 'fill' | 'click' | 'waitFor';
  url?: string;
  selector?: string;
  value?: string;
  optional?: boolean;
};

export type SurfaceCrawlOptions = {
  url: string;
  out: string;
  widths: number[];
  ignore: string[];
  height: number;
  screenshots: boolean;
  waitSelector?: string;
  /** Deterministic steps (login, unlock, seed input) run after EVERY fresh
   *  navigation, so each reset re-establishes the gated state identically. */
  setup?: SetupStep[];
  /** Also capture automatic data states of the entry page: `loading` (data
   *  requests stalled — the skeleton) and `error` (data requests fulfilled with
   *  a 500). Default true; states that render identically to base are skipped. */
  dataStates?: boolean;
  /** Coverage-oriented termination: stop as soon as every class the page's
   *  stylesheets define has been rendered (full coverage) OR coverage stops
   *  improving (no new class for a plateau of surfaces — it has converged short
   *  of full, and the rest is dead CSS or a genuinely-gated state). Off by
   *  default (exhaustive: map every surface). On, the crawl is a fast coverage
   *  check — it stops the moment it has SEEN everything, instead of enumerating
   *  every combinatorial surface that adds no new vocabulary. */
  stopWhenCovered?: boolean;
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
  /** Concurrent sweep workers (default 4). Each worker gets its own page from
   *  `newPage`; without a factory the crawl runs single-page regardless. The
   *  surface SET is identical to a serial crawl (same dedup sets); only which
   *  path first claims a shape — and so dup-key suffixes — can vary run to run.
   *  Use workers: 1 for byte-stable key attribution. */
  workers?: number;
  /** Factory for worker pages — create each in its OWN browser context so
   *  storage resets cannot interfere across concurrent sweeps. */
  newPage?: () => Promise<Page>;
};

// Exhaustive by default — these ceilings are safety backstops, not budgets.
export const CRAWL_DEFAULTS = {
  height: 900,
  screenshots: true,
  // ponytail: depth 16 is exhaustive for real UI — no human-navigable surface
  // is 16 clicks from load. Past that you're not finding surfaces, you're
  // riding an append-generator (a composer that adds a row per click) whose
  // every appended node is a fresh tag-path identity, so it recurses forever.
  // The cap terminates those chains; the coverage verifier still NAMES any
  // class left unrendered, so a too-low cap fails loudly rather than lying.
  // Raise with --max-depth if a design genuinely nests deeper.
  maxDepth: 16,
  maxActionsPerState: 100000,
  maxStates: 100000,
  resetStorage: true,
  workers: 4,
};

type RawCandidate = {
  action: 'click' | 'select-option' | 'fill-input';
  selector: string;
  /** SEMANTIC control identity: the class-context path (no positional indices)
   *  plus tag and label. The same logical control re-rendered in a different
   *  mode context keeps its identity even though its positional selector
   *  drifts — this is what the driven-once dedup keys on. Positional
   *  `selector` remains what actually gets clicked in a given state. */
  identity: string;
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
    /\b(delete|remove|destroy|logout|log ?out|sign ?out|publish|deploy|pay|purchase|buy|checkout|archive|disconnect|revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew)\b/i;
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
  const identityFor = (el: Element): string => {
    // Tag-path only — NO classes and NO indices: classes carry state (body.alt,
    // .on) and would re-contextualize the same control per mode; indices carry
    // position and drift on re-render. Tag ancestry + label is what stays
    // stable across every context the same logical control appears in.
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      parts.unshift(cur.tagName.toLowerCase());
      cur = cur.parentElement;
    }
    return `${parts.join('>')}|${labelFor(el)}|${el.getAttribute('role') ?? ''}`;
  };

  // Semantic controls first (stable, meaningful), then anything styled clickable.
  // `grab` counts too: a draggable card is routinely ALSO a click target (open on
  // click, drag to move), and we never drag — el.click() fires no drag gesture.
  const pool = new Set<Element>([...document.querySelectorAll(SEMANTIC)]);
  for (const el of document.querySelectorAll('body *')) {
    if (pool.has(el)) continue;
    const cursor = getComputedStyle(el).cursor;
    if (cursor !== 'pointer' && cursor !== 'grab') continue;
    // `cursor` is an INHERITED property: a clickable card makes every descendant
    // compute cursor:pointer, and clicking any descendant just bubbles to the
    // card's own handler — the SAME surface. Left unchecked, a card with N
    // children becomes N+1 candidates, each paying a drive + verified reset to
    // map one surface (the dominant cost of a large crawl). Add only the
    // OUTERMOST clickable in an inherited-cursor subtree: skip when an ancestor
    // is already a candidate. Semantic controls (button, a, [role]) are seeded
    // above and skipped by the guard at the top of the loop, so a real button
    // nested inside a clickable card is never dropped. (querySelectorAll walks
    // document order, so an ancestor is always pooled before its descendants.)
    let anc = el.parentElement;
    let nested = false;
    while (anc && anc !== document.body) {
      if (pool.has(anc)) {
        nested = true;
        break;
      }
      anc = anc.parentElement;
    }
    if (!nested) pool.add(el);
  }

  // Neutral text inputs are typed automatically with a deterministic value —
  // a search box or filter needs no secrets. Credential-semantic fields
  // (type=password, autocomplete username/current-password/new-password/
  // one-time-code) are NEVER auto-filled: those are --setup territory.
  const FILLABLE =
    'input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="tel"],input[type="url"],input[type="number"],textarea';
  const CRED_AUTOCOMPLETE = /username|current-password|new-password|one-time-code/i;
  const AUTO_VALUE: Record<string, string> = {
    email: 'sample@example.com',
    url: 'https://example.com',
    tel: '5550100',
    number: '1',
  };

  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const el of document.querySelectorAll(FILLABLE)) {
    if (CRED_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')) continue;
    if (el.closest(':disabled,[aria-disabled="true"]') || (el as HTMLInputElement).readOnly) continue;
    if (!visible(el)) continue;
    const selector = selectorFor(el);
    if (seen.has(selector)) continue;
    seen.add(selector);
    const kind = el.getAttribute('type') ?? 'text';
    out.push({
      action: 'fill-input',
      selector,
      identity: identityFor(el),
      label: labelFor(el) === el.tagName.toLowerCase() ? (el.getAttribute('placeholder') ?? 'input') : labelFor(el),
      reason: 'auto-fill',
      value: AUTO_VALUE[kind] ?? 'sample text',
      unsafe: false,
    });
  }
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
        out.push({
          action: 'select-option',
          selector,
          identity: identityFor(el),
          label,
          reason: 'select-option',
          value: next.value,
          unsafe,
        });
    } else {
      out.push({
        action: 'click',
        selector,
        identity: identityFor(el),
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
  const add = (el: Element): void => {
    const cls = el.getAttribute('class') ?? '';
    parts.push(`${el.tagName}.${cls}`);
    for (const c of cls.split(/\s+/)) if (c) classes.add(c);
  };
  // html/body themselves first: state classes there (a theme switch, modal-open)
  // are a common pattern and restyle the whole page without touching any
  // descendant's class — invisible to a descendants-only walk.
  add(document.documentElement);
  add(document.body);
  for (const el of document.body.getElementsByTagName('*')) {
    if (SKIP.has(el.tagName)) continue;
    // Skip non-page artifacts that pollute the fingerprint: StyleProof's own
    // injected hover-sink (added by a capture, so present when a state is
    // captured in place but NOT on a fresh load) and framework route-announcers.
    // Counting them made a state's in-place fingerprint differ from its
    // reset+replay fingerprint, so every reset to depth >= 2 failed verification
    // (and the same pollution split dedup, capturing one surface as two). They
    // are not part of the page.
    if (el.hasAttribute('data-styleproof-hover-sink')) continue;
    if (el.tagName === 'NEXT-ROUTE-ANNOUNCER' || el.id === '__next-route-announcer__') continue;
    add(el);
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
  // DOM-growth settle is the PRIMARY readiness signal — it detects an
  // async-mounted app (the DOM stops growing and is non-trivial) without an
  // app-specific selector, and it also catches fetch-painted content (that
  // grows the DOM). We deliberately do NOT gate on networkidle: it waits a
  // 500ms idle window ON TOP of any lingering request, and a single cross-origin
  // asset — a Google-Fonts stylesheet — keeps the network "busy" ~1s per load
  // with no bearing on readiness. gotoFresh runs once per state (plus per
  // retry), so that dominated crawl time (measured: ~995ms of every ~1531ms
  // reset). Instead we wait for FONTS specifically — they ARE part of the
  // computed style the diff compares, so they must be loaded before capture,
  // but document.fonts.ready is the deterministic signal (and resolves from the
  // page's cache on repeat loads, so it's ~free after the first).
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => document.body.getElementsByTagName('*').length);
    if (n > 5 && n === prev) break;
    prev = n;
    await page.waitForTimeout(100);
  }
  await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
}

/**
 * Load the URL from a clean slate (storage cleared by the init script armed in
 * crawlAndCapture — one navigation, no clear-then-reload) and wait for the app to
 * mount. Pins the viewport to widths[0] so DISCOVERY always happens at one
 * consistent width — captureInPlace sweeps the other widths and would otherwise
 * leave the viewport wherever it finished (e.g. a mobile band where half the
 * controls are hidden).
 */
/** One runner per setup action — a table, so adding an action is one entry. */
const SETUP_RUNNERS: Record<SetupStep['action'], (page: Page, s: SetupStep) => Promise<void>> = {
  goto: async (page, s) => {
    await page.goto(s.url ?? '', { waitUntil: 'load' });
  },
  fill: async (page, s) => {
    await page
      .locator(s.selector ?? '')
      .first()
      .fill(s.value ?? '', { timeout: 10000 });
  },
  click: async (page, s) => {
    await perform(page, { action: 'click', selector: s.selector ?? '' });
  },
  waitFor: async (page, s) => {
    await page
      .locator(s.selector ?? '')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 });
  },
};

/** Run the caller's deterministic setup steps (login, unlock, seed input). A
 *  non-optional step that fails throws loudly — a half-established gate must
 *  never silently crawl the ungated page instead. */
export async function runSetup(page: Page, steps: SetupStep[]): Promise<void> {
  for (const s of steps) {
    try {
      await SETUP_RUNNERS[s.action](page, s);
    } catch (e) {
      if (s.optional) continue;
      throw new Error(`setup step failed (${s.action} ${s.selector ?? s.url ?? ''})`, { cause: e });
    }
  }
}

/** Reveal scroll-gated content deterministically: IntersectionObserver mounts,
 *  lazy sections. One bounded pass per load (same scroll every time, so replay
 *  and fingerprints stay stable); capped so an infinite feed can't spin it. */
async function scrollReveal(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const step = Math.max(200, window.innerHeight);
      let y = 0;
      for (let i = 0; i < 20 && y <= document.body.scrollHeight; i++) {
        window.scrollTo(0, y);
        y += step;
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
}

async function gotoFresh(page: Page, opts: SurfaceCrawlOptions): Promise<void> {
  await page.setViewportSize({ width: opts.widths[0] ?? 1280, height: opts.height });
  await page.goto(opts.url, { waitUntil: 'load' });
  // Tolerant wait: the generic settle below is the real readiness signal; an
  // optional waitSelector just accelerates it and must not fail the crawl.
  const ready = opts.waitSelector ? page.locator(opts.waitSelector).first() : null;
  if (ready) await ready.waitFor({ state: 'visible' }).catch(() => {});
  await waitSettled(page);
  if (opts.setup?.length) {
    await runSetup(page, opts.setup);
    await settleDom(page); // the steps changed page state — let it land
  }
  await scrollReveal(page);
  await settleDom(page);
}

async function perform(page: Page, s: { action: string; selector: string; value?: string }): Promise<void> {
  const target = page.locator(s.selector).first();
  if (s.action === 'select-option') {
    await target.selectOption(s.value ?? '');
    return;
  }
  if (s.action === 'fill-input') {
    await target.fill(s.value ?? '', { timeout: 5000 });
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

/** retryOnly: this state was reached through a CONSUMING action (a control that
 *  disappeared when used — an approve/deny row, a dismiss). Such states are swept
 *  with the parent's persistent mode-switchers ONLY, never fresh candidates:
 *  consumed rows re-render their siblings, shifting nth-of-type selectors so the
 *  same logical controls look "fresh" in every decided-subset — the combinatorial
 *  decision lattice. Mode-switch views of a consumed state (its RESOLVED tab)
 *  stay reachable; the lattice does not. */
type QueueEntry = { path: CrawlStep[]; depth: number; sig: string; retryOnly: boolean; viaRetry: boolean };

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
  sink: QueueEntry[],
  retryOnly = false,
  viaRetry = false,
): Promise<void> {
  const key = deriveKey(newPath, st.used);
  const surface: CrawledSurface = { key, depth, path: newPath, elements: fp.elements };
  st.surfaces.push(surface);
  let addsVocab = false;
  for (const c of fp.classes)
    if (!st.classes.has(c)) {
      st.classes.add(c);
      addsVocab = true;
    }
  // Children buffer in the sweep's sink and enter the shared queue only when the
  // parent's sweep completes — family retry reads the parent's changer registry,
  // which is only complete then. (Serial mode passes st.queue directly.)
  //
  // COVERAGE-GUIDED QUEUE PRUNING: in --until-covered mode, a surface that adds
  // NO new render vocabulary is a structural repeat (the ninth agent's dossier,
  // identical to the first) — don't queue it for a sweep, because its subtree is
  // the same repeats and contributes nothing to coverage. This is what turns the
  // exhaustive breadth-first crawl into a FAST coverage check: the queue drains
  // to the few distinct components, each still drilled to depth (its own new
  // vocabulary keeps it queued) via now-reliable resets. Base (depth 0) always
  // seeds. Exhaustive mode (default) queues everything, so the surface-by-surface
  // diff still sees every state.
  const keep = !opts.stopWhenCovered || addsVocab || depth === 0;
  if (keep) {
    sink.push({ path: newPath, depth, sig: fp.sig, retryOnly, viaRetry });
  }
  // Skip the expensive style-map capture (getComputedStyle over every element,
  // per width) for coverage-redundant surfaces: in --until-covered mode a surface
  // that adds no vocabulary needs no map — its classes were already counted from
  // the fingerprint above — so paying the capture is pure waste. This is the
  // difference between a fast coverage check and re-capturing hundreds of
  // structural repeats. Distinct (vocab-adding) surfaces are still captured, so
  // the run leaves a usable map set behind.
  if (keep) {
    await captureAndReport(page, opts, surface, st);
  }
}

/** Capture the current page as `surface` at every width and report the outcome. */
async function captureAndReport(
  page: Page,
  opts: SurfaceCrawlOptions,
  surface: CrawledSurface,
  st: CrawlState,
): Promise<void> {
  let ok = true;
  try {
    await captureInPlace(page, surface.key, opts);
    st.captured++;
  } catch {
    st.failed.push(surface.key);
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
  sink: QueueEntry[],
  viaRetry: boolean,
  presentIds: Set<string> = new Set(),
): Promise<{ inState: boolean; skipped: boolean }> {
  // (retry-only lineage is inherited: a consumed state's descendants can also
  // only be mode-switch views, never fresh-candidate exploration.)
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
  if (!list.some((x) => x.c.identity === c.identity)) list.push({ c, persists });
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
  const childPath = [...entry.path, step];
  const childRetryOnly = entry.retryOnly || !persists;
  await record(page, opts, childPath, entry.depth + 1, fp, st, sink, childRetryOnly, viaRetry);

  // DESCEND IN PLACE. We are standing in the surface this click just opened,
  // reached by a reliable forward click. Sweep its OWN fresh controls now, while
  // we are here, rather than leaving it for the queued entry to re-reach by
  // reset+replay. In EXHAUSTIVE mode this is the win: it maps a deep branch (an
  // expanded run inside an expanded automation) while the page is already there,
  // instead of via a fragile deep replay. The queued entry still executes for
  // family-retry (pairwise) coverage; global `tried` means its fresh list is
  // already empty here, so this does not double-drive.
  //
  // But descent is DEPTH-FIRST: it drills the first candidate's whole subtree
  // before the base sweep reaches the next candidate, so a page whose distinct
  // vocabulary lives across many components (a roster of dossiers) covers slowly.
  // In --until-covered mode we therefore SKIP the in-place descent and let the
  // breadth-first queue + coverage-guided pruning reach every component fast and
  // drill each once — now that resets are reliable, the queue reaches depth too.
  if (!opts.stopWhenCovered && persists && entry.depth + 1 < opts.maxDepth) {
    const child: QueueEntry = {
      path: childPath,
      depth: entry.depth + 1,
      sig: fp.sig,
      retryOnly: childRetryOnly,
      viaRetry,
    };
    // Exclude controls that were ALSO present in the parent (mode-switchers,
    // shared chrome): those are breadth, owned by the queued family-retry.
    // Descend only into controls genuinely NEW to this surface — a run row that
    // exists only after the job expanded — which is exactly the deep nested UI
    // the reset-replay path starves.
    await sweepCandidatesHere(page, opts, child, st, sink, /* freshOnly */ true, presentIds).catch(() => {
      /* fail-soft: the surface was already captured; deeper descent is best-effort */
    });
  }
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
  // RETRIES DO NOT COMPOUND: a state reached via a family retry still explores
  // its genuinely-new UI (fresh selectors), but never re-retries mode-switchers.
  // Every PAIRWISE mode combination is captured; N-way products of independent
  // toggles are not walked — they multiply states without new render vocabulary,
  // and anything class-visible only at 3-way depth is still NAMED by the
  // coverage verifier.
  if (entry.viaRetry) return [];
  if (entry.path.length === 0) return [];
  const parentKey = stateKey(entry.path.slice(0, -1));
  const ownSelector = entry.path[entry.path.length - 1].selector;
  // Match registered changers to THIS state's candidates by semantic identity —
  // the mode switch re-rendered the subtree, so positional selectors drifted;
  // the current candidate carries the right selector for this state.
  const byIdentity = new Map(all.map((c) => [c.identity, c]));
  return (st.changersFrom.get(parentKey) ?? [])
    .filter((x) => x.persists && x.c.selector !== ownSelector)
    .map((x) => byIdentity.get(x.c.identity))
    .filter((c): c is RawCandidate => Boolean(c));
}

/** The work list for one state's sweep: fresh controls first (already-driven
 *  global chrome would otherwise starve a deep surface's own controls; the
 *  throttle applies to fresh ones), then the parent's persistent mode-switchers
 *  re-tried in THIS sibling mode. A state reached through a consuming action
 *  collects NO fresh candidates — see QueueEntry.retryOnly.
 *
 *  `freshOnly` drops the family-retries: the in-place descent of a
 *  freshly-opened surface explores its own new UI (DEPTH), but must NOT re-apply
 *  the parent's mode-switchers — that is the pairwise BREADTH, owned by the
 *  queued sweep. Re-applying them while descending would compound modes into
 *  N-way products (the very thing "retries don't compound" prevents). */
function sweepWorkList(
  entry: QueueEntry,
  all: RawCandidate[],
  opts: SurfaceCrawlOptions,
  st: CrawlState,
  freshOnly = false,
  excludeIds: Set<string> = new Set(),
): { c: RawCandidate; retry: boolean }[] {
  const fresh = entry.retryOnly
    ? []
    : all.filter((c) => !st.tried.has(c.identity) && !excludeIds.has(c.identity)).slice(0, opts.maxActionsPerState);
  return [
    ...fresh.map((c) => ({ c, retry: false })),
    ...(freshOnly ? [] : familyRetries(entry, all, st).map((c) => ({ c, retry: true }))),
  ];
}

/** Drive one state's work list from where the page ALREADY stands (no reset). A
 *  no-op click leaves the page in the state and the loop continues; a
 *  state-changing click drives the child in place (see driveCandidate) and then
 *  a verified reset returns here before the next candidate. Split out from
 *  sweepState so driveCandidate can call it to DESCEND a freshly-opened surface
 *  in place — reaching that surface via a forward click is reliable, so its deep
 *  descendants are captured on the first visit instead of via a later reset. */
async function sweepCandidatesHere(
  page: Page,
  opts: SurfaceCrawlOptions,
  entry: QueueEntry,
  st: CrawlState,
  sink: QueueEntry[],
  freshOnly = false,
  excludeIds: Set<string> = new Set(),
): Promise<{ tried: number; skipped: number }> {
  const all = await page.evaluate(collectClickable).catch(() => [] as RawCandidate[]);
  const work = sweepWorkList(entry, all, opts, st, freshOnly, excludeIds);
  // Controls present HERE — passed to each child's in-place descent as its
  // exclude set, so the descent skips this surface's mode-switchers/chrome and
  // only drills genuinely new nested UI.
  const presentIds = new Set(all.map((c) => c.identity));

  let tried = 0;
  let skipped = 0;
  let inState = true;
  for (const { c, retry } of work) {
    if (st.surfaces.length >= opts.maxStates) break;
    if (!inState) {
      if (!(await resetToState(page, opts, entry.path, entry.sig))) break; // abandon rest, fail-soft
      inState = true;
    }
    if (!retry) st.tried.add(c.identity);
    if (c.unsafe) {
      skipped++;
      continue;
    }
    tried++;
    const r = await driveCandidate(page, opts, entry, c, st, sink, retry, presentIds);
    inState = r.inState;
    if (r.skipped) skipped++;
  }
  return { tried, skipped };
}

async function sweepState(
  page: Page,
  opts: SurfaceCrawlOptions,
  entry: QueueEntry,
  st: CrawlState,
  sink: QueueEntry[],
): Promise<{ tried: number; skipped: number }> {
  if (!(await resetToState(page, opts, entry.path, entry.sig))) return { tried: 0, skipped: 0 };
  return sweepCandidatesHere(page, opts, entry, st, sink);
}

/** Capture one synthetic data state of the entry page (its data requests stalled
 *  or failed) in place, deduped and coverage-counted like any surface — but never
 *  queued: a stalled app is not a state to crawl deeper from. */
async function recordDataState(
  page: Page,
  opts: SurfaceCrawlOptions,
  mode: 'loading' | 'error',
  st: CrawlState,
): Promise<void> {
  // Match by resource TYPE, not by URL: real apps cache-bust (?t=...), so the
  // re-load's data URLs never equal the observed ones. Any fetch/xhr is data.
  await page.route('**/*', async (route) => {
    const kind = route.request().resourceType();
    if (kind !== 'fetch' && kind !== 'xhr') return route.continue();
    if (mode === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    // loading: leave the request pending forever — the skeleton IS the state.
  });
  try {
    await page.setViewportSize({ width: opts.widths[0] ?? 1280, height: opts.height });
    await page.goto(opts.url, { waitUntil: 'load' });
    await settleDom(page, 2500); // no networkidle wait — a stalled request never goes idle
    const fp = await fingerprint(page);
    if (st.seen.has(fp.sig)) return; // renders identically to a captured state (e.g. SSR)
    st.seen.add(fp.sig);
    for (const c of fp.classes) st.classes.add(c);
    const key = deriveKey(
      [{ action: 'click', selector: `(data:${mode})`, label: mode, reason: 'data-state' }],
      st.used,
    );
    const surface: CrawledSurface = { key, depth: 0, path: [], elements: fp.elements };
    st.surfaces.push(surface);
    await captureAndReport(page, opts, surface, st);
  } finally {
    await page.unroute('**/*');
  }
}

/**
 * Sweep the queue with N concurrent workers, each on its own page. LIFO keeps
 * the depth-first bias; a worker's discovered children enter the shared queue
 * only when its sweep completes (see record). The surface SET matches a serial
 * crawl — dedup sets are shared and mutated synchronously — only dup-key
 * suffix attribution can vary with timing.
 */
async function runPool(
  primary: Page,
  opts: SurfaceCrawlOptions,
  st: CrawlState,
  counters: { tried: number; skipped: number },
  defined: string[] = [],
): Promise<void> {
  const target = Math.max(1, opts.workers ?? 1);
  const pages: Page[] = [primary];
  while (opts.newPage && pages.length < target) {
    const extra = await opts.newPage();
    if (opts.resetStorage) await armResetStorage(extra);
    pages.push(extra);
  }

  // Coverage-oriented early stop (opt-in): the moment every defined class has
  // been SEEN, stop — the rest of the queue is redundant for a coverage check.
  // We do NOT plateau-stop on "N surfaces without a new class": a productive
  // deep state (an automation whose expandable run row is its last candidate)
  // adds its vocabulary only after many no-new siblings, so a plateau cuts the
  // crawl off before that state's sweep even starts. Termination instead comes
  // from the queue draining — and it drains fast because coverage-guided pruning
  // (see record) never queues a structural repeat. `cover.every` runs only when
  // the class count actually grows, so this is cheap.
  const cover = opts.stopWhenCovered && defined.length > 0 ? defined : null;
  let prevSize = st.classes.size;
  let covered = false;
  const converged = (): boolean => {
    if (!cover) return false;
    if (!covered && st.classes.size > prevSize) {
      prevSize = st.classes.size;
      if (cover.every((c) => st.classes.has(c))) covered = true;
    }
    return covered;
  };

  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (pages.length > 0 && st.queue.length > 0 && st.surfaces.length < opts.maxStates && !converged()) {
        const entry = st.queue.shift()!; // FIFO → breadth-first: exhaust every
        // shallow surface (nav tabs, opened panels — where distinct UI lives)
        // before drilling. Depth-first starves breadth: one append-generator
        // branch drills to depth 20+ while sibling tabs sit unpopped, so real
        // surfaces (an OAuth card, a skills grid) go uncaptured. Dedup is
        // set-based, so order never changes WHAT is found — only that shallow
        // is found first, which is what full coverage needs.
        if (entry.depth >= opts.maxDepth) continue;
        const worker = pages.pop()!;
        active++;
        const sink: QueueEntry[] = [];
        sweepState(worker, opts, entry, st, sink)
          .then((r) => {
            counters.tried += r.tried;
            counters.skipped += r.skipped;
          })
          .catch(() => {
            /* fail-soft: the state's surface was already captured in place */
          })
          .finally(() => {
            st.queue.push(...sink);
            pages.push(worker);
            active--;
            pump();
          });
      }
      if (active === 0 && (st.queue.length === 0 || st.surfaces.length >= opts.maxStates || converged())) resolve();
    };
    pump();
  });
}

/** Depth-first discovery + in-place capture of every reachable surface. Depth-first
 *  so a surface's OWN sub-states (a modal's tab → its toggles) are mapped while the
 *  branch is fresh; with no budget, order affects time-to-depth, not coverage. */
async function discover(page: Page, opts: SurfaceCrawlOptions): Promise<CrawlReport> {
  fs.mkdirSync(opts.out, { recursive: true });
  // Watch the entry load's data requests so the automatic data states know what
  // to stall/fail. Armed before navigation to see the app's own boot fetches.
  const dataUrls = new Set<string>();
  const onRequest = (req: { resourceType: () => string; url: () => string }) => {
    const t = req.resourceType();
    if (t === 'fetch' || t === 'xhr') dataUrls.add(req.url());
  };
  page.on('request', onRequest);
  await gotoFresh(page, opts);
  // No widths given? Detect the page's real @media breakpoints (like the
  // one-shot path does) and sweep one width per band — automatically. Detection
  // reads every stylesheet; if one is cross-origin/unreadable it falls back to
  // the single default width rather than dying.
  if (opts.widths.length === 0) {
    const widths = await detectViewportWidths(page).catch(() => [1280]);
    opts = { ...opts, widths };
    if ((widths[0] ?? 1280) !== 1280) await gotoFresh(page, opts); // re-pin discovery width BEFORE the base fingerprint
  }
  page.off('request', onRequest);
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
  await record(page, opts, [], 0, fp, st, st.queue, false, false);

  // Automatic data states of the entry page — the loading skeleton and the
  // error render exist in every data-driven app but almost never in a click
  // path. Captured out of the box; identical-to-base renders dedup away.
  if (opts.dataStates !== false && dataUrls.size > 0) {
    await recordDataState(page, opts, 'loading', st);
    await recordDataState(page, opts, 'error', st);
  }

  const counters = { tried: 0, skipped: 0 };
  await runPool(page, opts, st, counters, defined);
  const missing = defined.filter((c) => !st.classes.has(c)).sort();
  return {
    surfaces: st.surfaces,
    actionsTried: counters.tried,
    skipped: counters.skipped,
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
/** Clear storage before the app's code runs on EVERY load, so each gotoFresh is
 *  a clean slate in one navigation (no clear-then-reload round trip). */
async function armResetStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* storage unavailable (e.g. file://) — ignore */
    }
  });
}

export async function crawlAndCapture(page: Page, opts: SurfaceCrawlOptions): Promise<CrawlReport> {
  if (opts.resetStorage) await armResetStorage(page);
  return discover(page, opts);
}
