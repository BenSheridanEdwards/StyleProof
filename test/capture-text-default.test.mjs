import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings } from '../dist/runner/settings.js';
import { LiveTextError } from '../dist/live-text.js';

// #772 option A: unset captureText defaults ON so cold adopters get own-text
// pairing (#753) without discovering a flag. Explicit false remains the privacy opt-out.

test('resolveSettings: unset captureText defaults to true (#772 A)', () => {
  const settings = resolveSettings({ dir: 'head', freezeClock: false });
  assert.equal(settings.captureText, true);
});

test('resolveSettings: explicit captureText: false is preserved (privacy opt-out)', () => {
  const settings = resolveSettings({ dir: 'head', freezeClock: false, captureText: false });
  assert.equal(settings.captureText, false);
});

test('resolveSettings: explicit captureText: true stays true', () => {
  const settings = resolveSettings({ dir: 'head', freezeClock: false, captureText: true });
  assert.equal(settings.captureText, true);
});

test('resolveSettings: liveText with default captureText (unset) is allowed', () => {
  assert.doesNotThrow(() => resolveSettings({ dir: 'head', freezeClock: false, liveText: true }));
  const settings = resolveSettings({ dir: 'head', freezeClock: false, liveText: true });
  assert.equal(settings.captureText, true);
  assert.deepEqual(settings.liveText, { freeze: false, selectors: [] });
});

test('resolveSettings: liveText + explicit captureText: false still fail-closes', () => {
  assert.throws(
    () => resolveSettings({ dir: 'head', freezeClock: false, liveText: true, captureText: false }),
    LiveTextError,
  );
  assert.throws(
    () =>
      resolveSettings({
        dir: 'head',
        freezeClock: false,
        liveText: { freeze: true },
        captureText: false,
      }),
    /freeze requires captureText: true/,
  );
});
