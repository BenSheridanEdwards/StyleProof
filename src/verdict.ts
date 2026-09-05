/** Shared certification and Action trust policy. Keep CLI and Action consumers on this one closed-set decision. */

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
};

export type CertificationEvidenceDecision = {
  certifies: boolean;
  interactionStatesComplete: boolean;
};

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function entryCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Assess the closed set of evidence that cannot be cleared by visual approval. */
export function assessCertificationEvidence(receipt: CertificationEvidenceReceipt): CertificationEvidenceDecision {
  const interactionStatesComplete = receipt.statesUncertified === 0;
  const rawOnlyNoReviewable =
    receipt.reportConsistency?.ok === false || receipt.reportConsistency?.reason === 'raw_only_no_reviewable';
  const certifies =
    receipt.sourceBinding?.status === 'bound' &&
    receipt.coverage?.basis === 'complete' &&
    receipt.determinism?.status === 'proven' &&
    finiteCount(receipt.confidence?.counts?.inaccessible) === 0 &&
    receipt.comparison?.blocksCertification !== true &&
    !rawOnlyNoReviewable &&
    interactionStatesComplete;
  return { certifies, interactionStatesComplete };
}

export type StyleProofVerdictReceipt = CertificationEvidenceReceipt & {
  reviewableCounts?: { dom?: unknown; style?: unknown; state?: unknown } | null;
  surfaces?: unknown;
  inventory?: {
    added?: unknown;
    removed?: unknown;
    unacknowledged?: unknown;
    staleAcknowledgements?: unknown;
  } | null;
  dataResidue?: { blocking?: unknown; unacknowledged?: unknown } | null;
};

export type StyleProofVerdictOptions = {
  gateInventoryRemovals: boolean;
  baseCaptureFailed: boolean;
  changed: boolean;
};

export type StyleProofVerdict = {
  state: StyleProofTrustState;
  reviewableChanged: boolean;
  dataResidueKeys: string[];
};

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
    if (entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string') {
      return [(entry as { key: string }).key];
    }
    return [];
  });
}

/** Classify one diff receipt using the same precedence the composite Action exposes. */
export function classifyStyleProofVerdict(
  receipt: StyleProofVerdictReceipt,
  options: StyleProofVerdictOptions,
): StyleProofVerdict {
  const explained = new Set(
    Array.isArray(receipt.explainedMissingBaselineSurfaces) ? receipt.explainedMissingBaselineSurfaces : [],
  );
  const reviewableChanged =
    reviewableCount(receipt) > 0 ||
    (Array.isArray(receipt.surfaces) &&
      receipt.surfaces.some(
        (surface) =>
          surface &&
          typeof surface === 'object' &&
          ((surface as { missing?: unknown }).missing === 'after' ||
            ((surface as { missing?: unknown }).missing === 'before' &&
              !explained.has((surface as { surface?: unknown }).surface))),
      )) ||
    entryCount(receipt.inventory?.added) > 0 ||
    entryCount(receipt.inventory?.removed) > 0;
  const inventoryFailures = options.gateInventoryRemovals
    ? entryCount(receipt.inventory?.unacknowledged) + entryCount(receipt.inventory?.staleAcknowledgements)
    : 0;
  const certification = assessCertificationEvidence(receipt);
  const partialBaseline = receipt.partialBaseline === true || entryCount(receipt.explainedMissingBaselineSurfaces) > 0;

  let state: StyleProofTrustState = 'NO_REVIEWABLE_STYLE_CHANGES';
  if (finiteCount(receipt.dataResidue?.blocking) > 0) state = 'DATA_RESIDUE_UNACKNOWLEDGED';
  else if (inventoryFailures > 0) state = 'INVENTORY_REMOVAL_UNACKNOWLEDGED';
  else if (options.baseCaptureFailed) state = 'DEGRADED_BASELINE';
  else if (!certification.certifies) state = 'CERTIFICATION_FAILED';
  else if (partialBaseline) state = 'PARTIAL_BASELINE';
  else if (options.changed) state = 'STYLE_REVIEW_REQUIRED';

  return { state, reviewableChanged, dataResidueKeys: residueKeys(receipt) };
}
