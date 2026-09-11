/**
 * Durable machine JSON + human summary audit trail for StyleProof runs.
 * Captures the full decision provenance: what was captured, compared, and why.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/581
 */

import type { StyleProofTrustState } from './verdict.js';

/** Current schema version. Bump on breaking changes. */
export const AUDIT_SCHEMA_VERSION = 1;

export const AUDIT_FILE_NAME = 'styleproof-audit.json';

// ─── Capture Phase ───────────────────────────────────────────────────────────

export type SkippedSurfaceReason = 'auth-boundary' | 'incomplete-ui' | 'timeout' | 'capture-error' | 'excluded';

export type SkippedSurface = {
  surface: string;
  reason: SkippedSurfaceReason;
  acknowledged: boolean;
};

export type CaptureAudit = {
  surfacesCaptured: number;
  surfacesSkipped: number;
  skippedReasons: SkippedSurface[];
  widthsPerSurface: Record<string, number[]>;
  totalMapsWritten: number;
  captureTimeMs: number;
};

// ─── Comparison Phase ────────────────────────────────────────────────────────

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

// ─── Trust Decision ──────────────────────────────────────────────────────────

export type TrustCheckResult = 'bound' | 'clean' | 'complete' | 'proven' | 'found' | 'advisory' | 'failed' | 'unknown';

export type TrustCheck = {
  check: string;
  result: TrustCheckResult;
  detail: string;
};

export type TrustDecision = {
  finalState: StyleProofTrustState;
  gateMode: 'certify' | 'review-gate' | 'migration' | 'advisory';
  reasons: TrustCheck[];
  exitCode: number;
  exitReason: string;
};

// ─── Budget ──────────────────────────────────────────────────────────────────

export type BudgetAudit = {
  surfaceTimeoutMs: number;
  totalBudgetMs: number;
  actualTimeMs: number;
  statesSkipped: number;
  statesSkippedReasons: string[];
};

// ─── Full Audit Receipt ──────────────────────────────────────────────────────

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

// ─── Builder Helpers ─────────────────────────────────────────────────────────

export function createEmptyCaptureAudit(): CaptureAudit {
  return {
    surfacesCaptured: 0,
    surfacesSkipped: 0,
    skippedReasons: [],
    widthsPerSurface: {},
    totalMapsWritten: 0,
    captureTimeMs: 0,
  };
}

export function createEmptyComparisonAudit(): ComparisonAudit {
  return {
    baselineSource: 'none',
    baselineSha: null,
    surfacesCompared: 0,
    surfacesNew: 0,
    surfacesRemoved: 0,
    changesFound: 0,
    contentChanges: 0,
  };
}

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

// ─── Schema Validation ───────────────────────────────────────────────────────

export type AuditValidationError = {
  field: string;
  message: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

const VALID_SKIPPED_REASONS: SkippedSurfaceReason[] = [
  'auth-boundary',
  'incomplete-ui',
  'timeout',
  'capture-error',
  'excluded',
];

const VALID_BASELINE_SOURCES: BaselineSource[] = ['exact-restore', 'ancestor-reuse', 'captured', 'degraded', 'none'];

const VALID_TRUST_CHECK_RESULTS: TrustCheckResult[] = [
  'bound',
  'clean',
  'complete',
  'proven',
  'found',
  'advisory',
  'failed',
  'unknown',
];

const VALID_GATE_MODES = ['certify', 'review-gate', 'migration', 'advisory'] as const;

const VALID_TRUST_STATES: StyleProofTrustState[] = [
  'NO_REVIEWABLE_STYLE_CHANGES',
  'STYLE_REVIEW_REQUIRED',
  'DATA_RESIDUE_UNACKNOWLEDGED',
  'INVENTORY_REMOVAL_UNACKNOWLEDGED',
  'CERTIFICATION_FAILED',
  'PARTIAL_BASELINE',
  'DEGRADED_BASELINE',
];

function validateSkippedSurface(value: unknown, index: number, errors: AuditValidationError[]): void {
  const prefix = `capture.skippedReasons[${index}]`;
  if (!isObject(value)) {
    errors.push({ field: prefix, message: 'must be an object' });
    return;
  }
  if (!isString(value.surface)) {
    errors.push({ field: `${prefix}.surface`, message: 'must be a string' });
  }
  if (!isString(value.reason) || !VALID_SKIPPED_REASONS.includes(value.reason as SkippedSurfaceReason)) {
    errors.push({
      field: `${prefix}.reason`,
      message: `must be one of: ${VALID_SKIPPED_REASONS.join(', ')}`,
    });
  }
  if (!isBoolean(value.acknowledged)) {
    errors.push({ field: `${prefix}.acknowledged`, message: 'must be a boolean' });
  }
}

function validateNonNegativeInteger(value: unknown, fieldName: string, errors: AuditValidationError[]): void {
  if (!isInteger(value) || (value as number) < 0) {
    errors.push({ field: fieldName, message: 'must be a non-negative integer' });
  }
}

function validateNonNegativeNumber(value: unknown, fieldName: string, errors: AuditValidationError[]): void {
  if (!isNumber(value) || (value as number) < 0) {
    errors.push({ field: fieldName, message: 'must be a non-negative number' });
  }
}

function validateSkippedReasonsArray(value: unknown, errors: AuditValidationError[]): void {
  if (!isArray(value)) {
    errors.push({ field: 'capture.skippedReasons', message: 'must be an array' });
    return;
  }
  (value as unknown[]).forEach((item, i) => validateSkippedSurface(item, i, errors));
}

function validateWidthsPerSurface(value: unknown, errors: AuditValidationError[]): void {
  if (!isObject(value)) {
    errors.push({ field: 'capture.widthsPerSurface', message: 'must be an object' });
    return;
  }
  for (const [surface, widths] of Object.entries(value as Record<string, unknown>)) {
    if (!isArray(widths) || !widths.every(isInteger)) {
      errors.push({ field: `capture.widthsPerSurface.${surface}`, message: 'must be an array of integers' });
    }
  }
}

function validateCaptureAudit(value: unknown, errors: AuditValidationError[]): void {
  if (!isObject(value)) {
    errors.push({ field: 'capture', message: 'must be an object' });
    return;
  }
  validateNonNegativeInteger(value.surfacesCaptured, 'capture.surfacesCaptured', errors);
  validateNonNegativeInteger(value.surfacesSkipped, 'capture.surfacesSkipped', errors);
  validateSkippedReasonsArray(value.skippedReasons, errors);
  validateWidthsPerSurface(value.widthsPerSurface, errors);
  validateNonNegativeInteger(value.totalMapsWritten, 'capture.totalMapsWritten', errors);
  validateNonNegativeNumber(value.captureTimeMs, 'capture.captureTimeMs', errors);
}

function validateComparisonAudit(value: unknown, errors: AuditValidationError[]): void {
  if (!isObject(value)) {
    errors.push({ field: 'comparison', message: 'must be an object' });
    return;
  }
  if (!isString(value.baselineSource) || !VALID_BASELINE_SOURCES.includes(value.baselineSource as BaselineSource)) {
    errors.push({
      field: 'comparison.baselineSource',
      message: `must be one of: ${VALID_BASELINE_SOURCES.join(', ')}`,
    });
  }
  if (value.baselineSha !== null && !isString(value.baselineSha)) {
    errors.push({ field: 'comparison.baselineSha', message: 'must be a string or null' });
  }
  if (!isInteger(value.surfacesCompared) || (value.surfacesCompared as number) < 0) {
    errors.push({ field: 'comparison.surfacesCompared', message: 'must be a non-negative integer' });
  }
  if (!isInteger(value.surfacesNew) || (value.surfacesNew as number) < 0) {
    errors.push({ field: 'comparison.surfacesNew', message: 'must be a non-negative integer' });
  }
  if (!isInteger(value.surfacesRemoved) || (value.surfacesRemoved as number) < 0) {
    errors.push({ field: 'comparison.surfacesRemoved', message: 'must be a non-negative integer' });
  }
  if (!isInteger(value.changesFound) || (value.changesFound as number) < 0) {
    errors.push({ field: 'comparison.changesFound', message: 'must be a non-negative integer' });
  }
  if (!isInteger(value.contentChanges) || (value.contentChanges as number) < 0) {
    errors.push({ field: 'comparison.contentChanges', message: 'must be a non-negative integer' });
  }
}

function validateTrustCheck(value: unknown, index: number, errors: AuditValidationError[]): void {
  const prefix = `trustDecision.reasons[${index}]`;
  if (!isObject(value)) {
    errors.push({ field: prefix, message: 'must be an object' });
    return;
  }
  if (!isString(value.check)) {
    errors.push({ field: `${prefix}.check`, message: 'must be a string' });
  }
  if (!isString(value.result) || !VALID_TRUST_CHECK_RESULTS.includes(value.result as TrustCheckResult)) {
    errors.push({
      field: `${prefix}.result`,
      message: `must be one of: ${VALID_TRUST_CHECK_RESULTS.join(', ')}`,
    });
  }
  if (!isString(value.detail)) {
    errors.push({ field: `${prefix}.detail`, message: 'must be a string' });
  }
}

function validateTrustDecision(value: unknown, errors: AuditValidationError[]): void {
  if (!isObject(value)) {
    errors.push({ field: 'trustDecision', message: 'must be an object' });
    return;
  }
  if (!isString(value.finalState) || !VALID_TRUST_STATES.includes(value.finalState as StyleProofTrustState)) {
    errors.push({
      field: 'trustDecision.finalState',
      message: `must be one of: ${VALID_TRUST_STATES.join(', ')}`,
    });
  }
  if (!isString(value.gateMode) || !VALID_GATE_MODES.includes(value.gateMode as (typeof VALID_GATE_MODES)[number])) {
    errors.push({
      field: 'trustDecision.gateMode',
      message: `must be one of: ${VALID_GATE_MODES.join(', ')}`,
    });
  }
  if (!isArray(value.reasons)) {
    errors.push({ field: 'trustDecision.reasons', message: 'must be an array' });
  } else {
    (value.reasons as unknown[]).forEach((item, i) => validateTrustCheck(item, i, errors));
  }
  if (!isInteger(value.exitCode)) {
    errors.push({ field: 'trustDecision.exitCode', message: 'must be an integer' });
  }
  if (!isString(value.exitReason)) {
    errors.push({ field: 'trustDecision.exitReason', message: 'must be a string' });
  }
}

function validateBudgetAudit(value: unknown, errors: AuditValidationError[]): void {
  if (!isObject(value)) {
    errors.push({ field: 'budget', message: 'must be an object' });
    return;
  }
  if (!isNumber(value.surfaceTimeoutMs) || (value.surfaceTimeoutMs as number) < 0) {
    errors.push({ field: 'budget.surfaceTimeoutMs', message: 'must be a non-negative number' });
  }
  if (!isNumber(value.totalBudgetMs) || (value.totalBudgetMs as number) < 0) {
    errors.push({ field: 'budget.totalBudgetMs', message: 'must be a non-negative number' });
  }
  if (!isNumber(value.actualTimeMs) || (value.actualTimeMs as number) < 0) {
    errors.push({ field: 'budget.actualTimeMs', message: 'must be a non-negative number' });
  }
  if (!isInteger(value.statesSkipped) || (value.statesSkipped as number) < 0) {
    errors.push({ field: 'budget.statesSkipped', message: 'must be a non-negative integer' });
  }
  if (!isArray(value.statesSkippedReasons) || !(value.statesSkippedReasons as unknown[]).every(isString)) {
    errors.push({ field: 'budget.statesSkippedReasons', message: 'must be an array of strings' });
  }
}

/**
 * Validate an audit object against the schema.
 * Returns an empty array if valid, or an array of validation errors.
 */
export function validateAudit(value: unknown): AuditValidationError[] {
  const errors: AuditValidationError[] = [];

  if (!isObject(value)) {
    errors.push({ field: '', message: 'audit must be an object' });
    return errors;
  }

  if (value.version !== AUDIT_SCHEMA_VERSION) {
    errors.push({ field: 'version', message: `must be ${AUDIT_SCHEMA_VERSION}` });
  }
  if (!isString(value.timestamp) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value.timestamp as string)) {
    errors.push({ field: 'timestamp', message: 'must be an ISO 8601 timestamp' });
  }
  if (!isString(value.runId)) {
    errors.push({ field: 'runId', message: 'must be a string' });
  }
  if (!isString(value.headSha)) {
    errors.push({ field: 'headSha', message: 'must be a string' });
  }
  if (value.baseSha !== null && !isString(value.baseSha)) {
    errors.push({ field: 'baseSha', message: 'must be a string or null' });
  }

  validateCaptureAudit(value.capture, errors);
  validateComparisonAudit(value.comparison, errors);
  validateTrustDecision(value.trustDecision, errors);

  if (value.budget !== undefined) {
    validateBudgetAudit(value.budget, errors);
  }

  return errors;
}

/**
 * Check if an audit object is valid. Throws if invalid.
 */
export function assertValidAudit(value: unknown): asserts value is StyleProofAudit {
  const errors = validateAudit(value);
  if (errors.length > 0) {
    const messages = errors.map((e) => `${e.field}: ${e.message}`).join('\n');
    throw new Error(`Invalid audit:\n${messages}`);
  }
}

// ─── Human Summary Rendering ─────────────────────────────────────────────────

function checkIcon(result: TrustCheckResult): string {
  switch (result) {
    case 'bound':
    case 'clean':
    case 'complete':
    case 'proven':
      return '✅';
    case 'found':
    case 'advisory':
      return '⚠️';
    case 'failed':
    case 'unknown':
      return '❌';
    default:
      return '❓';
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function renderResultLabel(audit: StyleProofAudit): string {
  if (audit.trustDecision.finalState === 'NO_REVIEWABLE_STYLE_CHANGES') return 'no reviewable changes';
  if (audit.trustDecision.finalState === 'STYLE_REVIEW_REQUIRED') {
    return `${formatNumber(audit.comparison.changesFound)} style change(s) (review recommended)`;
  }
  return audit.trustDecision.finalState.toLowerCase().replace(/_/g, ' ');
}

function renderCaptureSection(audit: StyleProofAudit): string[] {
  const lines: string[] = ['### Capture'];
  const skippedDetail = audit.capture.surfacesSkipped > 0 ? ` (${audit.capture.surfacesSkipped} skipped)` : '';
  lines.push(`- ✅ ${formatNumber(audit.capture.surfacesCaptured)} surface(s) captured${skippedDetail}`);
  lines.push(...renderSkippedReasons(audit.capture.skippedReasons));
  lines.push(...renderWidthsSummary(audit.capture));
  if (audit.capture.captureTimeMs > 0) {
    lines.push(`- ⏱️ Capture time: ${formatTime(audit.capture.captureTimeMs)}`);
  }
  lines.push('');
  return lines;
}

function renderSkippedReasons(skippedReasons: SkippedSurface[]): string[] {
  if (skippedReasons.length === 0) return [];
  const byReason = new Map<string, number>();
  const acknowledged = new Map<string, number>();
  for (const skip of skippedReasons) {
    byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1);
    if (skip.acknowledged) {
      acknowledged.set(skip.reason, (acknowledged.get(skip.reason) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  for (const [reason, count] of byReason) {
    const ack = acknowledged.get(reason) ?? 0;
    parts.push(ack > 0 ? `${count} ${reason} (${ack} acknowledged)` : `${count} ${reason}`);
  }
  return [`  - Skipped: ${parts.join(', ')}`];
}

function renderWidthsSummary(capture: CaptureAudit): string[] {
  const widthSet = new Set<number>();
  for (const widths of Object.values(capture.widthsPerSurface)) {
    for (const w of widths) widthSet.add(w);
  }
  const widthCount = widthSet.size;
  return [`- ✅ ${formatNumber(capture.totalMapsWritten)} map(s) across ${widthCount} width(s)`];
}

function renderComparisonSection(audit: StyleProofAudit): string[] {
  const lines: string[] = ['### Comparison'];
  if (audit.comparison.baselineSource === 'none') {
    lines.push('- ⚠️ No baseline available');
  } else {
    const baselineDetail = audit.comparison.baselineSha ? ` from ${audit.comparison.baselineSha.slice(0, 7)}` : '';
    lines.push(`- ✅ Baseline: ${audit.comparison.baselineSource}${baselineDetail}`);
  }
  if (audit.comparison.changesFound > 0) {
    lines.push(
      `- ⚠️ ${formatNumber(audit.comparison.changesFound)} style change(s) on ${formatNumber(audit.comparison.surfacesCompared)} surface(s)`,
    );
  } else if (audit.comparison.surfacesCompared > 0) {
    lines.push(`- ✅ ${formatNumber(audit.comparison.surfacesCompared)} surface(s) compared, no changes`);
  }
  if (audit.comparison.surfacesNew > 0) {
    lines.push(`- 🆕 ${formatNumber(audit.comparison.surfacesNew)} new surface(s)`);
  }
  if (audit.comparison.surfacesRemoved > 0) {
    lines.push(`- ❌ ${formatNumber(audit.comparison.surfacesRemoved)} removed surface(s)`);
  }
  lines.push('');
  return lines;
}

function renderTrustChecksSection(audit: StyleProofAudit): string[] {
  const lines: string[] = ['### Trust Checks', '| Check | Result | Detail |', '| --- | --- | --- |'];
  for (const check of audit.trustDecision.reasons) {
    lines.push(`| ${check.check} | ${checkIcon(check.result)} ${check.result} | ${check.detail} |`);
  }
  lines.push('');
  if (audit.trustDecision.gateMode === 'advisory') {
    lines.push('**Why advisory:** Changes are informational only and do not block CI.');
  } else if (audit.trustDecision.finalState !== 'NO_REVIEWABLE_STYLE_CHANGES') {
    lines.push(`**Exit reason:** ${audit.trustDecision.exitReason}`);
  }
  return lines;
}

function renderBudgetSection(budget: BudgetAudit): string[] {
  const lines: string[] = ['', '### Budget'];
  lines.push(`- Actual time: ${formatTime(budget.actualTimeMs)} / ${formatTime(budget.totalBudgetMs)} budget`);
  if (budget.statesSkipped > 0) {
    lines.push(`- ⚠️ ${formatNumber(budget.statesSkipped)} state(s) skipped`);
    for (const reason of budget.statesSkippedReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  return lines;
}

/** Render the human-readable audit summary as markdown lines. */
export function renderAuditSummary(audit: StyleProofAudit): string[] {
  const lines: string[] = [
    '## StyleProof Audit Summary',
    '',
    `**Run:** ${audit.runId} | **Mode:** ${audit.trustDecision.gateMode} | **Result:** ${renderResultLabel(audit)}`,
    '',
    ...renderCaptureSection(audit),
    ...renderComparisonSection(audit),
    ...renderTrustChecksSection(audit),
  ];
  if (audit.budget) lines.push(...renderBudgetSection(audit.budget));
  return lines;
}

/**
 * Render the audit summary as a single markdown string.
 */
export function formatAuditSummary(audit: StyleProofAudit): string {
  return renderAuditSummary(audit).join('\n');
}
