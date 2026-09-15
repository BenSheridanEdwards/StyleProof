/**
 * Honest baseline/compare failure attribution (#651).
 *
 * When `base-capture-failed=false` and a baseline or compare fault occurs, every
 * adopter-facing surface (receipt, report, audit, Action copy) must name the
 * failing surface and SHA and must not claim that a base recapture failed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import {
  baselineFailureReceipts,
  formatDegradedBaselineComment,
  formatDegradedBaselineFailEcho,
  formatDegradedBaselineStatusDescription,
  formatPartialBaselineComment,
  formatPartialBaselineFailEcho,
  formatPartialBaselineStatusDescription,
  honestBaselineCompareAttribution,
  MAP_MANIFEST,
  parseBaselineFailureReceipts,
} from '../dist/map-store.js';
import { classifyStyleProofVerdict } from '../dist/verdict.js';
import { formatIntegrityRepairComment, formatIntegrityStatusDescription } from '../dist/integrity-repair.js';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { createAudit, formatAuditSummary } from '../dist/audit.js';
import { mkTmp, rmTmp, makeMap, solidPng, fixtureCompatibilityKey, fixtureCommitSha } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');
const ACTION_YML = path.join(here, '..', 'action.yml');

const BASE_SHA = fixtureCommitSha('honest-baseline-attribution-base');
const HEAD_SHA = fixtureCommitSha('honest-baseline-attribution-head');
const FAILED_SURFACE = 'pricing@1280';

/** False claims that the CI recapture itself failed — not the honest negation. */
const FALSE_RECAPTURE_CLAIM = /base recapture failed|the base capture failed/i;

const writeCapture = (dir, surface, map, png = null) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  if (png) fs.writeFileSync(path.join(dir, `${surface}.png`), png);
};

const writeManifest = (dir, sha, surfaceCaptureFailures = []) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MAP_MANIFEST),
    JSON.stringify({
      version: 1,
      packageVersion: '6.0.0',
      sha,
      dirty: false,
      spec: 'test.spec.ts',
      specHash: 'a'.repeat(64),
      platform: 'linux',
      arch: 'x64',
      nodeMajor: '22',
      screenshots: true,
      har: false,
      compatibilityKey: fixtureCompatibilityKey('honest-attribution'),
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(surfaceCaptureFailures.length ? { surfaceCaptureFailures } : {}),
    }),
  );
};

function buildPartialBaselinePair(tmp) {
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');
  const map = makeMap({
    elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } },
  });
  writeCapture(beforeDir, 'home@1280', map, solidPng(100, 100));
  writeCapture(afterDir, 'home@1280', map, solidPng(100, 100));
  writeCapture(afterDir, FAILED_SURFACE, map, solidPng(100, 100));
  writeManifest(beforeDir, BASE_SHA, [{ key: FAILED_SURFACE, reason: 'timeout on base', kind: 'capture' }]);
  writeManifest(afterDir, HEAD_SHA);
  return { beforeDir, afterDir };
}

test('baselineFailureReceipts names the public surface key and the baseline SHA', () => {
  const receipts = baselineFailureReceipts(
    [{ key: FAILED_SURFACE, reason: 'Timeout waiting for navigation' }],
    BASE_SHA,
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].key, FAILED_SURFACE);
  assert.equal(receipts[0].reason, 'capture_failed');
  assert.equal(receipts[0].sha, BASE_SHA);
});

test('honest attribution: base-capture-failed=false is never a recapture failure', () => {
  const receipts = baselineFailureReceipts([{ key: FAILED_SURFACE, reason: 'timeout' }], BASE_SHA);
  const attribution = honestBaselineCompareAttribution({
    baseCaptureFailed: false,
    receipts,
  });
  assert.equal(attribution.failureClass, 'baseline_surface_capture');
  assert.equal(attribution.recaptureFailed, false);
  assert.match(attribution.summary, new RegExp(FAILED_SURFACE));
  assert.match(attribution.summary, new RegExp(BASE_SHA));
  assert.match(attribution.summary, /base-capture-failed=false/);
  assert.match(attribution.summary, /not a base recapture failure/i);
  assert.doesNotMatch(attribution.summary, FALSE_RECAPTURE_CLAIM);
});

test('honest attribution: compare fault with base-capture-failed=false names surface+SHA', () => {
  const attribution = honestBaselineCompareAttribution({
    baseCaptureFailed: false,
    compareSurfaces: [{ key: 'home@1280', sha: HEAD_SHA }],
  });
  assert.equal(attribution.failureClass, 'compare');
  assert.equal(attribution.recaptureFailed, false);
  assert.match(attribution.summary, /home@1280/);
  assert.match(attribution.summary, new RegExp(HEAD_SHA));
  assert.match(attribution.summary, /not a base recapture failure/i);
  assert.doesNotMatch(attribution.summary, FALSE_RECAPTURE_CLAIM);
});

test('honest attribution: base-capture-failed=true is the recapture / head-only class', () => {
  const attribution = honestBaselineCompareAttribution({
    baseCaptureFailed: true,
    receipts: baselineFailureReceipts([{ key: FAILED_SURFACE, reason: 'timeout' }], BASE_SHA),
  });
  assert.equal(attribution.failureClass, 'base_recapture');
  assert.equal(attribution.recaptureFailed, true);
  assert.match(attribution.summary, /base capture failed/i);
});

test('TDD fixture: base-capture-failed=false + baseline fault names surface+SHA and does not claim recapture', async () => {
  const tmp = mkTmp();
  try {
    const { beforeDir, afterDir } = buildPartialBaselinePair(tmp);
    const outDir = path.join(tmp, 'out');
    const result = await generateStyleMapReport({ beforeDir, afterDir, outDir });
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const md = fs.readFileSync(result.reportMdPath, 'utf8');

    assert.equal(json.partialBaseline, true);
    assert.equal(json.baselineFailures.length, 1);
    assert.equal(json.baselineFailures[0].key, FAILED_SURFACE);
    assert.equal(json.baselineFailures[0].sha, BASE_SHA);
    assert.equal(json.baselineFailures[0].reason, 'capture_failed');

    assert.match(md, new RegExp(FAILED_SURFACE));
    assert.match(md, new RegExp(BASE_SHA));
    assert.match(md, /not a base recapture failure/i);
    assert.match(md, /base-capture-failed=false/);
    assert.doesNotMatch(md, FALSE_RECAPTURE_CLAIM);
  } finally {
    rmTmp(tmp);
  }
});

test('diff CLI: partial baseline with base-capture-failed=false names surface+SHA, not recapture', () => {
  const tmp = mkTmp();
  try {
    const { beforeDir, afterDir } = buildPartialBaselinePair(tmp);
    const jsonPath = path.join(tmp, 'out.json');
    const r = spawnSync(process.execPath, [DIFF, beforeDir, afterDir, '--json', jsonPath], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(FAILED_SURFACE));
    assert.match(r.stdout, new RegExp(BASE_SHA));
    assert.match(r.stdout, /not a base recapture failure/i);
    assert.doesNotMatch(r.stdout, FALSE_RECAPTURE_CLAIM);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.deepEqual(parsed.baselineFailures, [{ key: FAILED_SURFACE, reason: 'capture_failed', sha: BASE_SHA }]);
    assert.equal(parsed.partialBaseline, true);
  } finally {
    rmTmp(tmp);
  }
});

test('audit trail names the baseline surface+SHA and does not claim recapture', () => {
  const receipts = baselineFailureReceipts([{ key: FAILED_SURFACE, reason: 'timeout' }], BASE_SHA);
  const attribution = honestBaselineCompareAttribution({
    baseCaptureFailed: false,
    receipts,
  });
  const audit = createAudit({
    runId: 'test-honest-attribution',
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    comparison: {
      baselineSource: 'exact-restore',
      baselineSha: BASE_SHA,
      surfacesCompared: 1,
      surfacesNew: 0,
      surfacesRemoved: 0,
      changesFound: 0,
      contentChanges: 0,
    },
    trustDecision: {
      finalState: 'PARTIAL_BASELINE',
      gateMode: 'certify',
      reasons: [
        {
          check: 'baseline-surface-capture',
          result: 'failed',
          detail: attribution.summary,
        },
      ],
      exitCode: 1,
      exitReason: attribution.summary,
    },
  });
  const rendered = formatAuditSummary(audit);
  assert.match(rendered, new RegExp(FAILED_SURFACE));
  assert.match(rendered, new RegExp(BASE_SHA));
  assert.match(rendered, /not a base recapture failure/i);
  assert.doesNotMatch(rendered, /base recapture failed/i);
});

test('published Action-copy proof stays in lockstep with the formatters', () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(here, '../docs/proof/honest-baseline-attribution/baseline-failures.json'), 'utf8'),
  );
  const proof = fs.readFileSync(path.join(here, '../docs/proof/action-baseline-copy/action-copy.md'), 'utf8');
  const comment = formatPartialBaselineComment(fixture.baselineFailures);
  const status = formatPartialBaselineStatusDescription(fixture.baselineFailures);
  const failEcho = formatPartialBaselineFailEcho(fixture.baselineFailures);
  assert.match(proof, new RegExp(escapeRegExp(comment)));
  assert.match(proof, new RegExp(escapeRegExp(status)));
  assert.match(proof, new RegExp(escapeRegExp(failEcho)));
  assert.match(proof, new RegExp(escapeRegExp(formatDegradedBaselineComment(false))));
  assert.match(proof, new RegExp(escapeRegExp(formatDegradedBaselineComment(true))));
  assert.doesNotMatch(formatDegradedBaselineComment(false), FALSE_RECAPTURE_CLAIM);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Action PARTIAL_BASELINE copy interpolates the receipt key and SHA', () => {
  const receipts = baselineFailureReceipts([{ key: FAILED_SURFACE, reason: 'timeout' }], BASE_SHA);
  const comment = formatPartialBaselineComment(receipts);
  const status = formatPartialBaselineStatusDescription(receipts);
  const failEcho = formatPartialBaselineFailEcho(receipts);

  for (const text of [comment, status, failEcho]) {
    assert.match(text, new RegExp(FAILED_SURFACE));
    assert.match(text, new RegExp(BASE_SHA));
    assert.match(text, /not a base recapture failure/i);
    assert.doesNotMatch(text, FALSE_RECAPTURE_CLAIM);
  }
  assert.ok(status.length <= 140, `commit-status description must fit GitHub's 140-char limit: ${status}`);

  const actionYml = fs.readFileSync(ACTION_YML, 'utf8');
  assert.match(actionYml, /formatPartialBaselineComment/);
  assert.match(actionYml, /formatPartialBaselineStatusDescription/);
  assert.match(actionYml, /formatPartialBaselineFailEcho/);
  assert.match(actionYml, /parseBaselineFailureReceipts/);
  const commentStep = actionYml.match(/- name: Upsert PR comment[\s\S]*?(?=\n\s{4}# Review-gate)/);
  const statusStep = actionYml.match(/- name: Set review status[\s\S]*?(?=\n\s{4}# A failed base capture)/);
  const partialGate = actionYml.match(/- name: Block on partial baseline[\s\S]*?(?=\n\s{4}# blocking)/);
  assert.ok(commentStep, 'PR comment step present');
  assert.ok(statusStep, 'commit-status step present');
  assert.ok(partialGate, 'partial-baseline fail step present');
  assert.match(commentStep[0], /formatPartialBaselineComment\(baselineFailures\)/);
  assert.match(statusStep[0], /formatPartialBaselineStatusDescription\(baselineFailures\)/);
  assert.match(partialGate[0], /formatPartialBaselineFailEcho/);
  assert.match(partialGate[0], /report\.baselineFailures/);
  assert.match(partialGate[0], /process\.exit\(1\)/);
  assert.doesNotMatch(partialGate[0], /require-approval/);
});

test('Action DEGRADED_BASELINE / head-only copy claims recapture only when the flag is true', () => {
  const headOnlyComment = formatDegradedBaselineComment(false);
  const headOnlyStatus = formatDegradedBaselineStatusDescription(false);
  const headOnlyFail = formatDegradedBaselineFailEcho(false);
  for (const text of [headOnlyComment, headOnlyStatus, headOnlyFail]) {
    assert.match(text, /head-only/i);
    assert.doesNotMatch(text, FALSE_RECAPTURE_CLAIM);
    assert.doesNotMatch(text, /base capture failed/i);
  }

  const recaptureComment = formatDegradedBaselineComment(true);
  const recaptureStatus = formatDegradedBaselineStatusDescription(true);
  const recaptureFail = formatDegradedBaselineFailEcho(true);
  for (const text of [recaptureComment, recaptureStatus, recaptureFail]) {
    assert.match(text, /base capture failed/i);
    assert.match(text, /head-only/i);
  }

  const actionYml = fs.readFileSync(ACTION_YML, 'utf8');
  assert.match(actionYml, /formatDegradedBaselineComment\(baseCaptureFailed\)/);
  assert.match(actionYml, /formatDegradedBaselineStatusDescription\(baseCaptureFailed\)/);
  const commentStep = actionYml.match(/- name: Upsert PR comment[\s\S]*?(?=\n\s{4}# Review-gate)/);
  const statusStep = actionYml.match(/- name: Set review status[\s\S]*?(?=\n\s{4}# A failed base capture)/);
  const degradedGate = actionYml.match(/- name: Block on degraded baseline[\s\S]*?(?=\n\s{4}# Partial baseline)/);
  assert.ok(commentStep && statusStep && degradedGate);
  assert.match(commentStep[0], /baseCaptureFailed = .*inputs\.base-capture-failed/);
  assert.match(statusStep[0], /baseCaptureFailed = .*inputs\.base-capture-failed/);
  assert.match(degradedGate[0], /inputs\.base-capture-failed == 'true'/);
  assert.match(degradedGate[0], /formatDegradedBaselineFailEcho\(true\)/);
  assert.match(degradedGate[0], /process\.exit\(1\)/);
  assert.doesNotMatch(degradedGate[0], /require-approval/);
});

test('Action PARTIAL_BASELINE and CERTIFICATION_FAILED copy do not claim recapture', () => {
  const actionYml = fs.readFileSync(ACTION_YML, 'utf8');
  assert.match(actionYml, /formatIntegrityRepairComment/);
  assert.match(actionYml, /formatPartialBaselineComment/);
  assert.match(actionYml, /formatDegradedBaselineComment/);

  const genericCert = formatIntegrityRepairComment([]);
  const genericStatus = formatIntegrityStatusDescription([]);
  assert.match(genericCert, /not a base recapture failure/i);
  assert.match(genericStatus, /not a base recapture failure/i);
  assert.doesNotMatch(genericCert, FALSE_RECAPTURE_CLAIM);
  assert.doesNotMatch(genericStatus, FALSE_RECAPTURE_CLAIM);

  const receipts = parseBaselineFailureReceipts(
    baselineFailureReceipts([{ key: FAILED_SURFACE, reason: 'timeout' }], BASE_SHA),
  );
  assert.equal(receipts[0]?.key, FAILED_SURFACE);
  assert.equal(receipts[0]?.sha, BASE_SHA);
  assert.doesNotMatch(formatPartialBaselineComment(receipts), FALSE_RECAPTURE_CLAIM);
  assert.doesNotMatch(formatDegradedBaselineComment(false), FALSE_RECAPTURE_CLAIM);
});

test('Action fail-echo snippets interpolate receipts and stay fail-closed', () => {
  const tmp = mkTmp();
  try {
    const receipts = baselineFailureReceipts([{ key: FAILED_SURFACE, reason: 'timeout' }], BASE_SHA);
    const reportDir = path.join(tmp, 'styleproof-report');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, 'report.json'),
      JSON.stringify({ baselineFailures: receipts, partialBaseline: true }),
    );
    const actionRoot = path.join(here, '..');
    const partial = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import fs from 'node:fs';
         const { formatPartialBaselineFailEcho, parseBaselineFailureReceipts } = await import(
           process.env.GITHUB_ACTION_PATH + '/dist/map-store.js'
         );
         const report = JSON.parse(fs.readFileSync('styleproof-report/report.json', 'utf8'));
         console.error(formatPartialBaselineFailEcho(parseBaselineFailureReceipts(report.baselineFailures)));
         process.exit(1);`,
      ],
      { cwd: tmp, encoding: 'utf8', env: { ...process.env, GITHUB_ACTION_PATH: actionRoot } },
    );
    assert.equal(partial.status, 1, partial.stderr + partial.stdout);
    assert.match(partial.stderr, new RegExp(FAILED_SURFACE));
    assert.match(partial.stderr, new RegExp(BASE_SHA));
    assert.doesNotMatch(partial.stderr, FALSE_RECAPTURE_CLAIM);

    const headOnly = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { formatDegradedBaselineFailEcho } = await import(
           process.env.GITHUB_ACTION_PATH + '/dist/map-store.js'
         );
         console.error(formatDegradedBaselineFailEcho(false));
         process.exit(1);`,
      ],
      { cwd: tmp, encoding: 'utf8', env: { ...process.env, GITHUB_ACTION_PATH: actionRoot } },
    );
    assert.equal(headOnly.status, 1, headOnly.stderr + headOnly.stdout);
    assert.doesNotMatch(headOnly.stderr, FALSE_RECAPTURE_CLAIM);
    assert.doesNotMatch(headOnly.stderr, /base capture failed/i);

    const recapture = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { formatDegradedBaselineFailEcho } = await import(
           process.env.GITHUB_ACTION_PATH + '/dist/map-store.js'
         );
         console.error(formatDegradedBaselineFailEcho(true));
         process.exit(1);`,
      ],
      { cwd: tmp, encoding: 'utf8', env: { ...process.env, GITHUB_ACTION_PATH: actionRoot } },
    );
    assert.equal(recapture.status, 1, recapture.stderr + recapture.stdout);
    assert.match(recapture.stderr, /base capture failed/i);
  } finally {
    rmTmp(tmp);
  }
});

test('Action PARTIAL_BASELINE status stays within GitHub 140-char limit for many receipts', () => {
  const receipts = Array.from({ length: 8 }, (_, index) => ({
    key: `surface-${index}@1280`,
    reason: 'capture_failed',
    sha: BASE_SHA,
  }));
  const status = formatPartialBaselineStatusDescription(receipts);
  assert.match(status, /surface-0@1280/);
  assert.match(status, new RegExp(BASE_SHA));
  assert.match(status, /\(\+7\)/);
  assert.ok(status.length <= 140, status);
});

test('verdict: base-capture-failed=false + incomplete evidence is CERTIFICATION_FAILED, not degraded recapture', () => {
  const state = classifyStyleProofVerdict(
    {
      sourceBinding: { status: 'bound' },
      coverage: { basis: 'complete' },
      determinism: { status: 'proven' },
      confidence: { counts: { inaccessible: 0 } },
      comparison: { blocksCertification: true },
      reportConsistency: { ok: true, reason: 'aligned' },
      statesUncertified: 0,
    },
    { gateInventoryRemovals: true, baseCaptureFailed: false, changed: false },
  ).state;
  assert.equal(state, 'CERTIFICATION_FAILED');
  const attribution = honestBaselineCompareAttribution({
    baseCaptureFailed: false,
    compareSurfaces: [{ key: 'home@1280', sha: HEAD_SHA }],
  });
  assert.equal(attribution.failureClass, 'compare');
  assert.equal(attribution.recaptureFailed, false);
  assert.doesNotMatch(attribution.summary, FALSE_RECAPTURE_CLAIM);
});
