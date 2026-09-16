/** Durable machine-JSON audit trail for a StyleProof run: what was captured, compared, and why. */

import type { StyleProofTrustState } from './verdict.js';

/** Current schema version. Bump on breaking changes. */
export const AUDIT_SCHEMA_VERSION = 1;

export const AUDIT_FILE_NAME = 'styleproof-audit.json';

export type SkippedSurfaceReason = 'auth-boundary' | 'incomplete-ui' | 'timeout' | 'capture-error' | 'excluded';

export type SkippedSurface = { surface: string; reason: SkippedSurfaceReason; acknowledged: boolean };

export type CaptureAudit = {
  surfacesCaptured: number;
  surfacesSkipped: number;
  skippedReasons: SkippedSurface[];
  widthsPerSurface: Record<string, number[]>;
  totalMapsWritten: number;
  captureTimeMs: number;
};

export type BaselineSource = 'exact-restore' | 'ancestor-reuse' | 'captured' | 'degraded' | 'none';

export type ComparisonAudit = {
  baselineSource: BaselineSource;
  baselineSha: string | null;
  surfacesCompared: number;
  surfacesNew: number;
  surfacesRemoved: number;
  changesFound: number;
  contentChanges: number;
};

export type TrustCheckResult = 'bound' | 'clean' | 'complete' | 'proven' | 'found' | 'advisory' | 'failed' | 'unknown';

export type TrustCheck = { check: string; result: TrustCheckResult; detail: string };

export type TrustDecision = {
  finalState: StyleProofTrustState;
  gateMode: 'certify' | 'review-gate' | 'migration' | 'advisory';
  reasons: TrustCheck[];
  exitCode: number;
  exitReason: string;
};

export type BudgetAudit = {
  surfaceTimeoutMs: number;
  totalBudgetMs: number;
  actualTimeMs: number;
  statesSkipped: number;
  statesSkippedReasons: string[];
};

export type StyleProofAudit = {
  version: typeof AUDIT_SCHEMA_VERSION;
  timestamp: string;
  runId: string;
  headSha: string;
  baseSha: string | null;
  capture: CaptureAudit;
  comparison: ComparisonAudit;
  trustDecision: TrustDecision;
  budget?: BudgetAudit;
};

export const createEmptyCaptureAudit = (): CaptureAudit => ({
  surfacesCaptured: 0,
  surfacesSkipped: 0,
  skippedReasons: [],
  widthsPerSurface: {},
  totalMapsWritten: 0,
  captureTimeMs: 0,
});

export const createEmptyComparisonAudit = (): ComparisonAudit => ({
  baselineSource: 'none',
  baselineSha: null,
  surfacesCompared: 0,
  surfacesNew: 0,
  surfacesRemoved: 0,
  changesFound: 0,
  contentChanges: 0,
});

export type CreateAuditOptions = {
  runId: string;
  headSha: string;
  baseSha: string | null;
  capture?: Partial<CaptureAudit>;
  comparison?: Partial<ComparisonAudit>;
  trustDecision: TrustDecision;
  budget?: BudgetAudit;
};

export function createAudit(options: CreateAuditOptions): StyleProofAudit {
  return {
    version: AUDIT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    runId: options.runId,
    headSha: options.headSha,
    baseSha: options.baseSha,
    capture: { ...createEmptyCaptureAudit(), ...options.capture },
    comparison: { ...createEmptyComparisonAudit(), ...options.comparison },
    trustDecision: options.trustDecision,
    ...(options.budget ? { budget: options.budget } : {}),
  };
}
