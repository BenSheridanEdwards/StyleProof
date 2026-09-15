/**
 * #650 — adopter-legible repair path for CERTIFICATION_FAILED integrity reasons.
 * Each fixture reproduces one integrity state and asserts the repair guidance
 * is present on report / audit / Action comment surfaces. Integrity stays
 * unapprovable as style.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { generateStyleMapReport } from '../dist/index.js';
import {
  CONNECTOR_RECEIPT,
  INTEGRITY_FAILURE_REASONS,
  INTEGRITY_RECEIPT,
  SOURCE_BINDING_RECEIPT,
  INTEGRITY_REPAIR_PATHS,
  formatIntegrityRepairComment,
  formatIntegrityRepairMarkdown,
  formatIntegrityStatusDescription,
  inspectIntegrityFailures,
  integrityAuditChecks,
  integrityReasonsOf,
  integrityRepairPath,
  isIntegrityFailureReason,
  parseIntegrityFailures,
} from '../dist/integrity-repair.js';
import { classifyStyleProofVerdict } from '../dist/verdict.js';
import { isMapFile } from '../dist/map-store.js';
import { createAudit, formatAuditSummary } from '../dist/audit.js';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { buildConfidenceLedger, writeConfidenceLedger } from '../dist/confidence-ledger.js';
import { mkTmp, rmTmp, makeMap, writeCapture, fixtureCommitSha, fixtureCompatibilityKey } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');
const dogfoodYml = fs.readFileSync(path.join(here, '..', '.github/workflows/action-dogfood.yml'), 'utf8');
const reference = fs.readFileSync(path.join(here, '..', 'docs/REFERENCE.md'), 'utf8');

const HEALTHY_SHA = fixtureCommitSha('integrity-healthy');

function stampBundle(dir, surfaces = ['home']) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: HEALTHY_SHA,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: 'a'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: false,
      har: false,
      compatibilityKey: fixtureCompatibilityKey('integrity-repair'),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(dir, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: surfaces, exclude: {}, determinism: 'self-checked' }),
  );
  writeConfidenceLedger(
    dir,
    buildConfidenceLedger({
      capturedKeys: surfaces,
      coverage: { version: 1, expected: surfaces, exclude: {}, determinism: 'self-checked' },
    }),
  );
}

function healthyPair() {
  const root = mkTmp('sp-integrity-');
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  const map = makeMap({
    elements: { body: { tag: 'body', style: { color: 'rgb(0, 0, 0)' } } },
  });
  writeCapture(beforeDir, 'home@320', map, null);
  writeCapture(afterDir, 'home@320', map, null);
  stampBundle(beforeDir);
  stampBundle(afterDir);
  return { root, beforeDir, afterDir, outDir };
}

function certifyingReceipt(overrides = {}) {
  return {
    sourceBinding: { status: 'bound' },
    coverage: { basis: 'complete' },
    determinism: { status: 'proven' },
    confidence: { counts: { inaccessible: 0 } },
    comparison: { blocksCertification: false },
    reportConsistency: { ok: true, reason: 'aligned' },
    statesUncertified: 0,
    reviewableCounts: { dom: 0, style: 0, state: 0 },
    surfaces: [],
    inventory: { added: [], removed: [], unacknowledged: [], staleAcknowledgements: [] },
    dataResidue: { blocking: 0, unacknowledged: [] },
    ...overrides,
  };
}

function assertRepairGuidance(text, reason) {
  const repair = INTEGRITY_REPAIR_PATHS[reason];
  assert.match(text, new RegExp(reason));
  assert.match(text, /What broke/i);
  assert.match(text, /What to fix/i);
  assert.match(text, /How to verify/i);
  assert.match(text, new RegExp(repair.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(text, /Approve all changes/);
}

test('integrity sidecars are reserved bundle files, never surfaces', () => {
  assert.equal(isMapFile(CONNECTOR_RECEIPT), false);
  assert.equal(isMapFile(INTEGRITY_RECEIPT), false);
  assert.equal(isMapFile(SOURCE_BINDING_RECEIPT), false);
});

test('catalog names each integrity reason with an unapprovable repair path', () => {
  assert.deepEqual([...INTEGRITY_FAILURE_REASONS], ['connector-partial', 'duplicate-id', 'integrity-mismatch']);
  for (const reason of INTEGRITY_FAILURE_REASONS) {
    assert.equal(isIntegrityFailureReason(reason), true);
    const repair = integrityRepairPath(reason);
    assert.equal(repair.reason, reason);
    assert.equal(repair.approvable, false);
    assert.ok(repair.whatBroke.length > 20);
    assert.ok(repair.whatToFix.length > 20);
    assert.ok(repair.howToVerify.length > 20);
    assert.match(repair.howToVerify, /styleproof-diff|Action/i);
  }
});

test('healthy bundles inspect as empty — no new fail-closed on clean maps', () => {
  const { root, beforeDir, afterDir } = healthyPair();
  assert.deepEqual(inspectIntegrityFailures([beforeDir, afterDir]), []);
  rmTmp(root);
});

test('connector-partial sidecar is detected and named', () => {
  const { root, beforeDir, afterDir } = healthyPair();
  fs.writeFileSync(
    path.join(afterDir, CONNECTOR_RECEIPT),
    JSON.stringify({ version: 1, status: 'partial', missing: ['home'] }),
  );
  const findings = inspectIntegrityFailures([beforeDir, afterDir]);
  assert.deepEqual(integrityReasonsOf(findings), ['connector-partial']);
  assert.deepEqual(findings[0].surfaces, ['home']);
  rmTmp(root);
});

test('duplicate JSON keys in a style map are duplicate-id', () => {
  const { root, afterDir } = healthyPair();
  const duplicate =
    '{"defaults":{},"elements":{"body":{"tag":"body","cls":"","style":{}}},"elements":{"main":{"tag":"main","cls":"","style":{}}},"states":{}}';
  fs.writeFileSync(path.join(afterDir, 'home@320.json.gz'), gzipSync(duplicate));
  const findings = inspectIntegrityFailures([afterDir]);
  assert.deepEqual(integrityReasonsOf(findings), ['duplicate-id']);
  rmTmp(root);
});

test('integrity-mismatch receipt with unequal digests is detected', () => {
  const { root, afterDir } = healthyPair();
  fs.writeFileSync(
    path.join(afterDir, INTEGRITY_RECEIPT),
    JSON.stringify({
      version: 1,
      claimedDigest: '0'.repeat(64),
      actualDigest: '1'.repeat(64),
    }),
  );
  const findings = inspectIntegrityFailures([afterDir]);
  assert.deepEqual(integrityReasonsOf(findings), ['integrity-mismatch']);
  rmTmp(root);
});

test('sibling map digest that does not match the bytes is integrity-mismatch', () => {
  const { root, afterDir } = healthyPair();
  const mapPath = path.join(afterDir, 'home@320.json.gz');
  fs.writeFileSync(`${mapPath}.sha256`, `${'a'.repeat(64)}\n`);
  const findings = inspectIntegrityFailures([afterDir]);
  assert.deepEqual(integrityReasonsOf(findings), ['integrity-mismatch']);
  const actual = createHash('sha256').update(fs.readFileSync(mapPath)).digest('hex');
  fs.writeFileSync(`${mapPath}.sha256`, `${actual}\n`);
  assert.deepEqual(inspectIntegrityFailures([afterDir]), []);
  rmTmp(root);
});

test('repair markdown names what broke, what to fix, and how to verify for each reason', () => {
  for (const reason of INTEGRITY_FAILURE_REASONS) {
    const md = formatIntegrityRepairMarkdown([{ reason, surfaces: ['home'] }]).join('\n');
    assertRepairGuidance(md, reason);
    assert.match(md, /CERTIFICATION_FAILED/);
    assert.match(md, /cannot clear/i);
    assert.match(md, /`home`/);
  }
});

test('parseIntegrityFailures accepts reason strings and objects; unknown values drop', () => {
  assert.deepEqual(integrityReasonsOf(parseIntegrityFailures(['connector-partial', { reason: 'duplicate-id' }])), [
    'connector-partial',
    'duplicate-id',
  ]);
  assert.deepEqual(parseIntegrityFailures(['not-a-reason', { reason: 'style-change' }]), []);
});

test('integrity findings force CERTIFICATION_FAILED and never STYLE_REVIEW_REQUIRED', () => {
  for (const reason of INTEGRITY_FAILURE_REASONS) {
    const verdict = classifyStyleProofVerdict(
      certifyingReceipt({ integrityFailures: [{ reason, surfaces: ['home'] }] }),
      {
        gateInventoryRemovals: true,
        baseCaptureFailed: false,
        changed: true,
      },
    );
    assert.equal(verdict.state, 'CERTIFICATION_FAILED', reason);
  }
  const clean = classifyStyleProofVerdict(certifyingReceipt(), {
    gateInventoryRemovals: true,
    baseCaptureFailed: false,
    changed: false,
  });
  assert.equal(clean.state, 'NO_REVIEWABLE_STYLE_CHANGES');
});

test('report renders integrity repair guidance and writes it to report.json', () => {
  const { root, beforeDir, afterDir, outDir } = healthyPair();
  fs.writeFileSync(
    path.join(afterDir, CONNECTOR_RECEIPT),
    JSON.stringify({ version: 1, status: 'partial', missing: ['home'] }),
  );
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assertRepairGuidance(md, 'connector-partial');
  assert.equal(json.integrityFailures[0].reason, 'connector-partial');
  assert.deepEqual(json.integrityFailures[0].surfaces, ['home']);
  assert.deepEqual(result.integrityFailures[0].reason, 'connector-partial');
  rmTmp(root);
});

test('report surfaces duplicate-id and integrity-mismatch repair paths from fixtures', () => {
  for (const [reason, plant] of [
    [
      'duplicate-id',
      (dir) => {
        fs.writeFileSync(
          path.join(dir, 'home@320.json.gz'),
          gzipSync(
            '{"defaults":{},"elements":{"body":{"tag":"body","cls":"","style":{}}},"elements":{"main":{"tag":"main","cls":"","style":{}}},"states":{}}',
          ),
        );
      },
    ],
    [
      'integrity-mismatch',
      (dir) => {
        fs.writeFileSync(
          path.join(dir, INTEGRITY_RECEIPT),
          JSON.stringify({ version: 1, claimedDigest: '0'.repeat(64), actualDigest: 'f'.repeat(64) }),
        );
      },
    ],
  ]) {
    const { root, beforeDir, afterDir, outDir } = healthyPair();
    plant(afterDir);
    const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    assertRepairGuidance(md, reason);
    assert.equal(json.integrityFailures[0].reason, reason);
    rmTmp(root);
  }
});

test('audit summary includes integrity repair guidance and stays unapprovable', () => {
  const findings = [{ reason: 'integrity-mismatch', surfaces: [] }];
  const audit = createAudit({
    runId: 'local-integrity',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    trustDecision: {
      finalState: 'CERTIFICATION_FAILED',
      gateMode: 'certify',
      reasons: [
        { check: 'source-binding', result: 'bound', detail: 'both SHAs matched' },
        ...integrityAuditChecks(findings),
      ],
      exitCode: 1,
      exitReason: 'integrity failure',
    },
  });
  const md = formatAuditSummary(audit);
  assert.match(md, /integrity:integrity-mismatch/);
  assert.match(md, /CERTIFICATION_FAILED/);
  assert.match(md, /claimed evidence digest/i);
  assert.doesNotMatch(md, /Approve all changes/);
});

test('Action comment keeps CERTIFICATION_FAILED unapprovable and names integrity repair', () => {
  assert.match(actionYml, /trustState === 'STYLE_REVIEW_REQUIRED'/);
  assert.match(actionYml, /formatIntegrityRepairComment/);
  assert.match(actionYml, /integrityFailures/);
  assert.match(actionYml, /CERTIFICATION_FAILED/);
  const commentStep = actionYml.match(/- name: Upsert PR comment[\s\S]*?(?=\n\s{4}# Review-gate)/);
  assert.ok(commentStep, 'PR comment step present');
  assert.match(commentStep[0], /formatIntegrityRepairComment/);
  assert.doesNotMatch(
    commentStep[0].match(/const box =[\s\S]*?;/)?.[0] ?? '',
    /CERTIFICATION_FAILED/,
    'approval box must not appear for integrity failures',
  );
  const guidance = formatIntegrityRepairComment([{ reason: 'duplicate-id', surfaces: [] }]);
  assert.match(guidance, /duplicate-id/);
  assert.match(guidance, /cannot clear/i);
  const status = formatIntegrityStatusDescription([{ reason: 'connector-partial', surfaces: [] }]);
  assert.match(status, /connector-partial/);
  assert.match(status, /approval cannot clear/i);
});

test('action-dogfood reproduces each integrity reason and asserts guidance', () => {
  for (const reason of INTEGRITY_FAILURE_REASONS) {
    assert.match(dogfoodYml, new RegExp(reason));
  }
  assert.match(dogfoodYml, /integrity-repair/);
  assert.match(dogfoodYml, /CERTIFICATION_FAILED/);
  assert.match(dogfoodYml, /What broke/);
});

test('the reference documents the repair path for each integrity reason', () => {
  assert.match(reference, /connector-partial/);
  assert.match(reference, /duplicate-id/);
  assert.match(reference, /integrity-mismatch/);
  assert.match(reference, /What broke/);
  assert.match(reference, /cannot clear/i);
});
