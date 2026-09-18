import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_TEST_TIMEOUT_MS, nodeTestArgs } from '../scripts/run-node-test.mjs';

test('omits --test-timeout on Node 18', () => {
  const args = nodeTestArgs({ nodeMajor: 18, files: ['test/x.test.mjs'] });
  assert.deepEqual(args, ['--test', 'test/x.test.mjs']);
});

test('includes --test-timeout on Node 20+', () => {
  const args = nodeTestArgs({ nodeMajor: 20, files: ['test/x.test.mjs'] });
  assert.deepEqual(args, ['--test', `--test-timeout=${NODE_TEST_TIMEOUT_MS}`, 'test/x.test.mjs']);
});

test('preserves --watch before the timeout flag', () => {
  const args = nodeTestArgs({ nodeMajor: 22, watch: true, files: ['test/x.test.mjs'] });
  assert.deepEqual(args, ['--test', '--watch', `--test-timeout=${NODE_TEST_TIMEOUT_MS}`, 'test/x.test.mjs']);
});
