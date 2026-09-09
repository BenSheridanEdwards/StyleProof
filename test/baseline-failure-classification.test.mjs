/**
 * Baseline failure classification tests (#520 gap 1).
 *
 * StyleProof must correctly classify surfaces when baseline capture failures
 * exist alongside genuinely new surfaces and changed surfaces with healthy
 * baselines. This tests the classification logic that distinguishes:
 * - A surface missing on base BECAUSE capture failed (baseline failure)
 * - A surface missing on base because it's genuinely new on head
 * - A surface present on both sides with changes
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  baselineFailureReceipts,
  surfaceMissingMatchesBaselineFailure,
  explainedMissingBaselineSurfaces,
  recordSurfaceCaptureFailure,
  readSurfaceCaptureFailures,
  MAP_MANIFEST,
} from '../dist/map-store.js';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { mkTmp, rmTmp, makeMap, solidPng, fixtureCompatibilityKey } from './helpers.mjs';

const writeCapture = (dir, surface, map, png = null) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  if (png) fs.writeFileSync(path.join(dir, `${surface}.png`), png);
  return dir;
};

const writeMinimalManifest = (dir, surfaceCaptureFailures = []) => {
  const manifest = {
    version: 1,
    packageVersion: '6.0.0',
    sha: 'a'.repeat(40),
    dirty: false,
    spec: 'test.spec.ts',
    specHash: 'a'.repeat(64),
    platform: 'linux',
    arch: 'x64',
    nodeMajor: '22',
    screenshots: true,
    har: false,
    compatibilityKey: fixtureCompatibilityKey('test'),
    createdAt: new Date().toISOString(),
    ...(surfaceCaptureFailures.length ? { surfaceCaptureFailures } : {}),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MAP_MANIFEST), JSON.stringify(manifest));
};

test('baselineFailureReceipts converts private diagnostics to bounded public receipts', () => {
  const failures = [
    { key: 'dashboard@1280', reason: 'Timeout waiting for navigation' },
    { key: 'settings@768', reason: 'Element not found: .main-content' },
    { key: 'profile@auto', reason: 'net::ERR_CONNECTION_REFUSED' },
  ];

  const receipts = baselineFailureReceipts(failures);

  assert.equal(receipts.length, 3);
  receipts.forEach((receipt) => {
    assert.equal(receipt.reason, 'capture_failed');
    assert.ok(receipt.key.length > 0, 'key should not be empty');
  });
  assert.equal(receipts[0].key, 'dashboard@1280');
  assert.equal(receipts[1].key, 'settings@768');
  assert.equal(receipts[2].key, 'profile@auto');
});

test('baselineFailureReceipts hashes non-conforming keys for privacy', () => {
  const failures = [
    { key: 'Internal-Secret-Path@1280', reason: 'capture failed' },
    { key: 'valid-surface@900', reason: 'capture failed' },
  ];

  const receipts = baselineFailureReceipts(failures);

  assert.match(receipts[0].key, /^capture-[a-f0-9]{12}$/, 'non-conforming key should be hashed');
  assert.equal(receipts[1].key, 'valid-surface@900', 'conforming key preserved');
});

test('surfaceMissingMatchesBaselineFailure correctly identifies explained absences', () => {
  const failures = [
    { key: 'dashboard@1280', reason: 'timeout' },
    { key: 'dashboard@768', reason: 'timeout' },
    { key: 'settings@1280', reason: 'not found' },
  ];

  assert.equal(
    surfaceMissingMatchesBaselineFailure('dashboard@1280', failures),
    true,
    'exact match should be explained',
  );
  assert.equal(
    surfaceMissingMatchesBaselineFailure('dashboard@768', failures),
    true,
    'exact match should be explained',
  );
  assert.equal(
    surfaceMissingMatchesBaselineFailure('profile@1280', failures),
    false,
    'unrelated surface should not be explained',
  );
});

test('explainedMissingBaselineSurfaces filters and sorts correctly', () => {
  const surfaces = [
    { surface: 'dashboard@1280', missing: 'before' },
    { surface: 'settings@768', missing: 'before' },
    { surface: 'profile@1280', missing: 'before' },
    { surface: 'about@900', missing: 'after' },
    { surface: 'home@1280' },
  ];
  const failures = [
    { key: 'dashboard@1280', reason: 'timeout' },
    { key: 'settings@768', reason: 'error' },
  ];

  const explained = explainedMissingBaselineSurfaces(surfaces, failures);

  assert.deepEqual(explained, ['dashboard@1280', 'settings@768']);
});

test('recordSurfaceCaptureFailure and readSurfaceCaptureFailures round-trip correctly', () => {
  const tmp = mkTmp();
  try {
    const failures = [
      { key: 'surface-a@1280', reason: 'Timeout', kind: 'capture' },
      { key: 'surface-b@768', reason: 'Element not found', kind: 'capture' },
    ];

    failures.forEach((f) => recordSurfaceCaptureFailure(tmp, f));
    const read = readSurfaceCaptureFailures(tmp);

    assert.equal(read.length, 2);
    assert.deepEqual(
      read.map((f) => f.key),
      ['surface-a@1280', 'surface-b@768'],
    );
  } finally {
    rmTmp(tmp);
  }
});

test('mixed baseline failure scenario: failures, new surfaces, and changes classified correctly', async () => {
  const tmp = mkTmp();
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');
  const outDir = path.join(tmp, 'out');

  try {
    const baseMap = makeMap({
      elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } },
    });
    const changedMap = makeMap({
      elements: { 'body > div': { tag: 'div', style: { color: 'rgb(255, 0, 0)' } } },
    });
    const newMap = makeMap({
      elements: { 'body > section': { tag: 'section', style: { padding: '20px' } } },
    });

    writeCapture(beforeDir, 'healthy-changed@1280', baseMap, solidPng(100, 100));
    writeCapture(beforeDir, 'healthy-unchanged@1280', baseMap, solidPng(100, 100));
    writeCapture(afterDir, 'healthy-changed@1280', changedMap, solidPng(100, 100));
    writeCapture(afterDir, 'healthy-unchanged@1280', baseMap, solidPng(100, 100));
    writeCapture(afterDir, 'new-surface-a@1280', newMap, solidPng(100, 100));
    writeCapture(afterDir, 'new-surface-b@1280', newMap, solidPng(100, 100));

    const baselineFailures = [
      { key: 'failed-baseline-a@1280', reason: 'timeout' },
      { key: 'failed-baseline-b@768', reason: 'element not found' },
    ];

    writeMinimalManifest(beforeDir, baselineFailures);
    writeMinimalManifest(afterDir);

    const result = await generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
    });

    assert.ok(fs.existsSync(result.reportJsonPath), 'report.json should exist');
    assert.ok(fs.existsSync(result.reportMdPath), 'report.md should exist');

    const reportJson = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

    assert.equal(reportJson.baselineFailures.length, 2, 'should have 2 baseline failures');
    assert.ok(reportJson.partialBaseline, 'partialBaseline should be true');

    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    assert.match(md, /baseline capture failure/, 'Markdown should mention baseline failures');
  } finally {
    rmTmp(tmp);
  }
});

test('empty baseline failures produce clean report without partial baseline flag', async () => {
  const tmp = mkTmp();
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');
  const outDir = path.join(tmp, 'out');

  try {
    const map = makeMap({
      elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } },
    });

    writeCapture(beforeDir, 'surface@1280', map, solidPng(100, 100));
    writeCapture(afterDir, 'surface@1280', map, solidPng(100, 100));
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = await generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
    });

    const reportJson = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

    assert.equal(reportJson.baselineFailures.length, 0, 'should have no baseline failures');
    assert.equal(reportJson.partialBaseline, false, 'partialBaseline should be false');
  } finally {
    rmTmp(tmp);
  }
});
