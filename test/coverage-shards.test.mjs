import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { coverageArgs } from '../scripts/check-coverage.mjs';
import { mergeCoverage } from '../scripts/merge-coverage.mjs';

test('coverage shard arguments report lcov without a shard floor', () => {
  const args = coverageArgs({ nodeMajor: 22, nodeMinor: 13, shard: '1/3', lcov: 'one.info' });
  assert.ok(args.includes('--test-shard=1/3'));
  assert.ok(args.includes('--test-reporter=lcov'));
  assert.ok(!args.some((arg) => arg.startsWith('--test-coverage-lines=')));
});

test('merge CLI fails closed and enforces the floor at the boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-1210-'));
  const file = join(dir, 'input.info');
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/merge-coverage.mjs', ...args], {
      encoding: 'utf8',
    });
  assert.equal(run('--expect', '1', join(dir, 'missing')).status, 1);
  for (const content of ['', 'garbage', 'SF:dist/a.js\nDA:1,1\n']) {
    writeFileSync(file, content);
    assert.equal(run('--expect', '1', file).status, 1);
  }
  writeFileSync(file, 'SF:dist/a.js\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,0\nDA:5,0\nend_of_record\n');
  assert.equal(run('--expect', '1', file).status, 1);
  writeFileSync(file, 'SF:dist/a.js\nDA:1,1\nDA:2,1\nDA:3,0\nDA:4,0\nDA:5,0\nend_of_record\n');
  assert.equal(run('--expect', '1', file).status, 0);
  assert.equal(run('--expect', '2', file).status, 1);
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
