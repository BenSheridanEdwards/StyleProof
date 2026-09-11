import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_SCHEMA_VERSION,
  AUDIT_FILE_NAME,
  createAudit,
  createEmptyCaptureAudit,
  createEmptyComparisonAudit,
  validateAudit,
  assertValidAudit,
  renderAuditSummary,
  formatAuditSummary,
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

describe('audit schema validation', () => {
  test('AUDIT_SCHEMA_VERSION is 1', () => {
    assert.equal(AUDIT_SCHEMA_VERSION, 1);
  });

  test('AUDIT_FILE_NAME is styleproof-audit.json', () => {
    assert.equal(AUDIT_FILE_NAME, 'styleproof-audit.json');
  });

  test('validateAudit returns empty array for valid audit', () => {
    const audit = validAudit();
    const errors = validateAudit(audit);
    assert.deepEqual(errors, []);
  });

  test('assertValidAudit does not throw for valid audit', () => {
    const audit = validAudit();
    assert.doesNotThrow(() => assertValidAudit(audit));
  });

  test('validateAudit catches missing version', () => {
    const audit = validAudit();
    delete audit.version;
    const errors = validateAudit(audit);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].field, 'version');
  });

  test('validateAudit catches wrong version', () => {
    const audit = validAudit();
    audit.version = 99;
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field === 'version'),
      true,
    );
  });

  test('validateAudit catches invalid timestamp', () => {
    const audit = validAudit();
    audit.timestamp = 'not-a-timestamp';
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field === 'timestamp'),
      true,
    );
  });

  test('validateAudit catches missing runId', () => {
    const audit = validAudit();
    delete audit.runId;
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field === 'runId'),
      true,
    );
  });

  test('validateAudit catches non-object audit', () => {
    const errors = validateAudit('not-an-object');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'audit must be an object');
  });

  test('validateAudit catches invalid capture.surfacesCaptured', () => {
    const audit = validAudit();
    audit.capture.surfacesCaptured = -1;
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field === 'capture.surfacesCaptured'),
      true,
    );
  });

  test('validateAudit catches invalid capture.skippedReasons[].reason', () => {
    const audit = validAudit();
    audit.capture.skippedReasons[0].reason = 'invalid-reason';
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field.includes('skippedReasons')),
      true,
    );
  });

  test('validateAudit catches invalid comparison.baselineSource', () => {
    const audit = validAudit();
    audit.comparison.baselineSource = 'invalid-source';
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field === 'comparison.baselineSource'),
      true,
    );
  });

  test('validateAudit catches invalid trustDecision.finalState', () => {
    const audit = validAudit();
    audit.trustDecision.finalState = 'INVALID_STATE';
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field === 'trustDecision.finalState'),
      true,
    );
  });

  test('validateAudit catches invalid trustDecision.gateMode', () => {
    const audit = validAudit();
    audit.trustDecision.gateMode = 'invalid-mode';
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field === 'trustDecision.gateMode'),
      true,
    );
  });

  test('validateAudit catches invalid trustDecision.reasons[].result', () => {
    const audit = validAudit();
    audit.trustDecision.reasons[0].result = 'invalid-result';
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field.includes('reasons')),
      true,
    );
  });

  test('validateAudit allows null baseSha', () => {
    const audit = validAudit();
    audit.baseSha = null;
    const errors = validateAudit(audit);
    assert.deepEqual(errors, []);
  });

  test('validateAudit allows optional budget', () => {
    const audit = validAudit();
    delete audit.budget;
    const errors = validateAudit(audit);
    assert.deepEqual(errors, []);
  });

  test('validateAudit validates budget when present', () => {
    const audit = createAudit({
      runId: 'test-run',
      headSha: 'abc123',
      baseSha: null,
      trustDecision: {
        finalState: 'NO_REVIEWABLE_STYLE_CHANGES',
        gateMode: 'certify',
        reasons: [],
        exitCode: 0,
        exitReason: 'clean',
      },
      budget: {
        surfaceTimeoutMs: 300000,
        totalBudgetMs: 600000,
        actualTimeMs: 45000,
        statesSkipped: 2,
        statesSkippedReasons: ['timeout', 'flaky'],
      },
    });
    const errors = validateAudit(audit);
    assert.deepEqual(errors, []);
  });

  test('validateAudit catches invalid budget.statesSkipped', () => {
    const audit = createAudit({
      runId: 'test-run',
      headSha: 'abc123',
      baseSha: null,
      trustDecision: {
        finalState: 'NO_REVIEWABLE_STYLE_CHANGES',
        gateMode: 'certify',
        reasons: [],
        exitCode: 0,
        exitReason: 'clean',
      },
      budget: {
        surfaceTimeoutMs: 300000,
        totalBudgetMs: 600000,
        actualTimeMs: 45000,
        statesSkipped: -1,
        statesSkippedReasons: [],
      },
    });
    const errors = validateAudit(audit);
    assert.equal(
      errors.some((e) => e.field === 'budget.statesSkipped'),
      true,
    );
  });
});

// ─── Builder Tests ───────────────────────────────────────────────────────────

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

describe('audit summary rendering', () => {
  test('renderAuditSummary returns array of lines', () => {
    const audit = validAudit();
    const lines = renderAuditSummary(audit);
    assert.equal(Array.isArray(lines), true);
    assert.equal(lines.length > 0, true);
  });

  test('summary includes header', () => {
    const audit = validAudit();
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('## StyleProof Audit Summary'), true);
  });

  test('summary includes run info', () => {
    const audit = validAudit();
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('github-run-12345-attempt-1'), true);
    assert.equal(summary.includes('advisory'), true);
  });

  test('summary includes capture section', () => {
    const audit = validAudit();
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('### Capture'), true);
    assert.equal(summary.includes('42 surface(s) captured'), true);
    assert.equal(summary.includes('126 map(s)'), true);
  });

  test('summary includes comparison section', () => {
    const audit = validAudit();
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('### Comparison'), true);
    assert.equal(summary.includes('exact-restore'), true);
    assert.equal(summary.includes('7 style change(s)'), true);
  });

  test('summary includes trust checks table', () => {
    const audit = validAudit();
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('### Trust Checks'), true);
    assert.equal(summary.includes('| Check | Result | Detail |'), true);
    assert.equal(summary.includes('source-binding'), true);
    assert.equal(summary.includes('coverage'), true);
    assert.equal(summary.includes('determinism'), true);
  });

  test('summary shows skipped reasons when present', () => {
    const audit = validAudit();
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('auth-boundary'), true);
    assert.equal(summary.includes('incomplete-ui'), true);
  });

  test('summary shows new surfaces when present', () => {
    const audit = validAudit();
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('2 new surface(s)'), true);
  });

  test('summary shows advisory mode explanation', () => {
    const audit = validAudit();
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('advisory'), true);
  });

  test('summary shows budget when present', () => {
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
      budget: {
        surfaceTimeoutMs: 300000,
        totalBudgetMs: 600000,
        actualTimeMs: 45000,
        statesSkipped: 2,
        statesSkippedReasons: ['timeout reached', 'flaky element'],
      },
    });
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('### Budget'), true);
    assert.equal(summary.includes('45'), true);
    assert.equal(summary.includes('2 state(s) skipped'), true);
    assert.equal(summary.includes('timeout reached'), true);
  });

  test('summary handles no reviewable changes', () => {
    const audit = createAudit({
      runId: 'test',
      headSha: 'abc',
      baseSha: null,
      comparison: { surfacesCompared: 10, changesFound: 0 },
      trustDecision: {
        finalState: 'NO_REVIEWABLE_STYLE_CHANGES',
        gateMode: 'certify',
        reasons: [],
        exitCode: 0,
        exitReason: 'clean',
      },
    });
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('no reviewable changes'), true);
  });

  test('summary handles no baseline', () => {
    const audit = createAudit({
      runId: 'test',
      headSha: 'abc',
      baseSha: null,
      comparison: { baselineSource: 'none' },
      trustDecision: {
        finalState: 'STYLE_REVIEW_REQUIRED',
        gateMode: 'certify',
        reasons: [],
        exitCode: 1,
        exitReason: 'no baseline available',
      },
    });
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('No baseline available'), true);
  });

  test('summary handles removed surfaces', () => {
    const audit = createAudit({
      runId: 'test',
      headSha: 'abc',
      baseSha: 'def',
      comparison: { surfacesRemoved: 3 },
      trustDecision: {
        finalState: 'STYLE_REVIEW_REQUIRED',
        gateMode: 'certify',
        reasons: [],
        exitCode: 1,
        exitReason: 'surfaces removed',
      },
    });
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('3 removed surface(s)'), true);
  });

  test('summary uses correct icons for check results', () => {
    const audit = createAudit({
      runId: 'test',
      headSha: 'abc',
      baseSha: null,
      trustDecision: {
        finalState: 'CERTIFICATION_FAILED',
        gateMode: 'certify',
        reasons: [
          { check: 'bound-check', result: 'bound', detail: 'ok' },
          { check: 'clean-check', result: 'clean', detail: 'ok' },
          { check: 'complete-check', result: 'complete', detail: 'ok' },
          { check: 'proven-check', result: 'proven', detail: 'ok' },
          { check: 'found-check', result: 'found', detail: 'warning' },
          { check: 'advisory-check', result: 'advisory', detail: 'warning' },
          { check: 'failed-check', result: 'failed', detail: 'error' },
          { check: 'unknown-check', result: 'unknown', detail: 'error' },
        ],
        exitCode: 1,
        exitReason: 'test',
      },
    });
    const summary = formatAuditSummary(audit);
    assert.equal(summary.includes('✅ bound'), true);
    assert.equal(summary.includes('✅ clean'), true);
    assert.equal(summary.includes('✅ complete'), true);
    assert.equal(summary.includes('✅ proven'), true);
    assert.equal(summary.includes('⚠️ found'), true);
    assert.equal(summary.includes('⚠️ advisory'), true);
    assert.equal(summary.includes('❌ failed'), true);
    assert.equal(summary.includes('❌ unknown'), true);
  });
});

// ─── Roundtrip Tests ─────────────────────────────────────────────────────────

describe('audit JSON roundtrip', () => {
  test('audit survives JSON stringify/parse', () => {
    const audit = validAudit();
    const json = JSON.stringify(audit, null, 2);
    const parsed = JSON.parse(json);
    const errors = validateAudit(parsed);
    assert.deepEqual(errors, []);
  });

  test('assertValidAudit passes after JSON roundtrip', () => {
    const audit = validAudit();
    const json = JSON.stringify(audit);
    const parsed = JSON.parse(json);
    assert.doesNotThrow(() => assertValidAudit(parsed));
  });
});
