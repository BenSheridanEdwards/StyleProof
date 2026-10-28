import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { coverageArgs, COVERAGE_LINE_FLOOR, COVERAGE_TEST_TIMEOUT_MS } from './check-coverage.mjs';
import { fileSnapshot, nodeTestArgs, nodeTestEnv, snapshotChanges } from './run-node-test.mjs';

const testFiles = () => nodeTestArgs().filter((arg) => arg.endsWith('.test.mjs'));
const SUMMARY_LIMIT = 400_000; // Below 1 MB even with Actions' UTF-16 size accounting.

export function summarizeLcov(lcov, tests) {
  const files = [];
  let current;

  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      assert.ok(!current, 'unfinished lcov record');
      current = [line.slice(3), [], []];
    } else if (line.startsWith('DA:')) {
      const match = line.match(/^DA:([1-9]\d*),(\d+)$/);
      assert.ok(current && match, 'invalid lcov line');
      current[1].push(Number(match[1]));

      if (Number(match[2]) > 0) current[2].push(Number(match[1]));
    } else if (/^L[FH]:/.test(line)) {
      const index = line.startsWith('LF:') ? 1 : 2;
      assert.ok(current && Number(line.slice(3)) === current[index].length, 'lcov line count mismatch');
    } else if (line === 'end_of_record') {
      assert.ok(current, 'missing lcov file');
      files.push(current);
      current = undefined;
    }
  }

  assert.ok(!current && lcov.startsWith('TN:'), 'missing or truncated lcov report');

  return { tests, files };
}

export function encodeSummary(summary) {
  const encoded = gzipSync(JSON.stringify(summary)).toString('base64');
  assert.ok(encoded.length < SUMMARY_LIMIT, 'coverage summary exceeds job output budget');

  return encoded;
}

export function decodeSummary(encoded) {
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, 'invalid summary encoding');
  assert.ok(encoded.length < SUMMARY_LIMIT, 'summary exceeds output budget');
  const compressed = Buffer.from(encoded, 'base64');
  assert.equal(compressed.toString('base64'), encoded, 'invalid summary encoding');
  const summary = JSON.parse(gunzipSync(compressed, { maxOutputLength: 16_000_000 }).toString());
  assert.ok(Array.isArray(summary.tests), 'invalid test inventory');
  summary.tests.forEach((file) => assert.match(file, /^test\/[^/]+\.test\.mjs$/, 'invalid test file'));
  assert.ok(Array.isArray(summary.files), 'invalid summary files');
  const names = new Set();

  for (const entry of summary.files) {
    assert.ok(Array.isArray(entry) && entry.length === 3, 'invalid summary entry');
    const [file, lines, covered] = entry;
    assert.match(file, /^dist\/[^\s]+$/, 'invalid coverage file');
    assert.ok(!names.has(file), 'duplicate coverage file');
    names.add(file);

    for (const list of [lines, covered]) {
      assert.ok(Array.isArray(list), 'invalid summary lines');

      for (const line of list) assert.ok(Number.isSafeInteger(line) && line > 0, 'invalid summary line');
      assert.equal(new Set(list).size, list.length, 'duplicate summary lines');
    }

    const instrumented = new Set(lines);
    assert.ok(covered.every(instrumented.has.bind(instrumented)), 'covered line not instrumented');
  }

  return summary;
}

function merge(needs) {
  const files = new Map();
  const tests = [];

  for (let index = 1; index <= 3; index++) {
    const job = needs[`coverage-${index}`];
    assert.equal(job?.result, 'success', `coverage shard ${index} did not succeed`);
    const summary = decodeSummary(job.outputs?.summary);
    tests.push(...summary.tests);

    for (const [file, lines, covered] of summary.files) {
      if (!files.has(file)) files.set(file, [new Set(), new Set()]);
      const union = files.get(file);
      lines.forEach((line) => union[0].add(line));
      covered.forEach((line) => union[1].add(line));
    }
  }

  assert.deepEqual(tests.sort(), testFiles(), 'test inventory must include every unit file exactly once');
  const total = [...files.values()].reduce((sum, [lines]) => sum + lines.size, 0);
  const covered = [...files.values()].reduce((sum, [, hits]) => sum + hits.size, 0);
  const percent = total === 0 ? 100 : (covered / total) * 100;
  console.log(JSON.stringify({ total, covered, percent }));
  assert.ok(percent >= COVERAGE_LINE_FLOOR, `coverage ${percent}% below line floor ${COVERAGE_LINE_FLOOR}%`);
}

export function shardArgs(index, count, destination) {
  assert.ok(Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count, 'invalid shard');
  const coverage = coverageArgs();
  assert.ok(coverage, 'coverage shards require Node 22.8+');

  return [
    ...coverage.filter((arg) => !arg.startsWith('--test-coverage-lines=')),
    `--test-shard=${index}/${count}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stderr',
    '--test-reporter=lcov',
    `--test-reporter-destination=${destination}`,
    ...nodeTestArgs().map((arg) =>
      arg.startsWith('--test-timeout=') ? `--test-timeout=${COVERAGE_TEST_TIMEOUT_MS}` : arg,
    ),
  ];
}

function run(index, count) {
  const before = fileSnapshot('dist');

  const result = spawnSync(process.execPath, shardArgs(index, count, 'stdout'), {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64_000_000,
    env: nodeTestEnv(),
  });

  assert.equal(result.status, 0, 'coverage shard tests failed');
  assert.deepEqual(snapshotChanges(before, fileSnapshot('dist')), [], 'unit tests modified shared dist/');
  const tests = testFiles().filter((_, offset) => offset % count === index - 1);
  const summary = encodeSummary(summarizeLcov(result.stdout, tests));
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'merge') merge(JSON.parse(process.env.COVERAGE_NEEDS));
    else if (process.argv[2] === 'run') run(Number(process.argv[3]), Number(process.argv[4]));
    else throw new Error('usage: coverage-shards.mjs run <k> <n> | merge');
  } catch (error) {
    console.error(`coverage-shards: ${error.message}`);
    process.exitCode = 1;
  }
}
