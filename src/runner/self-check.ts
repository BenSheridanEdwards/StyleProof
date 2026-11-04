import type { Page } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';
import { scriptExecutionProjection } from '../script-reach.js';
import { captureStyleMap } from '../capture.js';
import type { ServedRuleTracker } from '../capture/reach.js';
import { trackScriptReach } from '../capture/script-reach.js';
import { warn } from '../capture/shared.js';
import type { LiveRegionCandidate, StyleMap } from '../capture/types.js';
import { diffStyleMaps, type Finding } from '../diff.js';
import { clearSurfaceCaptureFailure, markFatalCaptureFailure, recordSurfaceCaptureFailure } from '../map-store.js';
import { UndrainedSurfaceTimeoutError } from '../surface-progress.js';
import { captureOptionsFor } from './settings.js';
import type { ExpandedSurface, Settings } from './types.js';

/** Self-check / nondeterminism failures must never be tolerated. */
export function isSelfCheckCaptureFailure(message: string): boolean {
  return /self-check failed|non-deterministic/i.test(message);
}

/**
 * Ledger a non-fatal surface failure. Returns true when the failure was swallowed
 * under `--tolerate-surface-failures` (cold-base continue); false when the caller
 * must still fail closed (Soft-pass HOLD) after leaving the ledger for survivors.
 */
function ledgerNonFatalSurfaceFailure(
  settings: Settings,
  captureKey: string,
  reason: string,
  aggregate?: (line: string) => void,
): boolean {
  recordSurfaceCaptureFailure(settings.outDir, { key: captureKey, reason, kind: 'capture' });
  if (!settings.tolerateSurfaceFailures) return false;
  if (aggregate) process.stderr.write(`styleproof: tolerated crawl capture failure for ${captureKey}\n`);
  else warn(`styleproof: tolerated capture failure for ${captureKey} — ${reason}`);
  return true;
}

/**
 * Run one capture unit under the surface-failure policy: a self-check failure is
 * fatal for the run; any other failure is always ledgered. When
 * `tolerateSurfaceFailures` is set the failure is swallowed (cold-base continue);
 * otherwise it rethrows so the run exits non-zero — Soft-pass HOLD — while leaving
 * the ledger for partial publish of survivors. A run that succeeds clears the entry an
 * earlier attempt of the same key left, so a Playwright retry that captures is not a gap.
 * Returns the failure line when the caller aggregates instead of throwing (the crawl).
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

    if (e instanceof UndrainedSurfaceTimeoutError) {
      markFatalCaptureFailure(settings.outDir, reason);
      throw e;
    }

    if (isSelfCheckCaptureFailure(reason)) {
      markFatalCaptureFailure(settings.outDir, reason);
    } else if (ledgerNonFatalSurfaceFailure(settings, captureKey, reason, aggregate)) {
      return;
    }
    if (!aggregate) throw e;
    aggregate(`${captureKey.replace(/@([^@]*)$/, ' @ $1')}: ${reason}`);
    return;
  }
  clearSurfaceCaptureFailure(settings.outDir, captureKey);
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

/** Enabled reach evidence must be present and agree, even when computed styles agree. */
export function assertDeterministicReach(first: StyleMap, again: StyleMap, surfaceKey: string): void {
  if (!first.reach || !again.reach || !isDeepStrictEqual(first.reach, again.reach)) {
    throw new Error(
      `styleproof self-check failed: ${surfaceKey} is non-deterministic — served CSS reach evidence changed or is missing.`,
    );
  }
}

/** Compare mapped app-source evidence, never V8 script IDs, function names or counters. */
export function assertDeterministicScriptReach(first: StyleMap, again: StyleMap, surfaceKey: string): void {
  const left = first.scriptReach ? scriptExecutionProjection(first.scriptReach) : [];
  const right = again.scriptReach ? scriptExecutionProjection(again.scriptReach) : [];
  const residual = (map: StyleMap): unknown => [
    map.scriptReach?.status,
    map.scriptReach?.reason,
    map.scriptReach?.scripts.filter((script) => script.status !== 'mapped'),
  ];
  if (isDeepStrictEqual(left, right) && isDeepStrictEqual(residual(first), residual(again))) return;
  const rightByKey = new Map(right.map((file) => [file.sourceKey, file]));
  const changed = left.find(
    (file) => rightByKey.has(file.sourceKey) && !isDeepStrictEqual(file, rightByKey.get(file.sourceKey)),
  );
  const location = changed
    ? `: ${changed.sourceKey}:${firstScriptDifference(changed, rightByKey.get(changed.sourceKey)!)}`
    : '';
  first.scriptReach = {
    ...first.scriptReach,
    version: 1,
    window: 'navigation',
    status: 'unknown',
    reason: `script evidence not reproducible${location}`,
    scripts: isDeepStrictEqual(left, right)
      ? (first.scriptReach?.scripts ?? []).map((script) =>
          script.status === 'mapped'
            ? {
                url: script.url,
                status: 'unknown' as const,
                reason: `script evidence not reproducible (${surfaceKey})`,
              }
            : script,
        )
      : [],
  };
}

function scriptLines(file: ReturnType<typeof scriptExecutionProjection>[number]): Map<number, unknown[]> {
  const lines = new Map<number, unknown[]>();
  for (const kind of ['executed', 'mixed', 'unexecuted'] as const)
    for (const span of file[kind]) {
      const row = lines.get(span.start.line) ?? [];
      row.push([kind, span]);
      lines.set(span.start.line, row);
    }
  return lines;
}
function firstScriptDifference(
  file: ReturnType<typeof scriptExecutionProjection>[number],
  other: ReturnType<typeof scriptExecutionProjection>[number],
): number {
  const lines = scriptLines(file),
    otherLines = scriptLines(other);
  return (
    [...new Set([...lines.keys(), ...otherLines.keys()])]
      .sort((a, b) => a - b)
      .find((line) => !isDeepStrictEqual(lines.get(line), otherLines.get(line))) ?? 1
  );
}

/** Capture the surface again and throw if computed styles or enabled reach evidence drifted. */
export async function assertDeterministic(
  page: Page,
  surface: ExpandedSurface,
  first: StyleMap,
  settings: Settings,
  pending: () => number,
  servedRules?: ServedRuleTracker,
): Promise<void> {
  const scriptReach = settings.captureScriptReach
    ? await trackScriptReach(page, { projectRoot: settings.projectRoot, projectRootPrefix: settings.projectRootPrefix, mediaState: surface.metadata?.mediaState })
    : undefined;
  let again: StyleMap;
  try {
    await surface.go(page);
    again = await captureStyleMap(page, {
      scriptReach,
      ...captureOptionsFor(surface, settings, pending, servedRules),
      requiredVisibleState: surface.requiredVisibleState,
      metadata: surface.metadata,
    });
  } finally {
    await scriptReach?.dispose();
  }
  if (settings.captureScriptReach) assertDeterministicScriptReach(first, again, surface.key);
  if (settings.captureReach) assertDeterministicReach(first, again, surface.key);
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
