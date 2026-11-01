import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as coverage from '../scripts/check-coverage.mjs';
import { mergeCoverage } from '../scripts/merge-coverage.mjs';

test('coverage shard arguments report lcov without a shard floor', () => {
  const args = coverage.coverageArgs({ nodeMajor: 22, nodeMinor: 13, shard: '1/3', lcov: 'one.info' });
  assert.ok(args.includes('--test-shard=1/3'));
  assert.ok(args.includes('--test-reporter=lcov'));
  assert.ok(!args.some((arg) => arg.startsWith('--test-coverage-lines=')));
});

test('merged floor preserves comparable headroom while the local floor stays unchanged', () => {
  assert.equal(coverage.COVERAGE_LINE_FLOOR, 40);
  assert.equal(coverage.MERGED_COVERAGE_LINE_FLOOR, 80);
});

test('merge CLI fails closed and enforces the merged floor at the boundary', () => {
  const floor = coverage.MERGED_COVERAGE_LINE_FLOOR ?? 80;
  const dir = mkdtempSync(join(tmpdir(), 'coverage-1210-'));
  const file = join(dir, 'input.info');
  const script = fileURLToPath(new URL('../scripts/merge-coverage.mjs', import.meta.url));
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
    });
  try {
    assert.equal(run('--expect', '1', join(dir, 'missing')).status, 1);
    for (const content of ['', 'garbage', 'SF:dist/a.js\nDA:1,1\n']) {
      writeFileSync(file, content);
      assert.equal(run('--expect', '1', file).status, 1);
    }
    writeFileSync(file, 'SF:dist/a.js\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,0\nDA:5,0\nend_of_record\n');
    assert.equal(run('--expect', '1', file).status, 1);
    for (const hits of [floor - 1, floor, floor + 1]) {
      writeFileSync(
        file,
        `SF:dist/a.js\n${Array.from({ length: 100 }, (_, i) => `DA:${i + 1},${i < hits ? 1 : 0}`).join('\n')}\nend_of_record\n`,
      );
      const result = run('--expect', '1', file);
      assert.equal(result.status, hits < floor ? 1 : 0);
      assert.match(result.stdout, new RegExp(`floor ${floor}%`));
    }
    assert.equal(run('--expect', '2', file).status, 1);
    writeFileSync(
      file,
      `SF:dist/a.js\n${Array.from({ length: 20001 }, (_, i) => `DA:${i + 1},${i < floor * 200 ? 1 : 0}`).join('\n')}\nend_of_record\n`,
    );
    const rounded = run('--expect', '1', file);
    assert.ok(rounded.stdout.includes(`${floor.toFixed(2)}%`));
    assert.equal(rounded.status, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('merge rejects empty records, malformed lines and out-of-scope sources', () => {
  for (const body of ['SF:dist/a.js\n', 'SF:dist/a.js\nDA:bad\n']) {
    assert.throws(() => mergeCoverage([`${body}end_of_record\n`], 1));
  }
  for (const source of ['src/a.js', 'nested/dist/a.js', 'node_modules/dist/a.js']) {
    const outside = `SF:${source}\nDA:1,1\nend_of_record\n`;
    assert.throws(() => mergeCoverage([outside], 1));
    assert.throws(() => mergeCoverage([`SF:dist/a.js\nDA:1,1\nend_of_record\n${outside}`], 1));
  }
});

test('coverage CLI rejects invalid shard argv before running tests', () => {
  const script = fileURLToPath(new URL('../scripts/check-coverage.mjs', import.meta.url));
  for (const args of [
    ['--shard', '4/3', '--lcov', 'bad.info'],
    ['--shard', '1/3'],
    ['--shard', '1/3', '--lcov', 'bad.info', 'extra'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /check-coverage: use --shard i\/3 --lcov/);
  }
});

test('merged coverage unions line hits across shards', () => {
  const record = (hits) =>
    `SF:dist/index.js\n${hits.map((hit, i) => `DA:${i + 1},${hit}`).join('\n')}\nend_of_record\n`;
  assert.equal(mergeCoverage([record([1, 0]), record([0, 1])], 2), 100);
  assert.equal(mergeCoverage([record([1, 0, 0, 0, 0])], 1), 20);
  assert.equal(mergeCoverage([record([1, 1, 0, 0, 0])], 1), 40);
  for (const inputs of [[], [''], ['garbage']]) {
    assert.throws(() => mergeCoverage(inputs, 1));
  }
});
