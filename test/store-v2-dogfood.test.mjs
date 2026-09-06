import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { verifyV2StoreRoundTrip } from '../scripts/store-v2-dogfood.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

const sourceSha = 'a'.repeat(40);
function bundleFixture(directory) {
  fs.mkdirSync(directory);
  for (const [name, value] of Object.entries({
    'styleproof-manifest.json': {
      version: 1,
      packageVersion: '6.3.0',
      sha: sourceSha,
      dirty: false,
      spec: 'example/styleproof.spec.ts',
      specHash: '1'.repeat(64),
      platform: 'linux',
      arch: 'x64',
      nodeMajor: '22',
      screenshots: true,
      har: false,
      compatibilityKey: '0000000000000000',
      createdAt: '2026-09-06T00:00:00.000Z',
    },
    'styleproof-coverage.json': { version: 1, expected: null, exclude: {}, determinism: 'oracle-proven' },
    'styleproof-determinism.json': {
      schemaVersion: 1,
      producer: 'styleproof-map',
      verdict: { status: 'deterministic', requiredRuns: 5, observedRuns: 5, matchingRuns: 5 },
    },
    'home@900.json': { surface: 'home' },
  }))
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
}

test('v2 dogfood exercises CLI import twice, verification, and complete byte restoration', () => {
  const workspace = mkTmp('styleproof-v2-dogfood-');
  try {
    const bundle = path.join(workspace, 'bundle');
    bundleFixture(bundle);
    const result = verifyV2StoreRoundTrip(bundle, path.join(workspace, 'v2'), sourceSha);
    assert.equal(result.evidence.fileCount, 4);
    assert.equal(result.evidence.mapCount, 1);
    assert.deepEqual(result.trust, { coverageBasis: 'unasserted', determinismStatus: 'proven' });
    assert.equal(result.restoredBytes, 'identical');
  } finally {
    rmTmp(workspace);
  }
});

for (const [name, mutate, expectedSha, error] of [
  ['wrong source SHA', () => {}, 'b'.repeat(40), /checked-out source SHA/],
  [
    'missing oracle receipt',
    (dir) => fs.unlinkSync(path.join(dir, 'styleproof-determinism.json')),
    sourceSha,
    /ENOENT/,
  ],
  [
    'dropped file',
    (dir) => fs.writeFileSync(path.join(dir, 'unexpected.txt'), 'must not silently disappear'),
    sourceSha,
    /all bundle paths and bytes/,
  ],
]) {
  test(`v2 dogfood rejects ${name}`, () => {
    const workspace = mkTmp('styleproof-v2-dogfood-reject-');
    try {
      const bundle = path.join(workspace, 'bundle');
      bundleFixture(bundle);
      mutate(bundle);
      assert.throws(() => verifyV2StoreRoundTrip(bundle, path.join(workspace, 'v2'), expectedSha), error);
    } finally {
      rmTmp(workspace);
    }
  });
}
