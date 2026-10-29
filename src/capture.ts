// Computed-style capture: the browser's final resolved value for every CSS longhand
// on every element, keyed by DOM structure (never class names) so a class rewrite
// stays comparable. Public entry; the machinery lives under src/capture/.
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { classifyInventory, collectNavAffordances, type NavigableItem } from './inventory.js';
import { realNow } from './spec-clock.js';
import { PSEUDO_REFERENCES } from './pseudo-references.js';
import {
  capturePage,
  capturePageChanges,
  capturePageTokens,
  detectLiveCandidates,
  detectOverlayCandidates,
  freezeMotion,
  injectPathOf,
  installHoverSink,
  unfreezeMotion,
  type CaptureArgs,
  type PageCapture,
} from './capture/browser.js';
import { captureForcedStates, resolveForcedStateLimits } from './capture/forced-states.js';
import { alignRectsToFullPageGeometry } from './capture/full-page.js';
import { trackInflightRequests } from './capture/network.js';
import { trackServedRules } from './capture/reach.js';
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
  ForcedStateScope,
  LiveRegionCandidate,
  ProductStateIdentity,
  Rect,
  ServedRule,
  ServedRules,
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
export { trackServedRules, type ServedRuleTracker } from './capture/reach.js';
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
// One rule per pseudo-element: an unsupported one in a selector list voids the whole rule, and an
// animated ::backdrop would mark its dialog volatile. ::first-letter/::first-line stay out: a rule
// matching them makes every block box generate the pseudo-element, which changes what it computes.
const FREEZE_CSS = ['*,*::before,*::after', '::backdrop', '::file-selector-button']
  .map((selector) => `${selector}{animation:none!important;transition:none!important}`)
  .join('');

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

type SettleResult = { volatile: string[]; settled?: PageCapture };

function waitUntilQuietEdge(remaining: number, snapMs: number, interval: number): number {
  if (remaining <= 0) return 0;
  // Spread the remaining window over the fewest polls allowed by the interval.
  const polls = Math.max(1, Math.ceil(remaining / (snapMs + interval)));

  return Math.min(interval, Math.max(0, Math.round(remaining / polls - snapMs)));
}

/**
 * Poll until the map has been UNCHANGED for `quietFor` ms (through the lull before
 * late content paints) or the budget runs out. Returns the paths still changing at
 * timeout: genuine live regions to exclude. Only a quiet exit carries a reusable capture.
 */
async function stabilizePage(
  page: Page,
  args: CaptureArgs,
  { interval, quietFor, timeout }: { interval: number; quietFor: number; timeout: number },
  pending: () => number,
): Promise<SettleResult> {
  // captureText participates so text-only churn (a clock) is excluded like style churn.
  const key = `__spSettle_${randomUUID()}`;
  // Evaluated callbacks cannot see module imports; install capture for subsequent polls.
  const install = (): Promise<void> =>
    page.evaluate(
      `void Object.defineProperty(window, ${JSON.stringify(key)}, { configurable: true, value: { capture: (${capturePage.toString()}) } })`,
    );

  let snapMs = Infinity;

  const snap = async (): Promise<string[] | null> => {
    const startedAt = realNow();
    const changed = await page.evaluate(capturePageChanges, { key, args });
    snapMs = Math.min(snapMs, realNow() - startedAt);

    return changed;
  };

  let quiet = false;
  let volatile: string[] = [];
  let settled: PageCapture | undefined;
  try {
    await install();
    // realNow: under STYLEPROOF_FREEZE_SPEC_CLOCK a frozen Date would never advance these windows.
    const start = realNow();
    await snap();
    let lastChangeAt = start;
    // Per path: when it last changed. Out-of-phase tickers never change in the same poll, so
    // "the last poll's paths" would keep only one of them.
    const lastChangedAt = new Map<string, number>();
    const changedAgain = new Set<string>();
    while (realNow() - start < timeout) {
      await page.waitForTimeout(waitUntilQuietEdge(quietFor - (realNow() - lastChangeAt), snapMs, interval));
      const changed = await snap();
      if (changed === null) {
        // A lost baseline cannot prove changed paths; do not mark an unchanged reload volatile.
        lastChangeAt = realNow();
        await install();
        await snap();
      } else if (changed.length) {
        lastChangeAt = realNow();
        for (const p of changed) {
          if (lastChangedAt.has(p)) changedAgain.add(p);
          lastChangedAt.set(p, lastChangeAt);
        }
      } else if (pending() > 0) {
        // Quiet DOM but data requests in flight: the lull BEFORE the response paints.
        lastChangeAt = realNow();
      } else if (realNow() - lastChangeAt >= quietFor) {
        quiet = true;
        break;
      }
    }

    // Still changing at timeout: changed within the quiet window, or changed again in the last poll
    // that changed (in-flight requests can hold the loop open past a region ticking slower than
    // `quietFor`). Content that loaded late (in any number of steps) and then settled is compared,
    // and so is a path that changed only once, even while a request is still in flight.
    if (!quiet) {
      const end = realNow();

      const lastPoll = Math.max(...lastChangedAt.values());
      volatile = [...lastChangedAt].flatMap(([p, at]) =>
        (at === lastPoll && changedAgain.has(p)) || end - at <= quietFor ? [p] : [],
      );
    }
  } finally {
    // Best-effort cleanup also covers a failed poll or a page that closed mid-settle.
    settled = quiet
      ? await page
          .evaluate((key) => {
            // SAFETY: install() owns this random key and each poll stores a PageCapture there.
            const store = Object.getOwnPropertyDescriptor(window, key)?.value as { last?: PageCapture } | undefined;
            Reflect.deleteProperty(window, key);

            return store?.last;
          }, key)
          .catch(() => undefined)
      : await page
          .evaluate((key) => {
            Reflect.deleteProperty(window, key);

            return undefined;
          }, key)
          .catch(() => undefined);
  }

  return { volatile, settled };
}

/** Settle the page and return live-region paths and, when quiet, the final capture. */
async function detectVolatile(
  page: Page,
  args: CaptureArgs,
  stabilize: CaptureOptions['stabilize'],
  externalPending?: () => number,
): Promise<SettleResult> {
  if (stabilize === false) return { volatile: [] };
  const opt = typeof stabilize === 'object' ? stabilize : {};
  // Prefer the runner's pre-navigation tracker (it saw the page's load fetches).
  const waitForRequests = opt.waitForRequests ?? true;
  const tracker = waitForRequests && !externalPending ? trackInflightRequests(page) : undefined;
  const pending = (waitForRequests && (externalPending ?? tracker?.pending)) || ((): number => 0);
  try {
    const budget = { interval: opt.interval || 150, quietFor: opt.quietFor || 600, timeout: opt.timeout || 5000 };
    const result = await stabilizePage(page, args, budget, pending);
    const { volatile } = result;
    if (volatile.length) {
      warn(
        `styleproof: ${volatile.length} live region(s) kept changing on their own and were excluded from ` +
          'this capture (nondeterministic — a stream, ticker, or late-loading content). The diff skips them so ' +
          'they never read as a change. If a real change is being hidden, settle the page in go() or raise stabilize.timeout.',
      );
    }

    return result;
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
): Promise<Pick<StyleMap, 'states' | 'stateComputedValueStyle'> & { statesSkipped: boolean }> {
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
  const proof = forced.stateComputedValueStyle;
  return { states: forced.states, statesSkipped: forced.skipped, ...(proof ? { stateComputedValueStyle: proof } : {}) };
}

type SettledRead = {
  options: CaptureOptions;
  limits: Required<ForcedStateLimits>;
  ignore: string[];
  skipSel: string;
  args: CaptureArgs;
  settled?: PageCapture;
  volatile: string[];
  liveCandidates: LiveRegionCandidate[];
  motion: PageCapture['elements'];
};

/** Every read after the settle, with motion frozen: base map, overlays, states, tokens, inventory. */
async function readSettledPage(page: Page, read: SettledRead): Promise<StyleMap> {
  const { options, skipSel, volatile } = read;
  await assertRequiredVisibleState(page, options.requiredVisibleState);

  const base =
    (!options.captureComponent && !options.captureReach && read.settled) ||
    (await page.evaluate(capturePage, { ...read.args, captureComponent: options.captureComponent ?? false }));

  for (const p of Object.keys(base.elements)) if (isUnder(p, volatile)) delete base.elements[p];
  // Full-page geometry for report crops and visible-structure gating.
  const screenshotHeight = await alignRectsToFullPageGeometry(page, base.elements);
  const overlays = (await page.evaluate(detectOverlayCandidates, { skipSel })).filter((o) => base.elements[o.path]);
  warnUntraversed(base.shadowHosts, base.sameOriginFrames);
  mergeMotion(base.elements, read.motion);
  const { states, statesSkipped, stateComputedValueStyle } = await captureStateLayer(
    page,
    options,
    read.limits,
    read.ignore,
    volatile,
  );
  const tokens = await page.evaluate(capturePageTokens);
  const inventory: NavigableItem[] = options.inventory
    ? classifyInventory(await page.evaluate(collectNavAffordances))
    : [];
  await assertRequiredVisibleState(page, options.requiredVisibleState);
  const viewport = page.viewportSize();
  return {
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(viewport
      ? {
          viewport: {
            ...viewport,
            ...(base.scrollX || base.scrollY ? { scrollX: base.scrollX, scrollY: base.scrollY } : {}),
            documentHeight: base.documentHeight,
            screenshotHeight,
          },
        }
      : {}),
    defaults: base.defaults,
    elements: base.elements,
    states,
    ...(stateComputedValueStyle ? { stateComputedValueStyle } : {}),
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
  const captureText = options.captureText ?? true;
  // Shared by settle polls and the resting read; components require a separate capture.
  const args = { skipSel, motionOnly: false, captureText, pseudoReferences: PSEUDO_REFERENCES };

  // Resting captures clear ambient interactions; recipe captures keep the state
  // their driver deliberately reached, including CSS-only :hover and :focus.
  const recipeAction =
    options.metadata?.variantKind === 'state-recipe' ? options.metadata.stateRecipe?.action : undefined;

  if (recipeAction !== 'hover') {
    await page.evaluate(installHoverSink);
    await page.mouse.move(0, 0);
  }

  if (recipeAction !== 'focus' && recipeAction !== 'press') {
    // SAFETY: only the optional blur method is used; null and elements without it are skipped.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  }

  await page.evaluate(injectPathOf);
  // Freeze motion BEFORE settling. JS animation libraries honour prefers-reduced-motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(freezeMotion, FREEZE_CSS);

  options.onPhase?.('settle');
  const { volatile, settled } = await detectVolatile(page, args, options.stabilize ?? true, options.pendingRequests);
  options.onPhase?.('capture');
  await assertRequiredVisibleState(page, options.requiredVisibleState);
  // Live-region candidates are diagnostics only: stable status/alert UI is still captured.
  const liveCandidates = await page.evaluate(detectLiveCandidates, { skipSel });

  // Motion longhands are read on the SETTLED DOM with the freeze lifted (an element that
  // mounts during the settle must be seen), then the freeze is re-applied for every other read.
  await page.evaluate(unfreezeMotion, true);
  const motion = (
    await page.evaluate(capturePage, {
      skipSel,
      motionOnly: true,
      captureText: false,
      pseudoReferences: PSEUDO_REFERENCES,
    })
  ).elements;
  // Removed again below so a page reused without a reload (SPA go(), self-check) starts unfrozen.
  await page.evaluate(freezeMotion, FREEZE_CSS);
  // The identical freeze restores the polls' non-motion end state; mergeMotion supplies
  // declared motion separately, so lifting the freeze for that read does not invalidate it.
  // Rule usage starts after the settle, so a rule matched only while the page was still
  // changing is not recorded as reached; starting it records every rule the settled page matches.
  const reach = options.captureReach ? (options.servedRules ?? (await trackServedRules(page))) : undefined;
  try {
    await reach?.start();

    const map = await readSettledPage(page, {
      options,
      limits,
      ignore,
      skipSel,
      args,
      settled,
      volatile,
      liveCandidates,
      motion,
    });
    // Matches outside the compared elements do not count as reached (#993).
    const result = reach ? { ...map, reach: await reach.stop([FREEZE_CSS], Object.keys(map.elements)) } : map;
    // Validate before returning, outside best-effort cleanup: a page can replace its adopted sheets.
    await page.evaluate(unfreezeMotion, true);
    return result;
  } finally {
    // A caller-armed tracker outlives this capture (self-check, popups); one armed here does not.
    if (reach && !options.servedRules) await reach.dispose();
    // Best-effort: the page may already be closing on a throw path.
    await page.evaluate(unfreezeMotion, false).catch(() => {});
  }
}
