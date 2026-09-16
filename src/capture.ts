// Computed-style capture: the browser's final resolved value for every CSS longhand
// on every element, keyed by DOM structure (never class names) so a class rewrite
// stays comparable. Public entry; the machinery lives under src/capture/.
import type { Page } from '@playwright/test';
import { classifyInventory, collectNavAffordances, type NavigableItem } from './inventory.js';
import { realNow } from './spec-clock.js';
import {
  capturePage,
  capturePageTokens,
  detectLiveCandidates,
  detectOverlayCandidates,
  injectPathOf,
  installHoverSink,
  type PageCapture,
} from './capture/browser.js';
import { captureForcedStates, resolveForcedStateLimits } from './capture/forced-states.js';
import { trackInflightRequests } from './capture/network.js';
import { isUnder, skipSelector, warn } from './capture/shared.js';
import type {
  CaptureOptions,
  ElementEntry,
  ForcedStateLimits,
  LiveRegionCandidate,
  ProductStateIdentity,
  StyleMap,
} from './capture/types.js';

export type {
  CaptureMetadata,
  CaptureOptions,
  CapturedOverlay,
  ElementEntry,
  ForcedStateLimits,
  LiveRegionCandidate,
  ProductStateIdentity,
  Rect,
  StateRecipeCaptureProvenance,
  StyleMap,
} from './capture/types.js';
export { isUnder } from './capture/shared.js';
export {
  STATE_LAYER_NAMES,
  captureStateLayerScreenshots,
  captureSurfaceScreenshots,
  resolveForcedStateLimits,
  stateLayerScreenshotPath,
} from './capture/forced-states.js';
export { trackDataResidue, trackInflightRequests } from './capture/network.js';
export { urlMatcher } from './capture/url-glob.js';
export {
  captureKeyFromMapFile,
  captureKeysIn,
  loadStyleMap,
  mergeSurfaceKeyLookup,
  readInventories,
  readResidue,
  saveStyleMap,
  surfaceElementPaths,
  surfaceKeyByCaptureKey,
} from './capture/map-io.js';

export class ProductStateIdentityError extends Error {
  constructor(message: string) {
    super(`styleproof: invalid productState — ${message}`);
    this.name = 'ProductStateIdentityError';
  }
}

const PRODUCT_STATE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Validate and copy consumer-owned semantic identity without echoing hostile values. */
export function validateProductStateIdentity(value: unknown): ProductStateIdentity | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductStateIdentityError('expected an object with id and revision identifiers');
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new ProductStateIdentityError('identity could not be read safely');
  }
  const fields = Reflect.ownKeys(descriptors);
  if (fields.length !== 2 || !fields.includes('id') || !fields.includes('revision')) {
    throw new ProductStateIdentityError('only id and revision are allowed');
  }
  const { id, revision } = descriptors;
  if (!('value' in id) || !('value' in revision)) {
    throw new ProductStateIdentityError('id and revision must be plain values');
  }
  if (
    typeof id.value !== 'string' ||
    typeof revision.value !== 'string' ||
    !PRODUCT_STATE_IDENTIFIER.test(id.value) ||
    !PRODUCT_STATE_IDENTIFIER.test(revision.value)
  ) {
    throw new ProductStateIdentityError(
      'id and revision must be 1–128 character opaque identifiers using letters, numbers, dot, underscore, colon, or hyphen',
    );
  }
  return { id: id.value, revision: revision.value };
}

// Motion is frozen so every captured value is a settled end state.
const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important}';

// Always skipped: non-rendered elements frameworks stream into <body> and reorder, plus
// framework-injected live regions. A real stylesheet change still shows in element styles.
const FRAMEWORK_IGNORE = [
  ...'meta title link script style base noscript template next-route-announcer'.split(' '),
  '[id="__next-route-announcer__"]',
  '[data-styleproof-hover-sink]',
];

async function assertRequiredVisibleState(page: Page, required: CaptureOptions['requiredVisibleState']): Promise<void> {
  if (!required) return;
  const visible = await page
    .locator(required.selector)
    .first()
    .isVisible()
    .catch(() => false);
  if (!visible) {
    throw new Error(`styleproof: state recipe ${required.stateKey} observation phase pre-capture failed`);
  }
}

type Elements = Record<string, ElementEntry>;

function changedElementPaths(a: Elements, b: Elements): string[] {
  const out: string[] = [];
  for (const p of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (JSON.stringify(a[p]) !== JSON.stringify(b[p])) out.push(p);
  return out;
}

/**
 * Poll until the map has been UNCHANGED for `quietFor` ms (through the lull before
 * late content paints) or the budget runs out. Returns the paths still changing at
 * timeout: genuine live regions to exclude.
 */
async function stabilizePage(
  page: Page,
  skipSel: string,
  { interval, quietFor, timeout }: { interval: number; quietFor: number; timeout: number },
  captureText: boolean,
  pending: () => number,
): Promise<string[]> {
  // captureText participates so text-only churn (a clock) is excluded like style churn.
  const snap = async (): Promise<Elements> =>
    (await page.evaluate(capturePage, { skipSel, motionOnly: false, captureText })).elements as Elements;
  // realNow: under STYLEPROOF_FREEZE_SPEC_CLOCK a frozen Date would never advance these windows.
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
      // Quiet DOM but data requests in flight: the lull BEFORE the response paints.
      lastChangeAt = realNow();
    } else if (realNow() - lastChangeAt >= quietFor) {
      return [];
    }
  }
  return recent;
}

/** Settle the page and return the paths of live regions to exclude. */
async function detectVolatile(
  page: Page,
  skipSel: string,
  stabilize: CaptureOptions['stabilize'],
  captureText: boolean,
  externalPending?: () => number,
): Promise<string[]> {
  if (stabilize === false) return [];
  const opt = typeof stabilize === 'object' ? stabilize : {};
  // Prefer the runner's pre-navigation tracker (it saw the page's load fetches).
  const waitForRequests = opt.waitForRequests ?? true;
  const tracker = waitForRequests && !externalPending ? trackInflightRequests(page) : undefined;
  const pending = (waitForRequests && (externalPending ?? tracker?.pending)) || ((): number => 0);
  try {
    const budget = { interval: opt.interval || 150, quietFor: opt.quietFor || 600, timeout: opt.timeout || 5000 };
    const volatile = await stabilizePage(page, skipSel, budget, captureText, pending);
    if (volatile.length) {
      warn(
        `styleproof: ${volatile.length} live region(s) kept changing on their own and were excluded from ` +
          'this capture (nondeterministic — a stream, ticker, or late-loading content). The diff skips them so ' +
          'they never read as a change. If a real change is being hidden, settle the page in go() or raise stabilize.timeout.',
      );
    }
    return volatile;
  } finally {
    tracker?.dispose();
  }
}

function warnUntraversed(shadowHosts: number, sameOriginFrames: number): void {
  if (!shadowHosts && !sameOriginFrames) return;
  warn(
    `styleproof: ${shadowHosts} shadow host(s) and ${sameOriginFrames} same-origin iframe(s) were ` +
      'NOT traversed — styles inside shadow roots and frames are not captured or diffed. A refactor inside ' +
      'one would be reported as identical. See README "Limitations".',
  );
}

/** Fold the pre-freeze motion longhands back onto the settled base capture. */
function mergeMotion(elements: Elements, motion: PageCapture['elements']): void {
  for (const [p, entry] of Object.entries(elements)) {
    const m = motion[p];
    if (!m) continue;
    Object.assign(entry.style, m.style);
    for (const [ps, props] of Object.entries(m.pseudo ?? {})) {
      if (entry.pseudo?.[ps]) Object.assign(entry.pseudo[ps], props);
    }
  }
}

/** The forced-state layer, or `statesSkipped` when disabled or unsupported (CDP is Chromium-only). */
async function captureStateLayer(
  page: Page,
  options: CaptureOptions,
  limits: Required<ForcedStateLimits>,
  ignore: string[],
  volatile: string[],
): Promise<{ states: StyleMap['states']; statesSkipped: boolean }> {
  if (options.captureStates === false) return { states: {}, statesSkipped: true };
  const browserName = page.context().browser()?.browserType().name();
  if (browserName !== 'chromium') {
    warn(
      `styleproof: forced-state capture requires Chromium CDP; ${browserName ?? 'this browser'} is unsupported, ` +
        'so statesSkipped: true was persisted.',
    );
    return { states: {}, statesSkipped: true };
  }
  const forced = await captureForcedStates(page, ignore, options.maxInteractive ?? 800, limits, volatile);
  return { states: forced.states, statesSkipped: forced.skipped };
}

type SettledRead = {
  options: CaptureOptions;
  limits: Required<ForcedStateLimits>;
  ignore: string[];
  skipSel: string;
  volatile: string[];
  liveCandidates: LiveRegionCandidate[];
  motion: PageCapture['elements'];
};

/** Every read after the settle, with motion frozen: base map, overlays, states, tokens, inventory. */
async function readSettledPage(page: Page, read: SettledRead): Promise<StyleMap> {
  const { options, skipSel, volatile } = read;
  await assertRequiredVisibleState(page, options.requiredVisibleState);
  const base = await page.evaluate(capturePage, {
    skipSel,
    motionOnly: false,
    captureText: options.captureText ?? false,
    captureComponent: options.captureComponent ?? false,
  });
  for (const p of Object.keys(base.elements)) if (isUnder(p, volatile)) delete base.elements[p];
  const overlays = (await page.evaluate(detectOverlayCandidates, { skipSel })).filter((o) => base.elements[o.path]);
  warnUntraversed(base.shadowHosts, base.sameOriginFrames);
  mergeMotion(base.elements, read.motion);
  const { states, statesSkipped } = await captureStateLayer(page, options, read.limits, read.ignore, volatile);
  const tokens = await page.evaluate(capturePageTokens);
  const inventory: NavigableItem[] = options.inventory
    ? classifyInventory(await page.evaluate(collectNavAffordances))
    : [];
  await assertRequiredVisibleState(page, options.requiredVisibleState);
  const viewport = page.viewportSize();
  return {
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(viewport ? { viewport } : {}),
    defaults: base.defaults,
    elements: base.elements,
    states,
    ...(statesSkipped ? { statesSkipped: true } : {}),
    ...(volatile.length ? { volatile } : {}),
    ...(read.liveCandidates.length ? { liveCandidates: read.liveCandidates } : {}),
    ...(overlays.length ? { overlays } : {}),
    ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(inventory.length ? { inventory } : {}),
  };
}

/**
 * Capture the page's complete style map. Drive the page to the state first; by default
 * the capture settles it and excludes live regions (see `stabilize`).
 */
export async function captureStyleMap(page: Page, options: CaptureOptions = {}): Promise<StyleMap> {
  const limits = resolveForcedStateLimits(options); // validates before touching the browser
  const ignore = [...FRAMEWORK_IGNORE, ...(options.ignore ?? [])];
  const skipSel = skipSelector(ignore);
  const captureText = options.captureText ?? false;
  // Park the pointer over an ignored sink and blur focus: real :hover/:focus is
  // nondeterministic and would contaminate both the resting map and the forced deltas.
  await page.evaluate(installHoverSink);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.evaluate(injectPathOf);
  // Freeze motion BEFORE settling. JS animation libraries honour prefers-reduced-motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const freezeTag = await page.addStyleTag({ content: FREEZE_CSS });

  options.onPhase?.('settle');
  const volatile = await detectVolatile(page, skipSel, options.stabilize ?? true, captureText, options.pendingRequests);
  options.onPhase?.('capture');
  await assertRequiredVisibleState(page, options.requiredVisibleState);
  // Live-region candidates are diagnostics only: stable status/alert UI is still captured.
  const liveCandidates = await page.evaluate(detectLiveCandidates, { skipSel });

  // Motion longhands are read on the SETTLED DOM with the freeze lifted (an element that
  // mounts during the settle must be seen), then the freeze is re-applied for every other read.
  await freezeTag.evaluate((el) => (el as HTMLStyleElement).remove());
  const motion = (await page.evaluate(capturePage, { skipSel, motionOnly: true, captureText: false })).elements;
  // Tracked so a page reused without a reload (SPA go(), self-check) never accumulates freeze tags.
  const refreezeTag = await page.addStyleTag({ content: FREEZE_CSS });
  try {
    return await readSettledPage(page, { options, limits, ignore, skipSel, volatile, liveCandidates, motion });
  } finally {
    // Best-effort: the page may already be closing on a throw path.
    await refreezeTag.evaluate((el) => (el as HTMLStyleElement).remove()).catch(() => {});
  }
}
