import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * Computed-style capture: the browser's final resolved value for every CSS
 * longhand on every element, keyed by DOM structure (never by class name, so
 * a CSS-to-Tailwind migration can rewrite classes freely while the map stays
 * comparable). Three layers per capture:
 *
 *   elements — every element's computed style, pruned against per-tag UA
 *              defaults (measured in a clean iframe) to keep files small,
 *              plus ::before / ::after / ::marker / ::placeholder.
 *   states   — for interactive elements, what :hover, :focus(-visible) and
 *              :active change (forced via CDP, no mouse involved), captured
 *              as a delta over the element's subtree. Screenshots cannot see
 *              these; this is where dropped `hover:` variants get caught.
 *   motion   — transition/animation longhands are captured before the
 *              freeze-CSS below nulls them, so declared motion is verified
 *              too, while every other captured value is a settled end state.
 *
 * LIMITATIONS (documented, and warned at capture time):
 *   - Shadow DOM (open or closed) is NOT traversed: styles inside a web
 *     component's shadow root are invisible to the diff. A refactor inside a
 *     shadow tree would be falsely certified identical, so capture emits a
 *     one-time warning naming the shadow hosts it skipped.
 *   - Iframe content (same- or cross-origin) is NOT traversed for the same
 *     reason; same-origin frames are listed in the same warning.
 */

type Props = Record<string, string>;
/** Document-space bounding box: [x, y, width, height], rounded. */
export type Rect = [number, number, number, number];
export type ElementEntry = {
  tag: string;
  cls: string;
  rect?: Rect;
  style: Props;
  pseudo?: Record<string, Props>;
  /**
   * The element's OWN rendered text (direct text-node children only, whitespace
   * collapsed) — present only when capture ran with `captureText: true` (the
   * opt-in content layer, off by default). Own-text, not subtree text, so each
   * change is attributed to the single element that owns it. Diffed by
   * {@link diffContentMaps}, never by the certification diff — content is
   * advisory, not a computed-style outcome. See README "Optional: content layer".
   */
  text?: string;
};
export type StyleMap = {
  defaults: Record<string, Props>;
  elements: Record<string, ElementEntry>;
  states: Record<string, Record<string, Record<string, Props>>>;
  /**
   * True when the forced :hover/:focus/:active layer was skipped for this
   * capture because of CDP/page interactive-element count skew. Persisted so a
   * diff against a fully-captured side flags that the state layer wasn't
   * certified, instead of silently reading as "identical".
   */
  statesSkipped?: boolean;
  /**
   * Element paths detected as LIVE at capture time — they kept changing on
   * their own (after motion was frozen) until the settle budget ran out, so
   * they're nondeterministic. Excluded from `elements`/`states`/`defaults`
   * here, and skipped by the diff (which unions both sides' volatile sets) so a
   * stream/ticker never reads as a change. Empty/absent on a fully-settled page.
   */
  volatile?: string[];
  /**
   * Colour-valued `:root` custom properties (design/theme tokens), normalised to
   * the same `rgb(...)` form the longhands resolve to — `{ "--red-200": "rgb(254,
   * 202, 202)" }`. Lets the report name the token behind a colour change
   * (`red-100 → red-200`) instead of only the raw value. Captured once per
   * surface from the document root; per-subtree overrides aren't tracked.
   */
  tokens?: Record<string, string>;
};

export type CaptureOptions = {
  /**
   * Selectors for nondeterministic regions (live data, embeds, ads). The
   * matching elements and their descendants are skipped entirely. Added to a
   * built-in default that skips framework/non-visual noise (`<meta>`/`<title>`/
   * `<script>`/`<style>`/… and `next-route-announcer`), so you rarely need it —
   * `stabilize` also auto-detects live regions. Use it to skip a region you know
   * is volatile without paying the settle wait for it.
   */
  ignore?: string[];
  /**
   * Settle the page before capturing, and auto-exclude live regions (default
   * on). StyleProof polls the (motion-frozen) page until its computed-style map
   * stops changing — so async content that paints AFTER `go()` resolves (a
   * fetch, an SSE/WebSocket stream) is captured in its loaded state, not
   * mid-load. Any region still changing when the budget runs out is a live
   * region by definition (it mutates with no code change); its paths are
   * recorded in `StyleMap.volatile` and excluded from the diff, so a stream or
   * ticker never reads as a change — no manual `ignore` needed. Text-only churn
   * (a clock, "2m ago") never matters: the diff compares computed style, not
   * text. Pass `false` to capture the exact frame `go()` left, or `{ interval,
   * quietFor, timeout }` (ms) to tune the poll cadence, the no-change window
   * that counts as settled, and the budget. Note: content that first paints
   * after a quiet gap longer than `quietFor` can't be waited for without a
   * signal — settle that in `go()`; anything still moving at `timeout` is
   * treated as a live region.
   */
  stabilize?: boolean | { interval?: number; quietFor?: number; timeout?: number };
  /**
   * Capture forced :hover/:focus/:active state deltas (default true). This is
   * the expensive layer — O(interactive elements × 3 states) with a subtree
   * evaluate each. Set false to skip it on surfaces where you don't need
   * state certification, or where the page has thousands of interactive nodes.
   */
  captureStates?: boolean;
  /**
   * Cap on interactive elements forced-state-captured per surface (default
   * 800). Beyond this the capture warns and truncates rather than hanging for
   * minutes; raise it deliberately if you need full coverage of a huge page.
   */
  maxInteractive?: number;
  /**
   * Opt-in content layer (default OFF). When true, each element's own rendered
   * text is recorded on `ElementEntry.text` so {@link diffContentMaps} can
   * surface copy changes a pure-style diff is blind to — most importantly the
   * silent ones where new or longer text overflows or clips its box. This is
   * ADVISORY: it never feeds the certification diff or its blocking counts, and
   * StyleProof stays computed-styles-first. Off by default keeps the core
   * promise (a CSS-only refactor that rewrites text is still certified
   * identical) intact for anyone who doesn't opt in. Text churn (clocks,
   * "2m ago") is auto-excluded by the same live-region settle pass that already
   * guards styles, since text now participates in change detection.
   */
  captureText?: boolean;
};

const INTERACTIVE = 'a, button, input, textarea, select, summary, [role="button"], [tabindex]';
// Freeze motion so every captured value is a settled end state, not a frame
// of an animation or a mid-flight transition after a forced :hover.
const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important}';

// Always skipped, merged into the caller's `ignore`. Two kinds of noise that
// are never a visual change worth gating on but churn the DOM between runs:
//   - non-rendered elements frameworks stream into <body> then hoist (Next.js
//     app-router injects <meta>/<title>/<link>); they have no box to style, and
//     their presence/order is nondeterministic. A real stylesheet change still
//     shows up in the affected elements' computed styles, not in the <style> tag.
//   - framework-injected live regions / overlays that mount and reorder on their
//     own (Next.js's a11y route announcer — already a known source of CDP skew).
const FRAMEWORK_IGNORE = [
  'meta',
  'title',
  'link',
  'script',
  'style',
  'base',
  'noscript',
  'template',
  'next-route-announcer',
  '[id="__next-route-announcer__"]',
];

/** True if `path` is one of `roots` or a structural descendant of one. Shared by
 *  the capture (excluding live regions) and the diff (skipping them). */
export function isUnder(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(r + ' > '));
}

type CaptureArgs = { ignore: string[]; motionOnly: boolean; captureText: boolean };

// Serialized into the browser by page.evaluate; cannot call module helpers.
function capturePage({ ignore, motionOnly, captureText }: CaptureArgs) {
  const MOTION = /^(transition|animation)/;
  const PSEUDOS = ['::before', '::after', '::marker', '::placeholder'];
  const skipSel = ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';

  const pathOf = (el: Element): string => {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const parts: string[] = [];
    let n: Element | null = el;
    while (n && n !== document.body) {
      const parent: Element | null = n.parentElement;
      if (!parent) break;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, n) + 1})`);
      n = parent;
    }
    return 'body > ' + parts.join(' > ');
  };

  // Per-tag (and per-tag-per-pseudo) UA defaults from a stylesheet-free iframe,
  // used to prune the maps. A pseudo-element's UA defaults are NOT the host
  // element's defaults, so they are measured and cached separately under a
  // composite key (e.g. `li::marker`) — pruning a pseudo against the wrong
  // baseline can both drop real changes and bloat the file.
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;left:-9999px;width:100px;height:100px;border:0';
  document.body.appendChild(frame);
  const fdoc = frame.contentDocument as Document;
  const defaults: Record<string, Props> = {};
  const probeCache: Record<string, Element> = {};
  const probeFor = (tag: string): Element => {
    if (!(tag in probeCache)) {
      const probe = fdoc.createElement(tag);
      fdoc.body.appendChild(probe);
      probeCache[tag] = probe;
    }
    return probeCache[tag];
  };
  const defaultFor = (tag: string, pseudo?: string): Props => {
    const key = pseudo ? `${tag}${pseudo}` : tag;
    if (!(key in defaults)) {
      const cs = fdoc.defaultView!.getComputedStyle(probeFor(tag), pseudo ?? null);
      const o: Props = {};
      for (let i = 0; i < cs.length; i++) o[cs.item(i)] = cs.getPropertyValue(cs.item(i));
      defaults[key] = o;
    }
    return defaults[key];
  };

  const snap = (cs: CSSStyleDeclaration, def: Props | null): Props => {
    const o: Props = {};
    for (let i = 0; i < cs.length; i++) {
      const p = cs.item(i);
      if (motionOnly !== MOTION.test(p)) continue;
      const v = cs.getPropertyValue(p);
      if (!def || def[p] !== v) o[p] = v;
    }
    return o;
  };

  type Entry = {
    tag: string;
    cls: string;
    rect?: [number, number, number, number];
    style: Props;
    pseudo?: Record<string, Props>;
    text?: string;
  };
  const elements: Record<string, Entry> = {};
  const all = [document.documentElement, document.body, ...document.querySelectorAll('body *')];
  // Surface untraversed shadow roots and same-origin iframes so a refactor
  // inside one is not silently certified identical (see file header).
  let shadowHosts = 0;
  let sameOriginFrames = 0;
  for (const el of all) {
    if (el === frame || (skipSel && el.matches(skipSel))) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'noscript') continue;
    if (!motionOnly && (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) shadowHosts++;
    if (!motionOnly && (tag === 'iframe' || tag === 'frame')) {
      try {
        if ((el as HTMLIFrameElement).contentDocument) sameOriginFrames++;
      } catch {
        // cross-origin: genuinely untraversable, not counted
      }
    }
    const entry: Entry = {
      tag,
      cls: el.getAttribute('class') || '',
      style: snap(getComputedStyle(el), defaultFor(tag)),
    };
    if (!motionOnly) {
      // Document-space box so report crops can locate the element in a
      // full-page screenshot regardless of scroll position at capture time.
      const r = el.getBoundingClientRect();
      entry.rect = [
        Math.round(r.x + window.scrollX),
        Math.round(r.y + window.scrollY),
        Math.round(r.width),
        Math.round(r.height),
      ];
      if (captureText) {
        // Own text only (direct text-node children, whitespace collapsed), so a
        // parent and child never both report the same string — each change is
        // attributed to the element that actually owns the text.
        let t = '';
        for (const node of Array.prototype.slice.call(el.childNodes)) {
          if (node.nodeType === 3 /* TEXT_NODE */) t += node.textContent ?? '';
        }
        t = t.replace(/\s+/g, ' ').trim();
        if (t) entry.text = t;
      }
    }
    for (const ps of PSEUDOS) {
      if (ps === '::marker' && getComputedStyle(el).display !== 'list-item') continue;
      if (ps === '::placeholder' && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) continue;
      const cs = getComputedStyle(el, ps);
      if ((ps === '::before' || ps === '::after') && cs.getPropertyValue('content') === 'none') continue;
      const props = snap(cs, defaultFor(tag, ps));
      if (Object.keys(props).length) (entry.pseudo ??= {})[ps] = props;
    }
    elements[pathOf(el)] = entry;
  }
  frame.remove();
  return { defaults, elements, shadowHosts, sameOriginFrames };
}

type SubtreeArgs = { selector: string; index: number };

/** Full (unpruned) computed styles for an element and its descendants, pseudo-elements included. */
// Serialized into the browser by page.evaluate; cannot call module helpers.
function snapSubtree({ selector, index }: SubtreeArgs) {
  const el = document.querySelectorAll(selector)[index];
  const pathOf = (n: Element): string => {
    if (n === document.documentElement) return 'html';
    if (n === document.body) return 'body';
    const parts: string[] = [];
    let c: Element | null = n;
    while (c && c !== document.body) {
      const parent: Element | null = c.parentElement;
      if (!parent) break;
      parts.unshift(`${c.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, c) + 1})`);
      c = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
  const out: Record<string, Record<string, string>> = {};
  if (!el) return out;
  for (const n of [el, ...el.querySelectorAll('*')]) {
    for (const ps of [null, '::before', '::after']) {
      const cs = getComputedStyle(n, ps);
      if (ps && cs.getPropertyValue('content') === 'none') continue;
      const o: Record<string, string> = {};
      for (let i = 0; i < cs.length; i++) {
        const p = cs.item(i);
        if (/^(transition|animation)/.test(p)) continue; // frozen by FREEZE_CSS
        o[p] = cs.getPropertyValue(p);
      }
      out[pathOf(n) + (ps || '')] = o;
    }
  }
  return out;
}

type Snap = Record<string, Props>;

function deltaBetween(base: Snap, forced: Snap): Record<string, Props> {
  const delta: Record<string, Props> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(forced)])) {
    const a = base[key] || {};
    const b = forced[key] || {};
    const d: Props = {};
    for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[p] !== b[p]) d[p] = b[p] ?? '(gone)';
    }
    if (Object.keys(d).length) delta[key] = d;
  }
  return delta;
}

const STATE_SETS: Record<string, string[]> = {
  hover: ['hover'],
  focus: ['focus', 'focus-visible'],
  active: ['active'],
};

type PathArgs = { selector: string; skipSel: string };

/** Structural paths for every selector match, index-aligned with CDP's DOM.querySelectorAll. */
function pathsForSelector({ selector, skipSel }: PathArgs) {
  const pathOf = (el: Element): string => {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const parts: string[] = [];
    let n: Element | null = el;
    while (n && n !== document.body) {
      const parent: Element | null = n.parentElement;
      if (!parent) break;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, n) + 1})`);
      n = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
  return [...document.querySelectorAll(selector)].map((el) => (skipSel && el.matches(skipSel) ? null : pathOf(el)));
}

// Forced pseudo-class states on interactive elements, via CDP so no real
// mouse or focus is involved and parent-state descendant rules still apply.
async function captureForcedStates(
  page: Page,
  ignore: string[],
  maxInteractive: number,
  skipPaths: string[] = [],
): Promise<{ states: StyleMap['states']; skipped: boolean }> {
  const client = await page.context().newCDPSession(page);
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const { root } = await client.send('DOM.getDocument');
  const { nodeIds } = await client.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: INTERACTIVE });
  const skipSel = ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';
  // Null out forced-state work for live (volatile) paths too, so they're not
  // probed and can't reintroduce the churn the settle pass just excluded.
  const paths = (await page.evaluate(pathsForSelector, { selector: INTERACTIVE, skipSel })).map((p) =>
    p && skipPaths.length && isUnder(p, skipPaths) ? null : p,
  );

  // The CDP DOM snapshot and the live querySelectorAll are two separate,
  // non-atomic reads. They can legitimately disagree — display:contents,
  // nodes detached or injected between the two calls (next-route-announcer,
  // Playwright internals, late hydration adding [tabindex]). A mismatch is NOT
  // a fatal error: positional nodeId↔path alignment is only valid when the
  // counts agree, so on skew we warn and skip the forced-state layer for this
  // surface rather than aborting the whole capture (base + pseudo layers,
  // the load-bearing certification, still succeed).
  if (paths.length !== nodeIds.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `styleproof: interactive-element count skew (CDP saw ${nodeIds.length}, page saw ${paths.length}); ` +
        'skipping forced :hover/:focus/:active capture for this surface. This is usually a benign, ' +
        'transient DOM difference (display:contents, injected/detached nodes). Re-run if it persists.',
    );
    await client.detach();
    return { states: {}, skipped: true };
  }

  const limit = Math.min(nodeIds.length, maxInteractive);
  if (nodeIds.length > maxInteractive) {
    // eslint-disable-next-line no-console
    console.warn(
      `styleproof: ${nodeIds.length} interactive elements exceeds maxInteractive=${maxInteractive}; ` +
        `forced-state capture truncated to the first ${maxInteractive}. Raise maxInteractive to cover them all.`,
    );
  }

  const states: StyleMap['states'] = {};
  for (let i = 0; i < limit; i++) {
    const p = paths[i];
    if (!p) continue;
    const baseSnap: Snap = await page.evaluate(snapSubtree, { selector: INTERACTIVE, index: i });
    for (const [stateName, forcedPseudoClasses] of Object.entries(STATE_SETS)) {
      await client.send('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses });
      const forcedSnap: Snap = await page.evaluate(snapSubtree, { selector: INTERACTIVE, index: i });
      await client.send('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: [] });
      const delta = deltaBetween(baseSnap, forcedSnap);
      if (Object.keys(delta).length) (states[p] ??= {})[stateName] = delta;
    }
  }
  await client.detach();
  return { states, skipped: false };
}

type Elements = Record<string, ElementEntry>;
/** Element paths that differ between two captures (added, removed, or restyled). */
function changedElementPaths(a: Elements, b: Elements): string[] {
  const out: string[] = [];
  for (const p of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (JSON.stringify(a[p]) !== JSON.stringify(b[p])) out.push(p);
  return out;
}

/**
 * Poll the page until its computed-style map has been UNCHANGED for `quietFor`
 * ms (it settled — async content finished painting) or the budget runs out.
 * Requiring a sustained quiet window, not a single quiet sample, is what lets it
 * wait THROUGH the gap before late content paints and through a streaming
 * backfill instead of settling on the first lull. Returns the paths still
 * changing at timeout: genuine LIVE regions, to be excluded from the capture.
 * Reuses `capturePage` (motion already frozen by the caller), so only
 * content/layout churn — not an animation frame — keeps it from settling.
 */
async function stabilizePage(
  page: Page,
  ignore: string[],
  interval: number,
  quietFor: number,
  timeout: number,
  captureText: boolean,
): Promise<string[]> {
  // captureText is threaded in so text churn participates in settle detection:
  // a clock/ticker whose text changes (with no style change) keeps the map from
  // settling and is excluded as a live region, exactly as style churn already is.
  const snap = async (): Promise<Elements> =>
    (await page.evaluate(capturePage, { ignore, motionOnly: false, captureText })).elements as Elements;
  const start = Date.now();
  let prev = await snap();
  let lastChangeAt = start;
  let recent: string[] = [];
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(interval);
    const cur = await snap();
    const changed = changedElementPaths(prev, cur);
    prev = cur;
    if (changed.length) {
      lastChangeAt = Date.now();
      recent = changed;
    } else if (Date.now() - lastChangeAt >= quietFor) {
      return []; // unchanged for the full quiet window → settled
    }
  }
  return recent; // never went quiet for quietFor within budget → still-moving paths are live
}

// Serialized into the browser by page.evaluate; cannot call module helpers.
// Colour-valued `:root` custom properties (theme tokens), each normalised to the
// browser's `rgb(...)` form (via a probe element) so they match the resolved
// longhand values the diff compares — letting the report name `red-200` behind a
// colour. Non-colour tokens (spacing, etc.) are skipped.
function capturePageTokens(): Record<string, string> {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-9999px';
  document.body.appendChild(probe);
  const tokens: Record<string, string> = {};
  for (let i = 0; i < cs.length; i++) {
    const name = cs.item(i);
    if (!name.startsWith('--')) continue;
    const raw = cs.getPropertyValue(name).trim();
    if (!raw) continue;
    probe.style.color = '';
    probe.style.color = raw; // invalid (non-colour) values leave it empty
    if (!probe.style.color) continue;
    tokens[name] = getComputedStyle(probe).color; // canonical rgb(a)(...)
  }
  probe.remove();
  return tokens;
}

/** Settle the page and return the paths of live regions to exclude. */
async function detectVolatile(
  page: Page,
  ignore: string[],
  stabilize: CaptureOptions['stabilize'],
  captureText: boolean,
): Promise<string[]> {
  if (stabilize === false) return [];
  const opt = typeof stabilize === 'object' ? stabilize : {};
  const volatile = await stabilizePage(
    page,
    ignore,
    opt.interval || 150,
    opt.quietFor || 600,
    opt.timeout || 5000,
    captureText,
  );
  if (volatile.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `styleproof: ${volatile.length} live region(s) kept changing on their own and were excluded from ` +
        'this capture (nondeterministic — a stream, ticker, or late-loading content). The diff skips them so ' +
        'they never read as a change. If a real change is being hidden, settle the page in go() or raise stabilize.timeout.',
    );
  }
  return volatile;
}

/** Drop live regions (and their subtrees) from the base capture, in Node so the
 *  serialized capturePage stays a pure snapshot. */
function dropVolatile(elements: Elements, volatile: string[]): void {
  if (!volatile.length) return;
  for (const p of Object.keys(elements)) if (isUnder(p, volatile)) delete elements[p];
}

/** Warn once when shadow roots / iframes were skipped (their styles aren't captured or diffed). */
function warnUntraversed(shadowHosts?: number, sameOriginFrames?: number): void {
  if (!shadowHosts && !sameOriginFrames) return;
  // eslint-disable-next-line no-console
  console.warn(
    `styleproof: ${shadowHosts} shadow host(s) and ${sameOriginFrames} same-origin iframe(s) were ` +
      'NOT traversed — styles inside shadow roots and frames are not captured or diffed. A refactor inside ' +
      'one would be reported as identical. See README "Limitations".',
  );
}

/** Fold the pre-freeze motion longhands back onto the settled base capture. */
function mergeMotion(elements: Elements, motion: Elements): void {
  for (const [p, entry] of Object.entries(elements)) {
    const m = motion[p];
    if (!m) continue;
    Object.assign(entry.style, m.style);
    for (const [ps, props] of Object.entries(m.pseudo ?? {})) {
      if (entry.pseudo?.[ps]) Object.assign(entry.pseudo[ps], props);
    }
  }
}

/**
 * Capture the page's complete style map. Drive the page to the state you want
 * first (navigate, open menus); by default the capture then auto-settles the
 * page and excludes live regions (see `stabilize`), so a fetch/stream that
 * paints after `go()` resolves is captured loaded, not mid-load.
 */
export async function captureStyleMap(page: Page, options: CaptureOptions = {}): Promise<StyleMap> {
  // Framework/non-visual noise is always skipped, so it can't read as a DOM
  // change; the caller's `ignore` adds to it (not replaces it).
  const ignore = [...FRAMEWORK_IGNORE, ...(options.ignore ?? [])];
  const captureStates = options.captureStates ?? true;
  const maxInteractive = options.maxInteractive ?? 800;
  const stabilize = options.stabilize ?? true;
  const captureText = options.captureText ?? false;
  // Motion longhands first (FREEZE_CSS would null them), then everything else.
  // Motion never carries text — it's a settled end state of declared motion.
  const motion = await page.evaluate(capturePage, { ignore, motionOnly: true, captureText: false });
  await page.addStyleTag({ content: FREEZE_CSS });

  // Settle: wait for async content to finish painting so base and head capture
  // the same loaded state, and collect any region still changing on its own
  // (a live stream/ticker) to exclude — animations are frozen above, so only
  // real content/layout churn lands here.
  const volatile = await detectVolatile(page, ignore, stabilize, captureText);

  const base = await page.evaluate(capturePage, { ignore, motionOnly: false, captureText });
  dropVolatile(base.elements, volatile);
  warnUntraversed(base.shadowHosts, base.sameOriginFrames);
  mergeMotion(base.elements, motion.elements);
  let states: StyleMap['states'] = {};
  let statesSkipped = false;
  if (captureStates) {
    const forced = await captureForcedStates(page, ignore, maxInteractive, volatile);
    states = forced.states;
    statesSkipped = forced.skipped;
  }
  const tokens = await page.evaluate(capturePageTokens);
  return {
    defaults: base.defaults,
    elements: base.elements,
    states,
    ...(statesSkipped ? { statesSkipped: true } : {}),
    ...(volatile.length ? { volatile } : {}),
    ...(Object.keys(tokens).length ? { tokens } : {}),
  };
}

/** Write a style map to disk; gzipped when the path ends in `.gz`. */
export function saveStyleMap(filePath: string, map: StyleMap): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(map);
  fs.writeFileSync(filePath, filePath.endsWith('.gz') ? gzipSync(json) : json);
}

/** Read a style map written by {@link saveStyleMap} (`.json` or `.json.gz`). */
export function loadStyleMap(filePath: string): StyleMap {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch (e) {
    throw new Error(`styleproof: cannot read capture ${filePath}: ${(e as Error).message}`, { cause: e });
  }
  try {
    const text = filePath.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `styleproof: capture ${filePath} is corrupt or truncated (${(e as Error).message}). ` +
        'Re-capture it — a partial write or interrupted upload produces an unreadable .gz.',
      { cause: e },
    );
  }
}
