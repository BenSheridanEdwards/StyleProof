import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { coverageArgs, COVERAGE_LINE_FLOOR } from '../scripts/check-coverage.mjs';
import { nodeTestArgs } from '../scripts/run-node-test.mjs';
import { encodeSummary, decodeSummary, COVERAGE_SHARD_COUNT } from '../scripts/coverage-shards.mjs';

const testFiles = nodeTestArgs().filter((arg) => arg.endsWith('.test.mjs'));
const inventory = (index) => testFiles.filter((_, offset) => offset % COVERAGE_SHARD_COUNT === index);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-records-')));

after(() => fs.rmSync(root, { recursive: true, force: true }));

const coverage = (file, entries) => {
  const source = 'void 0;\n'.repeat(Math.max(...entries.map(([line]) => line)));
  const ranges = entries.map(([line, count]) => ({ startOffset: (line - 1) * 8, endOffset: line * 8, count }));

  return [[`dist/${file}.js`, [{ functionName: '', isBlockCoverage: true, ranges }], source]];
};

const record = (file, entries) =>
  coverage(
    file,
    entries.split(' ').map((entry) => entry.split(':').map(Number)),
  );

const passing = coverage('a', [[1, 1]]);
const summary = (files, tests) => encodeSummary({ tests, files });
const job = (summary) => ({ result: 'success', outputs: { summary } });

const needsFor = (reports = [passing, passing, passing]) =>
  Object.fromEntries(reports.map((report, index) => [`coverage-${index + 1}`, job(summary(report, inventory(index)))]));

function execute(args, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;

  const argsWithInternals = ['--expose-internals', ...args];
  const result = spawnSync(process.execPath, argsWithInternals, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });

  assert.ok(!result.error && result.status !== null, result.error?.message ?? result.stderr);

  return result;
}

const command = new URL('../scripts/coverage-shards.mjs', import.meta.url).pathname;
const merge = (needs) => execute([command, 'merge'], { COVERAGE_NEEDS: JSON.stringify(needs) });

test('merge matches union V8 totals, including coverage and files seen by only one shard', () => {
  const reports = [
    [...record('a', '1:1 2:0 4:0 8:0'), ...record('b', '10:1')],
    [...record('a', '1:0 2:5 4:0 8:0'), ...record('c', '1:0 3:1')],
    record('a', '1:0 2:0 4:1 8:0'),
  ];

  const union = [...record('a', '1:1 2:5 4:1 8:0'), ...record('b', '10:1'), ...record('c', '1:0 3:1')];
  const merged = merge(needsFor(reports));
  const single = merge(needsFor([union, union, union]));
  assert.equal(merged.status, 1, merged.stderr);
  assert.equal(single.status, 1, single.stderr);
  assert.deepEqual(JSON.parse(merged.stdout), JSON.parse(single.stdout));
  assert.deepEqual(JSON.parse(merged.stdout), { total: 21, covered: 5, percent: (5 / 21) * 100 });
});

for (const shard of ['coverage-1', 'coverage-2', 'coverage-3']) {
  for (const fault of ['missing', 'output', '', 'bad!', 'gzip', '{}', 'failure', 'skipped', 'cancelled']) {
    test(`merge fails closed: ${shard} has ${fault}`, () => {
      const needs = needsFor();

      if (fault === 'missing') delete needs[shard];
      else if (fault === 'output') delete needs[shard].outputs.summary;
      else if (['failure', 'skipped', 'cancelled'].includes(fault)) needs[shard].result = fault;
      else if (fault === 'gzip') needs[shard].outputs.summary = needs[shard].outputs.summary.slice(0, -8);
      else if (fault === '{}') needs[shard].outputs.summary = brotliCompressSync('{}').toString('base64');
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
    coverage(
      `module-${file}`,
      Array.from({ length: 500 }, (_, line) => [line * 2 + 1, (line + file) % 3 === 0 ? 7 : 0]),
    ),
  ).flat();

  const original = { files: report, tests: testFiles };
  const encoded = encodeSummary(original);
  assert.deepEqual(decodeSummary(encoded), original);
  assert.ok(Buffer.byteLength(encoded) < 100_000, `${Buffer.byteLength(encoded)} bytes must stay far below 1 MB`);
  assert.doesNotMatch(encoded, /[\r\n]/, 'one GITHUB_OUTPUT line');
});

for (const dir of ['dist', 'test', 'scripts']) fs.mkdirSync(path.join(root, dir));

for (const file of ['coverage-shards', 'check-coverage', 'run-node-test'])
  fs.copyFileSync(new URL(`../scripts/${file}.mjs`, import.meta.url), path.join(root, `scripts/${file}.mjs`));

fs.copyFileSync(new URL('./no-concurrent-jobs.cjs', import.meta.url), path.join(root, 'test/no-concurrent-jobs.cjs'));

const body = (name, size) => `export function ${name}() {\n${'  void 0;\n'.repeat(size)}}\n`;
const fixtureTests = ['test/0.test.mjs', 'test/1.test.mjs', 'test/2.test.mjs'];

for (const covered of [COVERAGE_LINE_FLOOR * 100 - 1, COVERAGE_LINE_FLOOR * 100]) {
  test(`real shards match Node and enforce the unchanged floor at ${covered / 100}% without rounding up`, () => {
    const below = covered < COVERAGE_LINE_FLOOR * 100;
    fs.writeFileSync(
      path.join(root, 'dist/module.js'),
      body('used', below ? 7993 : 7995) + body('unused', below ? 2003 : 2001),
    );

    for (let i = 0; i < 3; i++)
      fs.writeFileSync(
        path.join(root, `test/${i}.test.mjs`),
        `import { used, unused } from '../dist/module.js${i === 1 ? '?copy=1' : ''}';\n${i === 1 ? '' : 'used();'}\n`,
      );
    const single = execute([...coverageArgs(), '--test', '--test-reporter=spec', ...fixtureTests]);
    const needs = {};

    for (let i = 1; i <= 3; i++) {
      const output = path.join(root, `output-${below}-${i}`);
      const shard = execute(['scripts/coverage-shards.mjs', 'run', String(i), '3'], { GITHUB_OUTPUT: output });
      assert.equal(shard.status, 0, shard.stderr);
      needs[`coverage-${i}`] = job(fs.readFileSync(output, 'utf8').trim().slice('summary='.length));
    }

    const merged = execute(['scripts/coverage-shards.mjs', 'merge'], { COVERAGE_NEEDS: JSON.stringify(needs) });
    assert.equal(single.status, below ? 1 : 0, single.stdout + single.stderr);
    assert.equal(merged.status, single.status, merged.stdout + merged.stderr);

    assert.equal(JSON.parse(merged.stdout).percent.toFixed(2), (covered / 100).toFixed(2));
    assert.equal(JSON.parse(merged.stdout).percent.toFixed(2), single.stdout.match(/all files\s*\|\s*([\d.]+)/)?.[1]);
  });
}
