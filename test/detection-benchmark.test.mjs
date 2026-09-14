import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertBenchmarkSourceBinding,
  createBenchmarkPublication,
  discardBenchmark,
  isSafeBenchmarkCaseId,
  resolveNewBenchmarkOutput,
  publishBenchmark,
  settleBenchmarkTask,
  validateDetectionBenchmarkReceipt,
} from '../dist/detection-benchmark.js';

const SHA = '8'.repeat(40);
const DIGEST = 'a'.repeat(64);
const SENSOR_DIGEST = 'c'.repeat(64);
const SENSOR_SOURCE_DIGEST = 'd'.repeat(64);
const EXPECTATION_DIGEST = '1'.repeat(64);
const REVIEW_DIGEST = '2'.repeat(64);

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

function caseReceipt(id, caseClass, outcome, changed, findings) {
  const screenshot = (side) => ({
    path: `cases/${id}/${side}.png`,
    sha256: !changed || side === 'before' ? 'e'.repeat(64) : 'f'.repeat(64),
    width: 10,
    height: 10,
    bytes: 100,
  });
  return {
    id,
    class: caseClass,
    outcome,
    renderProof: renderProof(changed),
    findingCount: findings.length,
    findings,
    screenshots: [screenshot('before'), screenshot('after')],
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
        contractVersion: 2,
        digest: SENSOR_DIGEST,
        sourceDigest: SENSOR_SOURCE_DIGEST,
        buildCommand: 'npm run clean && npm run build',
      },
      corpus: {
        id: 'styleproof-issue447-phase0-pilot',
        version: '1.0.0',
        digest: DIGEST,
        expectationDigest: EXPECTATION_DIGEST,
        reviewDigest: REVIEW_DIGEST,
        cardinality: 4,
      },
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
      caseReceipt('a', 'computed-style', 'detected', true, [{ kind: 'style', props: [{ prop: 'background-color' }] }]),
      caseReceipt('b', 'computed-style', 'detected', true, [{ kind: 'style', props: [{ prop: 'color' }] }]),
      caseReceipt('c', 'cross-element-state', 'detected', true, [
        { kind: 'state', state: 'hover', props: [{ prop: 'background-color' }] },
      ]),
      caseReceipt('d', 'no-op-control', 'no-op-true-negative', false, []),
    ],
    full447: { status: 'not-run', claimed: false },
  };
}

const expected = {
  sourceSha: SHA,
  corpusId: 'styleproof-issue447-phase0-pilot',
  corpusVersion: '1.0.0',
  corpusDigest: DIGEST,
  expectationDigest: EXPECTATION_DIGEST,
  reviewDigest: REVIEW_DIGEST,
  corpusCardinality: 4,
  scopeKind: 'pilot',
  sensorDigest: SENSOR_DIGEST,
  sensorSourceDigest: SENSOR_SOURCE_DIGEST,
  cases: [
    {
      id: 'a',
      class: 'computed-style',
      renderChanged: true,
      detected: true,
      findingKind: 'style',
      findingProperty: 'background-color',
    },
    {
      id: 'b',
      class: 'computed-style',
      renderChanged: true,
      detected: true,
      findingKind: 'style',
      findingProperty: 'color',
    },
    {
      id: 'c',
      class: 'cross-element-state',
      renderChanged: true,
      detected: true,
      findingKind: 'state',
      findingState: 'hover',
      findingProperty: 'background-color',
    },
    { id: 'd', class: 'no-op-control', renderChanged: false, detected: false },
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

test('rejects substituted executable or source digests', () => {
  const receipt = validReceipt();
  receipt.bindings.sensor.digest = 'f'.repeat(64);
  delete receipt.bindings.sensor.sourceDigest;
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('sensor.digest')));
  assert.ok(result.reasons.some((reason) => reason.includes('sensor.sourceDigest')));
});

test('rejects swapped positive/no-op outcomes but allows an honest positive miss', () => {
  const swapped = validReceipt();
  swapped.cases[0].outcome = 'no-op-true-negative';
  swapped.cases[3].outcome = 'detected';
  assert.equal(validateDetectionBenchmarkReceipt(swapped, expected).ok, false);

  const honestMiss = validReceipt();
  honestMiss.cases[0].outcome = 'missed';
  honestMiss.cases[0].findings = [];
  honestMiss.cases[0].findingCount = 0;
  honestMiss.counts.detected = 2;
  honestMiss.counts.missed = 1;
  assert.equal(validateDetectionBenchmarkReceipt(honestMiss, expected).ok, true);
});

test('rejects invented classes and altered frozen expectation bindings', () => {
  const receipt = validReceipt();
  receipt.cases[0].class = 'invented';
  receipt.bindings.corpus.expectationDigest = '9'.repeat(64);
  const result = validateDetectionBenchmarkReceipt(receipt, expected);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('cases[0].class')));
  assert.ok(result.reasons.some((reason) => reason.includes('corpus.expectationDigest')));
});

test('rejects erased or mismatched findings and finding counts', () => {
  const erased = validReceipt();
  erased.cases[0].findings = [];
  erased.cases[0].findingCount = 0;
  assert.equal(validateDetectionBenchmarkReceipt(erased, expected).ok, false);
  const mismatched = validReceipt();
  mismatched.cases[2].findings[0].state = 'focus';
  mismatched.cases[2].findingCount = 9;
  assert.equal(validateDetectionBenchmarkReceipt(mismatched, expected).ok, false);
});

test('rejects unsafe, incomplete, or duplicate screenshot artifacts', () => {
  const unsafe = validReceipt();
  unsafe.cases[0].screenshots[0].path = '../../outside.png';
  assert.equal(validateDetectionBenchmarkReceipt(unsafe, expected).ok, false);
  const incomplete = validReceipt();
  delete incomplete.cases[1].screenshots[0].sha256;
  assert.equal(validateDetectionBenchmarkReceipt(incomplete, expected).ok, false);
  const duplicate = validReceipt();
  duplicate.cases[2].screenshots[1] = { ...duplicate.cases[2].screenshots[0] };
  assert.equal(validateDetectionBenchmarkReceipt(duplicate, expected).ok, false);
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
      path.join(fs.realpathSync(root), 'docs/proof/issue-447/new-run'),
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

test('staged benchmark publication is atomic and failed staging can be discarded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-benchmark-publish-'));
  try {
    const failed = createBenchmarkPublication(root, 'docs/proof/issue-447/failed');
    fs.writeFileSync(path.join(failed.stagingDirectory, 'partial.json'), '{');
    discardBenchmark(failed);
    assert.equal(fs.existsSync(failed.finalDirectory), false);
    assert.equal(fs.existsSync(failed.stagingDirectory), false);

    const complete = createBenchmarkPublication(root, 'docs/proof/issue-447/complete');
    const receipt = validReceipt();
    for (const item of receipt.cases) {
      item.outcome = 'skipped';
      item.findingCount = 0;
      item.findings = [];
      item.screenshots = [];
      delete item.renderProof;
    }
    Object.assign(receipt.counts, {
      executed: 0,
      valid: 0,
      detected: 0,
      skipped: 4,
      noOpTrueNegatives: 0,
    });
    fs.writeFileSync(path.join(complete.stagingDirectory, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
    fs.writeFileSync(path.join(complete.stagingDirectory, 'README.md'), '# benchmark\n');
    publishBenchmark(complete, expected);
    assert.equal(fs.existsSync(complete.stagingDirectory), false);
    assert.equal(fs.existsSync(path.join(complete.finalDirectory, 'receipt.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('timed out benchmark work is aborted and settled before timeout returns', async () => {
  const events = [];
  const result = await settleBenchmarkTask(
    (signal) =>
      new Promise((resolve) => {
        const late = setTimeout(() => {
          events.push('late-write');
          resolve();
        }, 100);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(late);
            setTimeout(() => {
              events.push('aborted-and-settled');
              resolve();
            }, 5);
          },
          { once: true },
        );
      }),
    5,
  );
  assert.deepEqual(result, { timedOut: true });
  assert.deepEqual(events, ['aborted-and-settled']);
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.deepEqual(events, ['aborted-and-settled']);
});

test('all non-scored outcomes reject retained scored-case findings, screenshots, and render proof', () => {
  for (const outcome of ['unsupported', 'skipped', 'timeout', 'invalid', 'duplicate']) {
    const receipt = validReceipt();
    receipt.cases[0].outcome = outcome;
    receipt.counts.detected -= 1;
    receipt.counts.valid -= 1;
    if (outcome === 'skipped' || outcome === 'duplicate') {
      receipt.counts.executed -= 1;
      receipt.counts[outcome] += 1;
    } else {
      receipt.counts[outcome] += 1;
    }
    const result = validateDetectionBenchmarkReceipt(receipt, expected);
    assert.equal(result.ok, false, `${outcome} retained scored-case data`);
    assert.ok(
      result.reasons.some((reason) => reason.includes('findings')),
      `${outcome} findings`,
    );
    assert.ok(
      result.reasons.some((reason) => reason.includes('screenshots')),
      `${outcome} screenshots`,
    );
    assert.ok(
      result.reasons.some((reason) => reason.includes('renderProof')),
      `${outcome} renderProof`,
    );
  }
});

test('all non-scored outcomes accept only empty findings and screenshots without render proof', () => {
  for (const outcome of ['unsupported', 'skipped', 'timeout', 'invalid', 'duplicate']) {
    const receipt = validReceipt();
    receipt.cases[0].outcome = outcome;
    receipt.cases[0].findings = [];
    receipt.cases[0].findingCount = 0;
    receipt.cases[0].screenshots = [];
    delete receipt.cases[0].renderProof;
    receipt.counts.detected -= 1;
    receipt.counts.valid -= 1;
    if (outcome === 'skipped' || outcome === 'duplicate') {
      receipt.counts.executed -= 1;
      receipt.counts[outcome] += 1;
    } else {
      receipt.counts[outcome] += 1;
    }
    assert.deepEqual(validateDetectionBenchmarkReceipt(receipt, expected), { ok: true, reasons: [] }, outcome);
  }
});

test('receipt validation rejects undeclared regular files and symbolic links in the artifact root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-benchmark-inventory-'));
  try {
    const receipt = validReceipt();
    const expectedWithArtifacts = { ...expected, artifactRoot: root };
    for (const item of receipt.cases) {
      for (const screenshot of item.screenshots) {
        const absolute = path.join(root, screenshot.path);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        const bytes = Buffer.from([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 10, 0, 0, 0, 10,
        ]);
        fs.writeFileSync(absolute, bytes);
        screenshot.sha256 = '0'.repeat(64);
        screenshot.bytes = bytes.length;
      }
    }
    fs.writeFileSync(path.join(root, 'orphan.partial'), 'partial');
    let result = validateDetectionBenchmarkReceipt(receipt, expectedWithArtifacts);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('undeclared artifact')));
    fs.rmSync(path.join(root, 'orphan.partial'));
    fs.symlinkSync(path.join(root, receipt.cases[0].screenshots[0].path), path.join(root, 'orphan-link.png'));
    result = validateDetectionBenchmarkReceipt(receipt, expectedWithArtifacts);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('symbolic link')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('timed-out partial and detached late writes cannot reach published output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-benchmark-timeout-publish-'));
  const publication = createBenchmarkPublication(root, 'docs/proof/issue-447/timeout');
  try {
    const receipt = validReceipt();
    for (const item of receipt.cases) {
      item.outcome = 'skipped';
      item.findingCount = 0;
      item.findings = [];
      item.screenshots = [];
      delete item.renderProof;
    }
    Object.assign(receipt.counts, {
      executed: 0,
      valid: 0,
      detected: 0,
      skipped: 4,
      noOpTrueNegatives: 0,
    });
    fs.writeFileSync(path.join(publication.stagingDirectory, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
    fs.writeFileSync(path.join(publication.stagingDirectory, 'README.md'), '# benchmark\n');
    const partial = path.join(publication.stagingDirectory, 'cases/a/before.png');
    const late = path.join(publication.stagingDirectory, 'cases/a/late.png');
    const result = await settleBenchmarkTask(
      (signal) =>
        new Promise((resolve) => {
          fs.mkdirSync(path.dirname(partial), { recursive: true });
          fs.writeFileSync(partial, 'partial');
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => fs.writeFileSync(late, 'late'), 30);
              setTimeout(resolve, 1);
            },
            { once: true },
          );
        }),
      5,
    );
    assert.deepEqual(result, { timedOut: true });
    assert.throws(() => publishBenchmark(publication, expected), /undeclared artifact/);
    assert.equal(fs.existsSync(publication.finalDirectory), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(path.join(publication.finalDirectory, 'cases/a/late.png')), false);
  } finally {
    discardBenchmark(publication);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
