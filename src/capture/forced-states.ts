// Forced :hover/:focus/:active via CDP: no real mouse or focus is involved, and
// parent-state descendant rules still apply.
import type { CDPSession, Page } from '@playwright/test';
import {
  analyzeForcedStateScope,
  clearInteractiveMarks,
  clearStateBaseline,
  markInteractiveElements,
  snapSessionBaseline,
  snapSubtree,
  type ForcedStateReadScope,
  type MarkedInteractive,
  type StateScopeArgs,
  type StateScopeResult,
} from './browser.js';
import { codeLiteral } from '../util.js';
import { captureFullPageScreenshot } from './full-page.js';
import { isUnder, skipSelector, warn } from './shared.js';
import type { ForcedStateLimits, ForcedStateScope, Props, StyleMap } from './types.js';

const INTERACTIVE = 'a, button, input, textarea, select, summary, [role="button"], [tabindex]';
const STATE_ID_ATTR = 'data-styleproof-state-id';
const STATE_BASELINE_KEY = '__spForcedStateBaseline';
const MAX_FORCED_STATE_ELEMENTS = 2_000;
const MAX_FORCED_STATE_SCAN_WORK = 32_000;
const FORCED_STATE_SCOPES: readonly ForcedStateScope[] = ['document', 'stylesheet'];

export const STATE_LAYER_NAMES = ['hover', 'focus', 'active'] as const;
const STATE_SETS: Record<(typeof STATE_LAYER_NAMES)[number], string[]> = {
  hover: ['hover'],
  focus: ['focus', 'focus-visible'],
  active: ['active'],
};

/** Resolve a finite caller-owned resource budget (and read scope) before touching the browser. */
export function resolveForcedStateLimits(options: ForcedStateLimits): Required<ForcedStateLimits> {
  // `=== undefined`, not `??`: null must fail validation, not fall back.
  const budget = {
    maxForcedStateElements:
      options.maxForcedStateElements === undefined ? MAX_FORCED_STATE_ELEMENTS : options.maxForcedStateElements,
    maxForcedStateScanWork:
      options.maxForcedStateScanWork === undefined ? MAX_FORCED_STATE_SCAN_WORK : options.maxForcedStateScanWork,
  };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`styleproof: ${name} must be a positive safe integer`);
  }
  const forcedStateScope = options.forcedStateScope === undefined ? 'document' : options.forcedStateScope;
  if (!FORCED_STATE_SCOPES.includes(forcedStateScope))
    throw new TypeError(`styleproof: forcedStateScope must be 'document' or 'stylesheet'`);
  return { ...budget, forcedStateScope };
}

type ForcedStateTarget = { selector: string; nodeId: number };

type ForcedStateSession = {
  client: CDPSession;
  rootNodeId: number;
  /** Targets currently holding a forced pseudo-class (reset on exit). */
  applied: Set<ForcedStateTarget>;
  marked: MarkedInteractive[];
};

/** Drain a failed phase so pending commands finish before cleanup. */
async function stateBatch<T>(pending: Promise<T>[]): Promise<T[]> {
  try {
    return await Promise.all(pending);
  } catch (error) {
    await Promise.allSettled(pending);
    throw error;
  }
}

/** Open a CDP session, mark the interactive elements, run `work`, then undo every forced state and mark. */
async function withForcedStateSession<T>(
  page: Page,
  skipSel: string,
  work: (session: ForcedStateSession) => Promise<T>,
  cleanup?: () => Promise<void>,
): Promise<T> {
  const client = await page.context().newCDPSession(page);
  const session: ForcedStateSession = { client, rootNodeId: 0, applied: new Set(), marked: [] };
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    session.rootNodeId = (await client.send('DOM.getDocument')).root.nodeId;
    session.marked = await page.evaluate(markInteractiveElements, {
      selector: INTERACTIVE,
      skipSel,
      attr: STATE_ID_ATTR,
    });
    return await work(session);
  } finally {
    try {
      await stateBatch([...session.applied].map((target) => forcePseudoState(session, target, [])));
    } finally {
      await cleanup?.();
      await page.evaluate(clearInteractiveMarks, STATE_ID_ATTR).catch(() => undefined);
      await client.detach().catch(() => undefined);
    }
  }
}

async function queryTarget(session: ForcedStateSession, selector: string): Promise<ForcedStateTarget | undefined> {
  const { nodeIds } = await session.client.send('DOM.querySelectorAll', { nodeId: session.rootNodeId, selector });
  return nodeIds.length === 1 ? { selector, nodeId: nodeIds[0] } : undefined;
}

const resolveMarkedTarget = (session: ForcedStateSession, id: string): Promise<ForcedStateTarget | undefined> =>
  queryTarget(session, `[${STATE_ID_ATTR}="${id}"]`);

function isStaleForcedStateNodeError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.includes('CSS.forcePseudoState')) return false;
  return [
    'Could not find node with given id',
    'No node with given id found',
    'Node is detached from document',
    'Node with given id does not belong to the document',
  ].some((message) => error.message.includes(message));
}

/** Force (or reset, with `[]`) one target, retrying once only when its CDP node went stale. */
async function forcePseudoState(
  session: ForcedStateSession,
  target: ForcedStateTarget,
  forcedPseudoClasses: string[],
): Promise<boolean> {
  const send = (): Promise<unknown> =>
    session.client.send('CSS.forcePseudoState', { nodeId: target.nodeId, forcedPseudoClasses });
  let ok = false;
  try {
    await send();
    ok = true;
  } catch (error) {
    if (!isStaleForcedStateNodeError(error)) throw error;
    const fresh = await queryTarget(session, target.selector);
    if (fresh) {
      target.nodeId = fresh.nodeId;
      ok = await send().then(
        () => true,
        (retryError: unknown) => {
          if (isStaleForcedStateNodeError(retryError)) return false;
          throw retryError;
        },
      );
    }
  }
  if (ok) {
    if (forcedPseudoClasses.length) session.applied.add(target);
    else session.applied.delete(target);
  }
  return ok;
}

async function settleForcedState(client: CDPSession, selector: string): Promise<boolean> {
  const { result } = await client.send('Runtime.evaluate', {
    expression: `(() => { const element = document.querySelector(${codeLiteral(selector)}); if (!element) return false; getComputedStyle(element).display; return true; })()`,
    returnByValue: true,
  });
  return result.value === true;
}

type SessionScopeResult = StateScopeResult & { targetMissing?: true };

async function snapStateScopeInSession(
  client: CDPSession,
  args: StateScopeArgs,
  snapshotKey: string,
): Promise<SessionScopeResult> {
  const snapshot = `window[${codeLiteral(snapshotKey)}](${codeLiteral(args)})`;
  // Keep force -> liveness -> style flush -> snapshot on the same CDP session.
  // The pre-read barrier shares this evaluation; post-reset barriers stay separate.
  const expression = args.saveBaseline
    ? snapshot
    : `(() => {
        const element = document.querySelector(${codeLiteral(args.selector)});
        if (!element) return { delta: {}, truncated: false, scanned: 0, targetMissing: true };
        getComputedStyle(element).display;
        return ${snapshot};
      })()`;
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`styleproof: forced-state snapshot failed: ${exceptionDetails.text}`);
  return (result.value ?? { delta: {}, truncated: true, scanned: 0 }) as SessionScopeResult;
}

type ForcedStateCaptureContext = {
  session: ForcedStateSession;
  states: StyleMap['states'];
  /** Typed OM margin proof per owner/state; dropped (undefined) once any read lacked Typed OM. */
  stateComputedValueStyle: StyleMap['stateComputedValueStyle'];
  baselineKey: string;
  snapshotKey: string;
  skipSel: string;
  skipPaths: string[];
  incomplete: boolean;
  scanWarningEmitted: boolean;
  scanWorkRemaining: number;
  limits: Required<ForcedStateLimits>;
  /** Elements each read compares; `'document'` unless `forcedStateScope: 'stylesheet'` proved a narrower one. */
  readScope: ForcedStateReadScope;
  sharedBaseline: boolean;
  warnings: string[];
};

type ForcedStateCaptureFlow = 'continue' | 'next-target' | 'stop-capture';

function warnDetachedForcedStateTarget(
  context: ForcedStateCaptureContext,
  id: string,
  action = 'during forced-state capture',
): void {
  context.warnings.push(`styleproof: interactive element ${id} detached ${action}; skipping it.`);
}

async function resetForcedStateTarget(context: ForcedStateCaptureContext, target: ForcedStateTarget): Promise<void> {
  if (!(await forcePseudoState(context.session, target, []))) context.incomplete = true;
}

/** A scope read sized to the remaining work budget. */
function scopeArgs(context: ForcedStateCaptureContext, selector: string, saveBaseline: boolean): StateScopeArgs {
  return {
    selector,
    skipSel: context.skipSel,
    skipPaths: context.skipPaths,
    maxElements: Math.min(context.limits.maxForcedStateElements, context.scanWorkRemaining),
    baselineKey: context.baselineKey,
    saveBaseline,
    scope: context.readScope,
  };
}

async function readScope(context: ForcedStateCaptureContext, args: StateScopeArgs): Promise<SessionScopeResult> {
  const read = await snapStateScopeInSession(context.session.client, args, context.snapshotKey);
  context.scanWorkRemaining -= read.scanned;
  context.incomplete ||= read.truncated;
  return read;
}

function budgetExhausted(context: ForcedStateCaptureContext): boolean {
  if (context.scanWorkRemaining !== 0) return false;
  context.incomplete = true;
  return true;
}

async function captureForcedStateVariation(
  context: ForcedStateCaptureContext,
  target: ForcedStateTarget,
  id: string,
  elementPath: string,
  stateName: string,
  forcedPseudoClasses: string[],
): Promise<ForcedStateCaptureFlow> {
  if (budgetExhausted(context)) return 'stop-capture';
  const { session } = context;
  if (!(await forcePseudoState(session, target, forcedPseudoClasses))) {
    context.incomplete = true;
    warnDetachedForcedStateTarget(context, id);
    return 'next-target';
  }
  const forced = await readScope(context, scopeArgs(context, target.selector, false));
  if (forced.targetMissing) {
    await resetForcedStateTarget(context, target);
    context.incomplete = true;
    warnDetachedForcedStateTarget(context, id);
    return 'next-target';
  }

  // CDP replaces the forced set. The next read flushes styles for that set;
  // only the last variation needs to restore and settle the resting state.
  if (stateName === 'active') {
    await resetForcedStateTarget(context, target);

    if (!(await settleForcedState(session.client, target.selector))) {
      context.incomplete = true;
      warnDetachedForcedStateTarget(context, id, 'while resetting forced state');

      return 'next-target';
    }
  }
  if (Object.keys(forced.delta).length) (context.states[elementPath] ??= {})[stateName] = forced.delta;
  recordStateComputedValueStyle(context, elementPath, stateName, forced.typedMargins);
  return 'continue';
}

/** Keep a read's Typed OM margin proof, or drop the whole field when this read had none. */
function recordStateComputedValueStyle(
  context: ForcedStateCaptureContext,
  elementPath: string,
  stateName: string,
  typedMargins: Record<string, Props> | undefined,
): void {
  if (!context.stateComputedValueStyle) return;
  if (!typedMargins) {
    context.stateComputedValueStyle = undefined;
    return;
  }
  if (Object.keys(typedMargins).length) (context.stateComputedValueStyle[elementPath] ??= {})[stateName] = typedMargins;
}

function warnTruncatedForcedStateScan(context: ForcedStateCaptureContext): void {
  if (context.scanWarningEmitted) return;
  context.scanWarningEmitted = true;
  context.warnings.push(
    `styleproof: forced-state document scan reached maxForcedStateElements=${context.limits.maxForcedStateElements} ` +
      `or the remaining maxForcedStateScanWork=${context.limits.maxForcedStateScanWork} budget; ` +
      'capture is target-first and truncated, so the forced-state layer is not certified.',
  );
}

async function captureForcedStateTarget(
  context: ForcedStateCaptureContext,
  marked: MarkedInteractive,
  target: ForcedStateTarget | undefined,
): Promise<ForcedStateCaptureFlow> {
  if (budgetExhausted(context)) return 'stop-capture';
  if (!target) {
    context.incomplete = true;
    context.warnings.push(
      `styleproof: interactive element ${marked.id} is missing or ambiguous; skipping forced-state capture.`,
    );
    return 'next-target';
  }

  const baseline = await readScope(context, {
    ...scopeArgs(context, target.selector, true),
    countOnly: context.sharedBaseline,
  });
  if (baseline.truncated) warnTruncatedForcedStateScan(context);
  if (budgetExhausted(context)) return 'stop-capture';

  for (const [stateName, forcedPseudoClasses] of Object.entries(STATE_SETS)) {
    const flow = await captureForcedStateVariation(
      context,
      target,
      marked.id,
      marked.path,
      stateName,
      forcedPseudoClasses,
    );

    if (flow !== 'continue') {
      // A budget stop or stale node may interrupt the sweep before active.
      if (context.session.applied.has(target)) {
        await resetForcedStateTarget(context, target);
        await settleForcedState(context.session.client, target.selector);
      }

      return baseline.truncated ? 'stop-capture' : flow;
    }
  }
  // A known-incomplete document scope cannot be restored by more targets: stop after this one.
  return baseline.truncated ? 'stop-capture' : 'continue';
}

/**
 * Save/check a document baseline in-page, outside the logical per-target budget.
 * The final comparison cannot detect resting styles that change and then revert.
 */
async function sessionBaseline(
  context: ForcedStateCaptureContext,
  targets: MarkedInteractive[],
  check = false,
): Promise<boolean> {
  const args: StateScopeArgs = {
    ...scopeArgs(context, targets.map(({ id }) => `[${STATE_ID_ATTR}="${id}"]`).join(','), true),
    maxElements: context.limits.maxForcedStateScanWork,
  };
  const { result, exceptionDetails } = await context.session.client.send('Runtime.evaluate', {
    expression: `(${snapSessionBaseline.toString()})(${codeLiteral(args)}, ${context.limits.maxForcedStateElements}, ${check}, window[${codeLiteral(context.snapshotKey)}])`,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`styleproof: forced-state snapshot failed: ${exceptionDetails.text}`);
  return result.value === true;
}

/**
 * The read scope for this session. `'stylesheet'` asks the page which elements its state
 * selectors can reach; anything it cannot bound falls back to whole-document reads (warned).
 */
async function resolveReadScope(page: Page, limits: Required<ForcedStateLimits>): Promise<ForcedStateReadScope> {
  if (limits.forcedStateScope !== 'stylesheet') return 'document';
  const analysis = await page.evaluate(analyzeForcedStateScope);
  if (analysis.scope === 'document')
    warn(
      `styleproof: forcedStateScope 'stylesheet' fell back to whole-document forced-state reads: ${analysis.reason}.`,
    );
  return analysis.scope;
}

/** Forced pseudo-class deltas for every interactive element, bounded by `maxInteractive` and `limits`. */
export async function captureForcedStates(
  page: Page,
  ignore: string[],
  maxInteractive: number,
  limits: Required<ForcedStateLimits>,
  skipPaths: string[] = [],
): Promise<{
  states: StyleMap['states'];
  skipped: boolean;
  stateComputedValueStyle?: StyleMap['stateComputedValueStyle'];
}> {
  const skipSel = skipSelector(ignore);
  const baselineKey = `${STATE_BASELINE_KEY}-${Math.random().toString(36).slice(2)}`;
  const snapshotKey = `${baselineKey}-snapshot`;
  let skipped = true;
  const { states, stateComputedValueStyle } = await withForcedStateSession(
    page,
    skipSel,
    async (session) => {
      const { exceptionDetails } = await session.client.send('Runtime.evaluate', {
        expression: `window[${codeLiteral(snapshotKey)}] = ${snapSubtree.toString()}; void 0;`,
      });

      if (exceptionDetails) throw new Error(`styleproof: forced-state snapshot failed: ${exceptionDetails.text}`);
      const marked = session.marked.filter((m) => !(skipPaths.length && isUnder(m.path, skipPaths)));
      const truncated = marked.length > maxInteractive;
      const context: ForcedStateCaptureContext = {
        session,
        states: {},
        stateComputedValueStyle: {},
        baselineKey,
        snapshotKey,
        skipSel,
        skipPaths,
        incomplete: truncated,
        scanWarningEmitted: false,
        scanWorkRemaining: limits.maxForcedStateScanWork,
        limits,
        readScope: await resolveReadScope(page, limits),
        sharedBaseline: false,
        warnings: [],
      };
      if (truncated) {
        warn(
          `styleproof: ${marked.length} interactive elements exceeds maxInteractive=${maxInteractive}; ` +
            `forced-state capture truncated to the first ${maxInteractive}. Raise maxInteractive to cover them all.`,
        );
      }
      const targets = marked.slice(0, maxInteractive);
      // Only document reads (including stylesheet fallback) share a baseline.
      // Mixed Typed OM support must retain the legacy per-scope availability rule.
      context.sharedBaseline =
        context.readScope === 'document' && targets.length > 0 && (await sessionBaseline(context, targets));
      const captureTargets = async (): Promise<void> => {
        const resolved = await stateBatch(targets.map(({ id }) => resolveMarkedTarget(session, id)));

        for (const [index, markedElement] of targets.entries()) {
          if ((await captureForcedStateTarget(context, markedElement, resolved[index])) === 'stop-capture') break;
        }
      };
      try {
        await captureTargets();
        if (context.sharedBaseline && !(await sessionBaseline(context, targets, true))) {
          // Discard all tentative output and warnings; retry the entire session once using
          // the original per-target baselines, with the original budget and target order.
          Object.assign(context, {
            sharedBaseline: false,
            states: {},
            stateComputedValueStyle: {},
            warnings: [],
            incomplete: truncated,
            scanWarningEmitted: false,
            scanWorkRemaining: limits.maxForcedStateScanWork,
          });
          for (const target of [...session.applied]) {
            await resetForcedStateTarget(context, target);
            await settleForcedState(session.client, target.selector);
          }
          await captureTargets();
        }
      } finally {
        for (const message of context.warnings) warn(message);
      }
      if (context.scanWorkRemaining === 0 && context.incomplete) {
        warn(
          `styleproof: forced-state aggregate scan exhausted its ${limits.maxForcedStateScanWork}-element work budget; ` +
            'capture stopped and the forced-state layer is not certified.',
        );
      }
      // Any omitted target or element leaves the layer incomplete: fail closed, never read partial as identical.
      skipped = truncated || context.incomplete;
      // A skipped layer proves nothing, so its margin proof is never persisted.
      const proof = skipped ? undefined : context.stateComputedValueStyle;
      return { states: context.states, stateComputedValueStyle: proof };
    },
    async () => {
      await page.evaluate(clearStateBaseline, baselineKey).catch(() => undefined);
      await page.evaluate(clearStateBaseline, snapshotKey).catch(() => undefined);
    },
  );
  return { states, skipped, ...(stateComputedValueStyle ? { stateComputedValueStyle } : {}) };
}

/** `<stem>.hover.png` — the full-page shot with every interactive node forced. */
export function stateLayerScreenshotPath(stem: string, state: string): string {
  return `${stem}.${state}.png`;
}

/** One full-page screenshot per forced state (hover, focus, active) next to the rest shot. */
export async function captureStateLayerScreenshots(
  page: Page,
  stem: string,
  options: { ignore?: string[]; maxInteractive?: number } = {},
): Promise<string[]> {
  const written: string[] = [];
  await withForcedStateSession(page, skipSelector(options.ignore ?? []), async (session) => {
    const targets = (
      await stateBatch(
        session.marked.slice(0, options.maxInteractive ?? 800).map(({ id }) => resolveMarkedTarget(session, id)),
      )
    ).filter((target) => target !== undefined);
    for (const [stateName, forcedPseudoClasses] of Object.entries(STATE_SETS)) {
      await stateBatch(targets.map((target) => forcePseudoState(session, target, forcedPseudoClasses)));
      const dest = stateLayerScreenshotPath(stem, stateName);
      await captureFullPageScreenshot(page, dest);
      written.push(dest);
      await stateBatch([...session.applied].map((target) => forcePseudoState(session, target, [])));
    }
  });
  return written;
}

/** Rest screenshot plus the three forced-state layers. */
export async function captureSurfaceScreenshots(
  page: Page,
  stem: string,
  options: { ignore?: string[]; maxInteractive?: number } = {},
): Promise<void> {
  await captureFullPageScreenshot(page, `${stem}.png`);
  await captureStateLayerScreenshots(page, stem, options);
}
