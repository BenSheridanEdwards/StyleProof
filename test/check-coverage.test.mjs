import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COVERAGE_INCLUDE,
  COVERAGE_LINE_FLOOR,
  COVERAGE_MIN_NODE,
  coverageArgs,
  coverageToolSupported,
} from '../scripts/check-coverage.mjs';

test('coverage floor is the measured dist/ baseline minus small slack', () => {
  // Baseline measured on tip 6155b54 with Node 22.20 + dist include: 41.49% lines.
  assert.equal(COVERAGE_LINE_FLOOR, 40);
  assert.equal(COVERAGE_INCLUDE, '**/dist/**');
  assert.deepEqual(COVERAGE_MIN_NODE, { major: 22, minor: 8 });
});

test('coverageToolSupported requires Node 22.8+ (threshold + include flags)', () => {
  assert.equal(coverageToolSupported(18, 20), false);
  assert.equal(coverageToolSupported(20, 19), false);
  assert.equal(coverageToolSupported(22, 7), false);
  assert.equal(coverageToolSupported(22, 8), true);
  assert.equal(coverageToolSupported(22, 20), true);
  assert.equal(coverageToolSupported(24, 0), true);
});

test('coverageArgs emits built-in include + line floor on supported Node', () => {
  assert.equal(coverageArgs({ nodeMajor: 20, nodeMinor: 19 }), null);
  assert.deepEqual(coverageArgs({ nodeMajor: 22, nodeMinor: 20 }), [
    '--experimental-test-coverage',
    '--test-coverage-include=**/dist/**',
    '--test-coverage-lines=40',
  ]);
  assert.deepEqual(coverageArgs({ nodeMajor: 22, nodeMinor: 20, floor: 99, include: '**/src/**' }), [
    '--experimental-test-coverage',
    '--test-coverage-include=**/src/**',
    '--test-coverage-lines=99',
  ]);
});

test('check-coverage exits non-zero when the line floor is impossible', () => {
  if (!coverageToolSupported()) {
    const unsupported = spawnSync(process.execPath, ['scripts/check-coverage.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, STYLEPROOF_PRODUCT_STATE: '' },
    });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /needs Node 22\.8\+/);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cov-floor-'));
  try {
    const covered = path.join(dir, 'lib.js');
    const testFile = path.join(dir, 'lib.test.mjs');
    // Multi-line unused bodies so V8 line coverage stays well below 100%.
    fs.writeFileSync(
      covered,
      [
        'export function used() {',
        '  return 1;',
        '}',
        'export function unusedA() {',
        '  const a = 2;',
        '  const b = 3;',
        '  return a + b;',
        '}',
        'export function unusedB() {',
        '  const a = 4;',
        '  const b = 5;',
        '  return a + b;',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      testFile,
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { used } from ${JSON.stringify(covered)};\ntest('hits one export', () => assert.equal(used(), 1));\n`,
    );

    const env = { ...process.env, STYLEPROOF_PRODUCT_STATE: '' };
    for (const key of Object.keys(env)) {
      if (/^(NODE_TEST|TEST_WORKER|TAP_)/i.test(key)) delete env[key];
    }

    const impossible = spawnSync(
      process.execPath,
      [
        '--experimental-test-coverage',
        `--test-coverage-include=${covered.replaceAll('\\', '/')}`,
        '--test-coverage-lines=100',
        '--test',
        testFile,
      ],
      { encoding: 'utf8', env },
    );
    assert.notEqual(impossible.status, 0, impossible.stdout + impossible.stderr);
    assert.match(`${impossible.stdout}\n${impossible.stderr}`, /coverage|threshold|100/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
