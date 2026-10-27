import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { orderSurfacesByBaseSize } from '../dist/runner/scheduling.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const surfaces = ['small', 'missing-a', 'large-a', 'large-b', 'missing-b'].map((key) => ({ key }));
const keys = (items) => items.map(({ surface }) => surface.key);

test('head scheduling uses file bytes, is stable for ties and missing maps, and leaves declarations intact', () => {
  const root = mkTmp();
  try {
    // Invalid gzip deliberately proves scheduling never decompresses or parses the maps.
    fs.writeFileSync(path.join(root, 'small@800.json.gz'), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, 'large-a@800.json.gz'), Buffer.alloc(300));
    fs.writeFileSync(path.join(root, 'large-b@400.json.gz'), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, 'large-b@800.json.gz'), Buffer.alloc(300));
    fs.mkdirSync(path.join(root, 'missing-a@800.json.gz'));
    const original = structuredClone(surfaces);
    const declared = original.map((surface) => ({ surface }));
    const expected = ['large-a', 'large-b', 'small', 'missing-a', 'missing-b'];
    assert.deepEqual(keys(orderSurfacesByBaseSize(surfaces, root)), expected);
    assert.deepEqual(surfaces, original);
    const widths = [
      { key: 'large-b', widths: [400, 800] },
      { key: 'large-a', widths: [800] },
    ];
    const scheduled = orderSurfacesByBaseSize(widths, root);
    assert.equal(scheduled[0].surface, widths[0], 'preserve the original go method receiver');
    assert.deepEqual(scheduled, [
      { surface: widths[0], width: 800 },
      { surface: widths[1], width: 800 },
      { surface: widths[0], width: 400 },
    ]);
    assert.deepEqual(widths[0].widths, [400, 800]);
    for (const base of [undefined, path.join(root, 'absent')]) {
      assert.deepEqual(orderSurfacesByBaseSize(surfaces, base), declared);
    }
  } finally {
    rmTmp(root);
  }
});
