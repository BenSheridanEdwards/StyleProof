import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdKeyframes } from '../dist/capture/visual-channel-values.js';
for (const [name, initial, surviving, unstable, expected] of [
  ['unstabilized CSS inputs', true, false, true, true],
  ['default restarted CSS inputs', true, false, false, false],
  ['default surviving Web Animation', true, true, false, true],
  ['new surviving effect', false, true, false, true],
  ['finished inputs', false, false, true, false],
  ['missing initial evidence', undefined, false, true, true],
  ['default ignores pre-freeze CSS liveness', undefined, false, false, false],
  ['missing surviving evidence', false, undefined, false, true],
])
  test(name, () => assert.equal(holdKeyframes(unstable, initial, surviving), expected));
