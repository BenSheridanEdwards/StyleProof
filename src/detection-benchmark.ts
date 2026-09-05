export type DetectionBenchmarkReceiptExpectation = {
  sourceSha: string;
  corpusId: string;
  corpusVersion: string;
  corpusDigest: string;
  corpusCardinality: number;
  scopeKind: 'smoke' | 'pilot';
  requestedCardinality?: number;
  cases: readonly { id: string; renderChanged: boolean }[];
};

export type DetectionBenchmarkReceiptValidation = { ok: boolean; reasons: string[] };

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

const COUNTERS = [
  'requested',
  'executed',
  'valid',
  'detected',
  'missed',
  'unsupported',
  'skipped',
  'timeout',
  'invalid',
  'duplicate',
  'noOpFalsePositives',
  'noOpTrueNegatives',
] as const;

const OUTCOMES = new Set([
  'detected',
  'missed',
  'unsupported',
  'skipped',
  'timeout',
  'invalid',
  'duplicate',
  'no-op-false-positive',
  'no-op-true-negative',
]);

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function exactString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requireRecord(parent: JsonRecord | null, key: string, reasons: string[], path = key): JsonRecord | null {
  const value = parent ? record(parent[key]) : null;
  if (!value) reasons.push(`${path} must be an object`);
  return value;
}

function requireString(parent: JsonRecord | null, key: string, reasons: string[], path = key): string | null {
  const value = parent ? exactString(parent[key]) : null;
  if (!value) reasons.push(`${path} must be a non-empty string`);
  return value;
}

function bindingMatches(actual: unknown, expected: unknown, path: string, reasons: string[]): void {
  if (actual !== expected) reasons.push(`${path} does not match the requested run binding`);
}

function validateBindings(
  receipt: JsonRecord,
  expected: DetectionBenchmarkReceiptExpectation,
  reasons: string[],
): void {
  const bindings = requireRecord(receipt, 'bindings', reasons);
  const browser = requireRecord(bindings, 'browser', reasons, 'bindings.browser');
  const runner = requireRecord(bindings, 'runner', reasons, 'bindings.runner');
  const sensor = requireRecord(bindings, 'sensor', reasons, 'bindings.sensor');
  const corpus = requireRecord(bindings, 'corpus', reasons, 'bindings.corpus');
  requireString(bindings, 'packageVersion', reasons, 'bindings.packageVersion');
  const sourceSha = requireString(bindings, 'sourceSha', reasons, 'bindings.sourceSha');
  if (sourceSha && !/^[0-9a-f]{40}$/.test(sourceSha))
    reasons.push('bindings.sourceSha must be a full lowercase commit SHA');
  requireString(browser, 'name', reasons, 'bindings.browser.name');
  requireString(browser, 'version', reasons, 'bindings.browser.version');
  for (const key of ['node', 'platform', 'release', 'arch', 'osVersion', 'osBuild']) {
    requireString(runner, key, reasons, `bindings.runner.${key}`);
  }
  requireString(sensor, 'name', reasons, 'bindings.sensor.name');
  if (nonnegativeInteger(sensor?.contractVersion) === null)
    reasons.push('bindings.sensor.contractVersion must be a non-negative integer');
  const sensorDigest = requireString(sensor, 'digest', reasons, 'bindings.sensor.digest');
  if (sensorDigest && !/^[0-9a-f]{64}$/.test(sensorDigest))
    reasons.push('bindings.sensor.digest must be a SHA-256 digest');
  const corpusDigest = requireString(corpus, 'digest', reasons, 'bindings.corpus.digest');
  if (corpusDigest && !/^[0-9a-f]{64}$/.test(corpusDigest))
    reasons.push('bindings.corpus.digest must be a SHA-256 digest');
  if (nonnegativeInteger(corpus?.cardinality) === null)
    reasons.push('bindings.corpus.cardinality must be a non-negative integer');
  bindingMatches(sourceSha, expected.sourceSha, 'bindings.sourceSha', reasons);
  bindingMatches(corpus?.id, expected.corpusId, 'bindings.corpus.id', reasons);
  bindingMatches(corpus?.version, expected.corpusVersion, 'bindings.corpus.version', reasons);
  bindingMatches(corpusDigest, expected.corpusDigest, 'bindings.corpus.digest', reasons);
  bindingMatches(corpus?.cardinality, expected.corpusCardinality, 'bindings.corpus.cardinality', reasons);
}

function validateRenderProof(item: JsonRecord, expectedChange: boolean, index: number, reasons: string[]): void {
  const proof = requireRecord(item, 'renderProof', reasons, `cases[${index}].renderProof`);
  if (!proof) return;
  if (proof.expectedChange !== expectedChange)
    reasons.push(`cases[${index}].renderProof.expectedChange conflicts with frozen expectation`);
  if (proof.propertyMatches !== true || proof.proofMatches !== true)
    reasons.push(`cases[${index}].renderProof does not prove the frozen property values`);
  if (typeof proof.observedPropertyChange !== 'boolean' || proof.observedPropertyChange !== expectedChange) {
    reasons.push(`cases[${index}].renderProof.observedPropertyChange conflicts with frozen expectation`);
  }
  if (typeof proof.observedPixelChange !== 'boolean' || proof.observedPixelChange !== expectedChange) {
    reasons.push(`cases[${index}].renderProof.observedPixelChange conflicts with frozen expectation`);
  }
  const changedPixels = nonnegativeInteger(proof.changedPixels);
  if (changedPixels === null || (expectedChange ? changedPixels === 0 : changedPixels !== 0)) {
    reasons.push(`cases[${index}].renderProof.changedPixels conflicts with frozen expectation`);
  }
  requireString(proof, 'before', reasons, `cases[${index}].renderProof.before`);
  requireString(proof, 'after', reasons, `cases[${index}].renderProof.after`);
}

function validatedCounterValues(counts: JsonRecord | null, reasons: string[]): Record<string, number> | null {
  const values: Record<string, number> = {};
  for (const key of COUNTERS) {
    const value = nonnegativeInteger(counts?.[key]);
    if (value === null) reasons.push(`counts.${key} must be a non-negative integer`);
    else values[key] = value;
  }
  return Object.keys(values).length === COUNTERS.length ? values : null;
}

function validateCountArithmetic(
  values: Record<string, number>,
  expected: DetectionBenchmarkReceiptExpectation,
  reasons: string[],
): void {
  if (values.valid !== values.detected + values.missed + values.noOpFalsePositives + values.noOpTrueNegatives) {
    reasons.push('counts.valid total conflicts with scored mutation and no-op outcomes');
  }
  if (values.executed !== values.valid + values.unsupported + values.timeout + values.invalid) {
    reasons.push('counts.executed total conflicts with valid, unsupported, timeout, and invalid outcomes');
  }
  if (values.requested !== values.executed + values.skipped + values.duplicate) {
    reasons.push('counts.requested total conflicts with executed, skipped, and duplicate outcomes');
  }
  if (expected.requestedCardinality !== undefined && values.requested !== expected.requestedCardinality) {
    reasons.push('counts.requested does not match the requested scope cardinality');
  }
}

function validateCaseIdentity(
  item: JsonRecord | null,
  index: number,
  seen: Set<string>,
  expectedById: Map<string, { id: string; renderChanged: boolean }>,
  outcome: string | null,
  reasons: string[],
): void {
  const id = item ? exactString(item.id) : null;
  if (!id) {
    reasons.push(`cases[${index}].id must be a non-empty string`);
    return;
  }
  if (seen.has(id)) {
    reasons.push(`cases[${index}].id duplicates ${id}`);
    return;
  }
  seen.add(id);
  const expectedCase = expectedById.get(id);
  if (!expectedCase) {
    reasons.push(`cases[${index}].id is not in the frozen selected corpus`);
    return;
  }
  if (item && ['detected', 'missed', 'no-op-false-positive', 'no-op-true-negative'].includes(outcome ?? '')) {
    validateRenderProof(item, expectedCase.renderChanged, index, reasons);
  }
}

function inspectCases(
  cases: unknown[],
  expected: DetectionBenchmarkReceiptExpectation,
  reasons: string[],
): Map<string, number> {
  const expectedById = new Map(expected.cases.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const outcomeCounts = new Map<string, number>();
  for (const [index, value] of cases.entries()) {
    const item = record(value);
    const outcome = item ? exactString(item.outcome) : null;
    validateCaseIdentity(item, index, seen, expectedById, outcome, reasons);
    if (!outcome || !OUTCOMES.has(outcome)) reasons.push(`cases[${index}].outcome is missing or unknown`);
    else outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
  }
  for (const id of expectedById.keys()) if (!seen.has(id)) reasons.push(`frozen selected case ${id} is missing`);
  return outcomeCounts;
}

function validateOutcomeCounts(
  values: Record<string, number>,
  outcomeCounts: Map<string, number>,
  reasons: string[],
): void {
  const pairs: Array<[string, string]> = [
    ['detected', 'detected'],
    ['missed', 'missed'],
    ['unsupported', 'unsupported'],
    ['skipped', 'skipped'],
    ['timeout', 'timeout'],
    ['invalid', 'invalid'],
    ['duplicate', 'duplicate'],
    ['noOpFalsePositives', 'no-op-false-positive'],
    ['noOpTrueNegatives', 'no-op-true-negative'],
  ];
  for (const [counter, outcome] of pairs) {
    if (values[counter] !== (outcomeCounts.get(outcome) ?? 0))
      reasons.push(`counts.${counter} conflicts with case outcomes`);
  }
}

function validateCounters(
  receipt: JsonRecord,
  expected: DetectionBenchmarkReceiptExpectation,
  reasons: string[],
): void {
  const counts = requireRecord(receipt, 'counts', reasons);
  const values = validatedCounterValues(counts, reasons);
  if (!values) return;
  validateCountArithmetic(values, expected, reasons);
  const cases = Array.isArray(receipt.cases) ? receipt.cases : null;
  if (!cases) {
    reasons.push('cases must be an array');
    return;
  }
  if (cases.length !== values.requested) reasons.push('cases cardinality conflicts with counts.requested');
  validateOutcomeCounts(values, inspectCases(cases, expected, reasons), reasons);
}
function validateScope(receipt: JsonRecord, expected: DetectionBenchmarkReceiptExpectation, reasons: string[]): void {
  const scope = requireRecord(receipt, 'scope', reasons);
  const full447 = requireRecord(receipt, 'full447', reasons);
  bindingMatches(scope?.kind, expected.scopeKind, 'scope.kind', reasons);
  if (scope?.issue !== 447) reasons.push('scope.issue must equal 447');
  if (scope?.full447 !== false) reasons.push('scope.full447 must be false for this bounded implementation');
  if (full447?.claimed !== false || full447?.status !== 'not-run') {
    reasons.push('full447 must be not-run and unclaimed; this implementation cannot validate full447');
  }
}
function validateReceipt(
  input: unknown,
  expected: DetectionBenchmarkReceiptExpectation,
): DetectionBenchmarkReceiptValidation {
  const reasons: string[] = [];
  const receipt = record(input);
  if (!receipt) return { ok: false, reasons: ['receipt must be an object'] };
  if (receipt.schemaVersion !== 1) reasons.push('schemaVersion must equal 1');
  if (receipt.benchmark !== 'styleproof-detection-rate')
    reasons.push('benchmark must identify styleproof-detection-rate');
  validateScope(receipt, expected, reasons);
  validateBindings(receipt, expected, reasons);
  validateCounters(receipt, expected, reasons);
  return { ok: reasons.length === 0, reasons };
}

/** Fail-closed structural and binding validation for a benchmark receipt. */
export function validateDetectionBenchmarkReceipt(
  input: unknown,
  expected: DetectionBenchmarkReceiptExpectation,
): DetectionBenchmarkReceiptValidation {
  try {
    return validateReceipt(input, expected);
  } catch {
    return { ok: false, reasons: ['receipt could not be inspected safely'] };
  }
}

const SAFE_CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSafeBenchmarkCaseId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CASE_ID.test(value) && value.length <= 96;
}

/** Resolve a new proof folder without permitting deletion or writes outside the fixed issue proof root. */
export function resolveNewBenchmarkOutput(repositoryRoot: string, requested: string): string {
  const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
  const proofRoot = path.resolve(canonicalRepositoryRoot, 'docs', 'proof', 'issue-447');
  const output = path.resolve(canonicalRepositoryRoot, requested);
  if (output === proofRoot || !output.startsWith(`${proofRoot}${path.sep}`)) {
    throw new Error('benchmark output must be a new child of docs/proof/issue-447');
  }
  const relative = path.relative(canonicalRepositoryRoot, output);
  let cursor = canonicalRepositoryRoot;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error('benchmark output path must not traverse a symbolic link');
    }
  }
  if (fs.existsSync(output)) throw new Error('benchmark output already exists; refusing destructive overwrite');
  return output;
}

export type BenchmarkSourceBinding = { sourceSha: string };

/** Bind the run to the actual clean Git head, never a caller-supplied label. */
export function assertBenchmarkSourceBinding(
  repositoryRoot: string,
  expectedSha: string | undefined,
  relevantPaths: readonly string[],
): BenchmarkSourceBinding {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('benchmark source is not a full Git commit SHA');
  if (expectedSha !== undefined && expectedSha !== sourceSha)
    throw new Error('expected source SHA does not match actual Git HEAD');
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', ...relevantPaths], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    });
  } catch {
    throw new Error('every benchmark source, runner, and corpus input must be tracked at Git HEAD');
  }
  for (const args of [
    ['diff', '--quiet', 'HEAD', '--', ...relevantPaths],
    ['diff', '--cached', '--quiet', 'HEAD', '--', ...relevantPaths],
  ]) {
    try {
      execFileSync('git', args, { cwd: repositoryRoot, stdio: 'pipe' });
    } catch {
      throw new Error('benchmark source, executable, or corpus differs from recorded Git HEAD');
    }
  }
  return { sourceSha };
}
