// Forced interactive and form pseudo-classes via CDP: no real mouse or focus is involved, and
// parent-state descendant rules still apply.
import { captureExpression } from './script-evaluation.js';
import type { CDPSession, Page } from '@playwright/test';
import filesystem from 'node:fs';
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

export const LEGACY_STATE_LAYER_NAMES = ['hover', 'focus', 'active'] as const;
export const FORM_STATE_LAYER_NAMES = ['checked', 'disabled', 'placeholder-shown'] as const;
export const STATE_LAYER_NAMES = [...LEGACY_STATE_LAYER_NAMES, ...FORM_STATE_LAYER_NAMES] as const;
const STATE_SETS: Record<(typeof STATE_LAYER_NAMES)[number], string[]> = {
  hover: ['hover'],
  focus: ['focus', 'focus-visible'],
  active: ['active'],
  checked: ['checked'],
  disabled: ['disabled'],
  'placeholder-shown': ['placeholder-shown'],
};

/** Resolve a finite caller-owned resource budget (and read scope) before touching the browser. */
export function resolveForcedStateLimits(options: ForcedStateLimits): Required<ForcedStateLimits> {
  // `=== undefined`, not `??`: null must fail validation, not fall back.
  const budget = {
    maxForcedStateElements:
      options.maxForcedStateElements === undefined ? MAX_FORCED_STATE_ELEMENTS : options.maxForcedStateElements,
    maxForcedStateScanWork:
      options.maxForcedStateScanWork === undefined ? MAX_FORCED_STATE_SCAN_WORK : options.maxForcedStateScanWork,
    maxFormStateScanWork:
      options.maxFormStateScanWork === undefined ? MAX_FORCED_STATE_SCAN_WORK : options.maxFormStateScanWork,
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
    expression: captureExpression(
      `(() => { const element = document.querySelector(${codeLiteral(selector)}); if (!element) return false; getComputedStyle(element).display; return true; })()`,
    ),
    returnByValue: true,
  });
  return result.value === true;
}

type SessionScopeResult = StateScopeResult & { targetMissing?: true; settled?: boolean };

async function snapStateScopeInSession(
  client: CDPSession,
  args: StateScopeArgs,
  snapshotKey: string,
  settleSelector?: string,
): Promise<SessionScopeResult> {
  const snapshot = `window[${codeLiteral(snapshotKey)}](${codeLiteral(args)})`;
  // Keep force -> liveness -> style flush -> snapshot on the same CDP session.
  // Also settle the preceding target's reset before reading this target.

  const expression = `(() => {
        const s = ${settleSelector ? `document.querySelector(${codeLiteral(settleSelector)})` : 'null'};
        const settled = !!s && (getComputedStyle(s).display, true);
        const element = document.querySelector(${codeLiteral(args.selector)});
        if (!element) return { delta: {}, truncated: false, scanned: 0, targetMissing: true, settled };
        getComputedStyle(element).display;
        return { ...${snapshot}, settled };
      })()`;
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: captureExpression(expression),
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`styleproof: forced-state snapshot failed: ${exceptionDetails.text}`);
  return (result.value ?? { delta: {}, truncated: true, scanned: 0 }) as SessionScopeResult;
}

type PendingSettle = {
  stateName: string;
  selector: string;
  id: string;
  elementPath: string;
  delta: Record<string, Props>;
  typedMargins?: Record<string, Props>;
  warningIndex: number;
};

type ForcedStateCaptureContext = {
  session: ForcedStateSession;
  states: StyleMap['states'];
  stateLayerOmissions?: StyleMap['stateLayerOmissions'];
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
  restingCounts?: number[];
  warnings: string[];
  pendingSettle?: PendingSettle;
};

type ForcedStateCaptureFlow = 'continue' | 'next-target' | 'stop-capture';

function detachedForcedStateTargetWarning(id: string, action = 'during forced-state capture'): string {
  return `styleproof: interactive element ${id} detached ${action}; skipping it.`;
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
  const pending = context.pendingSettle;
  context.pendingSettle = undefined;
  const read = await snapStateScopeInSession(context.session.client, args, context.snapshotKey, pending?.selector);

  if (pending) commitSettle(context, pending, read.settled === true);
  context.scanWorkRemaining -= read.scanned;
  context.incomplete ||= read.truncated;
  return read;
}

function commitSettle(context: ForcedStateCaptureContext, pending: PendingSettle, ok: boolean): void {
  if (!ok) {
    context.incomplete = true;
    context.warnings.splice(
      pending.warningIndex,
      0,
      detachedForcedStateTargetWarning(pending.id, 'while resetting forced state'),
    );

    return;
  }

  if (Object.keys(pending.delta).length)
    (context.states[pending.elementPath] ??= {})[pending.stateName] = pending.delta;
  recordStateComputedValueStyle(context, pending.elementPath, pending.stateName, pending.typedMargins);
}

async function flushPendingSettle(context: ForcedStateCaptureContext): Promise<void> {
  const pending = context.pendingSettle;

  if (!pending) return;
  context.pendingSettle = undefined;
  commitSettle(context, pending, await settleForcedState(context.session.client, pending.selector));
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
  finalVariation = stateName === 'active',
): Promise<ForcedStateCaptureFlow> {
  if (budgetExhausted(context)) return 'stop-capture';
  const { session } = context;
  if (!(await forcePseudoState(session, target, forcedPseudoClasses))) {
    context.incomplete = true;
    context.warnings.push(detachedForcedStateTargetWarning(id));
    return 'next-target';
  }
  const forced = await readScope(context, scopeArgs(context, target.selector, false));
  if (forced.targetMissing) {
    await resetForcedStateTarget(context, target);
    context.incomplete = true;
    context.warnings.push(detachedForcedStateTargetWarning(id));
    return 'next-target';
  }

  // CDP replaces the forced set. The next read flushes styles for that set;
  // only the last variation needs to restore and settle the resting state.
  // With stabilize:false, live transitions can carry hover values into focus.
  if (finalVariation) {
    await resetForcedStateTarget(context, target);
    context.pendingSettle = {
      stateName,
      selector: target.selector,
      id,
      elementPath,
      delta: forced.delta,
      typedMargins: forced.typedMargins,
      warningIndex: context.warnings.length,
    };

    return 'continue';
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

async function readRestingBaseline(
  context: ForcedStateCaptureContext,
  target: ForcedStateTarget,
  resting?: number,
): Promise<SessionScopeResult> {
  if (resting !== undefined) {
    const scanned = Math.min(resting, context.scanWorkRemaining);
    const truncated = scanned < resting;
    context.scanWorkRemaining -= scanned;
    context.incomplete ||= truncated;

    return { delta: {}, truncated, scanned };
  }

  return readScope(context, {
    ...scopeArgs(context, target.selector, true),
    countOnly: context.sharedBaseline,
  });
}

async function captureForcedStateTarget(
  context: ForcedStateCaptureContext,
  marked: MarkedInteractive,
  target: ForcedStateTarget | undefined,
  resting?: number,
): Promise<ForcedStateCaptureFlow> {
  if (budgetExhausted(context)) return 'stop-capture';
  if (!target) {
    context.incomplete = true;
    context.warnings.push(
      `styleproof: interactive element ${marked.id} is missing or ambiguous; skipping forced-state capture.`,
    );
    return 'next-target';
  }

  const baseline = await readRestingBaseline(context, target, resting);

  if (baseline.targetMissing) {
    context.incomplete = true;
    context.warnings.push(detachedForcedStateTargetWarning(marked.id));

    return 'next-target';
  }
  if (baseline.truncated) warnTruncatedForcedStateScan(context);
  if (budgetExhausted(context)) return 'stop-capture';

  for (const stateName of LEGACY_STATE_LAYER_NAMES) {
    const forcedPseudoClasses = STATE_SETS[stateName];
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

async function captureFormStateTarget(
  context: ForcedStateCaptureContext,
  marked: MarkedInteractive,
  target: ForcedStateTarget | undefined,
  resting?: number,
): Promise<void> {
  const layers = marked.formStateLayers ?? [];

  if (!layers.length || budgetExhausted(context)) return;
  if (!target) {
    context.incomplete = true;
    context.warnings.push(detachedForcedStateTargetWarning(marked.id, 'during form-state capture'));
    return;
  }

  const baseline = await readRestingBaseline(context, target, resting);

  if (baseline.targetMissing)
    context.warnings.push(detachedForcedStateTargetWarning(marked.id, 'during form-state capture'));
  if (baseline.targetMissing || baseline.truncated) {
    context.incomplete = true;
    return;
  }

  for (const [index, stateName] of layers.entries()) {
    const flow = await captureForcedStateVariation(
      context,
      target,
      marked.id,
      marked.path,
      stateName,
      STATE_SETS[stateName],
      index === layers.length - 1,
    );

    if (flow !== 'continue') break;
  }
}

/** A form layer is atomic: partial deltas and their Typed OM proof must be discarded together. */
function discardFormStateLayer(context: ForcedStateCaptureContext, stateName: string): void {
  for (const variations of Object.values(context.states)) delete variations[stateName];
  for (const variations of Object.values(context.stateComputedValueStyle ?? {})) delete variations[stateName];
}

function omitFormStateLayers(
  context: ForcedStateCaptureContext,
  reason: 'form-scan-work' | 'shared-baseline-unavailable',
): string[] {
  context.stateLayerOmissions = Object.fromEntries(FORM_STATE_LAYER_NAMES.map((stateName) => [stateName, reason]));
  return [...LEGACY_STATE_LAYER_NAMES];
}

/** At most two form variations plus one baseline per control, with an independent allowance. */
async function captureFormStateLayers(
  context: ForcedStateCaptureContext,
  targets: MarkedInteractive[],
  resolved: Array<ForcedStateTarget | undefined>,
  formReadScope: ForcedStateReadScope,
): Promise<string[]> {
  if (context.incomplete) return [...LEGACY_STATE_LAYER_NAMES];
  if (!targets.some((target) => target.formStateLayers?.length)) return [...STATE_LAYER_NAMES];

  const formContext: ForcedStateCaptureContext = {
    ...context,
    stateComputedValueStyle: {},
    incomplete: false,
    pendingSettle: undefined,
    scanWorkRemaining: context.limits.maxFormStateScanWork,
    readScope: formReadScope,
    sharedBaseline: context.sharedBaseline && formReadScope === context.readScope,
    restingCounts: formReadScope === context.readScope ? context.restingCounts : undefined,
  };

  if (!formContext.sharedBaseline) {
    const shared = await sessionBaseline(formContext, targets, false, true);
    formContext.sharedBaseline = shared !== false;
    formContext.restingCounts = Array.isArray(shared) ? shared : undefined;
  }

  if (!formContext.sharedBaseline) {
    context.warnings.push(
      'styleproof: no shared resting baseline for form-state reads; the form sweep was skipped. ' +
        'Raise maxFormStateScanWork or maxForcedStateElements to cover this scope.',
    );
    return omitFormStateLayers(context, 'shared-baseline-unavailable');
  }

  for (const [index, marked] of targets.entries()) {
    if (formContext.incomplete) break;
    await captureFormStateTarget(formContext, marked, resolved[index], formContext.restingCounts?.[index]);
  }

  return finishFormStateLayers(context, formContext, targets);
}

async function resetFormStateTargets(formContext: ForcedStateCaptureContext): Promise<void> {
  for (const target of [...formContext.session.applied]) {
    await resetForcedStateTarget(formContext, target);

    if (!(await settleForcedState(formContext.session.client, target.selector))) {
      formContext.incomplete = true;
      formContext.warnings.push(
        `styleproof: forced-state target ${target.selector} detached while resetting form state.`,
      );
    }
  }
}

function mergeFormStateProof(context: ForcedStateCaptureContext, formContext: ForcedStateCaptureContext): void {
  if (!context.stateComputedValueStyle || !formContext.stateComputedValueStyle) return;
  for (const [owner, variations] of Object.entries(formContext.stateComputedValueStyle))
    Object.assign((context.stateComputedValueStyle[owner] ??= {}), variations);
}

async function finishFormStateLayers(
  context: ForcedStateCaptureContext,
  formContext: ForcedStateCaptureContext,
  targets: MarkedInteractive[],
): Promise<string[]> {
  await flushPendingSettle(formContext);
  await resetFormStateTargets(formContext);

  const checked = formContext.sharedBaseline ? await sessionBaseline(formContext, targets, true, true) : false;

  const drifted =
    formContext.sharedBaseline &&
    checked !== true &&
    JSON.stringify(checked) !== JSON.stringify(formContext.restingCounts);

  if (drifted)
    formContext.warnings.push(
      'styleproof: resting styles changed after form-state capture; all form layers are not compared.',
    );
  if (!formContext.incomplete && !drifted) {
    mergeFormStateProof(context, formContext);
    return [...STATE_LAYER_NAMES];
  }

  for (const stateName of FORM_STATE_LAYER_NAMES) discardFormStateLayer(formContext, stateName);

  if (formContext.scanWorkRemaining === 0)
    context.warnings.push(
      `styleproof: form-state scan exhausted maxFormStateScanWork=${context.limits.maxFormStateScanWork}; ` +
        'all form layers are not compared. Raise maxFormStateScanWork to capture them.',
    );
  else if (!drifted)
    context.warnings.push('styleproof: form-state capture was incomplete; all form layers are not compared.');

  return formContext.scanWorkRemaining === 0 && !drifted
    ? omitFormStateLayers(context, 'form-scan-work')
    : [...LEGACY_STATE_LAYER_NAMES];
}

function formStateTargets(targets: MarkedInteractive[]): NonNullable<StyleMap['stateTargets']> {
  return Object.fromEntries(
    FORM_STATE_LAYER_NAMES.map((stateName) => [
      stateName,
      targets.filter((target) => target.formStateLayers?.includes(stateName)).map((target) => target.path),
    ]),
  );
}

/**
 * Save/check a scope baseline in-page, outside the logical per-target budget.
 * The final comparison cannot detect resting styles that change and then revert.
 */
async function sessionBaseline(
  context: ForcedStateCaptureContext,
  targets: MarkedInteractive[],
  check = false,
  formSweep = false,
): Promise<boolean | number[]> {
  const args: StateScopeArgs = {
    ...scopeArgs(context, targets.map(({ id }) => `[${STATE_ID_ATTR}="${id}"]`).join(','), true),
    maxElements: formSweep ? context.limits.maxFormStateScanWork : context.limits.maxForcedStateScanWork,
  };
  const { result, exceptionDetails } = await context.session.client.send('Runtime.evaluate', {
    expression: captureExpression(
      `(${snapSessionBaseline.toString()})(${codeLiteral(args)}, ${context.limits.maxForcedStateElements}, ${check}, window[${codeLiteral(context.snapshotKey)}], ${formSweep})`,
    ),
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`styleproof: forced-state snapshot failed: ${exceptionDetails.text}`);

  return result.value;
}

/**
 * The read scope for this session. `'stylesheet'` asks the page which elements its state
 * selectors can reach; anything it cannot bound falls back to whole-document reads (warned).
 */
async function resolveReadScope(
  page: Page,
  limits: Required<ForcedStateLimits>,
  includeFormStates = true,
): Promise<{ legacy: ForcedStateReadScope; form: ForcedStateReadScope }> {
  if (limits.forcedStateScope !== 'stylesheet') return { legacy: 'document', form: 'document' };
  const analysis = await page.evaluate(analyzeForcedStateScope, includeFormStates);
  const readKind = analysis.legacy && analysis.legacy.scope !== 'document' ? 'form-state' : 'forced-state';
  if (analysis.scope === 'document')
    warn(
      `styleproof: forcedStateScope 'stylesheet' fell back to whole-document ${readKind} reads: ${analysis.reason}.`,
    );

  return { legacy: analysis.legacy?.scope ?? analysis.scope, form: analysis.scope };
}

function warnForcedStateCapture(context: ForcedStateCaptureContext): void {
  for (const message of context.warnings) warn(message);

  if (context.scanWorkRemaining === 0 && context.incomplete)
    warn(
      `styleproof: forced-state aggregate scan exhausted its ${context.limits.maxForcedStateScanWork}-element work budget; capture stopped and the forced-state layer is not certified.`,
    );
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
  stateLayers: string[];
  stateLayerOmissions?: StyleMap['stateLayerOmissions'];
  stateTargets: NonNullable<StyleMap['stateTargets']>;
  skipped: boolean;
  stateComputedValueStyle?: StyleMap['stateComputedValueStyle'];
}> {
  const skipSel = skipSelector(ignore);
  const baselineKey = `${STATE_BASELINE_KEY}-${Math.random().toString(36).slice(2)}`;
  const snapshotKey = `${baselineKey}-snapshot`;
  let skipped = true;

  const captured = await withForcedStateSession(
    page,
    skipSel,
    async (session) => {
      const { exceptionDetails } = await session.client.send('Runtime.evaluate', {
        expression: captureExpression(`window[${codeLiteral(snapshotKey)}] = ${snapSubtree.toString()}; void 0;`),
      });

      if (exceptionDetails) throw new Error(`styleproof: forced-state snapshot failed: ${exceptionDetails.text}`);
      const marked = session.marked.filter((m) => !(skipPaths.length && isUnder(m.path, skipPaths)));
      const truncated = marked.length > maxInteractive;
      const readScopes = await resolveReadScope(page, limits);
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
        readScope: readScopes.legacy,
        sharedBaseline: false,
        warnings: [],
        pendingSettle: undefined,
      };
      if (truncated) {
        warn(
          `styleproof: ${marked.length} interactive elements exceeds maxInteractive=${maxInteractive}; ` +
            `forced-state capture truncated to the first ${maxInteractive}. Raise maxInteractive to cover them all.`,
        );
      }
      const targets = marked.slice(0, maxInteractive);

      // Mixed Typed OM support must retain the legacy per-scope availability rule.
      const shared =
        context.readScope !== 'parent' && targets.length > 0 ? await sessionBaseline(context, targets) : false;

      context.sharedBaseline = shared !== false;
      context.restingCounts = Array.isArray(shared) ? shared : undefined;

      // Resolve once; stale-node recovery remains in forcePseudoState.
      const resolved = await stateBatch(targets.map(({ id }) => resolveMarkedTarget(session, id)));
      const captureTargets = async (): Promise<void> => {
        for (const [index, markedElement] of targets.entries()) {
          if (
            (await captureForcedStateTarget(
              context,
              markedElement,
              resolved[index],
              context.restingCounts?.[index],
            )) === 'stop-capture'
          )
            break;
        }

        await flushPendingSettle(context);
      };
      try {
        await captureTargets();
        const checked = context.sharedBaseline ? await sessionBaseline(context, targets, true) : true;

        if (checked !== true && JSON.stringify(checked) !== JSON.stringify(context.restingCounts)) {
          // Discard all tentative output and warnings; retry the entire session once using
          // the original per-target baselines, with the original budget and target order.
          Object.assign(context, {
            sharedBaseline: false,
            restingCounts: undefined,
            states: {},
            stateComputedValueStyle: {},
            warnings: [],
            incomplete: truncated,
            scanWarningEmitted: false,
            scanWorkRemaining: limits.maxForcedStateScanWork,
            pendingSettle: undefined,
          });
          for (const target of [...session.applied]) {
            await resetForcedStateTarget(context, target);
            await settleForcedState(session.client, target.selector);
          }
          await captureTargets();
        }

        skipped = truncated || context.incomplete;

        const stateComputedValueStyle = skipped ? undefined : context.stateComputedValueStyle;
        const stateLayers = await captureFormStateLayers(context, targets, resolved, readScopes.form);
        const stateTargets = formStateTargets(targets);
        return {
          states: context.states,
          stateLayers,
          ...(context.stateLayerOmissions ? { stateLayerOmissions: context.stateLayerOmissions } : {}),
          stateTargets,
          stateComputedValueStyle,
        };
      } finally {
        warnForcedStateCapture(context);
      }
    },
    async () => {
      await page.evaluate(clearStateBaseline, baselineKey).catch(() => undefined);
      await page.evaluate(clearStateBaseline, snapshotKey).catch(() => undefined);
    },
  );

  const { states, stateLayers, stateLayerOmissions, stateTargets, stateComputedValueStyle } = captured;

  return {
    states,
    stateLayers,
    ...(stateLayerOmissions ? { stateLayerOmissions } : {}),
    stateTargets,
    skipped,
    ...(stateComputedValueStyle ? { stateComputedValueStyle } : {}),
  };
}

/** `<stem>.hover.png` — the full-page shot with every interactive node forced. */
export function stateLayerScreenshotPath(stem: string, state: string): string {
  return `${stem}.${state}.png`;
}

/** One full-page screenshot per applicable forced state next to the rest shot. */
export async function captureStateLayerScreenshots(
  page: Page,
  stem: string,
  options: { ignore?: string[]; maxInteractive?: number } = {},
): Promise<string[]> {
  const written: string[] = [];
  await withForcedStateSession(page, skipSelector(options.ignore ?? []), async (session) => {
    const targets = await stateBatch(
      session.marked.slice(0, options.maxInteractive ?? 800).map(({ id }) => resolveMarkedTarget(session, id)),
    );
    for (const [stateName, forcedPseudoClasses] of Object.entries(STATE_SETS)) {
      const applicable = targets.filter(
        (target, index): target is ForcedStateTarget =>
          target !== undefined &&
          (LEGACY_STATE_LAYER_NAMES.some((legacy) => legacy === stateName) ||
            (session.marked[index].formStateLayers?.some((layer) => layer === stateName) ?? false)),
      );

      await stateBatch(applicable.map((target) => forcePseudoState(session, target, forcedPseudoClasses)));
      const dest = stateLayerScreenshotPath(stem, stateName);
      if (
        FORM_STATE_LAYER_NAMES.some((state) => state === stateName) &&
        !session.marked
          .slice(0, targets.length)
          .some((marked) => marked.formStateLayers?.some((state) => state === stateName))
      ) {
        const restingPath = `${stem}.png`;
        if (!filesystem.existsSync(restingPath)) await captureFullPageScreenshot(page, restingPath);
        filesystem.copyFileSync(restingPath, dest);
      } else await captureFullPageScreenshot(page, dest);
      written.push(dest);
      await stateBatch([...session.applied].map((target) => forcePseudoState(session, target, [])));
    }
  });
  return written;
}

/** Rest screenshot plus the applicable forced-state layers. */
export async function captureSurfaceScreenshots(
  page: Page,
  stem: string,
  options: { ignore?: string[]; maxInteractive?: number } = {},
): Promise<void> {
  await captureFullPageScreenshot(page, `${stem}.png`);
  await captureStateLayerScreenshots(page, stem, options);
}
