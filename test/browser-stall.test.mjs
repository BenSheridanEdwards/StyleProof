import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserStallError, DEFAULT_STALL_TIMEOUT_MS, watchBrowserProgress } from '../dist/browser-stall.js';
import { UsageError, resolveStallTimeoutMs } from '../dist/capture-url.js';
import { spawnSyncToCompletion } from './helpers.mjs';

const CAPTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'styleproof-capture.mjs');

const never = () => new Promise(() => {});
const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const api = (watch, message) => watch.logger.log('api', 'info', message, [], {});

test('race settles as the work does while the browser keeps answering', async () => {
  const watch = watchBrowserProgress(5_000);
  assert.equal(await watch.race(delay(20, 'done')), 'done');
  await assert.rejects(watch.race(delay(20).then(() => Promise.reject(new Error('page crashed')))), /page crashed/);
});

test('race rejects with a named stall once no call has succeeded for the deadline', async () => {
  const watch = watchBrowserProgress(300);
  const started = Date.now();
  await assert.rejects(watch.race(never()), (error) => {
    assert.ok(error instanceof BrowserStallError);
    assert.equal(error.message, 'the browser stopped responding: no progress for 0.3s');
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 290, `stall fired early: ${elapsed}ms`);
  assert.ok(elapsed < 3_000, `stall fired late: ${elapsed}ms`);
  assert.equal(new BrowserStallError(300_000).message, 'the browser stopped responding: no progress for 300s');
});

test('every succeeded call pushes the deadline back, so a long run is never capped', async () => {
  const watch = watchBrowserProgress(250);
  const beats = setInterval(() => api(watch, '<= page.evaluate succeeded'), 50);
  try {
    assert.equal(await watch.race(delay(1_000, 'finished')), 'finished');
  } finally {
    clearInterval(beats);
  }
});

// A failed call can be Playwright's own timeout firing because the browser stopped answering, and a
// started call is Node asking, not the browser answering: neither is progress.
test('started and failed calls are not progress', async () => {
  const watch = watchBrowserProgress(250);
  const noise = setInterval(() => {
    api(watch, '=> page.evaluate started');
    api(watch, '<= locator.waitFor failed');
  }, 50);
  try {
    await assert.rejects(watch.race(never()), BrowserStallError);
  } finally {
    clearInterval(noise);
  }
});

// setTimeout cannot hold more than 2^31-1 ms: a larger delay fires after 1 ms and warns, so a huge
// deadline (someone "turning it off") must not re-arm every millisecond for the whole run.
test('a deadline beyond the timer limit waits quietly instead of re-arming every millisecond', async () => {
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning.name);
  process.on('warning', onWarning);
  try {
    const watch = watchBrowserProgress(99_999_999_999);
    assert.equal(await watch.race(delay(50, 'done')), 'done');
    await delay(0);
  } finally {
    process.off('warning', onWarning);
  }
  assert.deepEqual(warnings, []);
});

test('the watch subscribes to Playwright api logs only', () => {
  const { logger } = watchBrowserProgress(1_000);
  assert.equal(logger.isEnabled('api', 'info'), true);
  assert.equal(logger.isEnabled('protocol', 'verbose'), false);
  assert.equal(logger.isEnabled('browser', 'info'), false);
});

test('resolveStallTimeoutMs: default, override, and a loud usage error on a malformed value', () => {
  assert.equal(DEFAULT_STALL_TIMEOUT_MS, 300_000);
  assert.equal(resolveStallTimeoutMs(undefined), DEFAULT_STALL_TIMEOUT_MS);
  assert.equal(resolveStallTimeoutMs(''), DEFAULT_STALL_TIMEOUT_MS);
  assert.equal(resolveStallTimeoutMs('15000'), 15_000);
  for (const bad of ['abc', '0', '-5', 'Infinity']) {
    assert.throws(
      () => resolveStallTimeoutMs(bad),
      (error) =>
        error instanceof UsageError &&
        error.message === `STYLEPROOF_STALL_TIMEOUT_MS must be a positive number of milliseconds, got '${bad}'`,
    );
  }
});

test('styleproof-capture exits 2 on a malformed STYLEPROOF_STALL_TIMEOUT_MS, before it launches a browser', () => {
  const result = spawnSyncToCompletion(process.execPath, [CAPTURE, 'https://example.invalid', '--out', 'unused'], {
    encoding: 'utf8',
    env: { ...process.env, STYLEPROOF_STALL_TIMEOUT_MS: 'abc' },
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /STYLEPROOF_STALL_TIMEOUT_MS must be a positive number of milliseconds, got 'abc'/);
});
