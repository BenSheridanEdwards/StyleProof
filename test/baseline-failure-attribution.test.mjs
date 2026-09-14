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
import { baselineFailureReceipts, honestBaselineCompareAttribution, MAP_MANIFEST } from '../dist/map-store.js';
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

test('Action PARTIAL_BASELINE and CERTIFICATION_FAILED copy do not claim recapture', () => {
  const actionYml = fs.readFileSync(ACTION_YML, 'utf8');
  const partial = actionYml.match(/PARTIAL_BASELINE:\s*'([^']+)'/);
  const degraded = actionYml.match(/DEGRADED_BASELINE:\s*'([^']+)'/);
  assert.ok(partial, 'PARTIAL_BASELINE guidance present');
  assert.ok(degraded, 'DEGRADED_BASELINE guidance present');
  assert.match(actionYml, /formatIntegrityRepairComment/);
  assert.match(partial[1], /not a base recapture failure/i);
  assert.doesNotMatch(partial[1], /the base capture failed/i);
  assert.match(degraded[1], /base capture failed/i);

  const genericCert = formatIntegrityRepairComment([]);
  const genericStatus = formatIntegrityStatusDescription([]);
  assert.match(genericCert, /not a base recapture failure/i);
  assert.match(genericStatus, /not a base recapture failure/i);
  assert.doesNotMatch(genericCert, FALSE_RECAPTURE_CLAIM);
  assert.doesNotMatch(genericStatus, FALSE_RECAPTURE_CLAIM);

  const statusPartial = actionYml.match(/PARTIAL_BASELINE:\s*'Named surface[^']+'/);
  assert.ok(statusPartial, 'PARTIAL_BASELINE status description present');
  assert.match(statusPartial[0], /not a base recapture failure/i);
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
