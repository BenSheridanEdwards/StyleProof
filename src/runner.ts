import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  captureStyleMap,
  saveStyleMap,
  trackInflightRequests,
  type CaptureMetadata,
  type LiveRegionCandidate,
} from './capture.js';
import { diffStyleMaps, type Finding } from './diff.js';
import { coverageGaps } from './coverage.js';
import { detectViewportWidths } from './breakpoints.js';
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
  /**
   * Viewport widths to sweep — one per @media band, so breakpoint rules are verified
   * too. OMIT to detect the app's real breakpoints from the loaded CSSOM and sweep one
   * width per band automatically (no config); detection fails loudly if a stylesheet
   * is cross-origin/unreadable rather than guess. Set it explicitly to pin the sweep
   * or to cover a JS-only (`matchMedia`) breakpoint that has no CSS `@media` rule.
   */
  widths?: number[];
  /** Viewport height: a number, or a function of the width (default 800). */
  height?: number | ((width: number) => number);
  /**
   * Optional deterministic states of this same surface. Each variant becomes its
   * own capture (`<surface>-<variant>@<width>`), so base/head compare loading to
   * loading and loaded to loaded instead of treating live UI as one fuzzy state.
   */
  variants?: SurfaceVariant[];
  /**
   * First-class live product states for this surface. Use this for loading,
   * loaded, empty, error, streaming, etc. StyleProof records them as live-state
   * variants so reports and diagnostics can explain why the capture was split.
   */
  liveStates?: SurfaceLiveState[];
  /**
   * Opt in to automatically opening visible click-triggered popups after the base
   * surface is captured. Captures persistent dialogs, popovers, menus, listboxes,
   * tooltips, and open data-state overlays as `<surface>-popup-XX`.
   */
  popups?: boolean | PopupCaptureOptions;
};

export type SurfaceVariant = {
  /** Capture key suffix, joined as `<surface.key>-<variant.key>`. */
  key: string;
  /**
   * Seed the state before the parent surface navigates: route mocks, fixture data,
   * localStorage/sessionStorage, feature flags, etc.
   */
  setup?: (page: Page) => Promise<void>;
  /** Drive or assert the variant after the parent surface reaches its base state. */
  go?: (page: Page) => Promise<void>;
  /** Extra ignored selectors for this variant, appended to the parent surface's ignore list. */
  ignore?: string[];
  /** Override the parent viewport widths for this variant. */
  widths?: number[];
  /** Override the parent viewport height for this variant. */
  height?: number | ((width: number) => number);
};

export type SurfaceLiveState = SurfaceVariant;

export type PopupCaptureOptions = {
  /** Enable/disable popup discovery for this surface or capture run. */
  enabled?: boolean;
  /** Max visible trigger controls to try per surface/width (default 20). */
  max?: number;
  /** CSS selector for visible controls to click. */
  triggers?: string;
  /** CSS selector for visible popup/overlay roots that mean a click opened state. */
  overlays?: string;
  /** Max ms to wait for a clicked control to reveal an overlay (default 750). */
  timeoutMs?: number;
};

export type DefineOptions = {
  surfaces: Surface[];
  /**
   * The full set of surface keys the app knows it has — its route/view/state
   * universe, typically derived from registries (e.g. routes plus modal/menu
   * flows). Include expanded variant keys such as `dashboard-dialog-open` when
   * those states must be certified.
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
  /**
   * Opt-in automatic popup/modal capture for every surface. Existing suites keep
   * their exact capture set unless this is enabled.
   */
  popups?: boolean | PopupCaptureOptions;
  /**
   * Opt-in inventory guard (default OFF). Harvest each surface's navigable
   * affordances — route links, `role=tab`/`menuitem`, button-only nav — into
   * `StyleMap.inventory`, so `styleproof-diff` fails when a nav item / route the UI
   * used to offer disappears (acknowledge intentional removals in
   * `styleproof.inventory.json`). Additive; ignored by the certification style diff.
   * See `docs/inventory-guard.md`.
   */
  inventory?: boolean;
};

/** Resolved per-capture settings, shared with the helpers below. */
type Settings = Required<Omit<DefineOptions, 'surfaces' | 'replayFrom' | 'expected' | 'exclude' | 'popups'>> & {
  dir: string;
  replayFrom?: string;
  popups: ResolvedPopupCaptureOptions;
};

/** One-line description of the first drift finding, for the self-check error. */
function driftDesc(f: Finding): string {
  if (f.kind === 'dom') return `${f.path} ${f.change}`;
  const p = f.props[0];
  return p ? `${f.path} ${p.prop}: ${p.before} → ${p.after}` : f.path;
}

const ROOT_LAYOUT_PATHS = new Set(['html', 'body']);
const ROOT_LAYOUT_PROPS = new Set([
  'block-size',
  'height',
  'inline-size',
  'width',
  'min-block-size',
  'min-height',
  'max-block-size',
  'max-height',
  'perspective-origin',
  'transform-origin',
]);

function hasRootLayoutDrift(drift: Finding[]): boolean {
  return drift.some(
    (f) => f.kind === 'style' && ROOT_LAYOUT_PATHS.has(f.path) && f.props.some((p) => ROOT_LAYOUT_PROPS.has(p.prop)),
  );
}

function liveCandidateDesc(candidate: LiveRegionCandidate): string {
  const label = candidate.cls ? `${candidate.tag}.${candidate.cls.split(/\s+/)[0]}` : candidate.tag;
  return `${label} (${candidate.reason}) at ${candidate.path}`;
}

export function selfCheckErrorMessage(
  surfaceKey: string,
  drift: Finding[],
  volatile: string[] = [],
  liveCandidates: LiveRegionCandidate[] = [],
): string {
  const first = drift[0];
  let message =
    `styleproof self-check failed: ${surfaceKey} is non-deterministic — ` +
    `${drift.length} computed-style difference(s) between two captures of the same commit. ` +
    `Likely a replay gap (a request not in the baseline HAR) or unseeded randomness.`;
  if (volatile.length && hasRootLayoutDrift(drift)) {
    message +=
      ` Volatile regions were detected in this capture; root/body layout drift usually means live content ` +
      `is still changing document flow. Model those live states with \`liveStates\` instead ` +
      `of only ignoring the region.`;
    if (liveCandidates.length) {
      message += ` Auto-detected live-state candidate(s): ${liveCandidates
        .slice(0, 3)
        .map(liveCandidateDesc)
        .join('; ')}.`;
    }
  }
  return first ? `${message} First: ${driftDesc(first)}` : message;
}

function mergeIgnore(...groups: Array<string[] | undefined>): string[] | undefined {
  const merged = [...new Set(groups.flatMap((g) => g ?? []))];
  return merged.length ? merged : undefined;
}

const POPUP_TRIGGER_ATTR = 'data-styleproof-popup-trigger';
const DEFAULT_POPUP_TRIGGERS = [
  'button:not([disabled]):not([type="submit"]):not([type="reset"])',
  '[role="button"]:not([aria-disabled="true"])',
  '[aria-haspopup]',
  '[popovertarget]',
  'summary',
  'a[href^="#"]',
].join(', ');
const DEFAULT_POPUP_OVERLAYS = [
  'dialog[open]',
  '[popover]',
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[data-hot-toast]',
  '[data-sonner-toast]',
  '[data-toast]',
  '.hot-toast',
  '[class*="toast" i]',
  '[role="alert"]',
  '[role="status"]',
  '[data-state="open"]:not(button):not(a):not(summary)',
].join(', ');

type ResolvedPopupCaptureOptions = Required<PopupCaptureOptions>;
type PopupCandidate = { index: number };
type PopupDomSnapshot = { keys: string[]; indexes: number[] };

export function resolvePopupCaptureOptions(
  input: boolean | PopupCaptureOptions | undefined,
): ResolvedPopupCaptureOptions {
  if (input === false || input === undefined) {
    return {
      enabled: false,
      max: 20,
      triggers: DEFAULT_POPUP_TRIGGERS,
      overlays: DEFAULT_POPUP_OVERLAYS,
      timeoutMs: 750,
    };
  }
  const options = input === true ? {} : input;
  return {
    enabled: options.enabled ?? true,
    max: Math.max(0, Math.floor(options.max ?? 20)),
    triggers: options.triggers ?? DEFAULT_POPUP_TRIGGERS,
    overlays: options.overlays ?? DEFAULT_POPUP_OVERLAYS,
    timeoutMs: Math.max(0, Math.floor(options.timeoutMs ?? 750)),
  };
}

async function popupDomSnapshot(
  page: Page,
  options: {
    popupSelector: string;
    triggerSelector?: string;
    attr?: string;
    max?: number;
  },
): Promise<PopupDomSnapshot> {
  return page.evaluate(({ popupSelector, triggerSelector, attr, max = 0 }) => {
    const qsa = (sel: string): Element[] => {
      try {
        return [...document.querySelectorAll(sel)];
      } catch {
        return [];
      }
    };
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const pathOf = (el: Element): string => {
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur !== document.documentElement) {
        const parent = cur.parentElement;
        const tag = cur.tagName.toLowerCase();
        const id = cur.id ? `#${cur.id}` : '';
        const role = cur.getAttribute('role');
        const sameTag = parent ? [...parent.children].filter((child) => child.tagName === cur!.tagName) : [cur];
        const nth = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(cur) + 1})` : '';
        parts.unshift(`${tag}${id}${role ? `[role="${role}"]` : ''}${nth}`);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const popupKey = (el: Element): string => {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return [
        pathOf(el),
        el.getAttribute('role') ?? '',
        el.getAttribute('aria-modal') ?? '',
        el.getAttribute('aria-live') ?? '',
        el.getAttribute('data-state') ?? '',
        el.getAttribute('data-hot-toast') ?? '',
        el.getAttribute('data-sonner-toast') ?? '',
        el.getAttribute('data-toast') ?? '',
        text,
      ].join('|');
    };
    const popups = qsa(popupSelector).filter(visible);
    const keys = popups.map(popupKey);
    if (!triggerSelector || !attr) return { keys, indexes: [] };

    const safeTrigger = (el: Element): boolean => {
      const tag = el.tagName.toLowerCase();
      if (el.matches(':disabled, [aria-disabled="true"]')) return false;
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return false;
      if (tag === 'a') return (el as HTMLAnchorElement).getAttribute('href')?.startsWith('#') ?? false;
      return true;
    };

    for (const el of qsa(`[${attr}]`)) el.removeAttribute(attr);
    const candidates = qsa(triggerSelector).filter(
      (el) => visible(el) && !popups.some((popup) => popup !== el && popup.contains(el)) && safeTrigger(el),
    );
    candidates.slice(0, max).forEach((el, index) => el.setAttribute(attr, String(index)));
    return { keys, indexes: candidates.slice(0, max).map((_, index) => index) };
  }, options);
}

async function visiblePopupKeys(page: Page, selector: string): Promise<string[]> {
  return (await popupDomSnapshot(page, { popupSelector: selector })).keys;
}

async function markPopupCandidates(page: Page, options: ResolvedPopupCaptureOptions): Promise<PopupCandidate[]> {
  const snapshot = await popupDomSnapshot(page, {
    triggerSelector: options.triggers,
    popupSelector: options.overlays,
    attr: POPUP_TRIGGER_ATTR,
    max: options.max,
  });
  return snapshot.indexes.map((index) => ({ index }));
}

type ExpandedSurface = Omit<Surface, 'variants' | 'liveStates'> & { metadata?: CaptureMetadata };

function expandOne(
  surface: Surface,
  variant: SurfaceVariant,
  variantKind: CaptureMetadata['variantKind'],
): ExpandedSurface {
  return {
    key: `${surface.key}-${variant.key}`,
    go: async (page) => {
      await variant.setup?.(page);
      await surface.go(page);
      await variant.go?.(page);
    },
    ignore: mergeIgnore(surface.ignore, variant.ignore),
    widths: variant.widths ?? surface.widths,
    height: variant.height ?? surface.height,
    popups: surface.popups,
    metadata: { surfaceKey: surface.key, variantKey: variant.key, variantKind },
  };
}

export function expandSurfaceVariants(surface: Surface): ExpandedSurface[] {
  const variants = surface.variants ?? [];
  const liveStates = surface.liveStates ?? [];
  const { variants: _variants, liveStates: _liveStates, ...base } = surface;
  const baseSurface = { ...base, metadata: { surfaceKey: surface.key } };
  void _variants;
  void _liveStates;
  if (!variants.length && !liveStates.length) {
    return [baseSurface];
  }
  const expandedVariants = variants.map((variant) => expandOne(surface, variant, 'variant'));
  if (!liveStates.length) return [baseSurface, ...expandedVariants];

  return [...expandedVariants, ...liveStates.map((state) => expandOne(surface, state, 'live-state'))];
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
  surface: ExpandedSurface,
  first: Awaited<ReturnType<typeof captureStyleMap>>,
  captureText: boolean,
  pending: () => number,
): Promise<void> {
  await surface.go(page);
  const again = await captureStyleMap(page, { ignore: surface.ignore ?? [], captureText, pendingRequests: pending });
  const drift = diffStyleMaps(first, again);
  if (drift.length) {
    const liveCandidates = [...(first.liveCandidates ?? []), ...(again.liveCandidates ?? [])];
    throw new Error(
      selfCheckErrorMessage(
        surface.key,
        drift,
        [...new Set([...(first.volatile ?? []), ...(again.volatile ?? [])])],
        liveCandidates,
      ),
    );
  }
}

async function openPopupCandidate(
  page: Page,
  surface: ExpandedSurface,
  width: number,
  height: number,
  options: ResolvedPopupCaptureOptions,
  candidate: PopupCandidate,
): Promise<string | undefined> {
  await page.setViewportSize({ width, height });
  await page.keyboard.press('Escape').catch(() => {});
  await surface.go(page);
  const before = new Set(await visiblePopupKeys(page, options.overlays));
  const candidates = await markPopupCandidates(page, options);
  if (!candidates.some((c) => c.index === candidate.index)) return undefined;

  await page
    .locator(`[${POPUP_TRIGGER_ATTR}="${candidate.index}"]`)
    .first()
    .click({ timeout: Math.max(500, options.timeoutMs), noWaitAfter: true })
    .catch(() => undefined);

  const deadline = Date.now() + options.timeoutMs;
  do {
    const opened = (await visiblePopupKeys(page, options.overlays)).find((key) => !before.has(key));
    if (opened) return opened;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  return undefined;
}

function popupMetadata(surface: ExpandedSurface, popupId: string): CaptureMetadata {
  return {
    surfaceKey: surface.metadata?.surfaceKey ?? surface.key,
    variantKey: surface.metadata?.variantKey ? `${surface.metadata.variantKey}/${popupId}` : popupId,
    variantKind: 'popup',
  };
}

async function captureOpenedPopupMap(
  page: Page,
  surface: ExpandedSurface,
  s: Settings,
  pending: () => number,
  popupId: string,
): Promise<Awaited<ReturnType<typeof captureStyleMap>>> {
  return captureStyleMap(page, {
    ignore: surface.ignore ?? [],
    captureText: s.captureText,
    captureComponent: s.captureComponent,
    pendingRequests: pending,
    metadata: popupMetadata(surface, popupId),
  });
}

async function assertPopupDeterministic(
  page: Page,
  surface: ExpandedSurface,
  width: number,
  height: number,
  options: ResolvedPopupCaptureOptions,
  candidate: PopupCandidate,
  popupId: string,
  first: Awaited<ReturnType<typeof captureStyleMap>>,
  s: Settings,
  pending: () => number,
): Promise<void> {
  const againKey = await openPopupCandidate(page, surface, width, height, options, candidate);
  if (!againKey) throw new Error(`styleproof self-check failed: ${surface.key}-${popupId} popup did not reopen`);
  const again = await captureOpenedPopupMap(page, surface, s, pending, popupId);
  const drift = diffStyleMaps(first, again);
  if (drift.length) {
    throw new Error(selfCheckErrorMessage(`${surface.key}-${popupId}`, drift, first.volatile, first.liveCandidates));
  }
}

async function capturePopupCandidate(
  page: Page,
  surface: ExpandedSurface,
  width: number,
  height: number,
  s: Settings,
  options: ResolvedPopupCaptureOptions,
  candidate: PopupCandidate,
): Promise<void> {
  const requests = trackInflightRequests(page);
  try {
    const popupKey = await openPopupCandidate(page, surface, width, height, options, candidate);
    if (!popupKey) return;

    const popupId = `popup-${String(candidate.index + 1).padStart(2, '0')}`;
    const map = await captureOpenedPopupMap(page, surface, s, requests.pending, popupId);
    if (s.selfCheck)
      await assertPopupDeterministic(
        page,
        surface,
        width,
        height,
        options,
        candidate,
        popupId,
        map,
        s,
        requests.pending,
      );

    const stem = path.join(s.baseDir, s.dir, `${surface.key}-${popupId}@${width}`);
    saveStyleMap(`${stem}.json.gz`, map);
    if (s.screenshots) await page.screenshot({ path: `${stem}.png`, fullPage: true, animations: 'disabled' });
  } finally {
    requests.dispose();
  }
}

async function capturePopupSurfaces(
  page: Page,
  surface: ExpandedSurface,
  width: number,
  height: number,
  s: Settings,
): Promise<void> {
  const options = resolvePopupCaptureOptions(surface.popups ?? s.popups);
  if (!options.enabled || options.max === 0) return;

  await surface.go(page);
  const candidates = await markPopupCandidates(page, options);
  for (const candidate of candidates) {
    await capturePopupCandidate(page, surface, width, height, s, options, candidate);
  }
}

/** Drive one surface at one width to a settled state and save its style map (+ screenshot).
 *  The caller owns the test timeout (one-per-test for explicit surfaces, one budget for
 *  the whole crawl) so a multi-surface crawl can't reset its own deadline mid-loop. */
async function captureSurface(page: Page, surface: ExpandedSurface, width: number, s: Settings): Promise<void> {
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
      inventory: s.inventory,
      pendingRequests: requests.pending,
      metadata: surface.metadata,
    });
    if (s.selfCheck) await assertDeterministic(page, surface, map, s.captureText, requests.pending);

    const stem = path.join(s.baseDir, s.dir, `${surface.key}@${width}`);
    saveStyleMap(`${stem}.json.gz`, map);
    if (s.screenshots) {
      // captureStyleMap froze animations/transitions, so this is the same settled
      // state the map describes.
      await page.screenshot({ path: `${stem}.png`, fullPage: true, animations: 'disabled' });
    }
    await capturePopupSurfaces(page, surface, width, height, s);
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
 * default. Lets CLIs and CI redirect capture into cache/fallback dirs without
 * editing the spec — same env-wiring philosophy as `STYLEPROOF_REPLAY_*`.
 */
export function resolveBaseDir(
  baseDir: string | undefined,
  env: string | undefined = process.env.STYLEPROOF_BASEDIR,
): string {
  return baseDir ?? env ?? '__stylemaps__';
}

/**
 * Whether to save full-page screenshots: explicit `screenshots` wins, else
 * `STYLEPROOF_SCREENSHOTS=0` turns them off. On by default so restored map bundles
 * can generate reviewable reports without recapturing.
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
    popups: resolvePopupCaptureOptions(c.popups),
    inventory: c.inventory ?? false,
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
  const captureSurfaces = surfaces.flatMap(expandSurfaceVariants);

  // Coverage guard. Runs in the NORMAL test suite (NOT gated on a capture dir), so
  // a route added without a surface fails the app's own tests — long before, and
  // independent of, a capture run. This is the one gap captures can't catch: a
  // surface never taken can't be diffed. Only emitted when the spec declares its
  // `expected` universe; otherwise StyleProof keeps its prior behaviour exactly.
  if (expected) {
    test.describe('styleproof coverage', () => {
      test('every expected surface is captured or explicitly excluded', () => {
        const { uncovered, staleExclusions } = coverageGaps(
          captureSurfaces.map((s) => s.key),
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
    for (const surface of captureSurfaces) {
      if (surface.widths && surface.widths.length > 0) {
        // Explicit widths: one parallelizable test per surface × width.
        for (const width of surface.widths) {
          test(`${surface.key} @ ${width}`, ({ page }) => {
            test.setTimeout(180_000);
            return captureSurface(page, surface, width, settings);
          });
        }
      } else {
        // Auto widths: the band set isn't known until the page renders its CSS, so a
        // single test loads once, detects the breakpoints, then sweeps each band.
        test(`${surface.key} @ auto`, async ({ page }) => {
          await surface.go(page);
          const widths = await detectViewportWidths(page);
          test.setTimeout(Math.max(180_000, widths.length * 60_000));
          for (const width of widths) await captureSurface(page, surface, width, settings);
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
  /** Viewport widths swept for every discovered surface. Omit to auto-detect each
   *  surface's @media breakpoints (one viewport per band) — the same zero-config
   *  behaviour as an explicit surface with no `widths`. */
  widths?: number[];
  /** Viewport height per width (default 800). */
  height?: number | ((width: number) => number);
  /** Run after navigating to each discovered link, before capture — e.g. to trigger
   *  scroll-reveal content. The built-in font/animation/network settle always runs;
   *  this is the app-specific hook, the crawl's parity with a hand-listed surface's `go`. */
  settle?: (page: Page) => Promise<void>;
  /** Selectors skipped on every surface (live regions, third-party embeds). */
  ignore?: string[];
  /** Deterministic variants captured for every discovered link surface. */
  variants?: SurfaceVariant[];
  /** First-class live product states captured for every discovered link surface. */
  liveStates?: SurfaceLiveState[];
  /** Opt-in automatic popup/modal capture for every discovered link surface. */
  popups?: boolean | PopupCaptureOptions;
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
  const {
    from,
    match,
    key,
    widths,
    height,
    ignore,
    variants,
    liveStates,
    popups,
    linkTimeout = 15_000,
    dir,
    settle,
  } = options;
  const settings = resolveSettings(options);

  // Title contains "styleproof capture" so the same `--grep 'styleproof capture'`
  // that styleproof-map uses to select capture tests picks up crawl specs too.
  test.describe('styleproof capture (crawl)', () => {
    test.skip(!dir, 'set STYLEMAP_DIR=<label> to capture computed-style maps');
    test('discover surfaces by crawling links, then capture each', async ({ page }) => {
      // 1. Load the root and wait for its nav links to hydrate — an SPA renders them
      //    client-side, so they aren't in the initial HTML.
      await page.goto(from, { waitUntil: 'load' });
      // Wait for the nav's links to hydrate (an SPA renders them client-side). A link-less
      // page is fine for an unfiltered crawl — it still captures `from` itself (includeSelf);
      // a `match`-filtered crawl genuinely needs links, so let its timeout surface.
      await page.waitForSelector('a[href]', { timeout: linkTimeout }).catch((e) => {
        if (match !== undefined) throw e;
      });
      const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href')));
      // Unfiltered crawl → also capture `from` itself, so the root is always covered and
      // a single-page (or no-nav-self-link) app still yields a surface. A `match`-filtered
      // crawl captures only the links the caller asked for.
      const links = selectCrawlLinks(hrefs, { base: page.url(), match, key, includeSelf: match === undefined });
      if (links.length === 0) {
        throw new Error(
          `styleproof crawl: no links matched at ${from}. The nav must render same-origin ` +
            `<a href> links (a button-only nav exposes nothing to crawl), and \`match\` must keep them.`,
        );
      }
      const captureSurfaces = links.flatMap((link) =>
        expandSurfaceVariants({
          key: link.key,
          go: async (p) => {
            await p.goto(link.url, { waitUntil: 'load' });
            if (settle) await settle(p);
          },
          widths,
          ignore,
          height,
          variants,
          liveStates,
          popups,
        }),
      );
      // Budget the whole sweep up front: one test captures every surface, and
      // captureSurface no longer sets its own timeout, so size it to the work found.
      // With auto-width the band count isn't known until each surface renders, so
      // assume up to 4 bands per surface.
      test.setTimeout(
        Math.max(180_000, captureSurfaces.reduce((sum, surface) => sum + (surface.widths?.length ?? 4), 0) * 60_000),
      );

      // 2. Capture each discovered surface. Aggregate failures so one bad surface
      //    reports without skipping the rest — they're an independent set, not a chain.
      const failures: string[] = [];
      for (const surface of captureSurfaces) {
        // Auto-width parity with explicit surfaces: no widths given → navigate once and
        // detect this surface's @media bands, then sweep one viewport per band.
        let sweep = surface.widths;
        if (!sweep || sweep.length === 0) {
          try {
            await surface.go(page);
            sweep = await detectViewportWidths(page);
          } catch (e) {
            failures.push(`${surface.key} @ auto: ${(e as Error).message}`);
            continue;
          }
        }
        for (const width of sweep) {
          try {
            await captureSurface(page, surface, width, settings);
          } catch (e) {
            failures.push(`${surface.key} @ ${width}: ${(e as Error).message}`);
          }
        }
      }
      if (failures.length) {
        throw new Error(`styleproof crawl-capture: ${failures.length} surface(s) failed:\n${failures.join('\n')}`);
      }
    });
  });
}
