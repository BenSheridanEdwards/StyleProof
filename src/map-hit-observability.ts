// Greppable map-restore decision lines for Fleet Visual / CI watchers (issue #734).
// Soft-pass HOLD: observe only — never soft-green, skip-as-pass, or weaken gates.
// One stable line per restore decision; format is STABLE (`^styleproof: map-restore `).

/** Exact SHA hit vs ancestor reuse vs cold/miss. Field name matches Fleet grep vocabulary. */
export type MapBaseHit = 'exact' | 'ancestor' | 'miss';

/**
 * Structured cold/miss reasons. Values are STABLE for grep; refine by adding new
 * snake_case tokens only (never rename). Selective-* tokens are reserved for the
 * selective-remap tranche (#733) even when that wiring is absent from this release.
 */
export const COLD_REASONS = [
  'no_bundle',
  'compat_mismatch',
  'store_unreachable',
  'branch_missing',
  'no_store',
  'dirty',
  'ancestor_none_stored',
  'ancestor_relevant_changes',
  'ancestor_disabled',
  'ancestor_spec_ref',
  'ancestor_error',
  /** Reserved: selective remap opted off / unavailable (#733). */
  'opt_in_selective_off',
  /** Reserved: selective remap unbounded → recapture all (#733). */
  'selective_all',
  'forced_recapture',
] as const;

export type ColdReason = (typeof COLD_REASONS)[number];

const COLD_REASON_SET: ReadonlySet<string> = new Set(COLD_REASONS);

export function isColdReason(value: string): value is ColdReason {
  return COLD_REASON_SET.has(value);
}

export type MapRestoreDecision =
  | {
      side: string;
      sha: string;
      baseHit: 'exact';
      /** Present when the restored manifest SHA is known (usually equals `sha`). */
      restoredSha?: string;
    }
  | {
      side: string;
      sha: string;
      baseHit: 'ancestor';
      ancestorReuseFrom: string;
    }
  | {
      side: string;
      sha: string;
      baseHit: 'miss';
      coldReason: ColdReason;
    };

const SHA_FIELD = /^[0-9a-f]{7,40}$/i;

/** Normalize a commit-ish for the log line: lowercase hex, else the trimmed raw token. */
export function formatShaField(sha: string): string {
  const trimmed = sha.trim();
  return SHA_FIELD.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/**
 * One greppable restore-decision line.
 * Examples:
 *   styleproof: map-restore side=base sha=<sha> base_hit=exact
 *   styleproof: map-restore side=base sha=<sha> base_hit=ancestor ancestor_reuse_from=<sha>
 *   styleproof: map-restore side=base sha=<sha> base_hit=miss cold_reason=no_bundle
 */
export function formatMapRestoreDecisionLine(decision: MapRestoreDecision): string {
  const side = decision.side.trim() || 'restore';
  const sha = formatShaField(decision.sha);
  const parts = [`styleproof: map-restore`, `side=${side}`, `sha=${sha}`, `base_hit=${decision.baseHit}`];
  if (decision.baseHit === 'exact' && decision.restoredSha && formatShaField(decision.restoredSha) !== sha) {
    parts.push(`restored_sha=${formatShaField(decision.restoredSha)}`);
  }
  if (decision.baseHit === 'ancestor') {
    parts.push(`ancestor_reuse_from=${formatShaField(decision.ancestorReuseFrom)}`);
  }
  if (decision.baseHit === 'miss') {
    parts.push(`cold_reason=${decision.coldReason}`);
  }
  return parts.join(' ');
}

/** Classify a map-store miss / NotFound message into a cold_reason (best-effort). */
export function classifyColdReasonFromMissMessage(message: string): ColdReason {
  const text = message.toLowerCase();
  if (/branch .+ does not exist|map store branch/.test(text) && /does not exist/.test(text)) {
    return 'branch_missing';
  }
  if (/compatib/.test(text)) return 'compat_mismatch';
  if (/could not reach|network|infra|after \d+ attempt|timed out|timeout|econn|enotfound/.test(text)) {
    return 'store_unreachable';
  }
  if (/\bdirty\b/.test(text)) return 'dirty';
  if (/no cached|cache miss|missing styleproof-manifest|no bundle/.test(text)) return 'no_bundle';
  return 'no_bundle';
}

/** Pull `cold_reason=<token>` from a prior structured line (e.g. styleproof-map stderr). */
export function extractColdReasonFromLog(text: string): ColdReason | undefined {
  const match = /\bcold_reason=([a-z0-9_]+)\b/.exec(text);
  if (!match) return undefined;
  return isColdReason(match[1]) ? match[1] : undefined;
}

/** Map free-text / structured ancestor planner capture reasons onto cold_reason. */
export function classifyAncestorCaptureColdReason(
  reason: string,
  reasonCode?: 'ancestor_none_stored' | 'ancestor_relevant_changes' | 'ancestor_error',
): ColdReason {
  if (reasonCode) return reasonCode;
  const text = reason.toLowerCase();
  if (/no stored bundle/.test(text)) return 'ancestor_none_stored';
  if (/capture-relevant/.test(text)) return 'ancestor_relevant_changes';
  return 'ancestor_error';
}
