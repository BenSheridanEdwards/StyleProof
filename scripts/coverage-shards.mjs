import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import * as gate from './check-coverage.mjs';
import { fileSnapshot, nodeTestArgs, nodeTestEnv, snapshotChanges } from './run-node-test.mjs';

const script = fileURLToPath(import.meta.url);
const prefix = pathToFileURL(`${process.cwd()}${path.sep}`).href;
const testFiles = () => nodeTestArgs().filter((arg) => arg.endsWith('.test.mjs'));
export const COVERAGE_SHARD_COUNT = 3;
const SUMMARY_LIMIT = 400_000; // Below 1 MB even with Actions' UTF-16 size accounting.

export function encodeSummary(summary) {
  const encoded = brotliCompressSync(Buffer.from(JSON.stringify(summary))).toString('base64');
  assert.ok(encoded.length < SUMMARY_LIMIT, 'coverage summary exceeds job output budget');

  return encoded;
}

export function decodeSummary(encoded) {
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, 'invalid summary encoding');
  assert.ok(encoded.length < SUMMARY_LIMIT, 'summary exceeds output budget');
  const compressed = Buffer.from(encoded, 'base64');
  assert.equal(compressed.toString('base64'), encoded, 'invalid summary encoding');
  const summary = JSON.parse(brotliDecompressSync(compressed, { maxOutputLength: 16_000_000 }).toString());
  assert.ok(Array.isArray(summary.tests), 'invalid test inventory');
  summary.tests.forEach((file) => assert.match(file, /^test\/[^/]+\.test\.mjs$/, 'invalid test file'));
  assert.ok(Array.isArray(summary.files), 'invalid summary files');
  const names = new Set();

  for (const [file, functions, source] of summary.files) {
    assert.match(file, /^dist\/[^\s#]+\.js(?:\?[^\s#]*)?$/, 'invalid coverage file');
    assert.ok(!names.has(file), 'duplicate coverage file');
    names.add(file);
    assert.ok(Array.isArray(functions), 'invalid coverage functions');
    assert.match(source, /^[\s\S]*$/, 'missing coverage source');

    for (const { startOffset, endOffset, count } of functions.flatMap((fn) => fn.ranges)) {
      assert.ok([startOffset, endOffset, count].every(Number.isSafeInteger), 'invalid coverage range');
      assert.ok(startOffset >= 0 && endOffset >= startOffset && count >= 0, 'invalid coverage offsets');
    }
  }

  return summary;
}

// Node’s native merger preserves URL identities, ignored lines and V8 ranges lost by LCOV.
function merge(needs, coverage) {
  const files = new Map();
  const tests = [];

  for (let index = 1; index <= COVERAGE_SHARD_COUNT; index++) {
    const job = needs[`coverage-${index}`];
    assert.equal(job?.result, 'success', `coverage shard ${index} did not succeed`);
    const summary = decodeSummary(job.outputs?.summary);
    tests.push(...summary.tests);

    for (const [file, functions, source] of summary.files) {
      const url = new URL(file, prefix).href;
      assert.equal(files.get(url)?.source ?? source, source, 'shards disagree on source');
      coverage.getLines(url, source);
      coverage.mergeCoverage(files, [{ url, functions, source }]);
    }
  }

  assert.deepEqual(tests.sort(), testFiles(), 'test inventory must include every unit file exactly once');
  coverage.getCoverageFromDirectory = () => [...files.values()];
  const { totalLineCount: total, coveredLineCount: covered, coveredLinePercent: percent } = coverage.summary().totals;
  console.log(JSON.stringify({ total, covered, percent }));
  assert.ok(percent >= gate.COVERAGE_LINE_FLOOR, `coverage ${percent}% below line floor ${gate.COVERAGE_LINE_FLOOR}%`);
}

export default async function* inventoryReporter(events) {
  const tests = new Set();

  for await (const { type, data } of events) {
    if (type === 'test:complete' && path.resolve(data.name) === data.file) tests.add(path.relative('.', data.file));
  }

  yield JSON.stringify([...tests].sort());
}

function run(index, count, coverage) {
  assert.ok(Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count, 'invalid shard');
  const instrumentation = gate.coverageArgs();
  assert.ok(instrumentation, 'coverage shards require Node 22.8+');

  const args = [
    ...instrumentation.filter((arg) => !arg.startsWith('--test-coverage-lines=')),
    `--test-shard=${index}/${count}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stderr',
    `--test-reporter=${script}`,
    '--test-reporter-destination=stdout',
    ...nodeTestArgs().map((arg) =>
      arg.startsWith('--test-timeout=') ? `--test-timeout=${gate.COVERAGE_TEST_TIMEOUT_MS}` : arg,
    ),
  ];

  const before = fileSnapshot('dist');

  const result = spawnSync(process.execPath, args, {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64_000_000,
    env: { ...nodeTestEnv(), NODE_V8_COVERAGE: coverage.coverageDirectory },
  });

  assert.equal(result.status, 0, 'coverage shard tests failed');
  assert.deepEqual(snapshotChanges(before, fileSnapshot('dist')), [], 'unit tests modified shared dist/');

  const files = coverage
    .getCoverageFromDirectory()
    .map(({ url, functions }) => [url.slice(prefix.length), functions, fs.readFileSync(fileURLToPath(url), 'utf8')]);

  const summary = encodeSummary({ tests: JSON.parse(result.stdout), files });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
}

if (process.argv[1] === script) {
  try {
    const { setupCoverage } = createRequire(import.meta.url)('internal/test_runner/coverage');

    const coverage = setupCoverage({
      cwd: process.cwd(),
      coverageIncludeGlobs: [gate.COVERAGE_INCLUDE],
      coverageExcludeGlobs: [gate.COVERAGE_EXCLUDE],
    });

    process.once('exit', () => coverage.cleanup());

    if (process.argv[2] === 'merge') merge(JSON.parse(process.env.COVERAGE_NEEDS), coverage);
    else if (process.argv[2] === 'run')
      run(Number(process.argv[3]), Number(process.argv[4] ?? COVERAGE_SHARD_COUNT), coverage);
    else throw new Error('usage: coverage-shards.mjs run <k> <n> | merge');
  } catch (error) {
    console.error(`coverage-shards: ${error.message}`);
    process.exitCode = 1;
  }
}
