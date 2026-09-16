import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_SCHEMA_VERSION,
  createAudit,
  createEmptyCaptureAudit,
  createEmptyComparisonAudit,
} from '../dist/audit.js';

// ─── Helper: Create a valid audit for testing ────────────────────────────────

function validAudit() {
  return createAudit({
    runId: 'github-run-12345-attempt-1',
    headSha: 'abc123def456',
    baseSha: 'def456abc789',
    capture: {
      surfacesCaptured: 42,
      surfacesSkipped: 3,
      skippedReasons: [
        { surface: 'admin-panel', reason: 'auth-boundary', acknowledged: true },
        { surface: 'beta-feature', reason: 'incomplete-ui', acknowledged: false },
        { surface: 'old-page', reason: 'excluded', acknowledged: true },
      ],
      widthsPerSurface: { home: [1280, 768, 390], settings: [1280] },
      totalMapsWritten: 126,
      captureTimeMs: 45000,
    },
    comparison: {
      baselineSource: 'exact-restore',
      baselineSha: 'def456abc789',
      surfacesCompared: 42,
      surfacesNew: 2,
      surfacesRemoved: 0,
      changesFound: 7,
      contentChanges: 3,
    },
    trustDecision: {
      finalState: 'STYLE_REVIEW_REQUIRED',
      gateMode: 'advisory',
      reasons: [
        { check: 'source-binding', result: 'bound', detail: 'both SHAs matched' },
        { check: 'coverage', result: 'complete', detail: '42/42 expected captured' },
        { check: 'determinism', result: 'proven', detail: 'self-check passed' },
        { check: 'data-residue', result: 'clean', detail: '0 unacknowledged' },
        { check: 'inventory', result: 'clean', detail: '0 removals' },
        { check: 'reviewable-changes', result: 'found', detail: '7 style, 2 new surfaces' },
      ],
      exitCode: 0,
      exitReason: 'advisory mode — never blocks',
    },
  });
}

// ─── Schema Validation Tests ─────────────────────────────────────────────────

describe('audit builder helpers', () => {
  test('createEmptyCaptureAudit returns valid empty capture', () => {
    const capture = createEmptyCaptureAudit();
    assert.equal(capture.surfacesCaptured, 0);
    assert.equal(capture.surfacesSkipped, 0);
    assert.deepEqual(capture.skippedReasons, []);
    assert.deepEqual(capture.widthsPerSurface, {});
    assert.equal(capture.totalMapsWritten, 0);
    assert.equal(capture.captureTimeMs, 0);
  });

  test('createEmptyComparisonAudit returns valid empty comparison', () => {
    const comparison = createEmptyComparisonAudit();
    assert.equal(comparison.baselineSource, 'none');
    assert.equal(comparison.baselineSha, null);
    assert.equal(comparison.surfacesCompared, 0);
    assert.equal(comparison.surfacesNew, 0);
    assert.equal(comparison.surfacesRemoved, 0);
    assert.equal(comparison.changesFound, 0);
    assert.equal(comparison.contentChanges, 0);
  });

  test('createAudit sets timestamp automatically', () => {
    const before = Date.now();
    const audit = createAudit({
      runId: 'test',
      headSha: 'abc',
      baseSha: null,
      trustDecision: {
        finalState: 'NO_REVIEWABLE_STYLE_CHANGES',
        gateMode: 'certify',
        reasons: [],
        exitCode: 0,
        exitReason: 'clean',
      },
    });
    const after = Date.now();
    const auditTime = new Date(audit.timestamp).getTime();
    assert.equal(auditTime >= before, true);
    assert.equal(auditTime <= after, true);
  });

  test('createAudit sets version correctly', () => {
    const audit = createAudit({
      runId: 'test',
      headSha: 'abc',
      baseSha: null,
      trustDecision: {
        finalState: 'NO_REVIEWABLE_STYLE_CHANGES',
        gateMode: 'certify',
        reasons: [],
        exitCode: 0,
        exitReason: 'clean',
      },
    });
    assert.equal(audit.version, AUDIT_SCHEMA_VERSION);
  });

  test('createAudit merges partial capture', () => {
    const audit = createAudit({
      runId: 'test',
      headSha: 'abc',
      baseSha: null,
      capture: { surfacesCaptured: 10 },
      trustDecision: {
        finalState: 'NO_REVIEWABLE_STYLE_CHANGES',
        gateMode: 'certify',
        reasons: [],
        exitCode: 0,
        exitReason: 'clean',
      },
    });
    assert.equal(audit.capture.surfacesCaptured, 10);
    assert.equal(audit.capture.surfacesSkipped, 0);
  });

  test('createAudit merges partial comparison', () => {
    const audit = createAudit({
      runId: 'test',
      headSha: 'abc',
      baseSha: null,
      comparison: { surfacesNew: 5 },
      trustDecision: {
        finalState: 'NO_REVIEWABLE_STYLE_CHANGES',
        gateMode: 'certify',
        reasons: [],
        exitCode: 0,
        exitReason: 'clean',
      },
    });
    assert.equal(audit.comparison.surfacesNew, 5);
    assert.equal(audit.comparison.surfacesCompared, 0);
  });
});

// ─── Summary Rendering Tests ─────────────────────────────────────────────────

describe('audit JSON roundtrip', () => {
  test('audit survives JSON stringify/parse', () => {
    const audit = validAudit();
    assert.deepEqual(JSON.parse(JSON.stringify(audit)), audit);
  });
});
