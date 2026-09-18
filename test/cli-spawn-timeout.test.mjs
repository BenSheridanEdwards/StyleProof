import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_SPAWN_TIMEOUT_MS, spawnSyncBounded } from './helpers.mjs';

test('spawnSyncBounded kills a hung child within the timeout bound', () => {
  const boundMs = 400;
  const started = Date.now();
  const result = spawnSyncBounded(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { timeout: boundMs, encoding: 'utf8' },
  );
  const elapsed = Date.now() - started;

  assert.equal(result.error?.code, 'ETIMEDOUT', result.error?.message ?? 'missing ETIMEDOUT');
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
  // Allow generous slack for a loaded CI host, but never approach "indefinite".
  assert.ok(elapsed < boundMs + 5_000, `hung child escaped the bound: ${elapsed}ms`);
  assert.ok(elapsed >= boundMs - 50, `timeout fired too early: ${elapsed}ms`);
});

test('spawnSyncBounded default timeout is the shared CLI harness bound', () => {
  assert.equal(CLI_SPAWN_TIMEOUT_MS, 60_000);
  // A fast child must still succeed under the default bound.
  const result = spawnSyncBounded(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.error, undefined);
});

test('spawnSyncBounded preserves an explicit shorter timeout override', () => {
  const result = spawnSyncBounded(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { timeout: 200, encoding: 'utf8' },
  );
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGTERM');
});
