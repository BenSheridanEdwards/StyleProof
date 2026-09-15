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

function stampManifest(dir, sha, { exclude = {} } = {}) {
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
    JSON.stringify({ version: 1, expected: ['home'], exclude, determinism: 'self-checked' }),
  );
}

function fixture({ productState, exclude } = {}) {
  const root = mkTmp('styleproof-critical-states-cli-');
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  const map = {
    ...makeMap({
      elements: {
        'body > button:nth-child(1)': { tag: 'button', style: { color: 'black' } },
      },
    }),
    ...(productState ? { metadata: { productState } } : {}),
  };
  writeCapture(before, 'home@1280', map, null);
  writeCapture(after, 'home@1280', map, null);
  stampManifest(before, BASE_SHA, { exclude });
  stampManifest(after, HEAD_SHA, { exclude });
  return { root, before, after };
}

function writeObligations(root, obligations, name = 'styleproof.critical-states.json') {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(obligations, null, 2)}\n`);
  return file;
}

function runDiff(capture, extra = [], env = {}) {
  const json = path.join(capture.root, `diff-${extra.join('-') || 'default'}.json`);
  const result = spawnSync(
    process.execPath,
    [
      DIFF,
      capture.before,
      capture.after,
      '--json',
      json,
      '--expected-before-sha',
      BASE_SHA,
      '--expected-after-sha',
      HEAD_SHA,
      ...extra,
    ],
    { cwd: capture.root, encoding: 'utf8', env: { ...process.env, ...env } },
  );
  return {
    ...result,
    json: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null,
  };
}

test('declared critical obligation on an unproven pair fails closed', () => {
  const capture = fixture();
  writeObligations(capture.root, {
    home: { owner: 'checkout team', reason: 'release-blocking state' },
  });
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json.comparison.blocksCertification, true);
  assert.equal(result.json.certifiesFully, false);
  assert.deepEqual(result.json.criticalStates.failing, ['home']);
  assert.deepEqual(result.json.criticalStates.certified, []);
  assert.match(result.stdout, /critical obligation home is not certifying/);
  assert.match(result.stdout, /checkout team/);
  const audit = JSON.parse(fs.readFileSync(path.join(capture.root, 'styleproof-audit.json'), 'utf8'));
  assert.equal(audit.trustDecision.finalState, 'CERTIFICATION_FAILED');
  rmTmp(capture.root);
});

test('declared critical obligation on a comparable pair certifies', () => {
  const capture = fixture({ productState: { id: 'home-ready', revision: 'fixture-v1' } });
  writeObligations(capture.root, {
    home: { owner: 'checkout team', reason: 'release-blocking state' },
  });
  const result = runDiff(capture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.json.certifiesFully, true);
  assert.deepEqual(result.json.criticalStates.certified, ['home']);
  assert.deepEqual(result.json.criticalStates.failing, []);
  rmTmp(capture.root);
});

test('unresolved critical obligation with no paired evidence fails closed', () => {
  const capture = fixture({ productState: { id: 'home-ready', revision: 'fixture-v1' } });
  writeObligations(capture.root, {
    cart: { owner: 'payments team', reason: 'checkout must certify' },
  });
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json.comparison.blocksCertification, false, 'no pair may fail for other reasons');
  assert.equal(result.json.certifiesFully, false);
  assert.deepEqual(result.json.criticalStates.unresolved, ['cart']);
  assert.match(result.stdout, /unresolved critical obligation cart/);
  const audit = JSON.parse(fs.readFileSync(path.join(capture.root, 'styleproof-audit.json'), 'utf8'));
  assert.equal(
    audit.trustDecision.finalState,
    'CERTIFICATION_FAILED',
    'unresolved obligations must reach the shared verdict, not only the exit code',
  );
  rmTmp(capture.root);
});

test('contradictory critical obligation that is also coverage-excluded fails closed', () => {
  const capture = fixture({
    productState: { id: 'home-ready', revision: 'fixture-v1' },
    exclude: { home: 'intentionally skipped' },
  });
  writeObligations(capture.root, {
    home: { owner: 'checkout team', reason: 'release-blocking state' },
  });
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.deepEqual(result.json.criticalStates.contradictory, ['home']);
  assert.match(result.stdout, /contradictory critical obligation home/);
  rmTmp(capture.root);
});

test('an explicitly requested but missing obligation file exits 2', () => {
  const capture = fixture();
  const result = runDiff(capture, ['--critical-states', 'missing.json']);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /not readable/);
  rmTmp(capture.root);
});

test('a malformed obligation file exits 2', () => {
  const capture = fixture();
  fs.writeFileSync(path.join(capture.root, 'styleproof.critical-states.json'), '{ not json');
  const result = runDiff(capture);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /not valid JSON/);
  rmTmp(capture.root);
});

test('an obligation entry without bounded owner and reason exits 2', () => {
  const capture = fixture();
  writeObligations(capture.root, { home: 'just a reason string' });
  const result = runDiff(capture);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /owner|reason/);
  rmTmp(capture.root);
});

test('config productState.critical arms the gate and an empty env unarms it', () => {
  const capture = fixture();
  const obligations = writeObligations(
    capture.root,
    { home: { owner: 'checkout team', reason: 'release-blocking state' } },
    'obligations.json',
  );
  fs.writeFileSync(
    path.join(capture.root, 'styleproof.config.json'),
    `${JSON.stringify({ productState: { critical: obligations } }, null, 2)}\n`,
  );
  const armed = runDiff(capture);
  assert.equal(armed.status, 1, armed.stderr || armed.stdout);
  assert.deepEqual(armed.json.criticalStates.failing, ['home']);

  const unarmed = runDiff(capture, [], { STYLEPROOF_CRITICAL_STATES: '' });
  assert.equal(unarmed.status, 0, unarmed.stderr || unarmed.stdout);
  assert.equal(unarmed.json.criticalStates.armed, false);
  rmTmp(capture.root);
});

test('report CLI fails closed on failing obligations and certifies comparable ones', () => {
  const failing = fixture();
  const certifying = fixture({ productState: { id: 'home-ready', revision: 'fixture-v1' } });
  try {
    const failingObligations = writeObligations(failing.root, {
      home: { owner: 'checkout team', reason: 'release-blocking state' },
    });
    const failingOut = path.join(failing.root, 'report');
    const blocked = spawnSync(
      process.execPath,
      [
        REPORT,
        failing.before,
        failing.after,
        '--out',
        failingOut,
        '--critical-states',
        failingObligations,
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: failing.root, encoding: 'utf8' },
    );
    assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
    const blockedMd = fs.readFileSync(path.join(failingOut, 'report.md'), 'utf8');
    assert.match(blockedMd, /Critical state obligations/);
    assert.match(blockedMd, /non-certifying pair/);
    assert.match(blockedMd, /checkout team/);

    const certifyingObligations = writeObligations(certifying.root, {
      home: { owner: 'checkout team', reason: 'release-blocking state' },
    });
    const certifyingOut = path.join(certifying.root, 'report');
    const clean = spawnSync(
      process.execPath,
      [
        REPORT,
        certifying.before,
        certifying.after,
        '--out',
        certifyingOut,
        '--critical-states',
        certifyingObligations,
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: certifying.root, encoding: 'utf8' },
    );
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);
    const cleanMd = fs.readFileSync(path.join(certifyingOut, 'report.md'), 'utf8');
    assert.match(cleanMd, /Critical state obligations/);
    assert.match(cleanMd, /certifying on comparable paired evidence/);
    const cleanJson = JSON.parse(fs.readFileSync(path.join(certifyingOut, 'report.json'), 'utf8'));
    assert.deepEqual(cleanJson.criticalStates.certified, ['home']);
  } finally {
    rmTmp(failing.root);
    rmTmp(certifying.root);
  }
});

test('styleproof-diff passes criticalStates into classifyStyleProofVerdict so Action and CLI share one truth', () => {
  const source = fs.readFileSync(DIFF, 'utf8');
  assert.match(source, /classifyStyleProofVerdict\(/);
  assert.match(
    source,
    /classifyStyleProofVerdict\(\s*\{[\s\S]*?criticalStates:\s*criticalAudit/,
    'the CLI verdict receipt must include the critical-obligation audit, not only comparison.blocksCertification',
  );
});
