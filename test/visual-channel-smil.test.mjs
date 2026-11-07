import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as values from '../dist/capture/visual-channel-values.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  const svg = (attrs = {}, start = 0, time = 0.5, duration = 1) => ({
    getStartTime: () => start,
    getSimpleDuration: () => duration,
    getAttribute: (name) => attrs[name] ?? null,
    ownerSVGElement: { getCurrentTime: () => time },
  });

  for (const [name, element, expected] of [
    ['active', svg(), true],
    ['finished freeze', svg({}, 0, 2), false],
    ['future interval', svg({}, 2, 0), false],
    ['finite repeats active', svg({ repeatCount: '3' }, 0, 2), true],
    ['finite repeats finished', svg({ repeatCount: '3' }, 0, 3), false],
    ['indefinite repeats', svg({ repeatCount: 'indefinite' }, 0, 900), true],
    ['repeatDur extends simple duration', svg({ repeatDur: '3s' }, 0, 2), true],
    ['repeatDur finished', svg({ repeatDur: '3s' }, 0, 3), false],
    ['repeat limits intersect', svg({ repeatCount: '10', repeatDur: '2s' }, 0, 3), false],
    ['explicit end clips repeats', svg({ repeatCount: 'indefinite', end: '2s' }, 0, 3), false],
    ['invalid clock is unresolved', svg({ end: '0:99' }, 0, 200), true],
    [
      'indefinite simple duration',
      {
        ...svg(),
        getSimpleDuration() {
          throw new Error('no simple duration');
        },
      },
      true,
    ],
    ['event end unresolved', svg({ end: 'click' }), true],
    ['min can extend duration', svg({ min: '3s' }, 0, 2), true],
    ['unreadable clock', { ...svg(), ownerSVGElement: null }, true],
    [
      'no current interval: finished or never started',
      {
        ...svg(),
        getStartTime() {
          throw Object.assign(new Error(), { name: 'InvalidStateError' });
        },
      },
      false,
    ],
    [
      'unavailable timing API',
      {
        ...svg(),
        getStartTime() {
          throw new Error('unavailable');
        },
      },
      true,
    ],
  ])
    test(`SMIL ${name}`, () => assert.equal(values.smilInProgress(element), expected));
}
