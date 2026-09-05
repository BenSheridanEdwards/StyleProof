import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const unsupportedStateTest = {
  file: 'test/cross-element-state.e2e.spec.ts',
  title: 'non-Chromium capture persists unsupported forced-state evidence',
};

function reportTests(report) {
  assert.deepEqual(report.errors, [], 'browser report contains errors');
  const tests = [];
  function visit(suite, ancestors = []) {
    const suitePath = suite.title ? [...ancestors, suite.title] : ancestors;
    for (const spec of suite.specs ?? []) {
      assert.equal(typeof spec.id, 'string', 'missing test ID');
      assert.equal(typeof spec.file, 'string', 'missing test file identity');
      assert.equal(typeof spec.line, 'number', 'missing test line identity');
      assert.equal(typeof spec.column, 'number', 'missing test column identity');
      assert.equal(typeof spec.title, 'string', 'missing test title identity');
      for (const test of spec.tests) {
        tests.push({
          ...test,
          id: `${spec.id}:${test.projectName}`,
          identity: JSON.stringify([spec.file, spec.line, spec.column, ...suitePath, spec.title, test.projectName]),
          file: spec.file,
          title: spec.title,
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, suitePath);
  }
  visit(report);
  return tests;
}

/** Compare completed shard results with an independently collected full suite. */
export function verifyE2eShards(expectedReport, shardReports, receipts) {
  const expectedTests = reportTests(expectedReport);
  const expected = expectedTests.map((test) => test.identity);
  assert.ok(expected.length > 0, 'empty browser test inventory');
  assert.equal(new Set(expected).size, expected.length, 'duplicate collected test ID');
  const expectedUnsupportedStateTests = expectedTests.filter(
    (test) => test.file === unsupportedStateTest.file && test.title === unsupportedStateTest.title,
  );
  assert.deepEqual(
    expectedUnsupportedStateTests.map((test) => test.projectName).sort(),
    ['chromium', 'firefox-unsupported-state'],
    'unsupported-state inventory must contain the exact Chromium exclusion and Firefox regression',
  );
  assert.equal(shardReports.length, 2, 'expected two browser shards');
  const observed = [];
  let skipped = 0;
  for (const [index, report] of shardReports.entries()) {
    assert.deepEqual(report.config.shard, { current: index + 1, total: 2 }, 'missing or mismatched shard');
    for (const test of reportTests(report)) {
      const isAllowedChromiumExclusion =
        test.file === unsupportedStateTest.file &&
        test.title === unsupportedStateTest.title &&
        test.projectName === 'chromium';
      assert.equal(test.results.length, 1, `missing or retried result: ${test.id}`);
      if (isAllowedChromiumExclusion) {
        assert.equal(test.expectedStatus, 'skipped', `invalid declared exclusion: ${test.id}`);
        assert.equal(test.status, 'skipped', `invalid declared exclusion outcome: ${test.id}`);
        assert.equal(test.results[0].status, 'skipped', `invalid declared exclusion result: ${test.id}`);
        skipped += 1;
      } else {
        assert.equal(test.expectedStatus, 'passed', `non-passing expectation: ${test.id}`);
        assert.equal(test.status, 'expected', `unsuccessful test: ${test.id}`);
        assert.equal(test.results[0].status, 'passed', `test did not pass: ${test.id}`);
      }
      observed.push(test.identity);
    }
  }
  assert.equal(new Set(observed).size, observed.length, 'duplicate executed test ID');
  assert.deepEqual(observed.sort(), expected.sort(), 'executed tests differ from full inventory');
  assert.equal(receipts.length, 1, 'missing or duplicate determinism oracle receipt');
  const receipt = receipts[0];
  assert.equal(receipt.schemaVersion, 1, 'unsupported determinism receipt');
  assert.equal(receipt.fixture, 'state-recipes-capture', 'unexpected determinism fixture');
  assert.deepEqual(receipt.runLabels, ['maps-1', 'maps-2', 'maps-3', 'maps-4', 'maps-5'], 'invalid oracle run labels');
  assert.equal(receipt.verdict.status, 'deterministic', 'oracle did not prove determinism');
  for (const key of ['requiredRuns', 'observedRuns', 'matchingRuns']) {
    assert.equal(receipt.verdict[key], 5, `invalid oracle ${key}`);
  }
  const stateKeys = receipt.verdict.stateKeys;
  assert.ok(Array.isArray(stateKeys) && stateKeys.length > 0, 'missing oracle state keys');
  assert.equal(new Set(stateKeys).size, stateKeys.length, 'duplicate oracle state keys');
  const mapHashes = receipt.verdict.mapHashes;
  assert.ok(mapHashes && typeof mapHashes === 'object' && !Array.isArray(mapHashes), 'missing oracle map hashes');
  assert.deepEqual(Object.keys(mapHashes).sort(), [...stateKeys].sort(), 'incomplete oracle map hashes');
  for (const [stateKey, hash] of Object.entries(mapHashes)) {
    assert.match(hash, /^[a-f0-9]{64}$/, `invalid oracle map hash for ${stateKey}`);
  }
  assert.equal(skipped, 1, 'missing or duplicate declared Chromium exclusion');
  return {
    shards: 2,
    collected: expected.length,
    passed: observed.length - skipped,
    skipped,
    oracle: receipt.verdict.status,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [expectedPath, shardDirectory] = process.argv.slice(2);
  assert.ok(expectedPath && shardDirectory, 'usage: verify-e2e-shards.mjs <inventory.json> <shard-directory>');
  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const directories = [1, 2].map((index) => path.join(shardDirectory, `e2e-shard-${index}`));
  const receipts = directories
    .map((directory) => path.join(directory, 'determinism-oracle.json'))
    .filter((file) => fs.existsSync(file))
    .map(readJson);
  const result = verifyE2eShards(
    readJson(expectedPath),
    directories.map((directory) => readJson(path.join(directory, 'shard.json'))),
    receipts,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipts[0], null, 2)}\n`);
}
