import assert from 'node:assert/strict';
import test from 'node:test';
import { captureStyleMap, resolveForcedStateLimits } from '../dist/capture.js';
import { expandSurfaceVariants } from '../dist/runner.js';

test('forced-state resource defaults and explicit limits are resolved independently', () => {
  assert.deepEqual(resolveForcedStateLimits({}), { maxForcedStateElements: 2000, maxForcedStateScanWork: 32000 });
  assert.deepEqual(resolveForcedStateLimits({ maxForcedStateScanWork: 70000 }), {
    maxForcedStateElements: 2000,
    maxForcedStateScanWork: 70000,
  });
});

for (const name of ['maxForcedStateElements', 'maxForcedStateScanWork']) {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null, false]) {
    test(`${name} rejects ${String(value)} before browser access`, async () => {
      const page = new Proxy(
        {},
        {
          get() {
            throw new Error('browser was accessed');
          },
        },
      );
      await assert.rejects(captureStyleMap(page, { [name]: value }), {
        name: 'TypeError',
        message: `styleproof: ${name} must be a positive safe integer`,
      });
    });
  }
}

test('expanded variants inherit resource overrides without replacing runner defaults', () => {
  const [base, inherited, override] = expandSurfaceVariants({
    key: 'example',
    go: async () => {},
    maxForcedStateElements: 100,
    variants: [{ key: 'inherited' }, { key: 'override', maxForcedStateScanWork: 90000 }],
  });
  for (const surface of [base, inherited, override]) assert.equal(surface.maxForcedStateElements, 100);
  assert.equal(inherited.maxForcedStateScanWork, undefined);
  assert.equal(override.maxForcedStateScanWork, 90000);
});

test('expanded live states and state recipes preserve resource overrides', () => {
  const live = expandSurfaceVariants({
    key: 'example',
    go: async () => {},
    maxForcedStateScanWork: 60000,
    liveStates: [{ key: 'loaded', maxForcedStateElements: 120 }],
  });
  assert.equal(live[0].maxForcedStateElements, 120);
  assert.equal(live[0].maxForcedStateScanWork, 60000);
  const recipe = expandSurfaceVariants({
    key: 'example',
    go: async () => {},
    maxForcedStateScanWork: 60000,
    stateRecipes: [{ stateKey: 'hover', action: 'hover', selector: 'button' }],
  });
  assert.equal(recipe.at(-1).maxForcedStateScanWork, 60000);
});
