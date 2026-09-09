/**
 * Partial width capture tests (#520 gap 5).
 *
 * StyleProof must correctly handle surfaces where some widths succeed and
 * others fail (e.g., 1280 succeeds, 768 fails due to timeout). This tests:
 * - Coverage reports partial completion
 * - Confidence ledger downgrades surface appropriately
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { recordSurfaceCaptureFailure, readSurfaceCaptureFailures } from '../dist/map-store.js';
import { buildConfidenceLedger, summarizeConfidence } from '../dist/confidence-ledger.js';
import { auditCoverage, COVERAGE_LEDGER } from '../dist/coverage.js';
import { mkTmp, rmTmp, makeMap } from './helpers.mjs';

const writeMap = (dir, surface, map) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
};

const writeCoverageLedger = (dir, ledger) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, COVERAGE_LEDGER), JSON.stringify(ledger));
};

test('partial width capture: some widths succeed, some fail', () => {
  const tmp = mkTmp();
  try {
    writeMap(tmp, 'dashboard@1280', makeMap());
    writeMap(tmp, 'dashboard@1024', makeMap());

    recordSurfaceCaptureFailure(tmp, {
      key: 'dashboard@768',
      reason: 'Timeout waiting for selector .main-content',
      kind: 'capture',
    });
    recordSurfaceCaptureFailure(tmp, {
      key: 'dashboard@480',
      reason: 'Navigation failed: net::ERR_CONNECTION_REFUSED',
      kind: 'capture',
    });

    const failures = readSurfaceCaptureFailures(tmp);
    assert.equal(failures.length, 2);

    const maps = fs.readdirSync(tmp).filter((f) => f.endsWith('.json.gz'));
    assert.equal(maps.length, 2);

    const capturedKeys = maps.map((f) => f.replace('.json.gz', ''));
    assert.deepEqual(capturedKeys.sort(), ['dashboard@1024', 'dashboard@1280']);

    const failedKeys = failures.map((f) => f.key);
    assert.deepEqual(failedKeys.sort(), ['dashboard@480', 'dashboard@768']);
  } finally {
    rmTmp(tmp);
  }
});

test('partial width capture: coverage audit reflects partial completion', () => {
  const tmp = mkTmp();
  try {
    writeMap(tmp, 'home@1280', makeMap());
    writeMap(tmp, 'about@1280', makeMap());

    const ledger = {
      version: 1,
      expected: ['home@1280', 'home@768', 'about@1280', 'about@768'],
      exclude: {},
      determinism: 'self-checked',
    };
    writeCoverageLedger(tmp, ledger);

    const capturedKeys = ['home@1280', 'about@1280'];
    const verdict = auditCoverage(capturedKeys, ledger);

    assert.equal(verdict.basis, 'incomplete');
    assert.equal(verdict.registrySize, 4);
    assert.deepEqual(verdict.uncovered.sort(), ['about@768', 'home@768']);
    assert.deepEqual(verdict.staleExclusions, []);
  } finally {
    rmTmp(tmp);
  }
});

test('partial width capture: confidence ledger reflects partial completion', () => {
  const capturedKeys = ['dashboard@1280', 'dashboard@1024'];
  const coverage = {
    version: 1,
    expected: ['dashboard@1280', 'dashboard@1024', 'dashboard@768', 'dashboard@480'],
    exclude: {},
    determinism: 'self-checked',
  };

  const ledger = buildConfidenceLedger({ capturedKeys, coverage });

  assert.equal(ledger.basis, 'asserted');

  const summary = summarizeConfidence(ledger);

  assert.equal(summary.completeness, 'limited');
  assert.ok(summary.counts.captured >= 2, 'should have at least 2 captured');
  assert.ok(summary.counts.unknown >= 2, 'should have at least 2 unknown (missing widths)');
});

test('partial width capture: excluded widths are properly tracked', () => {
  const tmp = mkTmp();
  try {
    writeMap(tmp, 'settings@1280', makeMap());
    writeMap(tmp, 'settings@1024', makeMap());

    const ledger = {
      version: 1,
      expected: ['settings@1280', 'settings@1024', 'settings@768'],
      exclude: { 'settings@768': 'Mobile layout not yet implemented' },
      determinism: 'self-checked',
    };
    writeCoverageLedger(tmp, ledger);

    const capturedKeys = ['settings@1280', 'settings@1024'];
    const verdict = auditCoverage(capturedKeys, ledger);

    assert.equal(verdict.basis, 'complete');
    assert.deepEqual(verdict.uncovered, []);
    assert.deepEqual(verdict.staleExclusions, []);
  } finally {
    rmTmp(tmp);
  }
});

test('partial width capture: stale exclusions are detected', () => {
  const ledger = {
    version: 1,
    expected: ['home@1280', 'home@768'],
    exclude: { 'home@480': 'No longer used' },
    determinism: 'self-checked',
  };

  const capturedKeys = ['home@1280', 'home@768'];
  const verdict = auditCoverage(capturedKeys, ledger);

  assert.equal(verdict.basis, 'complete');
  assert.deepEqual(verdict.staleExclusions, ['home@480']);
});

test('partial width capture: confidence entries show correct status per surface', () => {
  const capturedKeys = ['page@1280'];
  const coverage = {
    version: 1,
    expected: ['page@1280', 'page@768'],
    exclude: {},
    determinism: 'self-checked',
  };

  const ledger = buildConfidenceLedger({ capturedKeys, coverage });
  const byKey = Object.fromEntries(ledger.entries.map((e) => [e.surface, e]));

  assert.equal(byKey['page@1280'].status, 'captured');
  assert.equal(byKey['page@768'].status, 'unknown');
  assert.match(byKey['page@768'].reason, /never captured/);
});

test('partial width capture with unproven determinism downgrades all surfaces', () => {
  const capturedKeys = ['surface@1280', 'surface@768'];
  const coverage = {
    version: 1,
    expected: ['surface@1280', 'surface@768'],
    exclude: {},
    determinism: 'unproven',
  };

  const ledger = buildConfidenceLedger({ capturedKeys, coverage });

  ledger.entries.forEach((entry) => {
    if (capturedKeys.includes(entry.surface)) {
      assert.equal(entry.status, 'unproven-determinism');
      assert.equal(entry.producer, 'determinism');
    }
  });

  const summary = summarizeConfidence(ledger);
  assert.equal(summary.completeness, 'limited');
});
