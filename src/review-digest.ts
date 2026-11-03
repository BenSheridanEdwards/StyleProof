import { createHash } from 'node:crypto';
import type { BaseOnlyVolatile, Finding, SurfaceDiff } from './diff.js';
import type { ReportReach } from './report/reach.js';
import type { StyleProofTrustState } from './verdict.js';

type ReviewDiff = {
  surfaces?: readonly SurfaceDiff[];
  inventory?: { added: readonly string[]; removed: readonly string[] } | null;
  volatility?: { baseOnly?: readonly BaseOnlyVolatile[] };
  reach?: Pick<ReportReach, 'level' | 'ledger' | 'counts' | 'blocking'>;
};

/** Stable object keys without changing the order of semantic collections. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

function sortedEntries(entries: readonly unknown[]): unknown[] {
  return entries
    .map((entry) => ({ entry, key: canonicalJson(entry) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ entry }) => entry);
}

/** Only verdict/review fields: component names are advisory capture passthrough. */
function reviewFinding(finding: Finding): unknown {
  const common = { kind: finding.kind, path: finding.path, cls: finding.cls };
  if (finding.kind === 'dom') return { ...common, change: finding.change, detail: finding.detail };
  const props = sortedEntries(finding.props.map(({ prop, before, after }) => ({ prop, before, after })));
  return finding.kind === 'style'
    ? { ...common, pseudo: finding.pseudo, props, contentLengthSignal: finding.contentLengthSignal }
    : {
        ...common,
        state: finding.state,
        sub: finding.sub,
        props,
        autoMarginEchoDropped: finding.autoMarginEchoDropped,
      };
}

/** Digest the reviewable diff, excluding capture metadata, advisory content and receipts. */
export function reviewDiffDigest(diff: ReviewDiff, trustState: StyleProofTrustState): string {
  const surfaces = [...(diff.surfaces ?? [])]
    .sort((a, b) => (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0))
    .map(({ surface, missing, classification, findings }) => ({
      surface,
      missing,
      classification,
      findings: sortedEntries(findings.map(reviewFinding)),
    }));
  // These can require review even when every surface has zero findings.
  const review = {
    trustState,
    surfaces,
    inventory: {
      added: [...(diff.inventory?.added ?? [])].sort(),
      removed: [...(diff.inventory?.removed ?? [])].sort(),
    },
    baseOnlyVolatile: sortedEntries((diff.volatility?.baseOnly ?? []).map(({ surface, path }) => ({ surface, path }))),
    reach:
      diff.reach?.level === 'gate'
        ? { ledger: diff.reach.ledger, counts: diff.reach.counts, blocking: diff.reach.blocking }
        : null,
  };
  return createHash('sha256').update(canonicalJson(review)).digest('hex');
}
