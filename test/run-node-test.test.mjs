import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NODE_TEST_TIMEOUT_MS,
  fileSnapshot,
  nodeTestArgs,
  nodeTestEnv,
  snapshotChanges,
} from '../scripts/run-node-test.mjs';

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

test('fileSnapshot/snapshotChanges report files added, removed, or rewritten in dist/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-dist-snapshot-'));
  try {
    fs.mkdirSync(path.join(dir, 'report'));
    fs.writeFileSync(path.join(dir, 'kept.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'report', 'rewritten.js'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(dir, 'removed.js'), 'export const c = 1;\n');
    const before = fileSnapshot(dir);
    assert.deepEqual(snapshotChanges(before, fileSnapshot(dir)), []);

    // Same size, later mtime: what a tsc rebuild of an unchanged module looks like.
    fs.writeFileSync(path.join(dir, 'report', 'rewritten.js'), 'export const b = 1;\n');
    fs.utimesSync(path.join(dir, 'report', 'rewritten.js'), new Date(), new Date(Date.now() + 5_000));
    fs.rmSync(path.join(dir, 'removed.js'));
    fs.writeFileSync(path.join(dir, 'added.js'), '');
    assert.deepEqual(snapshotChanges(before, fileSnapshot(dir)), ['added.js', 'removed.js', 'report/rewritten.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fileSnapshot of a missing dir is empty', () => {
  assert.equal(fileSnapshot(path.join(os.tmpdir(), 'styleproof-no-such-dist-dir')).size, 0);
});
