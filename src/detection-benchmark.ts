import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

export type DetectionBenchmarkCaseExpectation = {
  id: string;
  class: string;
  renderChanged: boolean;
  detected: boolean;
  findingKind?: string;
  findingState?: string;
  findingProperty?: string;
};

export type DetectionBenchmarkReceiptExpectation = {
  sourceSha: string;
  corpusId: string;
  corpusVersion: string;
  corpusDigest: string;
  expectationDigest: string;
  reviewDigest: string;
  corpusCardinality: number;
  scopeKind: 'smoke' | 'pilot';
  requestedCardinality?: number;
  sensorDigest: string;
  sensorSourceDigest: string;
  artifactRoot?: string;
  cases: readonly DetectionBenchmarkCaseExpectation[];
};

export type DetectionBenchmarkReceiptValidation = { ok: boolean; reasons: string[] };

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
const SAFE_CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}
function exactString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function requireRecord(parent: JsonRecord | null, key: string, reasons: string[], label = key): JsonRecord | null {
  const value = parent ? record(parent[key]) : null;
  if (!value) reasons.push(`${label} must be an object`);
  return value;
}
function requireString(parent: JsonRecord | null, key: string, reasons: string[], label = key): string | null {
  const value = parent ? exactString(parent[key]) : null;
  if (!value) reasons.push(`${label} must be a non-empty string`);
  return value;
}
function bindingMatches(actual: unknown, expected: unknown, label: string, reasons: string[]): void {
  if (actual !== expected) reasons.push(`${label} does not match the requested run binding`);
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
  for (const key of ['node', 'platform', 'release', 'arch', 'osVersion', 'osBuild'])
    requireString(runner, key, reasons, `bindings.runner.${key}`);
  requireString(sensor, 'name', reasons, 'bindings.sensor.name');
  requireString(sensor, 'buildCommand', reasons, 'bindings.sensor.buildCommand');
  if (sensor?.contractVersion !== 2) reasons.push('bindings.sensor.contractVersion must equal 2');
  bindingMatches(sensor?.buildCommand, 'npm run clean && npm run build', 'bindings.sensor.buildCommand', reasons);
  const sensorDigest = requireString(sensor, 'digest', reasons, 'bindings.sensor.digest');
  const sensorSourceDigest = requireString(sensor, 'sourceDigest', reasons, 'bindings.sensor.sourceDigest');
  if (sensorDigest && !SHA256.test(sensorDigest)) reasons.push('bindings.sensor.digest must be a SHA-256 digest');
  if (sensorSourceDigest && !SHA256.test(sensorSourceDigest))
    reasons.push('bindings.sensor.sourceDigest must be a SHA-256 digest');
  const corpusDigest = requireString(corpus, 'digest', reasons, 'bindings.corpus.digest');
  if (corpusDigest && !SHA256.test(corpusDigest)) reasons.push('bindings.corpus.digest must be a SHA-256 digest');
  if (nonnegativeInteger(corpus?.cardinality) === null)
    reasons.push('bindings.corpus.cardinality must be a non-negative integer');
  bindingMatches(sourceSha, expected.sourceSha, 'bindings.sourceSha', reasons);
  bindingMatches(sensorDigest, expected.sensorDigest, 'bindings.sensor.digest', reasons);
  bindingMatches(sensorSourceDigest, expected.sensorSourceDigest, 'bindings.sensor.sourceDigest', reasons);
  bindingMatches(corpus?.id, expected.corpusId, 'bindings.corpus.id', reasons);
  bindingMatches(corpus?.version, expected.corpusVersion, 'bindings.corpus.version', reasons);
  bindingMatches(corpusDigest, expected.corpusDigest, 'bindings.corpus.digest', reasons);
  bindingMatches(corpus?.expectationDigest, expected.expectationDigest, 'bindings.corpus.expectationDigest', reasons);
  bindingMatches(corpus?.reviewDigest, expected.reviewDigest, 'bindings.corpus.reviewDigest', reasons);
  bindingMatches(corpus?.cardinality, expected.corpusCardinality, 'bindings.corpus.cardinality', reasons);
}

function validateRenderProof(item: JsonRecord, expectedChange: boolean, index: number, reasons: string[]): void {
  const proof = requireRecord(item, 'renderProof', reasons, `cases[${index}].renderProof`);
  if (!proof) return;
  if (proof.expectedChange !== expectedChange)
    reasons.push(`cases[${index}].renderProof.expectedChange conflicts with frozen expectation`);
  if (proof.propertyMatches !== true || proof.proofMatches !== true)
    reasons.push(`cases[${index}].renderProof does not prove the frozen property values`);
  if (typeof proof.observedPropertyChange !== 'boolean' || proof.observedPropertyChange !== expectedChange)
    reasons.push(`cases[${index}].renderProof.observedPropertyChange conflicts with frozen expectation`);
  if (typeof proof.observedPixelChange !== 'boolean' || proof.observedPixelChange !== expectedChange)
    reasons.push(`cases[${index}].renderProof.observedPixelChange conflicts with frozen expectation`);
  const changedPixels = nonnegativeInteger(proof.changedPixels);
  if (changedPixels === null || (expectedChange ? changedPixels === 0 : changedPixels !== 0))
    reasons.push(`cases[${index}].renderProof.changedPixels conflicts with frozen expectation`);
  requireString(proof, 'before', reasons, `cases[${index}].renderProof.before`);
  requireString(proof, 'after', reasons, `cases[${index}].renderProof.after`);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function validateArtifactMetadata(
  meta: JsonRecord,
  label: string,
  reasons: string[],
): { digest: string | null; width: number | null; height: number | null; size: number | null } {
  const digest = requireString(meta, 'sha256', reasons, `${label}.sha256`);
  if (digest && !SHA256.test(digest)) reasons.push(`${label}.sha256 must be a SHA-256 digest`);
  const width = nonnegativeInteger(meta.width);
  const height = nonnegativeInteger(meta.height);
  const size = nonnegativeInteger(meta.bytes);
  if (!width) reasons.push(`${label}.width must be a positive integer`);
  if (!height) reasons.push(`${label}.height must be a positive integer`);
  if (!size) reasons.push(`${label}.bytes must be a positive integer`);
  return { digest, width, height, size };
}
function containedArtifact(root: string, relative: string, label: string, reasons: string[]): string | null {
  const canonicalRoot = fs.realpathSync(root);
  const absolute = path.resolve(canonicalRoot, relative);
  if (
    !absolute.startsWith(`${canonicalRoot}${path.sep}`) ||
    !fs.existsSync(absolute) ||
    !fs.statSync(absolute).isFile()
  ) {
    reasons.push(`${label}.path must name an existing contained regular file`);
    return null;
  }
  const real = fs.realpathSync(absolute);
  if (!real.startsWith(`${canonicalRoot}${path.sep}`)) {
    reasons.push(`${label}.path escapes the artifact root`);
    return null;
  }
  return real;
}
function validateArtifactBytes(
  file: string,
  metadata: ReturnType<typeof validateArtifactMetadata>,
  label: string,
  reasons: string[],
): void {
  const bytes = fs.readFileSync(file);
  const dimensions = pngDimensions(bytes);
  if (!dimensions) reasons.push(`${label}.path must be a PNG file`);
  if (metadata.digest && createHash('sha256').update(bytes).digest('hex') !== metadata.digest)
    reasons.push(`${label}.sha256 conflicts with artifact bytes`);
  if (metadata.size !== bytes.length) reasons.push(`${label}.bytes conflicts with artifact bytes`);
  if (dimensions && (metadata.width !== dimensions.width || metadata.height !== dimensions.height))
    reasons.push(`${label} dimensions conflict with artifact bytes`);
}
function validateArtifactFile(
  meta: JsonRecord,
  expectedPath: string,
  root: string | undefined,
  label: string,
  reasons: string[],
): void {
  bindingMatches(meta.path, expectedPath, `${label}.path`, reasons);
  const metadata = validateArtifactMetadata(meta, label, reasons);
  if (!root || meta.path !== expectedPath) return;
  const file = containedArtifact(root, expectedPath, label, reasons);
  if (file) validateArtifactBytes(file, metadata, label, reasons);
}
function validateScreenshots(
  item: JsonRecord,
  expected: DetectionBenchmarkCaseExpectation,
  index: number,
  root: string | undefined,
  reasons: string[],
): void {
  const screenshots = Array.isArray(item.screenshots) ? item.screenshots : null;
  if (!screenshots || screenshots.length !== 2) {
    reasons.push(`cases[${index}].screenshots must contain exact before and after artifacts`);
    return;
  }
  const records = screenshots.map(record);
  if (records.some((entry) => !entry)) {
    reasons.push(`cases[${index}].screenshots entries must be objects`);
    return;
  }
  const paths = [`cases/${expected.id}/before.png`, `cases/${expected.id}/after.png`];
  validateArtifactFile(records[0]!, paths[0], root, `cases[${index}].screenshots[0]`, reasons);
  validateArtifactFile(records[1]!, paths[1], root, `cases[${index}].screenshots[1]`, reasons);
  if (records[0]!.path === records[1]!.path) reasons.push(`cases[${index}].screenshots must be distinct artifacts`);
  const equalDigest = records[0]!.sha256 === records[1]!.sha256;
  if (equalDigest === expected.renderChanged)
    reasons.push(`cases[${index}].screenshot digests conflict with frozen render expectation`);
}

function findingMatches(value: unknown, expected: DetectionBenchmarkCaseExpectation): boolean {
  const finding = record(value);
  if (!finding || finding.kind !== expected.findingKind) return false;
  if (expected.findingState && finding.state !== expected.findingState) return false;
  if (!expected.findingProperty) return true;
  return (
    Array.isArray(finding.props) && finding.props.some((value) => record(value)?.prop === expected.findingProperty)
  );
}
function inspectedFindings(
  item: JsonRecord,
  index: number,
  reasons: string[],
): { findings: unknown[]; count: number | null } {
  const findings = Array.isArray(item.findings) ? item.findings : [];
  const count = nonnegativeInteger(item.findingCount);
  if (!Array.isArray(item.findings)) reasons.push(`cases[${index}].findings must be an array`);
  if (count === null || findings.length !== count) reasons.push(`cases[${index}].findingCount conflicts with findings`);
  return { findings, count };
}
function validatePositiveOutcome(
  outcome: string,
  findings: unknown[],
  expected: DetectionBenchmarkCaseExpectation,
  index: number,
  reasons: string[],
): void {
  if (!['detected', 'missed'].includes(outcome))
    reasons.push(`cases[${index}].outcome conflicts with frozen positive label`);
  const matched = findings.some((finding) => findingMatches(finding, expected));
  if ((outcome === 'detected') !== matched)
    reasons.push(`cases[${index}].outcome conflicts with the frozen expected finding`);
}
function validateNoOpOutcome(outcome: string, count: number | null, index: number, reasons: string[]): void {
  if (!['no-op-false-positive', 'no-op-true-negative'].includes(outcome))
    reasons.push(`cases[${index}].outcome conflicts with frozen no-op label`);
  if (outcome === 'no-op-true-negative' && count !== 0)
    reasons.push(`cases[${index}] no-op true negative must have zero findings`);
  if (outcome === 'no-op-false-positive' && count === 0)
    reasons.push(`cases[${index}] no-op false positive must have findings`);
}
function validateScoredCase(
  item: JsonRecord,
  expected: DetectionBenchmarkCaseExpectation,
  outcome: string,
  index: number,
  root: string | undefined,
  reasons: string[],
): void {
  validateRenderProof(item, expected.renderChanged, index, reasons);
  validateScreenshots(item, expected, index, root, reasons);
  const { findings, count } = inspectedFindings(item, index, reasons);
  if (expected.detected) validatePositiveOutcome(outcome, findings, expected, index, reasons);
  else validateNoOpOutcome(outcome, count, index, reasons);
}
function validateCase(
  item: JsonRecord | null,
  index: number,
  expected: DetectionBenchmarkCaseExpectation | undefined,
  outcome: string | null,
  root: string | undefined,
  reasons: string[],
): void {
  if (!item || !expected) return;
  bindingMatches(item.class, expected.class, `cases[${index}].class`, reasons);
  if (outcome && ['detected', 'missed', 'no-op-false-positive', 'no-op-true-negative'].includes(outcome))
    validateScoredCase(item, expected, outcome, index, root, reasons);
}
function inspectCaseEntry(
  value: unknown,
  index: number,
  expectedById: Map<string, DetectionBenchmarkCaseExpectation>,
  seen: Set<string>,
  root: string | undefined,
  reasons: string[],
): string | null {
  const item = record(value);
  const id = item ? exactString(item.id) : null;
  const outcome = item ? exactString(item.outcome) : null;
  if (!id) reasons.push(`cases[${index}].id must be a non-empty string`);
  else if (seen.has(id)) reasons.push(`cases[${index}].id duplicates ${id}`);
  else if (!expectedById.has(id)) reasons.push(`cases[${index}].id is not in the frozen selected corpus`);
  else seen.add(id);
  if (!outcome || !OUTCOMES.has(outcome)) reasons.push(`cases[${index}].outcome is missing or unknown`);
  validateCase(item, index, id ? expectedById.get(id) : undefined, outcome, root, reasons);
  return outcome && OUTCOMES.has(outcome) ? outcome : null;
}
function inspectCases(
  cases: unknown[],
  expected: DetectionBenchmarkReceiptExpectation,
  reasons: string[],
): Map<string, number> {
  const expectedById = new Map(expected.cases.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const outcomes = new Map<string, number>();
  for (const [index, value] of cases.entries()) {
    const outcome = inspectCaseEntry(value, index, expectedById, seen, expected.artifactRoot, reasons);
    if (outcome) outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  }
  for (const id of expectedById.keys()) if (!seen.has(id)) reasons.push(`frozen selected case ${id} is missing`);
  return outcomes;
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
  if (values.valid !== values.detected + values.missed + values.noOpFalsePositives + values.noOpTrueNegatives)
    reasons.push('counts.valid total conflicts with scored mutation and no-op outcomes');
  if (values.executed !== values.valid + values.unsupported + values.timeout + values.invalid)
    reasons.push('counts.executed total conflicts with valid, unsupported, timeout, and invalid outcomes');
  if (values.requested !== values.executed + values.skipped + values.duplicate)
    reasons.push('counts.requested total conflicts with executed, skipped, and duplicate outcomes');
  if (expected.requestedCardinality !== undefined && values.requested !== expected.requestedCardinality)
    reasons.push('counts.requested does not match the requested scope cardinality');
}
function validateOutcomeCounts(values: Record<string, number>, outcomes: Map<string, number>, reasons: string[]): void {
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
  for (const [counter, outcome] of pairs)
    if (values[counter] !== (outcomes.get(outcome) ?? 0))
      reasons.push(`counts.${counter} conflicts with case outcomes`);
}
function validateCounters(
  receipt: JsonRecord,
  expected: DetectionBenchmarkReceiptExpectation,
  reasons: string[],
): void {
  const values = validatedCounterValues(requireRecord(receipt, 'counts', reasons), reasons);
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
  if (full447?.claimed !== false || full447?.status !== 'not-run')
    reasons.push('full447 must be not-run and unclaimed; this implementation cannot validate full447');
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
export function isSafeBenchmarkCaseId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CASE_ID.test(value) && value.length <= 96;
}
export function resolveNewBenchmarkOutput(repositoryRoot: string, requested: string): string {
  const root = fs.realpathSync(repositoryRoot);
  const proofRoot = path.resolve(root, 'docs', 'proof', 'issue-447');
  const output = path.resolve(root, requested);
  if (output === proofRoot || !output.startsWith(`${proofRoot}${path.sep}`))
    throw new Error('benchmark output must be a new child of docs/proof/issue-447');
  let cursor = root;
  for (const segment of path.relative(root, output).split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
      throw new Error('benchmark output path must not traverse a symbolic link');
  }
  if (fs.existsSync(output)) throw new Error('benchmark output already exists; refusing destructive overwrite');
  return output;
}
export type BenchmarkSourceBinding = { sourceSha: string };
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

export type BenchmarkPublication = { finalDirectory: string; stagingDirectory: string };
export function createBenchmarkPublication(repositoryRoot: string, requested: string): BenchmarkPublication {
  const finalDirectory = resolveNewBenchmarkOutput(repositoryRoot, requested);
  const proofRoot = path.dirname(finalDirectory);
  fs.mkdirSync(proofRoot, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(proofRoot, '.benchmark-staging-'));
  return { finalDirectory, stagingDirectory };
}
export function publishBenchmark(publication: BenchmarkPublication): void {
  if (fs.existsSync(publication.finalDirectory)) throw new Error('benchmark final output already exists');
  fs.renameSync(publication.stagingDirectory, publication.finalDirectory);
}
export function discardBenchmark(publication: BenchmarkPublication): void {
  fs.rmSync(publication.stagingDirectory, { recursive: true, force: true });
}
export async function settleBenchmarkTask<T>(
  task: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const running = task(controller.signal);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('benchmark case timed out'));
    }, milliseconds);
  });
  try {
    return { timedOut: false, value: await Promise.race([running, timeout]) };
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    await running.catch(() => undefined);
    return { timedOut: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
