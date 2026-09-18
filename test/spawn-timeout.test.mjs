import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';

// Contract for test/spawn-timeout.cjs (#711): blocking CLI spawns carry a
// bounded default timeout so a deadlocked child dies with a signal instead of
// hanging the suite. The preload sets STYLEPROOF_SPAWN_TIMEOUT_LOADED; without
// it these tests skip rather than sleep out real seconds.
const LOADED = process.env.STYLEPROOF_SPAWN_TIMEOUT_LOADED === '1';
const SLEEP = ['-e', 'setTimeout(() => {}, 30000)'];

test('spawn-timeout preload kills a hung child within the env timeout', { skip: !LOADED }, () => {
  process.env.STYLEPROOF_TEST_SPAWN_TIMEOUT_MS = '150';
  try {
    const started = Date.now();
    const res = spawnSync(process.execPath, SLEEP, { encoding: 'utf8' });
    const elapsed = Date.now() - started;
    assert.equal(res.signal, 'SIGTERM');
    assert.ok(elapsed < 10_000, `child should be killed fast, took ${elapsed}ms`);
  } finally {
    delete process.env.STYLEPROOF_TEST_SPAWN_TIMEOUT_MS;
  }
});

test('spawn-timeout preload leaves fast children and caller timeouts alone', { skip: !LOADED }, () => {
  const ok = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  const started = Date.now();
  const res = spawnSync(process.execPath, SLEEP, { encoding: 'utf8', timeout: 100 });
  assert.equal(res.signal, 'SIGTERM');
  assert.ok(Date.now() - started < 10_000, 'caller timeout must beat the 120s default');
});

test('execFileSync carries the same bounded default', { skip: !LOADED }, () => {
  process.env.STYLEPROOF_TEST_SPAWN_TIMEOUT_MS = '150';
  try {
    assert.throws(
      () => execFileSync(process.execPath, SLEEP, { encoding: 'utf8' }),
      (err) => err.signal === 'SIGTERM',
    );
  } finally {
    delete process.env.STYLEPROOF_TEST_SPAWN_TIMEOUT_MS;
  }
});
