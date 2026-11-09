import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStyleMapReport } from '../dist/report.js';
import { pixelDiffSurface } from '../dist/pixel-diff.js';
import { fillRect } from '../dist/png-util.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

const SURFACE = 'home@200';
const TARGET = 'body > div:nth-child(1)';
const PAINT_RECT = [30, 240, 20, 20];
const BEFORE = [0, 100, 200];
const AFTER = [240, 100, 0];

function map(color, alternate, present = true) {
  const result = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 200, 100] },
      ...(present
        ? {
            [TARGET]: {
              cls: 'marker',
              rect: alternate ? [30, 20, 20, 20] : PAINT_RECT,
              style: { 'background-color': `rgb(${color.join(', ')})` },
            },
          }
        : {}),
    },
  });
  result.viewport = { width: 200, height: 100 };
  // The driven element is visible in its inner scroller; expansion paints it further down.
  if (alternate && present) result.elements[TARGET].screenshotRect = PAINT_RECT;
  return result;
}

function screenshot(color) {
  const png = PNG.sync.read(solidPng(200, 400, [255, 255, 255]));
  if (color) fillRect(png, ...PAINT_RECT, color);
  return PNG.sync.write(png);
}

function containsColor(file, rgb) {
  const png = PNG.sync.read(fs.readFileSync(file));
  for (let i = 0; i < png.data.length; i += 4) {
    if (rgb.every((value, channel) => png.data[i + channel] === value)) return true;
  }
  return false;
}

for (const alternate of [true, false]) {
  const mode = alternate ? 'screenshotRect' : 'legacy rect fallback';

  test(`style report crops and annotations use ${mode}`, () => {
    const dirs = tmpDirs();
    try {
      writeCapture(dirs.beforeDir, SURFACE, map(BEFORE, alternate), screenshot(BEFORE));
      writeCapture(dirs.afterDir, SURFACE, map(AFTER, alternate), screenshot(AFTER));
      const result = generateStyleMapReport({ ...dirs, pad: 4, minWidth: 40, minHeight: 40, maxHeight: 40 });
      const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
      const images = json.surfaces[0].regions[0].images;
      assert.ok(images.before && images.after, 'the changed style has screenshot evidence');
      assert.ok(containsColor(path.join(dirs.outDir, images.before), BEFORE), 'crop contains before pixels');
      assert.ok(containsColor(path.join(dirs.outDir, images.after), AFTER), 'crop contains after pixels');
      const where = json.surfaces[0].regions[0].where?.[0];
      assert.ok(where, 'the Where map boxes the element at its screenshot position');
      assert.ok(containsColor(path.join(dirs.outDir, where.image), [224, 17, 157]), 'the Where ring is drawn');
    } finally {
      rmTmp(dirs.root);
    }
  });

  test(`content report crop uses ${mode} instead of reporting identical pixels`, () => {
    const dirs = tmpDirs();
    try {
      writeCapture(dirs.beforeDir, SURFACE, map(AFTER, alternate, false), screenshot(null));
      writeCapture(dirs.afterDir, SURFACE, map(AFTER, alternate), screenshot(AFTER));
      const result = generateStyleMapReport({
        ...dirs,
        includeContent: true,
        pad: 4,
        minWidth: 40,
        minHeight: 40,
        maxHeight: 40,
      });
      const md = fs.readFileSync(result.reportMdPath, 'utf8');
      const crops = [...md.matchAll(/src="(crops\/[^"]+-after\.png)"/g)].map((match) => match[1]);
      assert.ok(
        crops.some((file) => containsColor(path.join(dirs.outDir, file), AFTER)),
        'content crop shows added pixels',
      );
      assert.doesNotMatch(
        md,
        /renders identically/,
        'the expanded element must not be described as absent pixel evidence',
      );
      const where = [...md.matchAll(/src="(crops\/[^"]+-where\.png)"/g)].map((match) => match[1]);
      assert.ok(where.some((file) => containsColor(path.join(dirs.outDir, file), [224, 17, 157])));
    } finally {
      rmTmp(dirs.root);
    }
  });

  test(`pixel attribution uses ${mode}`, () => {
    const dirs = tmpDirs();
    try {
      const before = map(BEFORE, alternate);
      const after = map(AFTER, alternate);
      writeCapture(dirs.beforeDir, SURFACE, before, screenshot(BEFORE));
      writeCapture(dirs.afterDir, SURFACE, after, screenshot(AFTER));
      const result = pixelDiffSurface(dirs.beforeDir, dirs.afterDir, SURFACE, before, after);
      const comparison = result.layers.find((layer) => layer.layer === 'rest').comparison;
      assert.equal(comparison.changedPixels, 400);
      assert.equal(comparison.regions.length, 1);
      assert.deepEqual(comparison.regions[0].elements, [{ path: TARGET, cls: 'marker' }]);
    } finally {
      rmTmp(dirs.root);
    }
  });
}
