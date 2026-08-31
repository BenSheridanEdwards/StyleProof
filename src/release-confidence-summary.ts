import {
  validateReleaseConfidenceManifest,
  type ReleaseConfidenceManifest,
  type ReleaseConfidenceManifestReason,
} from './release-confidence-manifest.js';

export type ReleaseConfidenceSummary = {
  kind: 'styleproof.release-confidence.summary';
  version: '0.1';
  presence: 'present' | 'present-invalid' | 'absent-legacy';
  certifies: boolean;
  status: 'valid' | 'invalid' | 'unproven';
  blocking: boolean;
  worstAxis: 'integrity' | 'comparability' | 'completeness' | 'none';
  declared: { surfaces: number; obligations: number; assertions: number };
  evidenced: { joins: number; completeDomains: number; requiredDomains: 6 };
  incomparable: string[];
  reasons: ReleaseConfidenceManifestReason[];
  manifestDigest?: string;
};

export function summarizeReleaseConfidence(input?: unknown): ReleaseConfidenceSummary {
  const receipt = validateReleaseConfidenceManifest(input);
  const manifest = receipt.presence === 'present' ? (input as ReleaseConfidenceManifest) : null;
  return {
    kind: 'styleproof.release-confidence.summary',
    version: '0.1',
    presence: receipt.presence,
    certifies: receipt.certifies,
    status: receipt.status,
    blocking: !receipt.certifies,
    worstAxis:
      receipt.presence !== 'present'
        ? 'integrity'
        : receipt.certifies
          ? 'none'
          : manifest && manifest.gaps.comparability.length > 0
            ? 'comparability'
            : 'completeness',
    declared: {
      surfaces: manifest?.declaredScope.surfaces.length ?? 0,
      obligations: manifest?.obligations.length ?? 0,
      assertions: manifest?.assertions.length ?? 0,
    },
    evidenced: {
      joins: manifest?.evidenceJoins.length ?? 0,
      completeDomains: manifest?.sourceRuns.filter((run) => run.execution === 'complete').length ?? 0,
      requiredDomains: 6,
    },
    incomparable: manifest?.gaps.comparability ?? [],
    reasons: receipt.reasons,
    ...(receipt.manifestDigest ? { manifestDigest: receipt.manifestDigest } : {}),
  };
}
