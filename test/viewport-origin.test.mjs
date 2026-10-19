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
    const map = { viewport: { width: 400, height: 300, scrollX, scrollY, documentHeight: scrollY + 300 } };
    assert.equal(isVisibleCapturedElement(entry([scrollX + 30, scrollY + 30, 40, 40]), map), true);
    assert.equal(isVisibleCapturedElement(entry([scrollX + 400, scrollY + 30, 40, 40]), map), false);
    assert.equal(isVisibleCapturedElement(entry([scrollX + 30, scrollY + 300, 40, 40]), map), false);
    assert.equal(isVisibleCapturedElement(entry([scrollX - 40, scrollY + 30, 40, 40]), map), false);
    assert.equal(
      isVisibleCapturedElement(entry([scrollX + 30, scrollY - 40, 40, 40]), map),
      scrollY > 0,
      'the full-page screenshot shows the document above a scrolled window',
    );
    assert.equal(isVisibleCapturedElement(entry([scrollX - 10, scrollY - 10, 40, 40]), map), true);
  });
}

test('visible structure spans the captured document height, not the first window', () => {
  const map = { viewport: { width: 400, height: 300, documentHeight: 2400 } };
  assert.equal(isVisibleCapturedElement(entry([30, 1900, 40, 40]), map), true);
  assert.equal(isVisibleCapturedElement(entry([30, 2380, 40, 40]), map), true);
  assert.equal(isVisibleCapturedElement(entry([30, 2400, 40, 40]), map), false, 'clipped past the document');
  assert.equal(isVisibleCapturedElement(entry([30, -9999, 40, 40]), map), false, 'positioned above the document');
  assert.equal(isVisibleCapturedElement(entry([-9999, 1900, 40, 40]), map), false, 'off-canvas horizontally');
  assert.equal(isVisibleCapturedElement(entry([400, 1900, 40, 40]), map), false, 'past the viewport width');
  for (const style of [{ display: 'none' }, { visibility: 'hidden' }, { opacity: '0' }]) {
    const hidden = { ...entry([30, 1900, 40, 40]), style };
    assert.equal(isVisibleCapturedElement(hidden, map), false, `${JSON.stringify(style)} below the window`);
  }
  assert.equal(isVisibleCapturedElement(entry([30, 1900, 0, 40]), map), false, 'zero-size below the window');
});

test('legacy captures without document height fail closed below the window', () => {
  const map = { viewport: { width: 400, height: 300 } };
  assert.equal(isVisibleCapturedElement(entry([30, 30, 40, 40]), map), true);
  assert.equal(isVisibleCapturedElement(entry([30, 1900, 40, 40]), map), true);
  assert.equal(isVisibleCapturedElement(entry([30, 1_000_000, 40, 40]), map), true);
  assert.equal(isVisibleCapturedElement(entry([30, -9999, 40, 40]), map), false);
  assert.equal(isVisibleCapturedElement(entry([400, 1900, 40, 40]), map), false);
});

test('horizontal-scrolled style evidence remains eligible for report crops', () => {
  const map = makeMap({ elements: { marker: entry([2000, 30, 120, 40]) } });
  map.viewport = { width: 400, height: 300, scrollX: 1800, scrollY: 0 };
  assert.equal(hasExposedChangedEntry(map, map, ['marker']), true);
});

test('report crop eligibility reads the screenshot box, not the driven box', () => {
  const at = (rect, screenshotRect, style = {}) => ({
    ...entry(rect),
    ...(screenshotRect && { screenshotRect }),
    style,
  });
  const map = {
    viewport: { width: 800, height: 600 },
    elements: {
      topScroller: at([0, -500, 800, 100], [0, 100, 800, 100]),
      lowerScroller: at([0, 1500, 800, 100], [0, 2100, 800, 100]),
      legacy: at([0, -500, 800, 100]),
      hidden: at([0, -500, 800, 100], [0, 100, 800, 100], { display: 'none' }),
      invisible: at([0, -500, 800, 100], [0, 100, 800, 100], { visibility: 'hidden' }),
      transparent: at([0, -500, 800, 100], [0, 100, 800, 100], { opacity: '0' }),
      collapsed: at([0, 100, 800, 100], [0, 100, 800, 0]),
    },
  };
  const exposed = (p) => hasExposedChangedEntry(map, map, [p]);
  assert.equal(exposed('topScroller'), true, 'scrolled out of a top-of-page inner scroller');
  assert.equal(exposed('lowerScroller'), true, 'scrolled out of a lower-page inner scroller');
  assert.equal(exposed('legacy'), false, 'legacy map without a screenshot box');
  for (const p of ['hidden', 'invisible', 'transparent', 'collapsed']) assert.equal(exposed(p), false, p);
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
