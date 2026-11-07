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
test('late root invalidates the watched catalogue; registered roots are reused', async () => {
  const { releaseVisualChannelSources } = await import('../dist/capture/visual-channel-boundaries.js');
  let scans = 0,
    resolves = 0;
  const listeners = new Map(),
    begins = [],
    finishes = [];
  const window = {
    __spChannelRoots: new Map(),
    __spChannelHosts: new WeakSet(),
    __spBeginChannelProof(...args) {
      begins.push(args);
    },
    __spFinishChannelProof(...args) {
      finishes.push(args);
    },
  };
  window.top = window;
  const root = { host: {}, getAnimations: () => [] };
  const client = {
    on(name, fn) {
      listeners.set(name, fn);
    },
    async send(method, args) {
      if (method === 'DOM.getDocument')
        return {
          root: { nodeType: 9, shadowRoots: ++scans === 1 ? [] : [{ shadowRootType: 'closed', backendNodeId: 42 }] },
        };
      if (method === 'DOM.resolveNode') {
        resolves++;
        return { object: { objectId: 'root' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        vm.runInNewContext('(' + args.functionDeclaration + '\n).call(root, 42)', { window, root });
        return {};
      }
      if (method === 'Runtime.evaluate') return { result: { value: [] } };
      return {};
    },
    async detach() {},
  };
  const page = {
    evaluate: async (expression) => vm.runInNewContext(expression, { window }),
    context: () => ({ newCDPSession: async () => client }),
  };
  await prepareVisualChannelSources(page);
  listeners.get('DOM.shadowRootPushed')();
  await prepareVisualChannelSources(page);
  await prepareVisualChannelSources(page);
  assert.equal(scans, 2);
  assert.equal(resolves, 1);
  assert.ok(finishes.every((args) => args[0]));
  assert.deepEqual(Array.from(begins[1][1]), [42]);
  assert.equal(window.__spChannelRoots.get(42), root);
  await releaseVisualChannelSources(page);
});
for (const [width, height, expected] of [
  [{ unit: 'px', value: 16 }, { unit: 'px', value: 16 }, true],
  [{ unit: 'px', value: 0 }, { unit: 'px', value: 0 }, true],
  [{ value: 'auto' }, { unit: 'px', value: 16 }, false],
  [{ unit: 'px', value: 16 }, { value: 'auto' }, false],
  [{ unit: 'percent', value: 100 }, { unit: 'px', value: 16 }, false],
  [undefined, undefined, false],
])
  test('opaque media requires two definite dimensions: ' + JSON.stringify([width, height]), () =>
    assert.equal(values.fixedMediaSize(width, height), expected),
  );
