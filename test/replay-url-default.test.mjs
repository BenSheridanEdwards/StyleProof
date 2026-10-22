import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings } from '../dist/runner/settings.js';

// #956: Playwright reads an empty routeFromHAR `url` as match-all, so a blank replayUrl
// recorded the base's document, CSS and JS and replayed them on head. A blank env value
// (an unset `${{ vars.X }}` in CI) must mean unset; a blank config value must fail loudly.

function withReplayUrlEnv(value, fn) {
  const previous = process.env.STYLEPROOF_REPLAY_URL;
  if (value === undefined) delete process.env.STYLEPROOF_REPLAY_URL;
  else process.env.STYLEPROOF_REPLAY_URL = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.STYLEPROOF_REPLAY_URL;
    else process.env.STYLEPROOF_REPLAY_URL = previous;
  }
}

const replayUrl = (config = {}) => resolveSettings({ dir: 'head', freezeClock: false, ...config }).replayUrl;

test('resolveSettings: an empty or blank STYLEPROOF_REPLAY_URL falls back to the **/api/** data boundary (#956)', () => {
  assert.equal(
    withReplayUrlEnv('', () => replayUrl()),
    '**/api/**',
  );
  assert.equal(
    withReplayUrlEnv('  ', () => replayUrl()),
    '**/api/**',
  );
});

test('resolveSettings: an empty or blank replayUrl in the config is a loud error (#956)', () => {
  for (const blank of ['', '   ']) {
    assert.throws(
      () => withReplayUrlEnv(undefined, () => replayUrl({ replayUrl: blank })),
      /styleproof: replayUrl must be a non-empty URL glob/,
    );
  }
});

test('resolveSettings: replayUrl precedence is config, then STYLEPROOF_REPLAY_URL, then **/api/**', () => {
  assert.equal(
    withReplayUrlEnv(undefined, () => replayUrl()),
    '**/api/**',
  );
  assert.equal(
    withReplayUrlEnv('**/graphql**', () => replayUrl()),
    '**/graphql**',
  );
  assert.equal(
    withReplayUrlEnv('**/graphql**', () => replayUrl({ replayUrl: '**/data/**' })),
    '**/data/**',
  );
});
