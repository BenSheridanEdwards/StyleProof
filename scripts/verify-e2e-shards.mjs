import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function reportTests(report) {
  assert.deepEqual(report.errors, [], 'browser report contains errors');
  const tests = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      assert.equal(typeof spec.id, 'string', 'missing test ID');
      for (const test of spec.tests) tests.push({ id: `${spec.id}:${test.projectName}`, ...test });
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  visit(report);
  return tests;
}

/** Compare completed shard results with an independently collected full suite. */
export function verifyE2eShards(expectedReport, shardReports, receipts) {
  const expected = reportTests(expectedReport).map((test) => test.id);
  assert.ok(expected.length > 0, 'empty browser test inventory');
  assert.equal(new Set(expected).size, expected.length, 'duplicate collected test ID');
  assert.equal(shardReports.length, 2, 'expected two browser shards');
  const observed = [];
  for (const [index, report] of shardReports.entries()) {
    assert.deepEqual(report.config.shard, { current: index + 1, total: 2 }, 'missing or mismatched shard');
    for (const test of reportTests(report)) {
      assert.equal(test.expectedStatus, 'passed', `non-passing expectation: ${test.id}`);
      assert.equal(test.status, 'expected', `unsuccessful test: ${test.id}`);
      assert.equal(test.results.length, 1, `missing or retried result: ${test.id}`);
      assert.equal(test.results[0].status, 'passed', `test did not pass: ${test.id}`);
      observed.push(test.id);
    }
  }
  assert.equal(new Set(observed).size, observed.length, 'duplicate executed test ID');
  assert.deepEqual(observed.sort(), expected.sort(), 'executed tests differ from full inventory');
  assert.equal(receipts.length, 1, 'missing or duplicate determinism oracle receipt');
  const receipt = receipts[0];
  assert.equal(receipt.schemaVersion, 1, 'unsupported determinism receipt');
  assert.equal(receipt.fixture, 'state-recipes-capture', 'unexpected determinism fixture');
  assert.equal(receipt.verdict.status, 'deterministic', 'oracle did not prove determinism');
  for (const key of ['requiredRuns', 'observedRuns', 'matchingRuns']) {
    assert.equal(receipt.verdict[key], 5, `invalid oracle ${key}`);
  }
  return { shards: 2, collected: expected.length, passed: observed.length, oracle: receipt.verdict.status };
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
