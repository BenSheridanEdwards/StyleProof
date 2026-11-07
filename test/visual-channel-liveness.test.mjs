import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdKeyframes, motionInProgress } from '../dist/capture/visual-channel-values.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
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
}

{
  const timing = { delay: 0, activeDuration: 1000, endTime: 1000, progress: 0, localTime: 0 };

  for (const [name, state, changes, expected] of [
    ['running', 'running', {}, true],
    ['paused at start', 'paused', {}, true],
    ['paused in progress', 'paused', { progress: 0.9, localTime: 900 }, true],
    ['paused at end', 'paused', { progress: 1, localTime: 1000 }, false],
    ['paused past end', 'paused', { progress: 1, localTime: 1500 }, false],
    ['paused before active interval', 'paused', { localTime: -1 }, false],
    ['paused delayed', 'paused', { delay: 100, localTime: 0 }, false],
    ['paused unfilled', 'paused', { progress: null }, false],
    ['unresolved time', 'paused', { localTime: null }, false],
    ['finished forwards', 'finished', { progress: 1, localTime: 1000 }, false],
    ['finished both', 'finished', { progress: 1, localTime: 1000 }, false],
    ['idle', 'idle', {}, false],
    ['missing time evidence', 'paused', { localTime: undefined }, true],
    ['missing duration evidence', 'paused', { endTime: undefined }, true],
  ])
    test(name, () => assert.equal(motionInProgress(state, { ...timing, ...changes }), expected));

  test('live unstabilized motion holds every body, independent of its CSS values', () => {
    for (const localTime of [0, 900])
      assert.equal(holdKeyframes(true, motionInProgress('paused', { ...timing, localTime }), false), true);
  });
}
