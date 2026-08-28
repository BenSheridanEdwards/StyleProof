import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIFF = path.join(ROOT, 'bin/styleproof-diff.mjs');
const REPORT = path.join(ROOT, 'bin/styleproof-report.mjs');
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

function stampManifest(dir, sha) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '1'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0000000000000000',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(dir, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
  );
}

function fixture({ beforeState, afterState, beforeColor = 'black', afterColor = beforeColor }) {
  const root = mkTmp('styleproof-product-state-cli-');
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  const map = (color, productState) => ({
    ...makeMap({
      elements: {
        'body > button:nth-child(1)': { tag: 'button', style: { color } },
      },
    }),
    ...(productState === undefined ? {} : { metadata: { productState } }),
  });
  writeCapture(before, 'home@1280', map(beforeColor, beforeState), null);
  writeCapture(after, 'home@1280', map(afterColor, afterState), null);
  stampManifest(before, BASE_SHA);
  stampManifest(after, HEAD_SHA);
  return { root, before, after };
}

function runDiff(fixture, extra = []) {
  const json = path.join(fixture.root, `diff-${extra.length}.json`);
  const result = spawnSync(
    process.execPath,
    [
      DIFF,
      fixture.before,
      fixture.after,
      '--json',
      json,
      '--expected-before-sha',
      BASE_SHA,
      '--expected-after-sha',
      HEAD_SHA,
      ...extra,
    ],
    { cwd: fixture.root, encoding: 'utf8' },
  );
  return { ...result, json: JSON.parse(fs.readFileSync(json, 'utf8')) };
}

function runDiffRaw(fixture, extra = []) {
  return spawnSync(process.execPath, [DIFF, fixture.before, fixture.after, ...extra], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
}

test('diff CLI labels an unbound clean comparison as diagnostic rather than certified success', () => {
  const capture = fixture({});
  try {
    const result = runDiffRaw(capture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /UNVERIFIED DIAGNOSTIC/i);
    assert.doesNotMatch(result.stdout, /✓ 0 reviewable computed-style changes/);
  } finally {
    rmTmp(capture.root);
  }
});

test('report CLI labels unbound clean output and durable markdown as unverified diagnostics', () => {
  const capture = fixture({});
  try {
    const out = path.join(capture.root, 'report-unverified');
    const result = spawnSync(process.execPath, [REPORT, capture.before, capture.after, '--out', out], {
      cwd: capture.root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /UNVERIFIED DIAGNOSTIC/i);
    assert.doesNotMatch(result.stdout, /✓ no reviewable/i);
    const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(markdown, /UNVERIFIED DIAGNOSTIC/i);
    assert.doesNotMatch(markdown, /✓ No reviewable computed-style changes/);
  } finally {
    rmTmp(capture.root);
  }
});

test('diff CLI binds capture manifests to explicit trusted source SHAs before diffing', () => {
  const capture = fixture({});
  try {
    const matching = runDiffRaw(capture, ['--expected-before-sha', BASE_SHA, '--expected-after-sha', HEAD_SHA]);
    assert.equal(matching.status, 0, matching.stderr || matching.stdout);

    const stale = runDiffRaw(capture, ['--expected-before-sha', BASE_SHA, '--expected-after-sha', 'c'.repeat(40)]);
    assert.equal(stale.status, 2, stale.stderr || stale.stdout);
    assert.match(stale.stderr, /after capture source does not match the trusted SHA/i);

    for (const partial of [
      ['--expected-before-sha', BASE_SHA],
      ['--expected-after-sha', HEAD_SHA],
    ]) {
      const result = runDiffRaw(capture, partial);
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.match(result.stderr, /must be supplied together/i);
    }
  } finally {
    rmTmp(capture.root);
  }
});

test('diff and report independently emit the same canonical source-binding receipt', () => {
  const capture = fixture({});
  const out = path.join(capture.root, 'report');
  try {
    const diff = runDiff(capture);
    assert.equal(diff.status, 0, diff.stderr || diff.stdout);
    assert.deepEqual(diff.json.sourceBinding, {
      status: 'bound',
      compatibility: 'matched',
      before: { expected: BASE_SHA, observed: BASE_SHA, result: 'matched' },
      after: { expected: HEAD_SHA, observed: HEAD_SHA, result: 'matched' },
    });
    assert.equal(diff.json.evidenceBinding.version, 1);
    assert.equal(diff.json.evidenceBinding.before.mapCount, 1);
    assert.equal(diff.json.evidenceBinding.after.mapCount, 1);
    assert.match(diff.json.evidenceBinding.before.digest, /^[0-9a-f]{64}$/);

    const reportArgs = [
      REPORT,
      capture.before,
      capture.after,
      '--out',
      out,
      '--expected-before-sha',
      BASE_SHA,
      '--expected-after-sha',
      HEAD_SHA,
    ];
    const report = spawnSync(process.execPath, reportArgs, { cwd: capture.root, encoding: 'utf8' });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    const reportJson = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.deepEqual(reportJson.sourceBinding, diff.json.sourceBinding);
    assert.deepEqual(reportJson.evidenceBinding, diff.json.evidenceBinding);

    writeCapture(
      capture.after,
      'home@1280',
      makeMap({ elements: { 'body > button:nth-child(1)': { tag: 'button', style: { color: 'blue' } } } }),
      null,
    );
    const swappedMapOut = path.join(capture.root, 'swapped-map-report');
    const swappedMap = spawnSync(
      process.execPath,
      reportArgs.map((argument) => (argument === out ? swappedMapOut : argument)),
      { cwd: capture.root, encoding: 'utf8' },
    );
    assert.equal(swappedMap.status, 1, swappedMap.stderr || swappedMap.stdout);
    const swappedMapJson = JSON.parse(fs.readFileSync(path.join(swappedMapOut, 'report.json'), 'utf8'));
    assert.notDeepEqual(swappedMapJson.evidenceBinding, diff.json.evidenceBinding);

    for (const partial of [
      ['--expected-before-sha', BASE_SHA],
      ['--expected-after-sha', HEAD_SHA],
      ['--expected-before-sha='],
      ['--expected-after-sha='],
    ]) {
      const partialReport = spawnSync(
        process.execPath,
        [REPORT, capture.before, capture.after, '--out', path.join(capture.root, 'partial-report'), ...partial],
        { cwd: capture.root, encoding: 'utf8' },
      );
      assert.equal(partialReport.status, 2, partialReport.stderr || partialReport.stdout);
      assert.match(partialReport.stderr, /must be supplied together|requires a full lowercase/i);
    }

    stampManifest(capture.after, 'c'.repeat(40));
    const swapped = spawnSync(process.execPath, reportArgs, { cwd: capture.root, encoding: 'utf8' });
    assert.equal(swapped.status, 2, swapped.stderr || swapped.stdout);
    assert.match(swapped.stderr, /after capture source does not match the trusted SHA/i);
  } finally {
    rmTmp(capture.root);
  }
});

test('diff CLI fails closed on malformed manifests and mismatched compatibility contracts', () => {
  const malformed = fixture({});
  try {
    fs.writeFileSync(path.join(malformed.after, 'styleproof-manifest.json'), '{}');
    const result = runDiffRaw(malformed);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /invalid styleproof-manifest\.json/i);
  } finally {
    rmTmp(malformed.root);
  }

  const incompatible = fixture({});
  try {
    const afterManifestPath = path.join(incompatible.after, 'styleproof-manifest.json');
    const afterManifest = JSON.parse(fs.readFileSync(afterManifestPath, 'utf8'));
    afterManifest.compatibilityKey = '1111111111111111';
    fs.writeFileSync(afterManifestPath, JSON.stringify(afterManifest));
    const result = runDiffRaw(incompatible);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /different capture compatibility/i);
  } finally {
    rmTmp(incompatible.root);
  }
});

test('diff CLI certifies matching explicit identity and emits bounded comparison receipts', () => {
  const state = { id: 'home-ready', revision: 'fixture-v2' };
  const capture = fixture({ beforeState: state, afterState: state });
  const result = runDiff(capture, ['--require-state-identity']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.json.comparison, {
    status: 'comparable',
    requireStateIdentity: true,
    blocksCertification: false,
    counts: {
      comparable: 1,
      incomparable: 0,
      unproven: 0,
      notRequired: 0,
      requiredUnproven: 0,
      globalRequiredUnproven: 0,
    },
  });
  assert.deepEqual(result.json.comparability, [
    { surface: 'home@1280', status: 'comparable', required: true, reason: 'explicit-state-match' },
  ]);
  assert.equal(result.json.certifiesFully, true);
  rmTmp(capture.root);
});

test('diff CLI keeps undeclared legacy pairs compatible unless state identity is required', () => {
  const capture = fixture({});
  const legacy = runDiff(capture);
  assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);
  assert.equal(legacy.json.comparison.status, 'unproven');
  assert.equal(legacy.json.comparison.blocksCertification, false);
  assert.equal(legacy.json.certifiesFully, true);

  const strict = runDiff(capture, ['--require-state-identity']);
  assert.equal(strict.status, 1, strict.stderr || strict.stdout);
  assert.equal(strict.json.comparison.status, 'unproven');
  assert.equal(strict.json.comparison.blocksCertification, true);
  assert.equal(strict.json.comparison.counts.globalRequiredUnproven, 1);
  assert.equal(strict.json.certifiesFully, false);
  assert.match(strict.stdout, /product-state identity unproven|state identity unproven/i);
  rmTmp(capture.root);
});

test('diff CLI makes explicit mismatch non-certifying and never prints it as approval evidence', () => {
  const capture = fixture({
    beforeState: { id: 'home-loading', revision: 'fixture-v2' },
    afterState: { id: 'home-ready', revision: 'fixture-v2' },
    beforeColor: 'black',
    afterColor: 'red',
  });
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json.counts.style, 1, 'raw detector evidence remains diagnostic');
  assert.equal(result.json.reviewableCounts.style, 0);
  assert.equal(result.json.comparison.status, 'incomparable');
  assert.equal(result.json.comparison.blocksCertification, true);
  assert.equal(result.json.certifiesFully, false);
  assert.match(result.stdout, /incomparable|different declared product states/i);
  assert.doesNotMatch(result.stdout, /body > button/, 'suppressed raw findings must not look approvable');
  rmTmp(capture.root);
});

test('diff CLI makes asymmetric identity required-unproven even without the global flag', () => {
  const capture = fixture({ afterState: { id: 'home-ready', revision: 'fixture-v2' }, afterColor: 'red' });
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json.comparison.counts.requiredUnproven, 1);
  assert.equal(result.json.reviewableCounts.style, 0);
  assert.equal(result.json.certifiesFully, false);
  rmTmp(capture.root);
});
