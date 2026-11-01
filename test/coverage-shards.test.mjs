import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coverageArgs } from '../scripts/check-coverage.mjs';
import { mergeCoverage } from '../scripts/merge-coverage.mjs';

test('coverage shard arguments report lcov without a shard floor', () => {
  const args = coverageArgs({ nodeMajor: 22, nodeMinor: 13, shard: '1/3', lcov: 'one.info' });
  assert.ok(args.includes('--test-shard=1/3'));
  assert.ok(args.includes('--test-reporter=lcov'));
  assert.ok(!args.some((arg) => arg.startsWith('--test-coverage-lines=')));
});

test('merged coverage unions hits and enforces the shared floor', () => {
  const record = (hits) =>
    `SF:dist/index.js\n${hits.map((hit, i) => `DA:${i + 1},${hit}`).join('\n')}\nend_of_record\n`;
  assert.equal(mergeCoverage([record([1, 0]), record([0, 1])], 2), 100);
  assert.equal(mergeCoverage([record([1, 0, 0, 0, 0])], 1), 20);
  assert.equal(mergeCoverage([record([1, 1, 0, 0, 0])], 1), 40);
  for (const inputs of [[], [''], ['garbage']]) {
    assert.throws(() => mergeCoverage(inputs, 1));
  }
});

test('coverage workflow shards and retains the required merge check', () => {
  const yaml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(yaml, /shard: \[1, 2, 3\]/);
  assert.match(yaml, /coverage:\n {4}name: coverage \(node 22\)\n {4}needs: coverage-shards/);
  assert.match(yaml, /needs: \[changes, build, coverage,/);
});
