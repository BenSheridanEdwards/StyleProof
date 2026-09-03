import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { comparePngs, comparePngFiles, attributeRegion, pixelDiffSurface } from '../dist/pixel-diff.js';
import { diffStyleMapDirs } from '../dist/diff.js';
import { fillRect } from '../dist/png-util.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

// A solid white canvas with optional painted boxes: [x, y, w, h, [r, g, b]].
function canvas(width, height, boxes = []) {
  const png = new PNG({ width, height });
  fillRect(png, 0, 0, width, height, [255, 255, 255]);
  for (const [x, y, w, h, rgb] of boxes) fillRect(png, x, y, w, h, rgb);
  return png;
}
const encode = (png) => PNG.sync.write(png);

test('comparePngs: identical screenshots have no changed pixels and no regions', () => {
  const a = canvas(200, 100, [[10, 10, 40, 20, [20, 184, 166]]]);
  const b = canvas(200, 100, [[10, 10, 40, 20, [20, 184, 166]]]);
  const c = comparePngs(a, b);
  assert.deepEqual(
    { changed: c.changedPixels, regions: c.regions, compared: c.comparedPixels },
    {
      changed: 0,
      regions: [],
      compared: 20000,
    },
  );
});

test('comparePngs: one repainted box is one region whose rect covers the box', () => {
  const a = canvas(200, 100, [[16, 8, 40, 24, [20, 184, 166]]]);
  const b = canvas(200, 100, [[16, 8, 40, 24, [220, 38, 38]]]);
  const c = comparePngs(a, b);
  assert.equal(c.changedPixels, 40 * 24);
  assert.equal(c.regions.length, 1);
  const [x, y, w, h] = c.regions[0].rect;
  assert.ok(x <= 16 && y <= 8 && x + w >= 56 && y + h >= 32, `region ${c.regions[0].rect} covers the box`);
  assert.equal(c.regions[0].changedPixels, 40 * 24);
});

test('comparePngs: two separated changes are two regions', () => {
  const a = canvas(300, 100);
  const b = canvas(300, 100, [
    [8, 8, 24, 24, [0, 0, 0]],
    [200, 40, 24, 24, [0, 0, 0]],
  ]);
  const regions = comparePngs(a, b)
    .regions.map((r) => r.rect[0])
    .sort((p, q) => p - q);
  assert.deepEqual(regions, [8, 200]);
});

test('comparePngs: anti-aliasing noise below the region floor is not a change', () => {
  const a = canvas(100, 100);
  const b = canvas(100, 100, [[50, 50, 1, 2, [0, 0, 0]]]); // 2 stray pixels
  const c = comparePngs(a, b);
  assert.equal(c.changedPixels, 2, 'the pixels are counted');
  assert.deepEqual(c.regions, [], 'but too few to form a region');
  assert.equal(comparePngs(a, b, { minRegionPixels: 1 }).regions.length, 1, 'the floor is configurable');
});

test('comparePngs: a colour shift under the YIQ threshold is not a change', () => {
  const a = canvas(50, 50, [[0, 0, 50, 50, [120, 120, 120]]]);
  const b = canvas(50, 50, [[0, 0, 50, 50, [122, 121, 120]]]);
  assert.equal(comparePngs(a, b).changedPixels, 0);
  assert.equal(comparePngs(a, b, { threshold: 0 }).changedPixels, 2500, 'threshold 0 is exact equality');
});

test('comparePngs: a taller after-screenshot reports the extra band as a region', () => {
  const a = canvas(100, 100);
  const b = canvas(100, 140);
  const c = comparePngs(a, b);
  assert.deepEqual(c.sizeMismatch, { before: [100, 100], after: [100, 140] });
  assert.equal(c.comparedPixels, 100 * 100);
  assert.deepEqual(c.regions, [{ rect: [0, 100, 100, 40], changedPixels: 4000, elements: [] }]);
});

test('attributeRegion names the smallest captured box under the region, never html/body', () => {
  const map = makeMap({
    elements: {
      html: { tag: 'html', rect: [0, 0, 800, 600], style: {} },
      body: { tag: 'body', rect: [0, 0, 800, 600], style: {} },
      'div:nth-child(1)': { tag: 'div', cls: 'card', rect: [0, 0, 400, 200], style: {} },
      'div:nth-child(1) > button:nth-child(1)': { tag: 'button', cls: 'cta', rect: [16, 8, 140, 44], style: {} },
      'div:nth-child(2)': { tag: 'div', cls: 'aside', rect: [500, 0, 200, 200], style: {} },
    },
  });
  assert.deepEqual(attributeRegion(map, [16, 8, 40, 24]), [
    { path: 'div:nth-child(1) > button:nth-child(1)', cls: 'cta' },
    { path: 'div:nth-child(1)', cls: 'card' },
  ]);
  assert.deepEqual(attributeRegion(map, [16, 8, 40, 24], 1), [
    { path: 'div:nth-child(1) > button:nth-child(1)', cls: 'cta' },
  ]);
  assert.deepEqual(attributeRegion(map, [700, 300, 10, 10]), [], 'nothing captured under an empty region');
});

test('pixelDiffSurface compares every layer present on both sides and flags one-sided layers', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  const before = canvas(200, 100, [[16, 8, 40, 24, [20, 184, 166]]]);
  const after = canvas(200, 100, [[16, 8, 40, 24, [220, 38, 38]]]);
  fs.writeFileSync(path.join(A, 'home@200.png'), encode(before));
  fs.writeFileSync(path.join(B, 'home@200.png'), encode(after));
  fs.writeFileSync(path.join(A, 'home@200.hover.png'), encode(before));
  fs.writeFileSync(path.join(B, 'home@200.hover.png'), encode(before)); // hover layer unchanged
  fs.writeFileSync(path.join(B, 'home@200.focus.png'), encode(after)); // focus layer only on head
  const map = makeMap({
    elements: {
      'div:nth-child(1) > button:nth-child(1)': { tag: 'button', cls: 'cta', rect: [16, 8, 40, 24], style: {} },
    },
  });
  const result = pixelDiffSurface(A, B, 'home@200', map, map);
  assert.equal(result.regionCount, 1);
  assert.deepEqual(result.uncompared, ['focus']);
  assert.deepEqual(
    result.layers.map((l) => [l.layer, l.status, l.status === 'compared' ? l.comparison.regions.length : null]),
    [
      ['rest', 'compared', 1],
      ['hover', 'compared', 0],
      ['focus', 'missing-before', null],
    ],
  );
  const rest = result.layers[0].comparison.regions[0];
  assert.deepEqual(rest.elements, [{ path: 'div:nth-child(1) > button:nth-child(1)', cls: 'cta' }]);
  assert.equal(comparePngFiles(path.join(A, 'home@200.png'), path.join(B, 'home@200.png')).changedPixels, 40 * 24);
  rmTmp(root);
});

test('diffStyleMapDirs with pixels: a change the computed-style differ cannot see is still gated and attributed', () => {
  // Same computed styles on both sides (an <img> whose bytes changed) — style diff is empty.
  const img = {
    tag: 'img',
    cls: 'hero',
    rect: [16, 8, 40, 24],
    style: { width: '40px', height: '24px' },
    ownTextLength: 0,
  };
  const map = makeMap({
    elements: {
      'div:nth-child(1)': { tag: 'div', cls: 'card', rect: [0, 0, 200, 100], style: {} },
      'div:nth-child(1) > img:nth-child(1)': img,
    },
  });
  const root = mkTmp();
  const A = writeCapture(
    path.join(root, 'a'),
    'home@200',
    map,
    encode(canvas(200, 100, [[16, 8, 40, 24, [20, 184, 166]]])),
  );
  const B = writeCapture(
    path.join(root, 'b'),
    'home@200',
    map,
    encode(canvas(200, 100, [[16, 8, 40, 24, [220, 38, 38]]])),
  );

  const plain = diffStyleMapDirs(A, B);
  assert.deepEqual(plain.counts, { dom: 0, style: 0, state: 0 });
  assert.equal(plain.pixels, undefined, 'the pixel gate is opt-in');

  const gated = diffStyleMapDirs(A, B, { includeStructure: false, pixels: true });
  assert.deepEqual(gated.counts, { dom: 0, style: 0, state: 0 }, 'pixel results never enter the style counts');
  assert.equal(gated.pixels.length, 1);
  assert.equal(gated.pixels[0].regionCount, 1);
  assert.deepEqual(
    gated.pixels[0].layers[0].comparison.regions[0].elements.map((e) => e.path),
    ['div:nth-child(1) > img:nth-child(1)', 'div:nth-child(1)'],
  );
  rmTmp(root);
});
