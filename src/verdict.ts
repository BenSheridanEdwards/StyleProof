/** Shared certification and Action trust policy: one closed-set decision for CLI and Action consumers. */

export type StyleProofTrustState =
  | 'NO_REVIEWABLE_STYLE_CHANGES'
  | 'STYLE_REVIEW_REQUIRED'
  | 'DATA_RESIDUE_UNACKNOWLEDGED'
  | 'INVENTORY_REMOVAL_UNACKNOWLEDGED'
  | 'CERTIFICATION_FAILED'
  | 'PARTIAL_BASELINE'
  | 'DEGRADED_BASELINE';

export type CertificationEvidenceReceipt = {
  sourceBinding?: { status?: unknown } | null;
  coverage?: { basis?: unknown } | null;
  determinism?: { status?: unknown } | null;
  confidence?: { counts?: { inaccessible?: unknown } | null } | null;
  comparison?: { blocksCertification?: unknown } | null;
  reportConsistency?: { ok?: unknown; reason?: unknown } | null;
  statesUncertified?: unknown;
  partialBaseline?: unknown;
  explainedMissingBaselineSurfaces?: unknown;
  liveTextFreeze?: { violated?: unknown } | null;
  /** Subtrees volatile on the head but compared on the base were excluded: never certified. */
  volatility?: { headOnly?: unknown } | null;
  /** Legacy product-state pair ledger. Armed + undeclared/stale fails closed. */
  legacyPairs?: { armed?: unknown; undeclared?: unknown; staleAcknowledgements?: unknown } | null;
  /** Critical state obligations. Armed + failing/unresolved/contradictory fails closed. */
  criticalStates?: { armed?: unknown; failing?: unknown; unresolved?: unknown; contradictory?: unknown } | null;
};

export type CertificationEvidenceDecision = { certifies: boolean; interactionStatesComplete: boolean };

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function entryCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** An armed ledger with entries in any of the blocking lists cannot certify. */
function armedLedgerBlocks(ledger: { armed?: unknown } | null | undefined, lists: unknown[]): boolean {
  if (!ledger || typeof ledger !== 'object' || ledger.armed !== true) return false;
  return lists.some((list) => entryCount(list) > 0);
}

/** Each evidence check that, when true, cannot be cleared by visual approval. */
const CERTIFICATION_BLOCKERS: ((r: CertificationEvidenceReceipt) => boolean)[] = [
  (r) => r.sourceBinding?.status !== 'bound',
  (r) => r.coverage?.basis !== 'complete',
  (r) => r.determinism?.status !== 'proven',
  (r) => finiteCount(r.confidence?.counts?.inaccessible) !== 0,
  (r) => r.comparison?.blocksCertification === true,
  (r) => r.reportConsistency?.ok === false,
  (r) => r.reportConsistency?.reason === 'raw_only_no_reviewable',
  (r) => r.liveTextFreeze?.violated === true,
  (r) => entryCount(r.volatility?.headOnly) > 0,
  (r) => r.statesUncertified !== 0,
  (r) => armedLedgerBlocks(r.legacyPairs, [r.legacyPairs?.undeclared, r.legacyPairs?.staleAcknowledgements]),
  (r) =>
    armedLedgerBlocks(r.criticalStates, [
      r.criticalStates?.failing,
      r.criticalStates?.unresolved,
      r.criticalStates?.contradictory,
    ]),
];

/** Assess the closed set of evidence that cannot be cleared by visual approval. */
export function assessCertificationEvidence(receipt: CertificationEvidenceReceipt): CertificationEvidenceDecision {
  return {
    certifies: !CERTIFICATION_BLOCKERS.some((blocks) => blocks(receipt)),
    interactionStatesComplete: receipt.statesUncertified === 0,
  };
}

export type StyleProofVerdictReceipt = CertificationEvidenceReceipt & {
  reviewableCounts?: { dom?: unknown; style?: unknown; state?: unknown } | null;
  surfaces?: unknown;
  inventory?: { added?: unknown; removed?: unknown; unacknowledged?: unknown; staleAcknowledgements?: unknown } | null;
  dataResidue?: { blocking?: unknown; unacknowledged?: unknown } | null;
  liveTextFreeze?: { violated?: unknown } | null;
};

export type StyleProofVerdictOptions = { gateInventoryRemovals: boolean; baseCaptureFailed: boolean; changed: boolean };

export type StyleProofVerdict = { state: StyleProofTrustState; reviewableChanged: boolean; dataResidueKeys: string[] };

function reviewableCount(receipt: StyleProofVerdictReceipt): number {
  return (['dom', 'style', 'state'] as const).reduce(
    (total, kind) => total + finiteCount(receipt.reviewableCounts?.[kind]),
    0,
  );
}

function residueKeys(receipt: StyleProofVerdictReceipt): string[] {
  if (!Array.isArray(receipt.dataResidue?.unacknowledged)) return [];
  return receipt.dataResidue.unacknowledged.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    const key = entry && typeof entry === 'object' ? (entry as { key?: unknown }).key : undefined;
    return typeof key === 'string' ? [key] : [];
  });
}

/** A removed surface, or a new one not explained by a baseline capture failure, is reviewable. */
function hasReviewableSurface(surfaces: unknown, explained: Set<unknown>): boolean {
  if (!Array.isArray(surfaces)) return false;
  return surfaces.some((surface) => {
    if (!surface || typeof surface !== 'object') return false;
    const { missing, surface: key } = surface as { missing?: unknown; surface?: unknown };
    return missing === 'after' || (missing === 'before' && !explained.has(key));
  });
}

/** Classify one diff receipt using the same precedence the composite Action exposes. */
export function classifyStyleProofVerdict(
  receipt: StyleProofVerdictReceipt,
  options: StyleProofVerdictOptions,
): StyleProofVerdict {
  const explainedMissing = receipt.explainedMissingBaselineSurfaces;
  const explained = new Set(Array.isArray(explainedMissing) ? explainedMissing : []);
  const reviewableChanged =
    reviewableCount(receipt) > 0 ||
    hasReviewableSurface(receipt.surfaces, explained) ||
    entryCount(receipt.inventory?.added) > 0 ||
    entryCount(receipt.inventory?.removed) > 0;
  const inventoryFailures = options.gateInventoryRemovals
    ? entryCount(receipt.inventory?.unacknowledged) + entryCount(receipt.inventory?.staleAcknowledgements)
    : 0;
  const partialBaseline = receipt.partialBaseline === true || entryCount(explainedMissing) > 0;
  // First matching rule wins; precedence mirrors the composite Action.
  const rules: [boolean, StyleProofTrustState][] = [
    [finiteCount(receipt.dataResidue?.blocking) > 0, 'DATA_RESIDUE_UNACKNOWLEDGED'],
    [inventoryFailures > 0, 'INVENTORY_REMOVAL_UNACKNOWLEDGED'],
    [options.baseCaptureFailed, 'DEGRADED_BASELINE'],
    [!assessCertificationEvidence(receipt).certifies, 'CERTIFICATION_FAILED'],
    [partialBaseline, 'PARTIAL_BASELINE'],
    [options.changed, 'STYLE_REVIEW_REQUIRED'],
  ];
  const state = rules.find(([hit]) => hit)?.[1] ?? 'NO_REVIEWABLE_STYLE_CHANGES';
  return { state, reviewableChanged, dataResidueKeys: residueKeys(receipt) };
}
