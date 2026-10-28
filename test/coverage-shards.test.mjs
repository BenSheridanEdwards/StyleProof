import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { COVERAGE_LINE_FLOOR } from '../scripts/check-coverage.mjs';
import { nodeTestArgs } from '../scripts/run-node-test.mjs';
import { summarizeLcov, encodeSummary, decodeSummary } from '../scripts/coverage-shards.mjs';

const testFiles = nodeTestArgs().filter((arg) => arg.endsWith('.test.mjs'));
const inventory = (index) => testFiles.filter((_, offset) => offset % 3 === index);
const lines = (total, covered) => Array.from({ length: total }, (_, i) => [i + 1, i < covered ? 1 : 0]);

const lcov = (file, entries) =>
  `TN:\nSF:dist/${file}.js\n${entries.map(([line, hits]) => `DA:${line},${hits}`).join('\n')}\nLF:${entries.length}\nLH:${entries.filter(([, hits]) => hits > 0).length}\nend_of_record\n`;

const record = (file, entries) =>
  `TN:\nSF:dist/${file}.js\nDA:${entries.replaceAll(':', ',').replaceAll(' ', '\nDA:')}\nend_of_record\n`;

const passing = lcov('a', [[1, 1]]);
const summary = (report, tests) => encodeSummary(summarizeLcov(report, tests));

const needsFor = (reports = [passing, passing, passing]) =>
  Object.fromEntries(
    reports.map((report, index) => [
      `coverage-${index + 1}`,
      { result: 'success', outputs: { summary: summary(report, inventory(index)) } },
    ]),
  );

function merge(needs) {
  const script = new URL('../scripts/coverage-shards.mjs', import.meta.url);

  const result = spawnSync(process.execPath, [script.pathname, 'merge'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, COVERAGE_NEEDS: JSON.stringify(needs) },
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.ok(!result.error && result.status !== null, result.error?.message ?? result.stderr);

  return result;
}

test('merge matches union LCOV totals, including coverage and files seen by only one shard', () => {
  const reports = [
    record('a', '1:1 2:0 4:0') + record('b', '10:1'),
    record('a', '1:0 2:5 4:0') + record('c', '1:0 3:1'),
    record('a', '1:0 2:0 4:1 8:0'),
  ];

  const union = record('a', '1:1 2:5 4:1 8:0') + record('b', '10:1') + record('c', '1:0 3:1');
  const merged = merge(needsFor(reports));
  const single = merge(needsFor([union, union, union]));
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(single.status, 0, single.stderr);
  assert.deepEqual(JSON.parse(merged.stdout), JSON.parse(single.stdout));
  assert.deepEqual(JSON.parse(merged.stdout), { total: 7, covered: 5, percent: (5 / 7) * 100 });
});

for (const covered of [COVERAGE_LINE_FLOOR * 100 - 1, COVERAGE_LINE_FLOOR * 100]) {
  test(`merge enforces the unchanged floor at ${covered / 100}% without rounding up`, () => {
    const report = lcov('floor', lines(10_000, covered));
    const result = merge(needsFor([report, report, report]));
    assert.equal(result.status === 0, covered === COVERAGE_LINE_FLOOR * 100, result.stdout + result.stderr);

    if (result.status === 0) assert.equal(JSON.parse(result.stdout).percent, COVERAGE_LINE_FLOOR);
    else assert.match(result.stderr, /floor|coverage|threshold/i);
  });
}

for (const shard of ['coverage-1', 'coverage-2', 'coverage-3']) {
  for (const fault of ['missing', 'output', '', 'bad!', 'gzip', '{}', 'failure', 'skipped', 'cancelled']) {
    test(`merge fails closed: ${shard} has ${fault}`, () => {
      const needs = needsFor();

      if (fault === 'missing') delete needs[shard];
      else if (fault === 'output') delete needs[shard].outputs.summary;
      else if (['failure', 'skipped', 'cancelled'].includes(fault)) needs[shard].result = fault;
      else if (fault === 'gzip') needs[shard].outputs.summary = needs[shard].outputs.summary.slice(0, -8);
      else if (fault === '{}') needs[shard].outputs.summary = gzipSync('{}').toString('base64');
      else needs[shard].outputs.summary = fault;
      const result = merge(needs);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /coverage|shard|summary/i);
    });
  }
}

for (const fault of ['missing', 'duplicate', 'unexpected']) {
  test(`merge rejects ${fault} test files even with passing coverage`, () => {
    const needs = needsFor();
    const files = inventory(0);

    if (fault === 'missing') files.shift();
    else files.push(fault === 'duplicate' ? testFiles[1] : 'test/not-in-the-suite.test.mjs');
    needs['coverage-1'].outputs.summary = summary(passing, files);
    const result = merge(needs);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /test|inventory/i);
  });
}

test('compact summary round trip preserves sparse line identities across 150 realistic files', () => {
  const report = Array.from({ length: 150 }, (_, file) =>
    lcov(
      `module-${file}`,
      Array.from({ length: 500 }, (_, line) => [line * 2 + 1, (line + file) % 3 === 0 ? 7 : 0]),
    ),
  ).join('');

  const original = summarizeLcov(report, testFiles);
  const encoded = encodeSummary(original);
  assert.deepEqual(decodeSummary(encoded), original);
  assert.ok(Buffer.byteLength(encoded) < 100_000, `${Buffer.byteLength(encoded)} bytes must stay far below 1 MB`);
  assert.doesNotMatch(encoded, /[\r\n]/, 'one GITHUB_OUTPUT line');
});
