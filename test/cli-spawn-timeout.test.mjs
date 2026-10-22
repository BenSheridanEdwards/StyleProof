import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_SPAWN_TIMEOUT_MS, spawnSyncBounded, spawnSyncToCompletion } from './helpers.mjs';

test('spawnSyncBounded kills a hung child within the timeout bound', () => {
  const boundMs = 400;
  const started = Date.now();
  const result = spawnSyncBounded(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    timeout: boundMs,
    encoding: 'utf8',
  });
  const elapsed = Date.now() - started;

  assert.equal(result.error?.code, 'ETIMEDOUT', result.error?.message ?? 'missing ETIMEDOUT');
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGKILL');
  // Allow generous slack for a loaded CI host, but never approach "indefinite".
  assert.ok(elapsed < boundMs + 5_000, `hung child escaped the bound: ${elapsed}ms`);
  assert.ok(elapsed >= boundMs - 50, `timeout fired too early: ${elapsed}ms`);
});

// A CLI that launched a browser through Playwright handles SIGTERM by closing the browser and keeps
// running. This child does the same, then exits on its own 4 s later — so a SIGTERM bound shows up
// as a 4 s overrun (and a clean exit) instead of hanging this test.
test('spawnSyncBounded kills a child that handles SIGTERM within the bound', () => {
  const boundMs = 400;
  const started = Date.now();
  const result = spawnSyncBounded(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 4_000)); setInterval(() => {}, 1_000);"],
    { timeout: boundMs, encoding: 'utf8' },
  );
  const elapsed = Date.now() - started;

  assert.equal(result.signal, 'SIGKILL', `child outlived the bound: status ${result.status}`);
  assert.ok(elapsed < boundMs + 3_000, `child outlived the bound: ${elapsed}ms`);
});

test('spawnSyncBounded default timeout is the shared CLI harness bound', () => {
  assert.equal(CLI_SPAWN_TIMEOUT_MS, 60_000);
  // A fast child must still succeed under the default bound.
  const result = spawnSyncBounded(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.error, undefined);
});

test('spawnSyncBounded preserves an explicit shorter timeout override', () => {
  const result = spawnSyncBounded(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    timeout: 200,
    encoding: 'utf8',
  });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGKILL');
});

test('spawnSyncToCompletion names a child killed at the bound, with its last output', () => {
  assert.throws(
    () =>
      spawnSyncToCompletion(process.execPath, ['-e', "console.log('reached step 2'); setInterval(() => {}, 1_000)"], {
        timeout: 400,
        encoding: 'utf8',
      }),
    /node -e .* was still running after 400 ms and was killed; last output:\nreached step 2/s,
  );
});

test('spawnSyncToCompletion returns a finished child as spawnSync does', () => {
  const result = spawnSyncToCompletion(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.equal(result.error, undefined);
});
