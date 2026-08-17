import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SURFACE_TIMEOUT_MS,
  captureTestBudgetMs,
  formatSurfaceHeartbeat,
  resolveSurfaceTimeoutMs,
  runWithSurfaceTimeout,
  surfaceTimeoutErrorMessage,
} from '../dist/surface-progress.js';
import { isSelfCheckCaptureFailure } from '../dist/runner.js';

// The heartbeat line is the CI liveness signal (issue #365): one stable,
// greppable line per completed surface with index/total, the capture key, and
// the durations, so a slow run is distinguishable from a hung one.
test('formatSurfaceHeartbeat: includes index/total, capture key, and durations', () => {
  assert.equal(
    formatSurfaceHeartbeat({
      index: 17,
      total: 41,
      captureKey: 'factory@1280',
      captureMs: 42_100,
      selfCheckMs: 12_300,
    }),
    'styleproof: surface 17/41 (factory@1280) captured in 42.1s (self-check 12.3s)',
  );
});

test('formatSurfaceHeartbeat: omits the self-check clause when the self-check did not run', () => {
  assert.equal(
    formatSurfaceHeartbeat({ index: 3, total: 8, captureKey: 'pricing@768', captureMs: 900 }),
    'styleproof: surface 3/8 (pricing@768) captured in 0.9s',
  );
});

test('resolveSurfaceTimeoutMs: defaults to 5 minutes', () => {
  assert.equal(resolveSurfaceTimeoutMs(undefined, undefined), 300_000);
  assert.equal(DEFAULT_SURFACE_TIMEOUT_MS, 300_000);
});

test('resolveSurfaceTimeoutMs: STYLEPROOF_SURFACE_TIMEOUT_MS overrides the default', () => {
  assert.equal(resolveSurfaceTimeoutMs(undefined, '600000'), 600_000);
});

test('resolveSurfaceTimeoutMs: the explicit spec option beats the environment variable', () => {
  assert.equal(resolveSurfaceTimeoutMs(120_000, '600000'), 120_000);
});

test('resolveSurfaceTimeoutMs: a malformed env value fails LOUDLY, never silently falls back', () => {
  assert.throws(() => resolveSurfaceTimeoutMs(undefined, 'five minutes'), /STYLEPROOF_SURFACE_TIMEOUT_MS/);
  assert.throws(() => resolveSurfaceTimeoutMs(undefined, '-1'), /STYLEPROOF_SURFACE_TIMEOUT_MS/);
});

test('resolveSurfaceTimeoutMs: a malformed spec option fails LOUDLY too', () => {
  assert.throws(() => resolveSurfaceTimeoutMs(0), /surfaceTimeoutMs/);
  assert.throws(() => resolveSurfaceTimeoutMs(Number.NaN), /surfaceTimeoutMs/);
});

// The Playwright test budget must always exceed the per-surface ceiling, so the
// NAMED per-surface timeout fires before Playwright's anonymous test timeout.
test('captureTestBudgetMs: exceeds the per-surface ceiling and scales with units', () => {
  assert.ok(captureTestBudgetMs(300_000) > 300_000);
  assert.equal(captureTestBudgetMs(300_000, 3), 3 * 360_000);
  // Never below the historic 180s floor for tiny ceilings.
  assert.equal(captureTestBudgetMs(1_000), 180_000);
});

test('runWithSurfaceTimeout: work under the ceiling resolves with its value', async () => {
  const result = await runWithSurfaceTimeout(
    'factory@1280',
    5_000,
    () => 'navigate',
    async () => 'captured',
  );
  assert.equal(result, 'captured');
});

test('runWithSurfaceTimeout: a breach rejects naming the surface AND the phase in flight', async () => {
  const never = () => new Promise(() => {});
  await assert.rejects(
    runWithSurfaceTimeout('factory@1280', 25, () => 'settle', never),
    (error) => {
      assert.match(error.message, /surface 'factory@1280' timed out/);
      assert.match(error.message, /'settle' phase in flight/);
      assert.match(error.message, /surfaceTimeoutMs/);
      assert.match(error.message, /STYLEPROOF_SURFACE_TIMEOUT_MS/);
      return true;
    },
  );
});

test('runWithSurfaceTimeout: the phase is read at breach time, not at start', async () => {
  let phase = 'navigate';
  const work = async () => {
    phase = 'self-check';
    await new Promise(() => {});
  };
  await assert.rejects(
    runWithSurfaceTimeout('home@768', 25, () => phase, work),
    /'self-check' phase in flight/,
  );
});

test('runWithSurfaceTimeout: a work failure under the ceiling propagates unchanged', async () => {
  await assert.rejects(
    runWithSurfaceTimeout(
      'home@768',
      5_000,
      () => 'capture',
      async () => {
        throw new Error('navigation refused');
      },
    ),
    /navigation refused/,
  );
});

// Timed-out work can still resolve later. The run token must flip inactive at the
// deadline so callers can refuse artifact writes after rejection (#420).
test('runWithSurfaceTimeout: abandoned work is marked inactive and cannot claim a live write fence', async () => {
  /** @type {{ isActive: () => boolean } | undefined} */
  let run;
  let wroteAfterTimeout = false;
  let observedActiveAfterTimeout = true;

  await assert.rejects(
    runWithSurfaceTimeout(
      'factory@1280',
      25,
      () => 'capture',
      async (surfaceRun) => {
        run = surfaceRun;
        await new Promise((resolve) => setTimeout(resolve, 80));
        observedActiveAfterTimeout = surfaceRun.isActive();
        if (surfaceRun.isActive()) wroteAfterTimeout = true;
        return 'late-write';
      },
    ),
    /surface 'factory@1280' timed out/,
  );

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(run?.isActive(), false);
  assert.equal(observedActiveAfterTimeout, false);
  assert.equal(wroteAfterTimeout, false);
});

// A timeout during the self-check PHASE is slowness or a hang, not proof of
// nondeterminism — it must stay tolerable on a baseline run instead of being
// escalated to a fatal self-check capture failure (#276 semantics).
test('surfaceTimeoutErrorMessage: never classified as a self-check capture failure', () => {
  for (const phase of ['navigate', 'settle', 'capture', 'self-check']) {
    assert.equal(isSelfCheckCaptureFailure(surfaceTimeoutErrorMessage('factory@1280', phase, 300_000)), false);
  }
});
