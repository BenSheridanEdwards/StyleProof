import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isVisibleCapturedElement } from '../dist/visible-structure-gate.js';
import { hasExposedChangedEntry } from '../dist/report/shared.js';
import { saveStyleMap, loadStyleMap } from '../dist/capture.js';
import { hashDeterminismMap } from '../dist/determinism-oracle.js';
import { makeMap, mkTmp, rmTmp } from './helpers.mjs';

const entry = (rect) => ({ tag: 'div', cls: 'marker', rect, style: {} });
for (const [name, scrollX, scrollY] of [
  ['vertical', 0, 1800],
  ['horizontal', 1800, 0],
  ['both axes', 1800, 1800],
  ['negative horizontal origin', -1800, 0],
]) {
  test(`visible structure uses the captured ${name} viewport origin`, () => {
    const map = { viewport: { width: 400, height: 300, scrollX, scrollY } };
    assert.equal(isVisibleCapturedElement(entry([scrollX + 30, scrollY + 30, 40, 40]), map), true);
    assert.equal(isVisibleCapturedElement(entry([scrollX + 400, scrollY + 30, 40, 40]), map), false);
    assert.equal(isVisibleCapturedElement(entry([scrollX + 30, scrollY + 300, 40, 40]), map), false);
    assert.equal(isVisibleCapturedElement(entry([scrollX - 40, scrollY + 30, 40, 40]), map), false);
    assert.equal(isVisibleCapturedElement(entry([scrollX + 30, scrollY - 40, 40, 40]), map), false);
    assert.equal(isVisibleCapturedElement(entry([scrollX - 10, scrollY - 10, 40, 40]), map), true);
  });
}

test('legacy captures retain a zero viewport origin', () => {
  const map = { viewport: { width: 400, height: 300 } };
  assert.equal(isVisibleCapturedElement(entry([30, 30, 40, 40]), map), true);
  assert.equal(isVisibleCapturedElement(entry([30, 1900, 40, 40]), map), false);
});

test('horizontal-scrolled style evidence remains eligible for report crops', () => {
  const map = makeMap({ elements: { marker: entry([2000, 30, 120, 40]) } });
  map.viewport = { width: 400, height: 300, scrollX: 1800, scrollY: 0 };
  assert.equal(hasExposedChangedEntry(map, map, ['marker']), true);
});

test('viewport origin survives stored maps and participates in determinism receipts', () => {
  const root = mkTmp('styleproof-viewport-origin-');
  try {
    const map = makeMap({ elements: { marker: entry([2000, 1900, 120, 40]) } });
    map.viewport = { width: 400, height: 300, scrollX: 1800, scrollY: 1800 };
    const file = path.join(root, 'map.json.gz');
    saveStyleMap(file, map);
    assert.deepEqual(loadStyleMap(file), map);
    assert.notEqual(hashDeterminismMap(map), hashDeterminismMap({ ...map, viewport: { width: 400, height: 300 } }));
  } finally {
    rmTmp(root);
  }
});
