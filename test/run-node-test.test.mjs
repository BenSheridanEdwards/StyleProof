import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NODE_TEST_TIMEOUT_MS, nodeTestArgs, nodeTestEnv } from '../scripts/run-node-test.mjs';

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

test('appends the no-concurrent-jobs preload after existing NODE_OPTIONS', () => {
  const env = nodeTestEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
  assert.match(env.NODE_OPTIONS, /^--max-old-space-size=4096 --require .+no-concurrent-jobs\.cjs$/);
});

test('skips the preload when its path cannot survive NODE_OPTIONS', () => {
  const env = nodeTestEnv({ NODE_OPTIONS: '--x' }, '/a path/with space/no-concurrent-jobs.cjs');
  assert.equal(env.NODE_OPTIONS, '--x');
});

test('a spawned Node child loads the preload (#718)', () => {
  const r = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(process.env.STYLEPROOF_NO_CONCURRENT_JOBS ?? "")'],
    { env: nodeTestEnv({ PATH: process.env.PATH }), encoding: 'utf8' },
  );
  // Unrecognized V8 flags print to stderr before throwing — on Node versions
  // without Maglev that noise would break every output-asserting CLI test.
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '1');
});
