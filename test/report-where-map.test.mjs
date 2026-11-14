import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createCropBudget } from '../dist/report/crop-budget.js';
import { drawWhereMap, pageBoxes, whereView, writeWhereMap } from '../dist/report/where-map.js';
import { mkTmp, rmTmp, solidPng } from './helpers.mjs';

// RV11-12 / QA12-02: the slowdown came from scanning every box twice for every map pixel (work
// grew with pixels × boxes). The drawing now marks each box once and writes each pixel once. This
// guard counts that work instead of timing it, so machine speed, coverage and load cannot move it.
test('a Where map writes each pixel once and marks each box by its rows, whatever the box count (RV11-12, QA12-02)', () => {
  const page = PNG.sync.read(solidPng(1280, 6000));
  const rects = (n) =>
    Array.from({ length: n }, (_, i) => [20 + (i % 3) * 400, 20 + Math.round((i * 5950) / (n - 1)), 360, 24]);
  const workFor = (n) => {
    const boxes = pageBoxes(rects(n), { w: page.width, h: page.height });
    const view = whereView({ w: page.width, h: page.height }, boxes);
    const work = { pixels: 0, boxRows: 0 };
    const map = drawWhereMap(page, view, boxes, work);
    return { work, pixels: map.width * map.height, boxes };
  };
  for (const n of [10, 300]) {
    const { work, pixels, boxes } = workFor(n);
    assert.equal(work.pixels, pixels, `${n} boxes: every map pixel is written exactly once`);
    // Each box marks its padded rows twice (ring, then inside): ((24 + 16) / 2) rows each, at most.
    assert.ok(work.boxRows <= boxes.length * 2 * 21, `${n} boxes marked ${work.boxRows} rows`);
    // The per-pixel scan did pixels × boxes × 2 box tests (about 1.2 billion for 300 boxes); this is
    // the pixels plus the boxes' rows, about one unit per pixel.
    assert.ok(work.pixels + work.boxRows < pixels * 1.01, `${n} boxes: ${work.pixels + work.boxRows} units`);
  }
});

test('the Where map rings each box and fades the page outside it', (t) => {
  const outDir = mkTmp('styleproof-where-pixels-');
  t.after(() => rmTmp(outDir));
  fs.mkdirSync(path.join(outDir, 'crops'));
  const ctx = { outDir, crops: createCropBudget(60, 50_000_000) };
  const page = PNG.sync.read(solidPng(400, 400, [0, 0, 0]));
  const map = writeWhereMap(ctx, { surface: 'p@400', suffix: '1', page, side: 'after', rects: [[100, 100, 100, 100]] });
  const png = PNG.sync.read(fs.readFileSync(path.join(outDir, map.image)));
  const pixel = (x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  // Map pixels are half scale and the view starts at y = 52: the padded box spans x 46–104, y 20–78.
  assert.deepEqual(pixel(10, 10), [140, 140, 140], 'faded outside');
  assert.deepEqual(pixel(46, 50), [224, 17, 157], 'ring on the edge');
  assert.deepEqual(pixel(75, 50), [0, 0, 0], 'page inside');
  assert.deepEqual(pixel(75, 76), [224, 17, 157], 'ring on the bottom edge');
  assert.deepEqual(pixel(75, 79), [140, 140, 140], 'faded below the box');
});
