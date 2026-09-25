import path from 'node:path';
import { resolveForcedStateLimits } from '../capture/forced-states.js';
import { warn } from '../capture/shared.js';
import type { CaptureOptions } from '../capture/types.js';
import { requireLiveTextCapture, validateLiveText } from '../live-text.js';
import { DEFAULT_CLOCK_TIME, frozenSpecClockInstant, restoreRealSpecClock } from '../spec-clock.js';
import { resolveNavigateTimeoutMs, resolveSurfaceTimeoutMs } from '../surface-progress.js';
import type {
  CaptureConfig,
  ExpandedSurface,
  PopupCaptureOptions,
  ResolvedPopupCaptureOptions,
  Settings,
} from './types.js';

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

export function resolvePopupCaptureOptions(
  input: boolean | PopupCaptureOptions | undefined,
): ResolvedPopupCaptureOptions {
  const options = input === true ? {} : input || {};
  return {
    enabled: input === false || input === undefined ? false : (options.enabled ?? true),
    max: Math.max(0, Math.floor(options.max ?? 20)),
    triggers: options.triggers ?? DEFAULT_POPUP_TRIGGERS,
    overlays: options.overlays ?? DEFAULT_POPUP_OVERLAYS,
    timeoutMs: Math.max(0, Math.floor(options.timeoutMs ?? 750)),
  };
}

/** `selfCheck` default: on when RECORDING (live nondeterminism surfaces there), off when replaying; env forces on. */
export function defaultSelfCheck(
  replayFrom: string | undefined,
  env: string | undefined = process.env.STYLEPROOF_SELFCHECK,
): boolean {
  return env === '1' || !replayFrom;
}

/** An ABSOLUTE `dir` is respected as-is; a relative one nests under `baseDir`. */
export function resolveOutputDir(baseDir: string, dir: string): string {
  return path.isAbsolute(dir) ? dir : path.join(baseDir, dir);
}

/** Explicit `baseDir`, then `STYLEPROOF_BASEDIR`, then the default. */
export function resolveBaseDir(
  baseDir: string | undefined,
  env: string | undefined = process.env.STYLEPROOF_BASEDIR,
): string {
  return baseDir ?? env ?? '__stylemaps__';
}

/** Explicit `screenshots`, else `STYLEPROOF_SCREENSHOTS=0` turns them off. */
export function resolveScreenshots(
  screenshots: boolean | undefined,
  env: string | undefined = process.env.STYLEPROOF_SCREENSHOTS,
): boolean {
  return screenshots ?? env !== '0';
}

/** `'gate'` (the v4 default) blocks the diff on an unacknowledged failing endpoint; `'warn'` only records. */
export function resolveDataResidue(mode: 'warn' | 'gate' | undefined): 'warn' | 'gate' {
  return mode ?? 'gate';
}

const envFlag = (value: string | undefined): boolean => value === '1' || value === 'true';

/**
 * Square the import-time spec-process clock freeze with the declared options:
 * `freezeClock: false` restores the real clock; a differing `clockTime` is named loudly
 * (module-level fixtures already used the frozen instant).
 */
function reconcileSpecClock(freezeClock: boolean, clockTime: string | number | Date): void {
  const installed = frozenSpecClockInstant();
  if (installed === undefined) return;
  if (!freezeClock) {
    restoreRealSpecClock();
    return;
  }
  if (new Date(clockTime).getTime() !== installed) {
    warn(
      `styleproof: clockTime (${new Date(clockTime).toISOString()}) differs from the spec-process ` +
        `frozen instant (${new Date(installed).toISOString()}); module-level fixtures used the latter. ` +
        `Set STYLEPROOF_CLOCK_TIME to match clockTime on the capture command.`,
    );
  }
}

/** Apply the capture defaults once, so explicit-surface and crawl capture cannot drift. */
export function resolveSettings(c: CaptureConfig): Settings {
  const env = process.env;
  const replayFrom = c.replayFrom ?? env.STYLEPROOF_REPLAY_FROM;
  const freezeClock = c.freezeClock ?? true;
  const clockTime = c.clockTime ?? DEFAULT_CLOCK_TIME;
  reconcileSpecClock(freezeClock, clockTime);
  const liveText = validateLiveText(c.liveText) ?? null;
  requireLiveTextCapture(liveText ?? undefined, c.captureText ?? false);
  const baseDir = resolveBaseDir(c.baseDir);
  const dir = c.dir as string;
  const surfaceTimeoutMs = resolveSurfaceTimeoutMs(c.surfaceTimeoutMs);
  const navigateTimeoutMs = resolveNavigateTimeoutMs(c.navigateTimeoutMs, surfaceTimeoutMs);
  return {
    ...resolveForcedStateLimits(c),
    dir,
    baseDir,
    outDir: resolveOutputDir(baseDir, dir),
    screenshots: resolveScreenshots(c.screenshots),
    replayFrom,
    replayUrl: c.replayUrl ?? env.STYLEPROOF_REPLAY_URL ?? '**/api/**',
    dataResidue: resolveDataResidue(c.dataResidue),
    freezeClock,
    clockTime,
    selfCheck: c.selfCheck ?? defaultSelfCheck(replayFrom),
    surfaceTimeoutMs,
    navigateTimeoutMs,
    captureText: c.captureText ?? false,
    captureComponent: c.captureComponent ?? false,
    popups: resolvePopupCaptureOptions(c.popups),
    inventory: c.inventory ?? false,
    liveText,
    tolerateSurfaceFailures: envFlag(env.STYLEPROOF_TOLERATE_SURFACE_FAILURES),
  };
}

/** The capture options every capture of `surface` shares (the surface's limits win over the run's). */
export function captureOptionsFor(surface: ExpandedSurface, s: Settings, pending: () => number): CaptureOptions {
  return {
    ...resolveForcedStateLimits({
      maxForcedStateElements:
        surface.maxForcedStateElements === undefined ? s.maxForcedStateElements : surface.maxForcedStateElements,
      maxForcedStateScanWork:
        surface.maxForcedStateScanWork === undefined ? s.maxForcedStateScanWork : surface.maxForcedStateScanWork,
    }),
    ignore: surface.ignore ?? [],
    captureText: s.captureText,
    pendingRequests: pending,
  };
}
