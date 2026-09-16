// Public, bounded baseline-failure receipts: privacy-safe conversion of private capture
// diagnostics, the honest attribution text, the action.yml comment/status/fail-echo
// formatters, and the ledger matching that explains a surface missing on base.
import { sha256 } from '../node-util.js';
import type { SurfaceCaptureFailure } from './bundle.js';
import { asRecord } from './json.js';

/** Public, bounded failure receipt shared by diff JSON, report JSON, and Markdown. */
export type BaselineFailureReceipt = {
  key: string;
  reason: 'capture_failed';
  /** Durable commit identity of the side that failed (40-hex, `uncommitted`, or hashed). */
  sha: string;
};

/** Closed set of adopter-facing baseline/compare failure classes. */
export type BaselineCompareFailureClass = 'baseline_surface_capture' | 'base_recapture' | 'compare';

export type BaselineCompareAttribution = {
  failureClass: BaselineCompareFailureClass;
  recaptureFailed: boolean;
  named: string;
  summary: string;
};

const PUBLIC_CAPTURE_FAILURE_KEY = /^[a-z0-9][a-z0-9._-]{0,199}@(auto|[1-9]\d{1,4})$/;
const PUBLIC_BASELINE_SHA = /^(?:[0-9a-f]{40}|uncommitted)$/;
/** GitHub commit-status `description` hard limit. */
const GITHUB_STATUS_DESCRIPTION_MAX = 140;
const NOT_RECAPTURE = 'this is not a base recapture failure';

/** 40-hex / `uncommitted`, or a privacy-safe hashed placeholder. */
function publicBaselineSha(sha: string | undefined): string {
  if (!sha) return 'unknown';
  return PUBLIC_BASELINE_SHA.test(sha) ? sha : `sha-${sha256(sha).slice(0, 12)}`;
}

const publicCaptureFailureKey = (key: string): string =>
  PUBLIC_CAPTURE_FAILURE_KEY.test(key) ? key : `capture-${sha256(key).slice(0, 12)}`;

const namedSurfaceShaList = (items: readonly { key: string; sha: string }[]): string =>
  items.map((item) => `\`${item.key}\` at \`${item.sha}\``).join(', ');

/** Convert private capture diagnostics into stable public receipts without exception text. */
export function baselineFailureReceipts(
  failures: readonly SurfaceCaptureFailure[],
  sha?: string,
): BaselineFailureReceipt[] {
  const publicSha = publicBaselineSha(sha);
  return failures.map((failure) => ({
    key: publicCaptureFailureKey(failure.key),
    reason: 'capture_failed',
    sha: publicSha,
  }));
}

/** Adopter-legible attribution for a baseline or compare fault. When
 *  `base-capture-failed=false`, never claims a base recapture failed. */
export function honestBaselineCompareAttribution(options: {
  baseCaptureFailed: boolean;
  receipts?: readonly BaselineFailureReceipt[];
  compareSurfaces?: readonly { key: string; sha: string }[];
}): BaselineCompareAttribution {
  if (options.baseCaptureFailed) {
    return {
      failureClass: 'base_recapture',
      recaptureFailed: true,
      named: '',
      summary:
        'The base capture failed, so this is a head-only receipt rather than a comparison — repair the base capture and rerun.',
    };
  }
  const receipts = options.receipts ?? [];
  if (receipts.length > 0) {
    const named = namedSurfaceShaList(receipts);
    return {
      failureClass: 'baseline_surface_capture',
      recaptureFailed: false,
      named,
      summary:
        `these named surface(s) failed on the base SHA and were omitted from the baseline bundle: ${named}. ` +
        `The base bundle was produced (\`base-capture-failed=false\`); ${NOT_RECAPTURE}. ` +
        `Repair the named surface(s) on that SHA; do not approve indefinitely. Raw exception details stay private.`,
    };
  }
  const named = namedSurfaceShaList(
    (options.compareSurfaces ?? []).map((item) => ({
      key: publicCaptureFailureKey(item.key),
      sha: publicBaselineSha(item.sha),
    })),
  );
  return {
    failureClass: 'compare',
    recaptureFailed: false,
    named,
    summary: named
      ? `compare/certification evidence is incomplete on ${named}. ` +
        `This is not a base recapture failure (\`base-capture-failed=false\`). Repair the named evidence; reviewer approval cannot clear it.`
      : 'compare/certification evidence is incomplete. This is not a base recapture failure (`base-capture-failed=false`).',
  };
}

/** Parse public baseline-failure receipts from report/diff JSON. */
export function parseBaselineFailureReceipts(value: unknown): BaselineFailureReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (
      !record ||
      typeof record.key !== 'string' ||
      typeof record.sha !== 'string' ||
      record.reason !== 'capture_failed'
    ) {
      return [];
    }
    return [
      {
        key: publicCaptureFailureKey(record.key),
        reason: 'capture_failed' as const,
        sha: publicBaselineSha(record.sha),
      },
    ];
  });
}

function partialBaselineNamed(receipts: unknown): string {
  const parsed = parseBaselineFailureReceipts(receipts);
  return (
    honestBaselineCompareAttribution({ baseCaptureFailed: false, receipts: parsed }).named ||
    'named surface(s) listed in the report'
  );
}

const wrapActionComment = (body: string): string => `_${body}_`;

/** PR-comment footer for PARTIAL_BASELINE — interpolates the receipt key+SHA. */
export function formatPartialBaselineComment(receipts: unknown): string {
  return wrapActionComment(
    `${partialBaselineNamed(receipts)} failed on the listed base SHA — ${NOT_RECAPTURE}. ` +
      `Repair those surfaces on that SHA; reviewer approval cannot clear missing baseline surfaces.`,
  );
}

/** Commit-status description for PARTIAL_BASELINE (≤140 chars, includes key+SHA). */
export function formatPartialBaselineStatusDescription(receipts: unknown): string {
  const parsed = parseBaselineFailureReceipts(receipts);
  const first = parsed.length ? `${parsed[0].key} at ${parsed[0].sha}` : 'named surface on listed base SHA';
  const text = `${parsed.length > 1 ? `${first} (+${parsed.length - 1})` : first} — not a base recapture failure`;
  return text.length <= GITHUB_STATUS_DESCRIPTION_MAX ? text : `${text.slice(0, GITHUB_STATUS_DESCRIPTION_MAX - 3)}...`;
}

/** Job-fail stderr for PARTIAL_BASELINE — interpolates the receipt key+SHA. */
export function formatPartialBaselineFailEcho(receipts: unknown): string {
  return (
    `StyleProof: ${partialBaselineNamed(receipts)} failed on the listed base SHA — ${NOT_RECAPTURE}. ` +
    `Repair those surfaces on that SHA (approval cannot clear this).`
  );
}

/** PR-comment footer for DEGRADED_BASELINE / head-only evidence; recapture language only when true. */
export function formatDegradedBaselineComment(baseCaptureFailed: boolean): string {
  return wrapActionComment(
    baseCaptureFailed
      ? `${honestBaselineCompareAttribution({ baseCaptureFailed: true }).summary} Reviewer approval cannot clear this failure.`
      : 'This is a head-only receipt rather than a comparison — not a base recapture failure ' +
          '(`base-capture-failed=false`). Repair the missing baseline evidence and rerun; ' +
          'reviewer approval cannot clear this failure.',
  );
}

/** Commit-status description for DEGRADED_BASELINE / head-only evidence. */
export function formatDegradedBaselineStatusDescription(baseCaptureFailed: boolean): string {
  return baseCaptureFailed
    ? 'Base capture failed — head-only evidence cannot certify this change'
    : 'Head-only evidence cannot certify this change — not a base recapture failure';
}

/** Job-fail stderr for DEGRADED_BASELINE / head-only evidence. */
export function formatDegradedBaselineFailEcho(baseCaptureFailed: boolean): string {
  return baseCaptureFailed
    ? 'StyleProof: base capture failed — the published report is head-only degraded evidence, not a base-vs-head certification. Repair the base capture and rerun.'
    : 'StyleProof: head-only evidence is not a base-vs-head certification — this is not a base recapture failure. Repair the missing baseline evidence and rerun.';
}

/** Split a capture key at the last `@` (`home@1280` → `home` + `1280`). */
function captureKeyParts(key: string): { surface: string; width: string } {
  const at = key.lastIndexOf('@');
  return at === -1 ? { surface: key, width: '' } : { surface: key.slice(0, at), width: key.slice(at + 1) };
}

/** A ledger entry explains a missing head key when it names the same key, or `surface@auto`
 *  (viewport detection failed before the width sweep) for that exact surface. */
export function baselineFailureMatchesSurface(failureKey: string, surfaceKey: string): boolean {
  if (failureKey === surfaceKey) return true;
  const failure = captureKeyParts(failureKey);
  return failure.surface === captureKeyParts(surfaceKey).surface && failure.width === 'auto';
}

/** True when any ledger entry explains why `surfaceKey` is absent from the base bundle. */
export const surfaceMissingMatchesBaselineFailure = (
  surfaceKey: string,
  failures: readonly SurfaceCaptureFailure[],
): boolean => failures.some((f) => baselineFailureMatchesSurface(f.key, surfaceKey));

/** Head capture keys missing on base that the baseline failure ledger explains (sorted). */
export function explainedMissingBaselineSurfaces(
  surfaces: readonly { surface: string; missing?: 'before' | 'after' }[],
  failures: readonly SurfaceCaptureFailure[],
): string[] {
  return surfaces
    .filter((s) => s.missing === 'before' && surfaceMissingMatchesBaselineFailure(s.surface, failures))
    .map((s) => s.surface)
    .sort((a, b) => a.localeCompare(b));
}
