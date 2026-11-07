import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as values from '../dist/capture/visual-channel-values.js';
import { prepareVisualChannelSources } from '../dist/capture/visual-channel-proof.js';
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
test('late author root is revalidated on the second channel read without per-host round trips', async () => {
  let reads = 0;
  const depths = [],
    finishes = [];
  const window = {
    __spChannelHostsChecked: true,
    __spBeginChannelProof() {},
    __spFinishChannelProof(...args) {
      finishes.push(args);
    },
  };
  const client = {
    on() {},
    async send(method, args) {
      if (method === 'DOM.getDocument') {
        depths.push(args.depth);
        return {
          root: { nodeType: 9, children: ++reads === 1 ? [] : [{ shadowRoots: [{ shadowRootType: 'closed' }] }] },
        };
      }
      if (method === 'Runtime.evaluate') return { result: { value: [] } };
      assert.ok(!method.startsWith('DOM.resolve'), 'bulk tree evidence must not resolve each host');
      return {};
    },
    async detach() {},
  };
  const page = {
    evaluate: (expression) => vm.runInNewContext(expression, { window }),
    context: () => ({ newCDPSession: async () => client }),
  };
  await prepareVisualChannelSources(page);
  await prepareVisualChannelSources(page);
  assert.deepEqual(depths, [-1, -1]);
  assert.equal(finishes[0][0], true);
  assert.equal(finishes[1][0], true);
  assert.equal(finishes[0][2], false);
  assert.equal(finishes[1][2], true);
});
