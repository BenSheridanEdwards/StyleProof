/**
 * Per-surface progress heartbeat + per-surface timeout (issue #365).
 *
 * An 80-minute capture on a saturated runner is indistinguishable from a hang
 * when the run prints nothing between start and finish — an operator watching
 * the log has no better option than to cancel it. Two additions fix that:
 *
 * - a HEARTBEAT: one stable, greppable line per completed surface capture
 *   (`styleproof: surface 17/41 (factory@1280) captured in 42.1s (self-check
 *   12.3s)`), so progressing-slowly reads as progress;
 * - a per-surface TIMEOUT: a configurable ceiling on one surface's capture that
 *   fails LOUDLY, naming the surface and the phase in flight (navigate / settle
 *   / capture / self-check), instead of letting one stuck surface silently
 *   consume the whole job budget.
 *
 * Pure logic lives here so the unit suite covers it without a browser; the
 * runner wires it into `captureSurface`.
 */

/** The stage of one surface's capture that is currently in flight. */
export type CapturePhase = 'navigate' | 'settle' | 'capture' | 'self-check';

/**
 * Default per-surface ceiling: 5 minutes. Generous — a normal surface captures
 * in well under a minute even with the self-check double capture — so only a
 * genuinely stuck surface hits it, while a merely slow one still completes.
 */
export const DEFAULT_SURFACE_TIMEOUT_MS = 300_000;

/** One completed surface capture, as reported by the heartbeat line. */
export type SurfaceHeartbeat = {
  /** Static ordinal of this capture unit in the run (1-based). */
  index: number;
  /** Total capture units the run declared. */
  total: number;
  /** The capture key, width included (`factory@1280`). */
  captureKey: string;
  /** Wall-clock duration of the whole surface capture, ms. */
  captureMs: number;
  /** Wall-clock duration of the self-check re-capture, ms; omit when it did not run. */
  selfCheckMs?: number;
};

function secondsLabel(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * The one-line-per-surface progress heartbeat. Format is STABLE and greppable
 * (`grep -c '^styleproof: surface '` counts completions); change it only with
 * a CHANGELOG entry, because CI watchers key on it.
 */
export function formatSurfaceHeartbeat(heartbeat: SurfaceHeartbeat): string {
  const selfCheck = heartbeat.selfCheckMs === undefined ? '' : ` (self-check ${secondsLabel(heartbeat.selfCheckMs)})`;
  return (
    `styleproof: surface ${heartbeat.index}/${heartbeat.total} (${heartbeat.captureKey}) ` +
    `captured in ${secondsLabel(heartbeat.captureMs)}${selfCheck}`
  );
}

/**
 * The named-surface, named-phase timeout error. Deliberately does NOT contain
 * the phrases `isSelfCheckCaptureFailure` matches ("self-check failed" /
 * "non-deterministic"): a timeout during the self-check phase is slowness or a
 * hang, not proof of nondeterminism, so it must stay tolerable on a baseline
 * run instead of being escalated to a fatal capture failure.
 */
export function surfaceTimeoutErrorMessage(captureKey: string, phase: CapturePhase, timeoutMs: number): string {
  return (
    `styleproof: surface '${captureKey}' timed out after ${secondsLabel(timeoutMs)} with the ` +
    `'${phase}' phase in flight — one stuck surface must not silently consume the job budget. ` +
    `If this surface is legitimately slow, raise \`surfaceTimeoutMs\` in the spec ` +
    `(or set STYLEPROOF_SURFACE_TIMEOUT_MS on the capture command).`
  );
}

/**
 * Resolve the per-surface ceiling: explicit spec option wins, then the
 * STYLEPROOF_SURFACE_TIMEOUT_MS environment variable, then the default — the
 * same precedence as every other capture knob. A malformed value is a LOUD
 * error, never a silent fallback to the default (config the user wrote must
 * not be dropped).
 */
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
  if (env !== undefined && env !== '') {
    const parsed = Number(env);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `styleproof: STYLEPROOF_SURFACE_TIMEOUT_MS must be a positive number of milliseconds, got '${env}'`,
      );
    }
    return parsed;
  }
  return DEFAULT_SURFACE_TIMEOUT_MS;
}

/**
 * The Playwright test budget wrapping `units` per-surface captures. Always
 * exceeds the per-surface ceiling by a slack margin, so the NAMED per-surface
 * timeout fires before Playwright's anonymous "Test timeout of Nms exceeded"
 * — the whole point is that the failure names the surface and phase.
 */
export function captureTestBudgetMs(surfaceTimeoutMs: number, units = 1): number {
  return Math.max(180_000, units * (surfaceTimeoutMs + 60_000));
}

/**
 * Run one surface's capture under the per-surface ceiling. On breach, reject
 * with {@link surfaceTimeoutErrorMessage} naming the surface and the phase the
 * `currentPhase` getter reports at that moment. Playwright work is not abortable,
 * so the callback receives a {@link SurfaceRun} fence: `isActive()` flips false at
 * the deadline and callers must refuse artifact writes once inactive. Eventual
 * rejection from abandoned work is detached so it never surfaces as unhandled.
 */
export type SurfaceRun = {
  /** True only while this surface still owns the capture result. */
  isActive: () => boolean;
};

export async function runWithSurfaceTimeout<ResultType>(
  captureKey: string,
  timeoutMs: number,
  currentPhase: () => CapturePhase,
  work: (run: SurfaceRun) => Promise<ResultType>,
): Promise<ResultType> {
  let timer: NodeJS.Timeout | undefined;
  let active = true;
  const run: SurfaceRun = {
    isActive: () => active,
  };
  const working = Promise.resolve().then(() => work(run));
  // Detached second listener: if the timeout wins the race, a later rejection
  // from the abandoned work must not crash the process. The original promise
  // still rejects the race normally when it loses first.
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
