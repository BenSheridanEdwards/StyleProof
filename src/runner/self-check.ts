import type { Page } from '@playwright/test';
import { captureStyleMap } from '../capture.js';
import { warn } from '../capture/shared.js';
import type { LiveRegionCandidate, StyleMap } from '../capture/types.js';
import { diffStyleMaps, type Finding } from '../diff.js';
import { markFatalCaptureFailure, recordSurfaceCaptureFailure } from '../map-store.js';
import { captureOptionsFor } from './settings.js';
import type { ExpandedSurface, Settings } from './types.js';

/** Self-check / nondeterminism failures must never be tolerated. */
export function isSelfCheckCaptureFailure(message: string): boolean {
  return /self-check failed|non-deterministic/i.test(message);
}

/**
 * Run one capture unit under the baseline failure policy: a self-check failure is
 * fatal for the run; any other failure is recorded and tolerated only when
 * `tolerateSurfaceFailures` is set. Returns the failure line when the caller
 * aggregates instead of throwing (the crawl), else rethrows.
 */
export async function withSurfaceFailureTolerance(
  settings: Settings,
  captureKey: string,
  run: () => Promise<void>,
  aggregate?: (line: string) => void,
): Promise<void> {
  try {
    await run();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const fatal = isSelfCheckCaptureFailure(reason);
    if (fatal) markFatalCaptureFailure(settings.outDir, reason);
    if (!fatal && settings.tolerateSurfaceFailures) {
      recordSurfaceCaptureFailure(settings.outDir, { key: captureKey, reason, kind: 'capture' });
      if (aggregate) process.stderr.write(`styleproof: tolerated crawl capture failure for ${captureKey}\n`);
      else warn(`styleproof: tolerated capture failure for ${captureKey} — ${reason}`);
      return;
    }
    if (!aggregate) throw e;
    aggregate(`${captureKey.replace(/@([^@]*)$/, ' @ $1')}: ${reason}`);
  }
}

function driftDesc(f: Finding): string {
  if (f.kind === 'dom') return `${f.path} ${f.change}`;
  const p = f.props[0];
  return p ? `${f.path} ${p.prop}: ${p.before} → ${p.after}` : f.path;
}

const ROOT_LAYOUT_PATHS = new Set(['html', 'body']);
const ROOT_LAYOUT_PROPS = new Set(
  'block-size height inline-size width min-block-size min-height max-block-size max-height perspective-origin transform-origin'.split(
    ' ',
  ),
);

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

/** Capture the surface again and throw if the computed styles drifted from `first`. */
export async function assertDeterministic(
  page: Page,
  surface: ExpandedSurface,
  first: StyleMap,
  settings: Settings,
  pending: () => number,
): Promise<void> {
  await surface.go(page);
  const again = await captureStyleMap(page, {
    ...captureOptionsFor(surface, settings, pending),
    requiredVisibleState: surface.requiredVisibleState,
  });
  const drift = diffStyleMaps(first, again);
  if (drift.length) {
    throw new Error(
      selfCheckErrorMessage(
        surface.key,
        drift,
        [...new Set([...(first.volatile ?? []), ...(again.volatile ?? [])])],
        [...(first.liveCandidates ?? []), ...(again.liveCandidates ?? [])],
      ),
    );
  }
}
