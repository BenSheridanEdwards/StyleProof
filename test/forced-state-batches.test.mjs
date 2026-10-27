import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { captureStateLayerScreenshots } from '../dist/capture/forced-states.js';

function stateLayerHarness(intercept = async () => {}) {
  const states = new Map();
  const shots = [];
  const events = [];
  const pending = {};
  const peaks = {};
  const client = {
    async send(method, params = {}) {
      const phase =
        method === 'CSS.forcePseudoState' ? `force:${params.forcedPseudoClasses.join(',') || 'reset'}` : method;
      pending[phase] = (pending[phase] ?? 0) + 1;
      peaks[phase] = Math.max(peaks[phase] ?? 0, pending[phase]);
      try {
        await intercept(method, params);
        await setImmediate();
        switch (method) {
          case 'DOM.enable':
          case 'CSS.enable':
            return {};
          case 'DOM.getDocument':
            return { root: { nodeId: 100 } };
          case 'DOM.querySelectorAll':
            return { nodeIds: [Number(params.selector.match(/"(\d+)"/)[1])] };
          case 'CSS.forcePseudoState':
            if (params.forcedPseudoClasses.length) states.set(params.nodeId, params.forcedPseudoClasses);
            else states.delete(params.nodeId);
            return {};
          default:
            throw new Error(`Unexpected CDP command: ${method}`);
        }
      } finally {
        pending[phase]--;
      }
    },
    async detach() {
      events.push('detached');
    },
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    async evaluate(fn) {
      switch (fn.name) {
        case 'markInteractiveElements':
          return [1, 2, 3].map((id) => ({ id: String(id), path: `button-${id}` }));
        case 'clearInteractiveMarks':
          events.push('marks cleared');
          return;
        case 'expandInnerScrollContainers':
        case 'restoreInnerScrollContainers':
          return;
        default:
          throw new Error(`Unexpected page callback: ${fn.name}`);
      }
    },
    async screenshot({ path }) {
      shots.push({ path, states: [...states] });
    },
  };
  return { page, states, shots, events, peaks };
}

test('state layers capture every target in each state and leave all targets at rest', async () => {
  const harness = stateLayerHarness();
  const paths = await captureStateLayerScreenshots(harness.page, 'surface');
  assert.deepEqual(paths, ['surface.hover.png', 'surface.focus.png', 'surface.active.png']);
  assert.deepEqual(
    harness.shots,
    [['hover'], ['focus', 'focus-visible'], ['active']].map((classes, index) => ({
      path: paths[index],
      states: [1, 2, 3].map((id) => [id, classes]),
    })),
  );
  assert.equal(harness.states.size, 0);
  assert.deepEqual(harness.events, ['marks cleared', 'detached']);
  assert.equal(harness.peaks['DOM.querySelectorAll'], 3);
  assert.equal(harness.peaks['force:reset'], 3);
  for (const phase of ['force:hover', 'force:focus,focus-visible', 'force:active'])
    assert.equal(harness.peaks[phase], 1);
});

for (const phase of ['lookup', 'reset']) {
  test(`a failed ${phase} batch drains pending commands before cleanup`, async (t) => {
    const failure = new Error(`deliberate ${phase} failure`);
    const failed = Promise.withResolvers();
    const slowStarted = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    let injected = false;
    const harness = stateLayerHarness(async (method, params) => {
      const matches =
        phase === 'lookup'
          ? method === 'DOM.querySelectorAll'
          : method === 'CSS.forcePseudoState' && params.forcedPseudoClasses.length === 0;
      if (!matches) return;
      const id = phase === 'lookup' ? Number(params.selector.match(/"(\d+)"/)[1]) : params.nodeId;
      if (id === 1 && !injected) {
        injected = true;
        failed.resolve();
        throw failure;
      }
      if (id === 3) {
        slowStarted.resolve();
        await release.promise;
        harness.events.push('slow command finished');
      }
    });
    const result = assert.rejects(captureStateLayerScreenshots(harness.page, 'surface'), (error) => error === failure);
    await Promise.all([failed.promise, slowStarted.promise]);
    await setImmediate();
    assert.deepEqual(harness.events, [], 'marks and session survive until every pending command settles');
    release.resolve();
    await result;
    assert.deepEqual(harness.events, ['slow command finished', 'marks cleared', 'detached']);
    assert.equal(harness.states.size, 0);
    assert.equal(harness.shots.length, phase === 'lookup' ? 0 : 1);
  });
}
