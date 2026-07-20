import type { Page, Request, Response } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { classifyInventory, collectNavAffordances, type NavigableItem } from './inventory.js';
import { realNow } from './spec-clock.js';
import { endpointOf, residueKey, type DataResidueEntry } from './data-residue.js';
import { isMapFile } from './map-store.js';

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
   * Length of the element's own rendered text after whitespace normalization.
   * Always captured, but never the text itself: this privacy-safe signal lets
   * the differ distinguish content-length reflow from a genuine sizing-rule
   * change without enabling the opt-in content layer.
   */
  ownTextLength?: number;
  /**
   * The element's OWN rendered text (direct text-node children only, whitespace
   * collapsed) — present only when capture ran with `captureText: true` (the
   * opt-in content layer, off by default). Own-text, not subtree text, so each
   * change is attributed to the single element that owns it. Diffed by
   * {@link diffContentMaps}, never by the certification diff — content is
   * advisory, not a computed-style outcome. See README "Optional: content layer".
   */
  text?: string;
  /**
   * The React component that rendered this element, and a sanitized subset of its
   * props — present only when capture ran with `captureComponent: true` (opt-in,
   * off by default). Extracted in-page from the React fiber. ADVISORY: never fed
   * to the certification diff or its counts (like {@link ElementEntry.text}); it
   * only enriches the report so a reviewer sees `Button (variant=primary)` rather
   * than a bare `<button>`. Best in dev/non-minified builds (prod mangles names).
   */
  component?: { name: string; props?: Record<string, string> };
};
export type CaptureMetadata = {
  surfaceKey?: string;
  variantKey?: string;
  variantKind?: 'variant' | 'live-state' | 'popup';
};
export type LiveRegionCandidate = {
  path: string;
  tag: string;
  cls: string;
  reason: string;
  role?: string;
  ariaLive?: string;
  ariaBusy?: string;
};
export type CapturedOverlay = {
  path: string;
  tag: string;
  cls: string;
  reason: string;
  role?: string;
  ariaModal?: string;
  ariaLive?: string;
  text?: string;
};
export type StyleMap = {
  /** Optional runner-supplied context; ignored by the certification diff. */
  metadata?: CaptureMetadata;
  /** Browser viewport used for this capture. Report-only; ignored by the certification diff. */
  viewport?: { width: number; height: number };
  defaults: Record<string, Props>;
  elements: Record<string, ElementEntry>;
  states: Record<string, Record<string, Record<string, Props>>>;
  /**
   * True when the forced :hover/:focus/:active layer was not fully captured for
   * this capture — either CDP/page interactive-element count skew, or because the
   * interactive-element count exceeded `maxInteractive` and capture was truncated.
   * Persisted so a diff against a fully-captured side flags that the state layer
   * wasn't certified, instead of silently reading as "identical".
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
   * Semantic live-state candidates detected automatically from the DOM, such as
   * `[aria-live]`, `role=status`, `role=alert`, or `aria-busy=true`. These are
   * diagnostics only: stable candidates are still captured and compared; only
   * regions that actually keep changing are auto-excluded via `volatile`.
   */
  liveCandidates?: LiveRegionCandidate[];
  /**
   * Visible semantic overlay roots that were present in the captured DOM and
   * whose paths are present in `elements`. This is diagnostic/proof metadata:
   * dialogs, menus, listboxes, modal roots and toast roots are still certified by
   * the normal computed-style map, while this list lets tests prove those states
   * were actually reached and captured.
   */
  overlays?: CapturedOverlay[];
  /**
   * Colour-valued `:root` custom properties (design/theme tokens), normalised to
   * the same `rgb(...)` form the longhands resolve to — `{ "--red-200": "rgb(254,
   * 202, 202)" }`. Lets the report name the token behind a colour change
   * (`red-100 → red-200`) instead of only the raw value. Captured once per
   * surface from the document root; per-subtree overrides aren't tracked.
   */
  tokens?: Record<string, string>;
  /**
   * The surface's navigable inventory — user-reachable affordances (route links,
   * tabs, menu items, button-only nav), keyed stably. Present only when captured
   * with `inventory: true`. Diffed by the inventory guard (a removal gates), never
   * by the certification diff. See docs/inventory-guard.md.
   */
  inventory?: NavigableItem[];
  /**
   * Data-boundary requests (matching `replayUrl`) that FAILED during this capture —
   * a network error or a 4xx/5xx. Their presence means the captured state renders the
   * endpoint's FALLBACK branch, so states driven by its real responses are uncaptured
   * and unproven. Present only when the residue guard was armed (`dataResidue` set) and
   * a failure actually occurred; absent (byte-identical to before) on a clean capture.
   * Surfaced by the data-residue guard, never by the certification diff. See issue #205.
   */
  dataResidue?: DataResidueEntry[];
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
   * Harvest the surface's navigable inventory (route links, tabs, menu items,
   * button-only nav) into `StyleMap.inventory`, for the inventory guard. Off by
   * default; advisory to the certification diff — a removal gates separately.
   */
  inventory?: boolean;
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
   * quietFor, timeout, waitForRequests }` to tune the poll cadence, the no-change
   * window that counts as settled, the budget (ms), and the network signal.
   *
   * By default the settle is **network-aware** (`waitForRequests: true`): it won't
   * settle on the brief DOM lull BEFORE a `fetch`/XHR response arrives — it holds
   * while data requests are in flight (excluding long-lived `EventSource`/WebSocket
   * streams, which never finish), so late-fetched content is captured loaded, not
   * mid-load. This is the signal a DOM-quiet window alone lacks: without it, a slow
   * backend (e.g. a dev server under CI load) settles on the loading state on one run
   * and the loaded state on the next — a self-check flake. Anything still moving at
   * `timeout` is treated as a live region. Set `waitForRequests: false` to settle on
   * DOM quiet alone.
   */
  stabilize?: boolean | { interval?: number; quietFor?: number; timeout?: number; waitForRequests?: boolean };
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
  /**
   * Opt-in React layer (default OFF). When true, each element records the React
   * component that rendered it (display name) and a sanitized subset of its props
   * on {@link ElementEntry.component}, read in-page from the React fiber
   * (`__reactFiber$*`/`__reactProps$*` on React 17+, `__reactInternalInstance$*`
   * on ≤16). Lets the report name `Button (variant=primary)` instead of a bare
   * `<button>`. ADVISORY — like `captureText` it never feeds the certification
   * diff or its blocking counts. Only primitive props (string/number/boolean) are
   * kept (children/handlers/objects dropped); names are mangled in minified prod
   * builds, so this is most useful against dev/non-minified output. No-op on
   * non-React pages (fiber keys absent → field omitted).
   */
  captureComponent?: boolean;
  /**
   * Advanced/internal: a getter for the count of in-flight data requests, supplied by
   * a tracker ({@link trackInflightRequests}) armed BEFORE navigation so the page's own
   * load fetches are counted by the network-aware settle. `defineStyleMapCapture`
   * wires this automatically. Omit it for a direct `captureStyleMap` call and the
   * settle arms its own tracker from capture time — which can't see a request already
   * in flight when you called it (arm one yourself before `goto` if that matters).
   */
  pendingRequests?: () => number;
  /** Advanced/internal: metadata to persist with the capture for report context. */
  metadata?: CaptureMetadata;
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
  '[data-styleproof-hover-sink]',
];

function installHoverSink(): void {
  let sink = document.querySelector<HTMLElement>('[data-styleproof-hover-sink]');
  if (!sink) {
    sink = document.createElement('div');
    sink.setAttribute('data-styleproof-hover-sink', '');
    document.body.appendChild(sink);
  }
  sink.setAttribute(
    'style',
    [
      'position:fixed',
      'left:0',
      'top:0',
      'width:1px',
      'height:1px',
      'z-index:2147483647',
      'pointer-events:auto',
      'opacity:0',
    ].join(';'),
  );
}

/** True if `path` is one of `roots` or a structural descendant of one. Shared by
 *  the capture (excluding live regions) and the diff (skipping them). */
export function isUnder(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(r + ' > '));
}

// Defines the structural-path helper on `window` once so the two functions
// serialized into the page (capturePage, markInteractiveElements) share ONE
// implementation — page.evaluate can't reference a module-scope helper, so the
// alternative is an identical copy in each. Injected at the top of captureStyleMap.
function injectPathOf(): void {
  (window as unknown as { __spPathOf?: (el: Element) => string }).__spPathOf = (el: Element): string => {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const identityCandidates = (element: Element): string[] => {
      const tag = element.tagName.toLowerCase();
      const attributes: Array<[string, string | null]> = [
        ['styleproof', element.getAttribute('data-styleproof-key')],
        ['id', element.getAttribute('id')],
        ['testid', element.getAttribute('data-testid')],
        ['test', element.getAttribute('data-test')],
        ...(tag === 'a' ? ([['href', element.getAttribute('href')]] as Array<[string, string | null]>) : []),
        ...(['input', 'select', 'textarea'].includes(tag)
          ? ([['name', element.getAttribute('name')]] as Array<[string, string | null]>)
          : []),
      ];
      return attributes.flatMap(([name, value]) => (value ? [`${name}:${value}`] : []));
    };
    const privacySafeHash = (value: string): string => {
      let hash = 2166136261;
      for (let characterIndex = 0; characterIndex < value.length; characterIndex++) {
        hash ^= value.charCodeAt(characterIndex);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    };
    const stableSegment = (element: Element, parent: Element): string => {
      const candidate = identityCandidates(element).find(
        (identity) =>
          [...parent.children].filter((sibling) => identityCandidates(sibling).includes(identity)).length === 1,
      );
      if (candidate) return `${element.tagName.toLowerCase()}:sp-key(${privacySafeHash(candidate)})`;
      return `${element.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, element) + 1})`;
    };
    const parts: string[] = [];
    let element: Element | null = el;
    while (element && element !== document.body) {
      const parent: Element | null = element.parentElement;
      if (!parent) break;
      parts.unshift(stableSegment(element, parent));
      element = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
}
/** In-page shape of the window after {@link injectPathOf} runs. */
type WithPathOf = { __spPathOf: (el: Element) => string };

type CaptureArgs = { ignore: string[]; motionOnly: boolean; captureText: boolean; captureComponent?: boolean };

// Serialized into the browser by page.evaluate; cannot call module helpers.
// Pre-existing, grandfathered in the health baseline; the content layer adds
// one small captureText block, not new structure.
// fallow-ignore-next-line complexity
function capturePage({ ignore, motionOnly, captureText, captureComponent }: CaptureArgs) {
  const MOTION = /^(transition|animation)/;
  const PSEUDOS = ['::before', '::after', '::marker', '::placeholder'];
  const skipSel = ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';

  const pathOf = (window as unknown as WithPathOf).__spPathOf;

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
    ownTextLength?: number;
    text?: string;
    component?: { name: string; props?: Record<string, string> };
  };

  // React stores the fiber + props on each DOM node under a hashed key. Walk up
  // to the nearest component fiber (host fibers have a string `type`; component
  // fibers a function/object `type`) for its display name + sanitized props.
  type Fiber = { type: unknown; return: Fiber | null; memoizedProps?: Record<string, unknown> };
  // Display name from a fiber `type`: function/class, or a forwardRef/memo wrapper
  // object; '' for host fibers (string type), which keeps the walk going upward.
  const nameOfType = (t: unknown): string => {
    if (typeof t === 'function') {
      const f = t as { displayName?: string; name?: string };
      return f.displayName || f.name || '';
    }
    if (t && typeof t === 'object') {
      const w = t as {
        displayName?: string;
        render?: { displayName?: string; name?: string };
        type?: { displayName?: string; name?: string };
      };
      const inner = w.render || w.type;
      return w.displayName || inner?.displayName || inner?.name || '';
    }
    return '';
  };
  // Keep only primitive props (drop children/className/style/handlers/objects),
  // capped — advisory, so never anything that could be huge or non-serializable.
  const sanitizeProps = (mp: Record<string, unknown>): Record<string, string> => {
    const props: Record<string, string> = {};
    for (const k of Object.keys(mp)) {
      if (k === 'children' || k === 'className' || k === 'style') continue;
      const ty = typeof mp[k];
      if (ty === 'string' || ty === 'number' || ty === 'boolean') props[k] = String(mp[k]).slice(0, 80);
    }
    return props;
  };
  const reactComponent = (el: Element): Entry['component'] => {
    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (!fiberKey) return undefined;
    let fiber = (el as unknown as Record<string, Fiber | undefined>)[fiberKey] ?? null;
    for (let hops = 0; fiber && hops < 30; fiber = fiber.return, hops++) {
      const name = nameOfType(fiber.type);
      if (!name || name === 'Symbol(react.fragment)') continue;
      const out: { name: string; props?: Record<string, string> } = { name };
      const mp = fiber.memoizedProps;
      if (mp && typeof mp === 'object') {
        const props = sanitizeProps(mp);
        if (Object.keys(props).length) out.props = props;
      }
      return out;
    }
    return undefined;
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
      // Own text only (direct text-node children, whitespace collapsed), so a
      // parent and child never both report the same string. The length is a
      // privacy-safe default signal for content-driven reflow; the actual text
      // remains opt-in through captureText.
      let ownText = '';
      for (const node of Array.prototype.slice.call(el.childNodes)) {
        if (node.nodeType === 3 /* TEXT_NODE */) ownText += node.textContent ?? '';
      }
      ownText = ownText.replace(/\s+/g, ' ').trim();
      entry.ownTextLength = ownText.length;
      if (captureText && ownText) entry.text = ownText;
      if (captureComponent) {
        try {
          const comp = reactComponent(el);
          if (comp) entry.component = comp;
        } catch {
          // non-React node or inaccessible fiber — component stays absent
        }
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

type LiveCandidateArgs = { ignore: string[] };
type OverlayCandidateArgs = { ignore: string[] };

function detectLiveCandidates({ ignore }: LiveCandidateArgs): LiveRegionCandidate[] {
  const pathOf = (window as unknown as WithPathOf).__spPathOf;
  const skipSel = ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';
  const reasonsFor = (role: string, ariaLive: string, ariaBusy: string): string[] => {
    const reasons: string[] = [];
    if (ariaLive && ariaLive !== 'off') reasons.push(`aria-live=${ariaLive}`);
    if (['alert', 'log', 'marquee', 'status', 'timer'].includes(role)) reasons.push(`role=${role}`);
    if (ariaBusy === 'true') reasons.push('aria-busy=true');
    return reasons;
  };
  return [document.documentElement, document.body, ...document.querySelectorAll('body *')]
    .filter((el) => !skipSel || !el.matches(skipSel))
    .flatMap((el): LiveRegionCandidate[] => {
      const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
      const ariaLive = (el.getAttribute('aria-live') ?? '').trim().toLowerCase();
      const ariaBusy = (el.getAttribute('aria-busy') ?? '').trim().toLowerCase();
      const reasons = reasonsFor(role, ariaLive, ariaBusy);
      return reasons.length
        ? [
            {
              path: pathOf(el),
              tag: el.tagName.toLowerCase(),
              cls: el.getAttribute('class') || '',
              reason: reasons.join(', '),
              ...(role ? { role } : {}),
              ...(ariaLive ? { ariaLive } : {}),
              ...(ariaBusy ? { ariaBusy } : {}),
            },
          ]
        : [];
    });
}

function detectOverlayCandidates({ ignore }: OverlayCandidateArgs): CapturedOverlay[] {
  const pathOf = (window as unknown as WithPathOf).__spPathOf;
  const skipSel = ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';
  const visible = (el: Element): boolean => {
    if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const textOf = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const toastish = (el: Element): boolean => {
    const haystack = [
      el.id,
      el.getAttribute('class'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-hot-toast'),
      el.getAttribute('data-sonner-toast'),
      el.getAttribute('data-toast'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return /\b(toast|hot-toast|sonner)\b/.test(haystack);
  };
  const reasonsFor = (el: Element, role: string, ariaModal: string): string[] => {
    const reasons: string[] = [];
    if (el instanceof HTMLDialogElement && el.open) reasons.push('dialog[open]');
    if (el.hasAttribute('popover')) reasons.push('popover');
    if (['dialog', 'alertdialog', 'menu', 'listbox', 'tooltip'].includes(role)) reasons.push(`role=${role}`);
    if (ariaModal === 'true') reasons.push('aria-modal=true');
    if (toastish(el)) reasons.push('toast');
    if (el.hasAttribute('data-hot-toast')) reasons.push('data-hot-toast');
    if (el.hasAttribute('data-sonner-toast')) reasons.push('data-sonner-toast');
    if ((role === 'status' || role === 'alert') && toastish(el)) reasons.push(`role=${role}`);
    return [...new Set(reasons)];
  };

  return [document.documentElement, document.body, ...document.querySelectorAll('body *')]
    .filter((el) => (!skipSel || !el.matches(skipSel)) && visible(el))
    .flatMap((el): CapturedOverlay[] => {
      const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
      const ariaModal = (el.getAttribute('aria-modal') ?? '').trim().toLowerCase();
      const ariaLive = (el.getAttribute('aria-live') ?? '').trim().toLowerCase();
      const reasons = reasonsFor(el, role, ariaModal);
      if (!reasons.length) return [];
      const text = textOf(el);
      return [
        {
          path: pathOf(el),
          tag: el.tagName.toLowerCase(),
          cls: el.getAttribute('class') || '',
          reason: reasons.join(', '),
          ...(role ? { role } : {}),
          ...(ariaModal ? { ariaModal } : {}),
          ...(ariaLive ? { ariaLive } : {}),
          ...(text ? { text } : {}),
        },
      ];
    });
}

type SubtreeArgs = { selector: string; index: number };

/** Full (unpruned) computed styles for an element and its descendants, pseudo-elements included. */
// Serialized into the browser by page.evaluate; cannot call module helpers, so this
// in-page fn (cog 16) can't be split into smaller ones. Pre-existing; refactor separately.
// fallow-ignore-next-line complexity
function snapSubtree({ selector, index }: SubtreeArgs) {
  const el = document.querySelectorAll(selector)[index];
  const pathOf = (window as unknown as WithPathOf).__spPathOf;
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

const STATE_ID_ATTR = 'data-styleproof-state-id';

type MarkArgs = { selector: string; skipSel: string; attr: string };
type MarkedInteractive = { id: string; path: string };

/**
 * Mark interactive elements once, then address that same element from both CDP
 * and page.evaluate. Positional CDP nodeId ↔ querySelectorAll index alignment is
 * flaky on hydrated apps: two non-atomic DOM snapshots can have the same count
 * but different ordering, which produces phantom forced-state diffs.
 */
function markInteractiveElements({ selector, skipSel, attr }: MarkArgs): MarkedInteractive[] {
  const pathOf = (window as unknown as WithPathOf).__spPathOf;
  let i = 0;
  return [...document.querySelectorAll(selector)].flatMap((el) => {
    if (skipSel && el.matches(skipSel)) return [];
    const id = `sp-${i++}`;
    el.setAttribute(attr, id);
    return [{ id, path: pathOf(el) }];
  });
}

function clearInteractiveMarks(attr: string): void {
  for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
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
  const skipSel = ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';
  const marked = (
    await page.evaluate(markInteractiveElements, { selector: INTERACTIVE, skipSel, attr: STATE_ID_ATTR })
  ).filter((m) => !(skipPaths.length && isUnder(m.path, skipPaths)));

  const limit = Math.min(marked.length, maxInteractive);
  const truncated = marked.length > maxInteractive;
  if (truncated) {
    // eslint-disable-next-line no-console
    console.warn(
      `styleproof: ${marked.length} interactive elements exceeds maxInteractive=${maxInteractive}; ` +
        `forced-state capture truncated to the first ${maxInteractive}. Raise maxInteractive to cover them all.`,
    );
  }

  const states: StyleMap['states'] = {};
  try {
    for (const { id, path: p } of marked.slice(0, limit)) {
      const selector = `[${STATE_ID_ATTR}="${id}"]`;
      const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) {
        // eslint-disable-next-line no-console
        console.warn(`styleproof: interactive element ${id} detached before forced-state capture; skipping it.`);
        continue;
      }
      const baseSnap: Snap = await page.evaluate(snapSubtree, { selector, index: 0 });
      for (const [stateName, forcedPseudoClasses] of Object.entries(STATE_SETS)) {
        await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses });
        const forcedSnap: Snap = await page.evaluate(snapSubtree, { selector, index: 0 });
        await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        const delta = deltaBetween(baseSnap, forcedSnap);
        if (Object.keys(delta).length) (states[p] ??= {})[stateName] = delta;
      }
    }
  } finally {
    await page.evaluate(clearInteractiveMarks, STATE_ID_ATTR).catch(() => undefined);
    await client.detach();
  }
  // When truncated, the elements past the limit have no forced-state delta —
  // flag the layer so the diff reports it as uncertified instead of letting the
  // missing states read as "identical" against a fully-captured side.
  return { states, skipped: truncated };
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
  pending: () => number,
): Promise<string[]> {
  // captureText is threaded in so text churn participates in settle detection:
  // a clock/ticker whose text changes (with no style change) keeps the map from
  // settling and is excluded as a live region, exactly as style churn already is.
  const snap = async (): Promise<Elements> =>
    (await page.evaluate(capturePage, { ignore, motionOnly: false, captureText })).elements as Elements;
  // realNow, not Date.now: under STYLEPROOF_FREEZE_SPEC_CLOCK the process Date is
  // frozen, and a frozen elapsed-time read would never advance these windows.
  const start = realNow();
  let prev = await snap();
  let lastChangeAt = start;
  let recent: string[] = [];
  while (realNow() - start < timeout) {
    await page.waitForTimeout(interval);
    const cur = await snap();
    const changed = changedElementPaths(prev, cur);
    prev = cur;
    if (changed.length) {
      lastChangeAt = realNow();
      recent = changed;
    } else if (pending() > 0) {
      // The DOM is momentarily quiet, but data requests are still in flight — this
      // is the lull BEFORE the response paints, not a settled state. Hold the quiet
      // window so we wait for the content to ARRIVE (no live-region path to record;
      // network activity isn't a mutating element). Long-lived streams are excluded
      // by the caller, so this can't hang on an SSE that never finishes.
      lastChangeAt = realNow();
    } else if (realNow() - lastChangeAt >= quietFor) {
      return []; // DOM unchanged AND network idle for the full quiet window → settled
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

/**
 * Track in-flight DATA requests on `page` so the network-aware settle can wait for
 * late-loading content to ARRIVE, not just for the DOM to go briefly quiet (the lull
 * before a response paints). Long-lived streams (EventSource/WebSocket) never finish,
 * so they're excluded — their painted state is handled by the live-region pass.
 *
 * Attach BEFORE navigation to count the page's OWN load fetches: a request already in
 * flight when you call `captureStyleMap` fired its `request` event before any listener
 * attached there, so only a tracker armed earlier (the runner does this before `go()`)
 * can see it.
 */
export function trackInflightRequests(page: Page): { pending: () => number; dispose: () => void } {
  const inflight = new Set<Request>();
  const isStream = (r: Request): boolean => {
    const t = r.resourceType();
    return t === 'eventsource' || t === 'websocket';
  };
  const onStart = (r: Request): void => {
    if (!isStream(r)) inflight.add(r);
  };
  const onEnd = (r: Request): void => {
    inflight.delete(r);
  };
  page.on('request', onStart);
  page.on('requestfinished', onEnd);
  page.on('requestfailed', onEnd);
  return {
    pending: (): number => inflight.size,
    dispose: (): void => {
      page.off('request', onStart);
      page.off('requestfinished', onEnd);
      page.off('requestfailed', onEnd);
    },
  };
}

/**
 * Watch the data boundary (`url`, the same `replayUrl` glob record/replay uses) for
 * requests that FAIL during capture — a network-level failure or a 4xx/5xx response.
 * A failing data request means the captured state renders that endpoint's FALLBACK
 * branch; the response-driven state is uncaptured and unproven (issue #205).
 *
 * Matches purely by listening to `requestfailed`/`response` and testing the URL against
 * the boundary glob — NOT via a `page.route`. A passive route can't be used to tag: the
 * tracker is armed before `go()`, and a route the surface itself adds in `go()` (an abort
 * fixture, the HAR replay route) runs first and never falls through to a tag route added
 * earlier, so tagged requests would be missed. Listeners see every request regardless of
 * routing, which is exactly what a residue observer needs. Arm BEFORE navigation, like
 * {@link trackInflightRequests}, so the page's own load fetches are seen; deduped per
 * `<surface>·<endpoint>` so the same failure across widths / a self-check re-run is one entry.
 *
 * ONLY failures are recorded — never a 2xx that merely wasn't fixtured: in recording mode
 * every live 2xx is legitimately recorded, so a blanket "uncontrolled" flag would fire on
 * every healthy record run (issue #205, "deliberately out of scope").
 */
export function trackDataResidue(
  page: Page,
  url: string,
  surface: string,
): { residue: () => DataResidueEntry[]; dispose: () => void } {
  const byKey = new Map<string, DataResidueEntry>();
  const inBoundary = urlMatcher(url);
  const record = (request: Request, reason: string): void => {
    if (!inBoundary(request.url())) return;
    const endpoint = endpointOf(request.url());
    const key = residueKey(surface, endpoint);
    if (!byKey.has(key)) byKey.set(key, { key, surface, endpoint, reason });
  };
  const onFailed = (r: Request): void => record(r, r.failure()?.errorText ?? 'request failed');
  // A completed response's status is synchronous here, so a 4xx/5xx is recorded before
  // capture reads the residue. A >=400 is a fallback-branch trigger just like a net failure.
  const onResponse = (resp: Response): void => {
    if (resp.status() >= 400) record(resp.request(), `HTTP ${resp.status()}`);
  };
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);
  return {
    residue: (): DataResidueEntry[] => Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key)),
    dispose: (): void => {
      page.off('requestfailed', onFailed);
      page.off('response', onResponse);
    },
  };
}

/**
 * A predicate matching a URL against a Playwright-style URL glob — the same micro-syntax
 * `page.route`/`routeFromHAR` accept for `replayUrl`, replicated because Playwright exposes
 * no public matcher and reaching into its bundled internals is fragile across versions.
 * `**` spans path separators, `*` matches within a segment (not `/`), `?` is a literal
 * (URL globs, unlike shell globs, treat `?` as the query delimiter), and `{a,b}` alternates.
 * A plain (glob-char-free) string is treated as a substring match, matching Playwright's
 * own "contains" fallback for non-glob route URLs.
 */
export function urlMatcher(glob: string): (url: string) => boolean {
  if (!/[*?{}[\]]/.test(glob)) return (url) => url.includes(glob);
  const specials = new Set(['.', '+', '^', '$', '|', '(', ')']);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '\\?';
    else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else if (specials.has(c)) re += `\\${c}`;
    else re += c;
  }
  const compiled = new RegExp(`^${re}$`);
  return (url) => compiled.test(url);
}

/** Settle the page and return the paths of live regions to exclude. */
async function detectVolatile(
  page: Page,
  ignore: string[],
  stabilize: CaptureOptions['stabilize'],
  captureText: boolean,
  externalPending?: () => number,
): Promise<string[]> {
  if (stabilize === false) return [];
  const opt = typeof stabilize === 'object' ? stabilize : {};
  const waitForRequests = opt.waitForRequests ?? true;

  // Prefer the runner's pre-navigation tracker (it counts the page's load fetches);
  // otherwise arm one here as a fallback for requests that fire after this call.
  let pending: () => number = (): number => 0;
  let dispose: () => void = (): void => {};
  if (waitForRequests) {
    if (externalPending) {
      pending = externalPending;
    } else {
      const t = trackInflightRequests(page);
      pending = t.pending;
      dispose = t.dispose;
    }
  }
  try {
    const volatile = await stabilizePage(
      page,
      ignore,
      opt.interval || 150,
      opt.quietFor || 600,
      opt.timeout || 5000,
      captureText,
      pending,
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
  } finally {
    dispose();
  }
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
/**
 * Harvest the surface's navigable inventory when enabled; `[]` otherwise. Kept out
 * of captureStyleMap so that function stays within the complexity budget.
 */
async function harvestInventoryFor(page: Page, enabled: boolean | undefined): Promise<NavigableItem[]> {
  return enabled ? classifyInventory(await page.evaluate(collectNavAffordances)) : [];
}

export async function captureStyleMap(page: Page, options: CaptureOptions = {}): Promise<StyleMap> {
  // Framework/non-visual noise is always skipped, so it can't read as a DOM
  // change; the caller's `ignore` adds to it (not replaces it).
  const ignore = [...FRAMEWORK_IGNORE, ...(options.ignore ?? [])];
  const captureStates = options.captureStates ?? true;
  const maxInteractive = options.maxInteractive ?? 800;
  const stabilize = options.stabilize ?? true;
  const captureText = options.captureText ?? false;
  const captureComponent = options.captureComponent ?? false;
  const viewport = page.viewportSize();
  // Neutralise real hover/focus the same way FREEZE_CSS neutralises motion: park
  // the pointer over an ignored 1px sink and blur whatever element holds focus so
  // every read below is the no-interaction resting state. Real :hover/:focus is
  // nondeterministic across runs (the last Playwright action, autofocus, late
  // hydration, a stray prior action) and contaminates BOTH layers — it bakes an
  // interaction style into the resting map, AND it cancels that forced-state
  // delta (forcing :focus on an already-focused element changes nothing). States
  // are certified deterministically via CDP forcePseudoState below, never via
  // whatever happened to be hovered or focused.
  await page.evaluate(installHoverSink);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  // Inject the structural-path helper once so both capturePage and
  // markInteractiveElements (each serialized into the page by page.evaluate, which
  // can't share a module-scope function) call ONE definition — no duplicated source.
  // It persists on `window` for every evaluate below (no navigation between them).
  await page.evaluate(injectPathOf);
  // Freeze motion BEFORE settling: animating elements would otherwise read as
  // perpetual churn during the settle, and any content that mounts during the
  // settle must be frozen by the time we read it below.
  //
  // FREEZE_CSS only reaches CSS-declared motion. JS-driven animation libraries
  // (framer-motion, react-spring…) write inline styles from rAF loops that no
  // stylesheet can override — but they all honour prefers-reduced-motion, so
  // declare it: an entrance animation caught mid-flight (blur/opacity/transform
  // between two same-commit captures) is exactly the nondeterminism the
  // self-check would otherwise fail on.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const freezeTag = await page.addStyleTag({ content: FREEZE_CSS });

  // Settle: wait for async content to finish painting so base and head capture
  // the same loaded state, and collect any region still changing on its own
  // (a live stream/ticker) to exclude — animations are frozen above, so only
  // real content/layout churn lands here.
  const volatile = await detectVolatile(page, ignore, stabilize, captureText, options.pendingRequests);
  // Detect semantic live-state candidates automatically, but don't exclude them
  // merely for being live regions. Stable status/alert/log UI is product UI and
  // should still be captured; this metadata only improves reports and diagnostics.
  // Honour the caller's `ignore` too: a region the user excluded shouldn't be
  // surfaced (or persisted) as a live candidate, matching every other capture pass.
  const liveCandidates = await page.evaluate(detectLiveCandidates, { ignore });

  // Motion longhands (transition/animation) are read separately so declared
  // motion is verified even though every other value is a frozen end state.
  // Read them on the SETTLED DOM, not before it: capturing pre-settle missed any
  // element that mounts DURING the settle (e.g. a late status glyph), so its
  // declared `animation-duration` was folded back on the run where it happened to
  // mount early but left frozen (0s) on the run where it mounted late — a
  // self-check "non-deterministic" flip. Lift the freeze just for this read (it
  // nulls motion to 0s), then re-apply it before reading everything else.
  await freezeTag.evaluate((el) => (el as HTMLStyleElement).remove());
  const motion = await page.evaluate(capturePage, { ignore, motionOnly: true, captureText: false });
  // Re-apply the freeze for the base + forced-state reads (both must see motion
  // nulled). This tag is KEEP-a-handle: unlike the pre-motion tag above (which was
  // explicitly removed), an un-tracked tag would accumulate on any page reused without
  // a reload — a second capture on the same page (SPA go() that doesn't navigate,
  // multi-surface reuse, the self-check's re-run) would then read this run's frozen
  // motion (`none`/`0s`) as its baseline and report phantom drift. Remove it in a
  // `finally` so throw paths (a settle timeout, a forced-state error) also leave the
  // page clean, not just the happy path.
  const refreezeTag = await page.addStyleTag({ content: FREEZE_CSS });
  try {
    const base = await page.evaluate(capturePage, { ignore, motionOnly: false, captureText, captureComponent });
    dropVolatile(base.elements, volatile);
    const overlays = (await page.evaluate(detectOverlayCandidates, { ignore })).filter(
      (overlay) => base.elements[overlay.path],
    );
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
    const inventory = await harvestInventoryFor(page, options.inventory);
    return {
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(viewport ? { viewport } : {}),
      defaults: base.defaults,
      elements: base.elements,
      states,
      ...(statesSkipped ? { statesSkipped: true } : {}),
      ...(volatile.length ? { volatile } : {}),
      ...(liveCandidates.length ? { liveCandidates } : {}),
      ...(overlays.length ? { overlays } : {}),
      ...(Object.keys(tokens).length ? { tokens } : {}),
      ...(inventory.length ? { inventory } : {}),
    };
  } finally {
    // Best-effort: the page may already be closing on a throw path.
    await refreezeTag.evaluate((el) => (el as HTMLStyleElement).remove()).catch(() => {});
  }
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

/** Every surface map in a capture dir, loaded — the shared reader behind the
 *  per-field extractors below. */
function loadDirMaps(dir: string): StyleMap[] {
  return fs
    .readdirSync(dir)
    .filter(isMapFile)
    .map((f) => loadStyleMap(path.join(dir, f)));
}

/**
 * Read every surface map's navigable inventory from a capture dir, in the shape the
 * inventory audit consumes. One home for "read the inventories out of a dir", shared
 * by the diff CLI and the report (was duplicated in both).
 */
export function readInventories(dir: string): Array<{ inventory?: NavigableItem[] }> {
  return loadDirMaps(dir).map((m) => (m.inventory ? { inventory: m.inventory } : {}));
}

/**
 * Read every surface map's `dataResidue` from a capture dir, in the shape the
 * data-residue audit consumes. Lives here (not in data-residue.ts) so that module
 * stays a pure leaf — it must not import `loadStyleMap` back from this file.
 */
export function readResidue(dir: string): Array<{ dataResidue?: DataResidueEntry[] }> {
  return loadDirMaps(dir).map((m) => (m.dataResidue ? { dataResidue: m.dataResidue } : {}));
}

/**
 * Each captured surface key → the set of element paths it renders, unioned across
 * the given dirs (so an element present on only one side still "belongs" to the
 * surface). Feeds the shared-chrome tier, which needs to know, per surface, which
 * paths exist to tell a frame-wide change from one view's content. Shared by the
 * report and the diff CLI (both already read maps this way).
 */
export function surfaceElementPaths(...dirs: string[]): Map<string, Set<string>> {
  const bySurface = new Map<string, Set<string>>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(isMapFile)) {
      const surface = file.replace(/\.json(\.gz)?$/, '');
      const set = bySurface.get(surface) ?? new Set<string>();
      for (const p of Object.keys(loadStyleMap(path.join(dir, file)).elements)) set.add(p);
      bySurface.set(surface, set);
    }
  }
  return bySurface;
}

/** Capture key from a map filename (`home@1280.json.gz` → `home@1280`). */
export function captureKeyFromMapFile(filename: string): string {
  return filename.replace(/\.json(\.gz)?$/, '');
}

/** Every capture key present as a map file in `dir`. */
export function captureKeysIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isMapFile).map(captureKeyFromMapFile);
}

/** Per capture key, the authoring `metadata.surfaceKey` from that map (if any). */
export function surfaceKeyByCaptureKey(dir: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(isMapFile)) {
    const key = captureKeyFromMapFile(f);
    const map = loadStyleMap(path.join(dir, f));
    out.set(key, map.metadata?.surfaceKey);
  }
  return out;
}

/**
 * Lookup authoring `metadata.surfaceKey` across capture dirs in order (typically
 * `beforeDir`, `afterDir`). For the same capture key, a **later** dir wins when it
 * carries a defined `surfaceKey`; an undefined later entry does not clobber an
 * earlier defined value (head/after authoritative, base/before fallback).
 */
export function mergeSurfaceKeyLookup(...dirs: string[]): (captureKey: string) => string | undefined {
  const merged = new Map<string, string | undefined>();
  for (const dir of dirs) {
    for (const [k, v] of surfaceKeyByCaptureKey(dir)) {
      if (v !== undefined) merged.set(k, v);
      else if (!merged.has(k)) merged.set(k, undefined);
    }
  }
  return (captureKey) => merged.get(captureKey);
}
