import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { saveStyleMap, loadStyleMap, loadSharedStyleMap } from '../dist/capture/map-io.js';
import { mkTmp, rmTmp } from './helpers.mjs';

for (const extension of ['json', 'json.gz']) {
  test(`settle timeout metadata survives ${extension} save/load`, (t) => {
    const dir = mkTmp('styleproof-settle-');
    t.after(() => rmTmp(dir));
    const file = path.join(dir, `home@1280.${extension}`);

    const map = {
      metadata: { surfaceKey: 'home', inputs: 'live', settleTimedOutWithRequestsInFlight: 2 },
      defaults: {},
      elements: {},
      states: {},
    };

    saveStyleMap(file, map);
    assert.deepEqual(loadStyleMap(file), map);
    assert.deepEqual(loadSharedStyleMap(file), map);
  });
}

test('older maps without settle timeout metadata still load', (t) => {
  const dir = mkTmp('styleproof-settle-');
  t.after(() => rmTmp(dir));
  const file = path.join(dir, 'home@1280.json');
  const map = { defaults: {}, elements: {}, states: {} };
  saveStyleMap(file, map);
  assert.deepEqual(loadStyleMap(file), map);
});
