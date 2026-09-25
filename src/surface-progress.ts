// Per-surface progress heartbeat + per-surface timeout: a slow capture run must stay
// distinguishable from a hung one, and a stuck surface must fail LOUDLY by name.
// Pure logic, unit-tested without a browser; the runner wires it into captureSurface.

/** The stage of one surface's capture that is currently in flight. */
export type CapturePhase = 'navigate' | 'settle' | 'capture' | 'self-check';

/** Default per-surface ceiling: 5 minutes — only a genuinely stuck surface hits it. */
export const DEFAULT_SURFACE_TIMEOUT_MS = 300_000;

/**
 * Default navigate-phase budget under the overall ceiling. Stuck navigate must fail
 * the surface well before the full 300s ceiling burns (~60s).
 */
export const DEFAULT_NAVIGATE_TIMEOUT_MS = 60_000;

export type SurfaceHeartbeat = {
  /** Static ordinal of this capture unit in the run (1-based). */
  index: number;
  total: number;
  /** The capture key, width included (`factory@1280`). */
  captureKey: string;
  captureMs: number;
  /** Self-check re-capture duration; omit when it did not run. */
  selfCheckMs?: number;
};

const secondsLabel = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

/** The one-line-per-surface heartbeat. Format is STABLE and greppable (`^styleproof: surface `); CI watchers key on it. */
export function formatSurfaceHeartbeat(heartbeat: SurfaceHeartbeat): string {
  const selfCheck = heartbeat.selfCheckMs === undefined ? '' : ` (self-check ${secondsLabel(heartbeat.selfCheckMs)})`;
  return (
    `styleproof: surface ${heartbeat.index}/${heartbeat.total} (${heartbeat.captureKey}) ` +
    `captured in ${secondsLabel(heartbeat.captureMs)}${selfCheck}`
  );
}

export type SurfaceTimeoutBudget = 'surface' | 'navigate';

/**
 * The named-surface, named-phase timeout error. Deliberately avoids the phrases
 * `isSelfCheckCaptureFailure` matches: a timeout is slowness, not proof of nondeterminism.
 * Navigate-budget breaches name the navigate knobs; overall-ceiling breaches keep the
 * historic surfaceTimeoutMs / STYLEPROOF_SURFACE_TIMEOUT_MS wording.
 */
export function surfaceTimeoutErrorMessage(
  captureKey: string,
  phase: CapturePhase,
  timeoutMs: number,
  budget: SurfaceTimeoutBudget = 'surface',
): string {
  const knobHelp =
    budget === 'navigate'
      ? `If this surface's navigate is legitimately slow, raise \`navigateTimeoutMs\` in the spec ` +
        `(or set STYLEPROOF_NAVIGATE_TIMEOUT_MS on the capture command). ` +
        `The overall ceiling remains \`surfaceTimeoutMs\` / STYLEPROOF_SURFACE_TIMEOUT_MS.`
      : `If this surface is legitimately slow, raise \`surfaceTimeoutMs\` in the spec ` +
        `(or set STYLEPROOF_SURFACE_TIMEOUT_MS on the capture command).`;
  return (
    `styleproof: surface '${captureKey}' timed out after ${secondsLabel(timeoutMs)} with the ` +
    `'${phase}' phase in flight — one stuck surface must not silently consume the job budget. ` +
    knobHelp
  );
}

/** Explicit option, then STYLEPROOF_SURFACE_TIMEOUT_MS, then the default. A malformed value is a LOUD error. */
export function resolveSurfaceTimeoutMs(
  configured: number | undefined,
  env: string | undefined = process.env.STYLEPROOF_SURFACE_TIMEOUT_MS,
): number {
  if (configured !== undefined) {
    if (!Number.isFinite(configured) || configured <= 0) {
      throw new Error(`styleproof: surfaceTimeoutMs must be a positive number of milliseconds, got ${configured}`);
    }
    return configured;
  }
  if (env === undefined || env === '') return DEFAULT_SURFACE_TIMEOUT_MS;
  const parsed = Number(env);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `styleproof: STYLEPROOF_SURFACE_TIMEOUT_MS must be a positive number of milliseconds, got '${env}'`,
    );
  }
  return parsed;
}

/**
 * Explicit option, then STYLEPROOF_NAVIGATE_TIMEOUT_MS, then the default — never above the
 * overall surface ceiling. A malformed value is a LOUD error.
 */
export function resolveNavigateTimeoutMs(
  configured: number | undefined,
  overallCeilingMs: number,
  env: string | undefined = process.env.STYLEPROOF_NAVIGATE_TIMEOUT_MS,
): number {
  if (!Number.isFinite(overallCeilingMs) || overallCeilingMs <= 0) {
    throw new Error(
      `styleproof: navigateTimeoutMs requires a positive overall surfaceTimeoutMs ceiling, got ${overallCeilingMs}`,
    );
  }
  let resolved: number;
  if (configured !== undefined) {
    if (!Number.isFinite(configured) || configured <= 0) {
      throw new Error(`styleproof: navigateTimeoutMs must be a positive number of milliseconds, got ${configured}`);
    }
    resolved = configured;
  } else if (env === undefined || env === '') {
    resolved = DEFAULT_NAVIGATE_TIMEOUT_MS;
  } else {
    const parsed = Number(env);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `styleproof: STYLEPROOF_NAVIGATE_TIMEOUT_MS must be a positive number of milliseconds, got '${env}'`,
      );
    }
    resolved = parsed;
  }
  return Math.min(resolved, overallCeilingMs);
}

/** Playwright test budget for `units` captures: always exceeds the per-surface ceiling so the NAMED timeout fires first. */
export function captureTestBudgetMs(surfaceTimeoutMs: number, units = 1): number {
  return Math.max(180_000, units * (surfaceTimeoutMs + 60_000));
}

export type SurfaceRun = {
  /** True only while this surface still owns the capture result. */
  isActive: () => boolean;
};

export type RunWithSurfaceTimeoutOptions = {
  /** Navigate-phase budget in ms; capped by `timeoutMs`. Default: min(60s, overall). */
  navigateTimeoutMs?: number;
};

/**
 * Run one surface's capture under the per-surface ceiling. While phase is still
 * `navigate`, the navigate budget can fire first (named navigate, navigate ms in
 * the message). After leaving navigate, only the overall remaining budget applies.
 * Playwright work is not abortable, so on breach `isActive()` flips false and
 * callers must refuse artifact writes; a later rejection from the abandoned work
 * is detached, never unhandled.
 */
export async function runWithSurfaceTimeout<ResultType>(
  captureKey: string,
  timeoutMs: number,
  currentPhase: () => CapturePhase,
  work: (run: SurfaceRun) => Promise<ResultType>,
  options: RunWithSurfaceTimeoutOptions = {},
): Promise<ResultType> {
  const navigateBudgetMs = resolveNavigateTimeoutMs(options.navigateTimeoutMs, timeoutMs, undefined);
  let overallTimer: NodeJS.Timeout | undefined;
  let navigateTimer: NodeJS.Timeout | undefined;
  let active = true;
  const working = Promise.resolve().then(() => work({ isActive: () => active }));
  working.catch(() => {});
  try {
    return await Promise.race([
      working,
      new Promise<never>((_resolve, reject) => {
        const fail = (budget: SurfaceTimeoutBudget, budgetMs: number) => {
          if (!active) return;
          active = false;
          clearTimeout(overallTimer);
          clearTimeout(navigateTimer);
          reject(new Error(surfaceTimeoutErrorMessage(captureKey, currentPhase(), budgetMs, budget)));
        };
        overallTimer = setTimeout(() => fail('surface', timeoutMs), timeoutMs);
        navigateTimer = setTimeout(() => {
          if (currentPhase() === 'navigate') fail('navigate', navigateBudgetMs);
        }, navigateBudgetMs);
      }),
    ]);
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(navigateTimer);
  }
}
