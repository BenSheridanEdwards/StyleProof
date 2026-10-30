import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashDeterminismMap } from '../dist/determinism-oracle.js';

test('settle request diagnostics do not change hashes, but styles and other metadata do', () => {
  const map = {
    metadata: { surfaceKey: 'home', settleTimedOutWithRequestsInFlight: 1 },
    defaults: {},
    elements: { app: { color: 'red' } },
    states: {},
  };

  const hash = hashDeterminismMap(map);

  const withCount = (count) => ({
    ...map,
    metadata: { ...map.metadata, settleTimedOutWithRequestsInFlight: count },
  });

  assert.equal(hash, hashDeterminismMap(withCount(2)));
  assert.equal(hash, hashDeterminismMap({ ...map, metadata: { surfaceKey: 'home' } }));
  assert.notEqual(hash, hashDeterminismMap({ ...map, elements: { app: { color: 'blue' } } }));
  assert.notEqual(hash, hashDeterminismMap({ ...map, metadata: { surfaceKey: 'pricing' } }));
  assert.notEqual(hash, hashDeterminismMap({ ...map, states: { settleTimedOutWithRequestsInFlight: 2 } }));
  assert.equal(map.metadata.settleTimedOutWithRequestsInFlight, 1);
});
