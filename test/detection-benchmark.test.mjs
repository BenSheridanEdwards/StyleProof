import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertBenchmarkSourceBinding,
  isSafeBenchmarkCaseId,
  resolveNewBenchmarkOutput,
  validateDetectionBenchmarkReceipt,
} from '../dist/detection-benchmark.js';

const SHA = '8'.repeat(40);
const DIGEST = 'a'.repeat(64);

function renderProof(changed) {
  return {
    expectedChange: changed,
    observedPropertyChange: changed,
    observedPixelChange: changed,
    changedPixels: changed ? 12 : 0,
    propertyMatches: true,
    proofMatches: true,
    before: 'before',
    after: 'after',
  };
}

function validReceipt() {
  return {
    schemaVersion: 1,
    benchmark: 'styleproof-detection-rate',
    scope: { kind: 'pilot', issue: 447, full447: false },
    bindings: {
      sourceSha: SHA,
      packageVersion: '6.3.0',
      browser: { name: 'chromium', version: '1.2.3.4' },
      runner: {
        node: 'v22.1.0',
        platform: 'darwin',
        release: '25.0.0',
        arch: 'arm64',
        osVersion: '26.0',
        osBuild: '25A1',
      },
      sensor: {
        name: 'captureStyleMap+diffStyleMaps',
        contractVersion: 1,
        digest: 'c'.repeat(64),
        sourceDigest: 'd'.repeat(64),
      },
      corpus: { id: 'styleproof-issue447-phase0-pilot', version: '1.0.0', digest: DIGEST, cardinality: 4 },
    },
    counts: {
      requested: 4,
      executed: 4,
      valid: 4,
      detected: 3,
      missed: 0,
      unsupported: 0,
      skipped: 0,
      timeout: 0,
      invalid: 0,
      duplicate: 0,
      noOpFalsePositives: 0,
      noOpTrueNegatives: 1,
    },
    cases: [
      { id: 'a', outcome: 'detected', renderProof: renderProof(true) },
      { id: 'b', outcome: 'detected', renderProof: renderProof(true) },
      { id: 'c', outcome: 'detected', renderProof: renderProof(true) },
      { id: 'd', outcome: 'no-op-true-negative', renderProof: renderProof(false) },
    ],
    full447: { status: 'not-run', claimed: false },
  };
}

const expected = {
  sourceSha: SHA,
  corpusId: 'styleproof-issue447-phase0-pilot',
  corpusVersion: '1.0.0',
  corpusDigest: DIGEST,
  corpusCardinality: 4,
  scopeKind: 'pilot',
  cases: [
    { id: 'a', renderChanged: true },
    { id: 'b', renderChanged: true },
    { id: 'c', renderChanged: true },
    { id: 'd', renderChanged: false },
  ],
};

test('accepts one complete, internally consistent pilot receipt', () => {
  assert.deepEqual(validateDetectionBenchmarkReceipt(validReceipt(), expected), { ok: true, reasons: [] });
});

test('rejects an incomplete receipt with a missing required counter', () => {
  const receipt = validReceipt();
  delete receipt.counts.timeout;
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('counts.timeout')));
});

test('rejects malformed counter types instead of coercing them', () => {
  const receipt = validReceipt();
  receipt.counts.invalid = '0';
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('counts.invalid')));
});

test('rejects conflicting totals even when every field is present', () => {
  const receipt = validReceipt();
  receipt.counts.valid = 3;
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('valid total')));
});

test('rejects stale or incompatible source and corpus bindings', () => {
  const receipt = validReceipt();
  receipt.bindings.sourceSha = '7'.repeat(40);
  receipt.bindings.corpus.digest = 'b'.repeat(64);
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('sourceSha')));
  assert.ok(result.reasons.some((reason) => reason.includes('corpus.digest')));
});

test('a pilot receipt cannot claim a full issue #447 run', () => {
  const receipt = validReceipt();
  receipt.full447 = { status: 'complete', claimed: true };
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('full447')));
});

test('rejects missing, unexpected, or duplicate case identities even when totals still balance', () => {
  const receipt = validReceipt();
  receipt.cases[1].id = 'a';
  receipt.cases[2].id = 'invented';
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('duplicates')));
  assert.ok(result.reasons.some((reason) => reason.includes('not in the frozen')));
  assert.ok(result.reasons.some((reason) => reason.includes('is missing')));
});

test('rejects scored outcomes without typed independent render proof', () => {
  const receipt = validReceipt();
  delete receipt.cases[0].renderProof;
  receipt.cases[3].renderProof.changedPixels = 1;
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('renderProof')));
  assert.ok(result.reasons.some((reason) => reason.includes('changedPixels')));
});

test('rejects unsafe output paths and any pre-existing output directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-benchmark-output-'));
  try {
    assert.throws(() => resolveNewBenchmarkOutput(root, '../outside'), /new child/);
    assert.throws(() => resolveNewBenchmarkOutput(root, 'docs/proof/issue-447'), /new child/);
    const existing = path.join(root, 'docs/proof/issue-447/existing');
    fs.mkdirSync(existing, { recursive: true });
    assert.throws(() => resolveNewBenchmarkOutput(root, 'docs/proof/issue-447/existing'), /already exists/);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'docs/proof/issue-447/link'));
    assert.throws(() => resolveNewBenchmarkOutput(root, 'docs/proof/issue-447/link/run'), /symbolic link/);
    assert.equal(
      resolveNewBenchmarkOutput(root, 'docs/proof/issue-447/new-run'),
      path.join(root, 'docs/proof/issue-447/new-run'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('case IDs cannot escape their artifact directory', () => {
  assert.equal(isSafeBenchmarkCaseId('computed-rest-background-v1'), true);
  for (const value of ['../escape', 'nested/path', '/absolute', '', 'UPPER'])
    assert.equal(isSafeBenchmarkCaseId(value), false);
});

test('source binding reads actual Git HEAD and rejects a dirty relevant source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-benchmark-source-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Benchmark Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'benchmark@example.test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'sensor.ts'), 'export const sensor = 1;\n');
    execFileSync('git', ['add', 'sensor.ts'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'test: fixture'], { cwd: root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.deepEqual(assertBenchmarkSourceBinding(root, head, ['sensor.ts']), { sourceSha: head });
    assert.throws(() => assertBenchmarkSourceBinding(root, '0'.repeat(40), ['sensor.ts']), /actual Git HEAD/);
    fs.writeFileSync(path.join(root, 'untracked.ts'), 'export const extra = 1;\n');
    assert.throws(() => assertBenchmarkSourceBinding(root, head, ['sensor.ts', 'untracked.ts']), /must be tracked/);
    fs.writeFileSync(path.join(root, 'sensor.ts'), 'export const sensor = 2;\n');
    assert.throws(() => assertBenchmarkSourceBinding(root, head, ['sensor.ts']), /differs from recorded Git HEAD/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
