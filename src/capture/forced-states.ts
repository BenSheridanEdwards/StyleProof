// Forced :hover/:focus/:active via CDP: no real mouse or focus is involved, and
// parent-state descendant rules still apply.
import type { CDPSession, Page } from '@playwright/test';
import {
  clearInteractiveMarks,
  clearStateBaseline,
  markInteractiveElements,
  snapSubtree,
  type MarkedInteractive,
  type StateScopeArgs,
  type StateScopeResult,
} from './browser.js';
import { codeLiteral } from '../util.js';
import { isUnder, skipSelector, warn } from './shared.js';
import type { ForcedStateLimits, StyleMap } from './types.js';

const INTERACTIVE = 'a, button, input, textarea, select, summary, [role="button"], [tabindex]';
const STATE_ID_ATTR = 'data-styleproof-state-id';
const STATE_BASELINE_KEY = '__spForcedStateBaseline';
const MAX_FORCED_STATE_ELEMENTS = 2_000;
const MAX_FORCED_STATE_SCAN_WORK = 32_000;

export const STATE_LAYER_NAMES = ['hover', 'focus', 'active'] as const;
const STATE_SETS: Record<(typeof STATE_LAYER_NAMES)[number], string[]> = {
  hover: ['hover'],
  focus: ['focus', 'focus-visible'],
  active: ['active'],
};

/** Resolve a finite caller-owned resource budget before touching the browser. */
export function resolveForcedStateLimits(options: ForcedStateLimits): Required<ForcedStateLimits> {
  // `=== undefined`, not `??`: null must fail validation, not fall back.
  const limits = {
    maxForcedStateElements:
      options.maxForcedStateElements === undefined ? MAX_FORCED_STATE_ELEMENTS : options.maxForcedStateElements,
    maxForcedStateScanWork:
      options.maxForcedStateScanWork === undefined ? MAX_FORCED_STATE_SCAN_WORK : options.maxForcedStateScanWork,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`styleproof: ${name} must be a positive safe integer`);
  }
  return limits;
}

type ForcedStateTarget = { selector: string; nodeId: number };

type ForcedStateSession = {
  client: CDPSession;
  rootNodeId: number;
  /** Targets currently holding a forced pseudo-class (reset on exit). */
  applied: Set<ForcedStateTarget>;
  marked: MarkedInteractive[];
};

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
      for (const target of session.applied) await forcePseudoState(session, target, []);
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

async function snapStateScopeInSession(client: CDPSession, args: StateScopeArgs): Promise<StateScopeResult> {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: `(${snapSubtree.toString()})(${codeLiteral(args)})`,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`styleproof: forced-state snapshot failed: ${exceptionDetails.text}`);
  return (result.value ?? { delta: {}, truncated: true, scanned: 0 }) as StateScopeResult;
}

type ForcedStateCaptureContext = {
  session: ForcedStateSession;
  states: StyleMap['states'];
  baselineKey: string;
  skipSel: string;
  skipPaths: string[];
  incomplete: boolean;
  scanWarningEmitted: boolean;
  scanWorkRemaining: number;
  limits: Required<ForcedStateLimits>;
};

type ForcedStateCaptureFlow = 'continue' | 'next-target' | 'stop-capture';

function warnDetachedForcedStateTarget(id: string, action = 'during forced-state capture'): void {
  warn(`styleproof: interactive element ${id} detached ${action}; skipping it.`);
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
  };
}

async function readScope(context: ForcedStateCaptureContext, args: StateScopeArgs): Promise<StateScopeResult> {
  const read = await snapStateScopeInSession(context.session.client, args);
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
    warnDetachedForcedStateTarget(id);
    return 'next-target';
  }
  if (!(await settleForcedState(session.client, target.selector))) {
    await resetForcedStateTarget(context, target);
    context.incomplete = true;
    warnDetachedForcedStateTarget(id);
    return 'next-target';
  }

  const forced = await readScope(context, scopeArgs(context, target.selector, false));
  await resetForcedStateTarget(context, target);
  if (!(await settleForcedState(session.client, target.selector))) {
    context.incomplete = true;
    warnDetachedForcedStateTarget(id, 'while resetting forced state');
    return 'next-target';
  }
  if (Object.keys(forced.delta).length) (context.states[elementPath] ??= {})[stateName] = forced.delta;
  return 'continue';
}

function warnTruncatedForcedStateScan(context: ForcedStateCaptureContext): void {
  if (context.scanWarningEmitted) return;
  context.scanWarningEmitted = true;
  warn(
    `styleproof: forced-state document scan reached maxForcedStateElements=${context.limits.maxForcedStateElements} ` +
      `or the remaining maxForcedStateScanWork=${context.limits.maxForcedStateScanWork} budget; ` +
      'capture is target-first and truncated, so the forced-state layer is not certified.',
  );
}

async function captureForcedStateTarget(
  context: ForcedStateCaptureContext,
  marked: MarkedInteractive,
): Promise<ForcedStateCaptureFlow> {
  if (budgetExhausted(context)) return 'stop-capture';
  const target = await resolveMarkedTarget(context.session, marked.id);
  if (!target) {
    context.incomplete = true;
    warn(`styleproof: interactive element ${marked.id} is missing or ambiguous; skipping forced-state capture.`);
    return 'next-target';
  }

  const baseline = await readScope(context, scopeArgs(context, target.selector, true));
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
    if (flow === 'stop-capture') return flow;
    if (flow === 'next-target') return baseline.truncated ? 'stop-capture' : flow;
  }
  // A known-incomplete document scope cannot be restored by more targets: stop after this one.
  return baseline.truncated ? 'stop-capture' : 'continue';
}

/** Forced pseudo-class deltas for every interactive element, bounded by `maxInteractive` and `limits`. */
export async function captureForcedStates(
  page: Page,
  ignore: string[],
  maxInteractive: number,
  limits: Required<ForcedStateLimits>,
  skipPaths: string[] = [],
): Promise<{ states: StyleMap['states']; skipped: boolean }> {
  const skipSel = skipSelector(ignore);
  const baselineKey = `${STATE_BASELINE_KEY}-${Math.random().toString(36).slice(2)}`;
  let skipped = true;
  const states = await withForcedStateSession(
    page,
    skipSel,
    async (session) => {
      const marked = session.marked.filter((m) => !(skipPaths.length && isUnder(m.path, skipPaths)));
      const truncated = marked.length > maxInteractive;
      const context: ForcedStateCaptureContext = {
        session,
        states: {},
        baselineKey,
        skipSel,
        skipPaths,
        incomplete: truncated,
        scanWarningEmitted: false,
        scanWorkRemaining: limits.maxForcedStateScanWork,
        limits,
      };
      if (truncated) {
        warn(
          `styleproof: ${marked.length} interactive elements exceeds maxInteractive=${maxInteractive}; ` +
            `forced-state capture truncated to the first ${maxInteractive}. Raise maxInteractive to cover them all.`,
        );
      }
      for (const markedElement of marked.slice(0, maxInteractive)) {
        if ((await captureForcedStateTarget(context, markedElement)) === 'stop-capture') break;
      }
      if (context.scanWorkRemaining === 0 && context.incomplete) {
        warn(
          `styleproof: forced-state aggregate scan exhausted its ${limits.maxForcedStateScanWork}-element work budget; ` +
            'capture stopped and the forced-state layer is not certified.',
        );
      }
      // Any omitted target or element leaves the layer incomplete: fail closed, never read partial as identical.
      skipped = truncated || context.incomplete;
      return context.states;
    },
    () => page.evaluate(clearStateBaseline, baselineKey).catch(() => undefined),
  );
  return { states, skipped };
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
    const targets: ForcedStateTarget[] = [];
    for (const { id } of session.marked.slice(0, options.maxInteractive ?? 800)) {
      const target = await resolveMarkedTarget(session, id);
      if (target) targets.push(target);
    }
    for (const [stateName, forcedPseudoClasses] of Object.entries(STATE_SETS)) {
      for (const target of targets) await forcePseudoState(session, target, forcedPseudoClasses);
      const dest = stateLayerScreenshotPath(stem, stateName);
      await page.screenshot({ path: dest, fullPage: true, animations: 'disabled' });
      written.push(dest);
      for (const target of [...session.applied]) await forcePseudoState(session, target, []);
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
  await page.screenshot({ path: `${stem}.png`, fullPage: true, animations: 'disabled' });
  await captureStateLayerScreenshots(page, stem, options);
}
