import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSelfCheck } from '../dist/runner.js';

// selfCheck defaults ON when recording (no replayFrom) — where live nondeterminism
// surfaces — and OFF when replaying (deterministic by construction). The env var
// forces it on either way; an explicit `selfCheck` is handled by the destructuring,
// not here.
test('defaultSelfCheck: ON when recording (no replayFrom)', () => {
  assert.equal(defaultSelfCheck(undefined, undefined), true);
});

test('defaultSelfCheck: OFF when replaying (replayFrom set)', () => {
  assert.equal(defaultSelfCheck('__stylemaps__/base', undefined), false);
});

test('defaultSelfCheck: STYLEPROOF_SELFCHECK=1 forces it on even when replaying', () => {
  assert.equal(defaultSelfCheck('__stylemaps__/base', '1'), true);
});
