import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publish = path.join(root, 'bin/styleproof-publish-report.mjs');
const prune = path.join(root, 'bin/styleproof-prune-reports.mjs');

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: '' },
  });
}

for (const [name, script] of [
  ['styleproof-publish-report', publish],
  ['styleproof-prune-reports', prune],
]) {
  test(`${name}: --help prints usage and exits zero`, () => {
    const result = run(script, ['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^usage: ${name}`));
  });
}

test('styleproof-prune-reports: invalid numeric limits fail before any GitHub request', () => {
  const invalidBudget = run(prune, [
    '--repository',
    'acme/widgets',
    '--retention-days',
    '14',
    '--budget-bytes',
    'not-a-number',
  ]);
  assert.equal(invalidBudget.status, 2);
  assert.match(invalidBudget.stderr, /--budget-bytes must be a finite non-negative number/);

  const invalidPullRequest = run(prune, ['--repository', 'acme/widgets', '--pull-request', '1.5']);
  assert.equal(invalidPullRequest.status, 2);
  assert.match(invalidPullRequest.stderr, /--pull-request must be a positive integer/);
});

test('report-management CLIs accept --flag=value syntax', () => {
  const pruneResult = run(prune, ['--repository=acme/widgets', '--pull-request=42']);
  assert.equal(pruneResult.status, 2);
  assert.match(pruneResult.stderr, /GH_TOKEN is required/);
  assert.doesNotMatch(pruneResult.stderr, /missing --repository/);

  const publishResult = run(publish, [
    '--repository=acme/widgets',
    '--branch=styleproof-reports',
    '--report-path=pr-42',
    '--report-dir=styleproof-report',
    '--head-sha=abc123',
    `--manifest-digest=${'a'.repeat(64)}`,
    '--run-id=7',
    '--run-attempt=1',
  ]);
  assert.equal(publishResult.status, 2);
  assert.match(publishResult.stderr, /GH_TOKEN is required/);
  assert.doesNotMatch(publishResult.stderr, /missing --repository/);
});
