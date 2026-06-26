import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSelfCheck, resolveBaseDir, resolveScreenshots } from '../dist/runner.js';

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

// baseDir/screenshots env overrides — what lets a pre-push hook redirect capture
// into a COMMITTED, lean (no-PNG) dir without editing the spec.
test('resolveBaseDir: explicit option wins over env and default', () => {
  assert.equal(resolveBaseDir('custom', 'stylemaps'), 'custom');
});

test('resolveBaseDir: STYLEPROOF_BASEDIR used when no explicit option', () => {
  assert.equal(resolveBaseDir(undefined, 'stylemaps'), 'stylemaps');
});

test('resolveBaseDir: default __stylemaps__ when neither is set', () => {
  assert.equal(resolveBaseDir(undefined, undefined), '__stylemaps__');
});

test('resolveScreenshots: STYLEPROOF_SCREENSHOTS=0 disables; on by default', () => {
  assert.equal(resolveScreenshots(undefined, '0'), false);
  assert.equal(resolveScreenshots(undefined, undefined), true);
});

test('resolveScreenshots: an explicit value wins over the env', () => {
  assert.equal(resolveScreenshots(false, undefined), false);
  assert.equal(resolveScreenshots(true, '0'), true);
});
