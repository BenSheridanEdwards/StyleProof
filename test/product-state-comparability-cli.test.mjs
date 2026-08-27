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

function stampManifest(dir, sha) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: 'test',
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: 'product-state-test',
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
  stampManifest(before, 'base-sha');
  stampManifest(after, 'head-sha');
  return { root, before, after };
}

function runDiff(fixture, extra = []) {
  const json = path.join(fixture.root, `diff-${extra.length}.json`);
  const result = spawnSync(process.execPath, [DIFF, fixture.before, fixture.after, '--json', json, ...extra], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  return { ...result, json: JSON.parse(fs.readFileSync(json, 'utf8')) };
}

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
