import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NODE_TEST_TIMEOUT_MS,
  fileSnapshot,
  nodeTestArgs,
  nodeTestEnv,
  runnerOptions,
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

test('STYLEPROOF_PRODUCT_STATE defaults to empty so the live dogfood ledger cannot poison CLI fixtures', () => {
  const env = nodeTestEnv({});
  assert.equal(env.STYLEPROOF_PRODUCT_STATE, '');
  const preserved = nodeTestEnv({ STYLEPROOF_PRODUCT_STATE: 'custom.json' });
  assert.equal(preserved.STYLEPROOF_PRODUCT_STATE, 'custom.json');
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

const RUNNER = fileURLToPath(new URL('../scripts/run-node-test.mjs', import.meta.url));

test('test file arguments run just those files, still with the preload (#799)', () => {
  assert.deepEqual(runnerOptions([]), { watch: false, files: undefined });
  assert.deepEqual(runnerOptions(['--watch']), { watch: true, files: undefined });
  assert.deepEqual(runnerOptions(['test/a.test.mjs', '--watch']), { watch: true, files: ['test/a.test.mjs'] });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-runner-files-'));
  try {
    const file = path.join(dir, 'preloaded.test.mjs');
    const ran = path.join(dir, 'ran');
    fs.writeFileSync(
      file,
      "import fs from 'node:fs';\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
        "test('preloaded', () => {\n  assert.equal(process.env.STYLEPROOF_NO_CONCURRENT_JOBS, '1');\n" +
        `  fs.writeFileSync(${JSON.stringify(ran)}, '');\n});\n`,
    );
    // Drop this suite's own preload so only the runner can supply it, and the
    // test-runner context so the nested run reports like a top-level one.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.STYLEPROOF_NO_CONCURRENT_JOBS;
    for (const key of Object.keys(env)) {
      if (/^(NODE_TEST|TEST_WORKER|TAP_)/i.test(key)) delete env[key];
    }
    const r = spawnSync(process.execPath, [RUNNER, file], { env, encoding: 'utf8', timeout: 60_000 });
    // Exit status and a marker, not the summary text: Node 26 prints a spec
    // summary to a pipe, while CI's Node 18–22 print TAP.
    assert.equal(r.status, 0, `the named file must pass with the preload\n${r.stdout}${r.stderr}`);
    assert.ok(fs.existsSync(ran), 'the named file ran');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
