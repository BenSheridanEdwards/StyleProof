import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createCropBudget } from '../dist/report/crop-budget.js';
import { writeWhereMap } from '../dist/report/where-map.js';
import { mkTmp, rmTmp, solidPng } from './helpers.mjs';

// RV11-12: drawing a Where map marks each box once, then writes every map pixel in one pass. The
// per-pixel version scanned every box twice per pixel and took about 1.5 s for this page.
test('a Where map for 300 elements on a 1280 × 6000 page draws in well under a second (RV11-12)', (t) => {
  const outDir = mkTmp('styleproof-where-timing-');
  t.after(() => rmTmp(outDir));
  fs.mkdirSync(path.join(outDir, 'crops'));
  const ctx = { outDir, crops: createCropBudget(60, 50_000_000) };
  const page = PNG.sync.read(solidPng(1280, 6000));
  const rects = Array.from({ length: 300 }, (_, i) => [20 + (i % 3) * 400, 20 + Math.floor(i / 3) * 59, 360, 24]);
  const started = performance.now();
  const map = writeWhereMap(ctx, { surface: 'list@1280', suffix: '1', page, side: 'after', rects });
  const elapsedMs = performance.now() - started;
  assert.ok(map, 'the map was written');
  assert.equal(map.boxes.length, 300);
  assert.ok(elapsedMs < 600, `the Where map took ${elapsedMs.toFixed(0)}ms`);
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
