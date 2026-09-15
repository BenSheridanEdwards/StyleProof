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

function fixture({ productState } = {}) {
  const root = mkTmp('styleproof-legacy-pairs-cli-');
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
  stampManifest(before, BASE_SHA);
  stampManifest(after, HEAD_SHA);
  return { root, before, after };
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

test('undeclared legacy pairs fail closed when the declare file is armed', () => {
  const capture = fixture();
  fs.writeFileSync(path.join(capture.root, 'styleproof.product-state.json'), '{}\n');
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json.comparison.blocksCertification, true);
  assert.equal(result.json.certifiesFully, false);
  assert.deepEqual(result.json.legacyPairs.undeclared, ['home@1280']);
  assert.match(result.stdout, /undeclared legacy pair: home@1280/);
  const audit = JSON.parse(fs.readFileSync(path.join(capture.root, 'styleproof-audit.json'), 'utf8'));
  assert.equal(
    audit.trustDecision.finalState,
    'CERTIFICATION_FAILED',
    'CLI audit trust state must share the Action verdict for undeclared pairs',
  );
  rmTmp(capture.root);
});

test('declared legacy pairs stay advisory and never soft-green certify', () => {
  const capture = fixture();
  fs.writeFileSync(
    path.join(capture.root, 'styleproof.product-state.json'),
    JSON.stringify({ home: 'known demo shell pending identity stamp' }),
  );
  const result = runDiff(capture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.json.comparison.blocksCertification, false);
  assert.equal(result.json.certifiesFully, false, 'declared legacy pairs must not certify');
  assert.deepEqual(result.json.legacyPairs.declared, ['home@1280']);
  assert.deepEqual(result.json.legacyPairs.undeclared, []);
  assert.match(result.stdout, /declared legacy pair/);
  assert.doesNotMatch(result.stdout, /✓ 0 reviewable computed-style changes/);
  rmTmp(capture.root);
});

test('explicit productState identity still certifies when the declare gate is armed', () => {
  const capture = fixture({ productState: { id: 'home-ready', revision: 'fixture-v1' } });
  fs.writeFileSync(path.join(capture.root, 'styleproof.product-state.json'), '{}\n');
  const result = runDiff(capture, ['--require-state-identity']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.json.comparison.status, 'comparable');
  assert.equal(result.json.certifiesFully, true);
  assert.deepEqual(result.json.legacyPairs.legacyPairs, []);
  rmTmp(capture.root);
});

test('$STYLEPROOF_PRODUCT_STATE overrides discovered config productState.legacyPairs', () => {
  const capture = fixture({ productState: { id: 'home-ready', revision: 'fixture-v1' } });
  try {
    fs.writeFileSync(
      path.join(capture.root, 'live-ledger.json'),
      `${JSON.stringify({ home: 'live ledger pending identity stamp' }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(capture.root, 'styleproof.config.json'),
      `${JSON.stringify({ productState: { legacyPairs: 'live-ledger.json' } }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(capture.root, 'empty.json'), '{}\n');

    const inherited = runDiff(capture);
    assert.equal(inherited.status, 1, inherited.stderr || inherited.stdout);
    assert.deepEqual(inherited.json.legacyPairs.staleAcknowledgements, ['home']);
    assert.equal(inherited.json.certifiesFully, false);

    const isolated = runDiff(capture, [], { STYLEPROOF_PRODUCT_STATE: path.join(capture.root, 'empty.json') });
    assert.equal(isolated.status, 0, isolated.stderr || isolated.stdout);
    assert.equal(isolated.json.legacyPairs.armed, true);
    assert.deepEqual(isolated.json.legacyPairs.staleAcknowledgements, []);
    assert.equal(isolated.json.certifiesFully, true);

    const unarmed = runDiff(capture, [], { STYLEPROOF_PRODUCT_STATE: '' });
    assert.equal(unarmed.status, 0, unarmed.stderr || unarmed.stdout);
    assert.equal(unarmed.json.legacyPairs.armed, false);
    assert.equal(unarmed.json.certifiesFully, true);
  } finally {
    rmTmp(capture.root);
  }
});

test('synthetic action-dogfood clean fixtures stale-fail when the repo-root live ledger is inherited', () => {
  const root = mkTmp('styleproof-action-dogfood-live-ledger-');
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  try {
    const generated = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/action-dogfood-fixtures.mjs'), root, baseSha, headSha],
      { encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const json = path.join(root, 'inherited-clean.json');
    const inherited = spawnSync(
      process.execPath,
      [
        DIFF,
        path.join(root, 'clean-base'),
        path.join(root, 'clean-head'),
        '--json',
        json,
        '--expected-before-sha',
        baseSha,
        '--expected-after-sha',
        headSha,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(inherited.status, 1, inherited.stderr || inherited.stdout);
    assert.match(inherited.stdout, /undeclared or stale legacy product-state pair/);
    const receipt = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.equal(receipt.legacyPairs.armed, true);
    assert.deepEqual(receipt.legacyPairs.staleAcknowledgements, ['home']);
    assert.equal(receipt.certifiesFully, false);
  } finally {
    rmTmp(root);
  }
});

test('synthetic action-dogfood clean fixtures certify when $STYLEPROOF_PRODUCT_STATE isolates the live ledger', () => {
  const root = mkTmp('styleproof-action-dogfood-isolated-');
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  try {
    const generated = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/action-dogfood-fixtures.mjs'), root, baseSha, headSha],
      { encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const json = path.join(root, 'isolated-clean.json');
    const isolated = spawnSync(
      process.execPath,
      [
        DIFF,
        path.join(root, 'clean-base'),
        path.join(root, 'clean-head'),
        '--json',
        json,
        '--expected-before-sha',
        baseSha,
        '--expected-after-sha',
        headSha,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, STYLEPROOF_PRODUCT_STATE: path.join(root, 'legacy-pairs-empty.json') },
      },
    );
    assert.equal(isolated.status, 0, isolated.stderr || isolated.stdout);
    const receipt = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.equal(receipt.legacyPairs.armed, true);
    assert.deepEqual(receipt.legacyPairs.staleAcknowledgements, []);
    assert.equal(receipt.certifiesFully, true);
    assert.doesNotMatch(isolated.stdout, /undeclared or stale legacy product-state pair/);
  } finally {
    rmTmp(root);
  }
});

test('report CLI fails closed on undeclared pairs and stays advisory when declared', () => {
  const undeclared = fixture();
  const declared = fixture();
  try {
    fs.writeFileSync(path.join(undeclared.root, 'empty.json'), '{}\n');
    const undeclaredOut = path.join(undeclared.root, 'report');
    const blocked = spawnSync(
      process.execPath,
      [
        REPORT,
        undeclared.before,
        undeclared.after,
        '--out',
        undeclaredOut,
        '--legacy-pairs',
        path.join(undeclared.root, 'empty.json'),
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: undeclared.root, encoding: 'utf8' },
    );
    assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
    const blockedMd = fs.readFileSync(path.join(undeclaredOut, 'report.md'), 'utf8');
    assert.match(blockedMd, /undeclared legacy pair/);
    assert.match(blockedMd, /cannot certify/);

    fs.writeFileSync(
      path.join(declared.root, 'declared.json'),
      JSON.stringify({ home: 'known demo shell pending identity stamp' }),
    );
    const declaredOut = path.join(declared.root, 'report');
    const advisory = spawnSync(
      process.execPath,
      [
        REPORT,
        declared.before,
        declared.after,
        '--out',
        declaredOut,
        '--legacy-pairs',
        path.join(declared.root, 'declared.json'),
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: declared.root, encoding: 'utf8' },
    );
    assert.equal(advisory.status, 0, advisory.stderr || advisory.stdout);
    const declaredMd = fs.readFileSync(path.join(declaredOut, 'report.md'), 'utf8');
    assert.match(declaredMd, /declared legacy pair/);
    assert.match(declaredMd, /advisory, not certification/);
    const declaredJson = JSON.parse(fs.readFileSync(path.join(declaredOut, 'report.json'), 'utf8'));
    assert.deepEqual(declaredJson.legacyPairs.declared, ['home@1280']);
  } finally {
    rmTmp(undeclared.root);
    rmTmp(declared.root);
  }
});

test('live StyleProof-on-StyleProof declare file covers home@* and fails closed when emptied', () => {
  const liveFile = path.join(ROOT, 'example/styleproof.product-state.json');
  assert.ok(fs.existsSync(liveFile), 'example/styleproof.product-state.json is the live dogfood ledger');
  const capture = fixture();
  try {
    const declared = runDiff(capture, [], { STYLEPROOF_PRODUCT_STATE: liveFile });
    assert.equal(declared.status, 0, declared.stderr || declared.stdout);
    assert.equal(declared.json.certifiesFully, false);
    assert.deepEqual(declared.json.legacyPairs.declared, ['home@1280']);
    assert.deepEqual(declared.json.legacyPairs.undeclared, []);

    const empty = path.join(capture.root, 'legacy-pairs-empty.json');
    fs.writeFileSync(empty, '{}\n');
    const blocked = runDiff(capture, [], { STYLEPROOF_PRODUCT_STATE: empty });
    assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
    assert.equal(blocked.json.certifiesFully, false);
    assert.deepEqual(blocked.json.legacyPairs.undeclared, ['home@1280']);
    const audit = JSON.parse(fs.readFileSync(path.join(capture.root, 'styleproof-audit.json'), 'utf8'));
    assert.equal(audit.trustDecision.finalState, 'CERTIFICATION_FAILED');
  } finally {
    rmTmp(capture.root);
  }
});

test('styleproof-diff passes legacyPairs into classifyStyleProofVerdict so Action and CLI share one truth', () => {
  const source = fs.readFileSync(DIFF, 'utf8');
  assert.match(source, /classifyStyleProofVerdict\(/);
  assert.match(
    source,
    /classifyStyleProofVerdict\(\s*\{[\s\S]*?legacyPairs:\s*legacyPairAudit/,
    'the CLI verdict receipt must include the legacy-pair audit, not only comparison.blocksCertification',
  );
});

test('config productState.requireIdentity arms the same fail-closed path as the flag', () => {
  const capture = fixture();
  fs.writeFileSync(
    path.join(capture.root, 'styleproof.config.json'),
    JSON.stringify({ productState: { requireIdentity: true } }),
  );
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json.comparison.blocksCertification, true);
  assert.equal(result.json.certifiesFully, false);
  rmTmp(capture.root);
});
