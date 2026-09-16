// Per-surface progress heartbeat + per-surface timeout: a slow capture run must stay
// distinguishable from a hung one, and a stuck surface must fail LOUDLY by name.
// Pure logic, unit-tested without a browser; the runner wires it into captureSurface.

/** The stage of one surface's capture that is currently in flight. */
export type CapturePhase = 'navigate' | 'settle' | 'capture' | 'self-check';

/** Default per-surface ceiling: 5 minutes — only a genuinely stuck surface hits it. */
export const DEFAULT_SURFACE_TIMEOUT_MS = 300_000;

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

/**
 * The named-surface, named-phase timeout error. Deliberately avoids the phrases
 * `isSelfCheckCaptureFailure` matches: a timeout is slowness, not proof of nondeterminism.
 */
export function surfaceTimeoutErrorMessage(captureKey: string, phase: CapturePhase, timeoutMs: number): string {
  return (
    `styleproof: surface '${captureKey}' timed out after ${secondsLabel(timeoutMs)} with the ` +
    `'${phase}' phase in flight — one stuck surface must not silently consume the job budget. ` +
    `If this surface is legitimately slow, raise \`surfaceTimeoutMs\` in the spec ` +
    `(or set STYLEPROOF_SURFACE_TIMEOUT_MS on the capture command).`
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

/** Playwright test budget for `units` captures: always exceeds the per-surface ceiling so the NAMED timeout fires first. */
export function captureTestBudgetMs(surfaceTimeoutMs: number, units = 1): number {
  return Math.max(180_000, units * (surfaceTimeoutMs + 60_000));
}

export type SurfaceRun = {
  /** True only while this surface still owns the capture result. */
  isActive: () => boolean;
};

/**
 * Run one surface's capture under the per-surface ceiling. Playwright work is not
 * abortable, so on breach `isActive()` flips false and callers must refuse artifact
 * writes; a later rejection from the abandoned work is detached, never unhandled.
 */
export async function runWithSurfaceTimeout<ResultType>(
  captureKey: string,
  timeoutMs: number,
  currentPhase: () => CapturePhase,
  work: (run: SurfaceRun) => Promise<ResultType>,
): Promise<ResultType> {
  let timer: NodeJS.Timeout | undefined;
  let active = true;
  const working = Promise.resolve().then(() => work({ isActive: () => active }));
  working.catch(() => {});
  try {
    return await Promise.race([
      working,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          active = false;
          reject(new Error(surfaceTimeoutErrorMessage(captureKey, currentPhase(), timeoutMs)));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
