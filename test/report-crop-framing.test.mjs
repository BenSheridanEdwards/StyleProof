import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

// QA1-05: a small changed element is framed on its enclosing card, so the crop does not
// cut the card's text in half, and the crop is still an untouched rectangle of the capture.
const card = 'body > main:nth-child(1) > article:nth-child(1)';
const title = `${card} > h2:nth-child(1)`;

function capture(seed) {
  const png = new PNG({ width: 1280, height: 600 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++)
      png.data.set([(x + seed) % 256, y % 256, (x * y) % 256, 255], (y * 1280 + x) * 4);
  }
  return png;
}

test('a small changed element is cropped on its enclosing card, pixel for pixel', (t) => {
  const root = mkTmp('styleproof-framing-');
  t.after(() => rmTmp(root));
  const sources = [capture(0), capture(40)];
  for (const [i, side] of ['before', 'after'].entries()) {
    const map = makeMap({
      elements: {
        'body > main:nth-child(1)': { tag: 'main', cls: 'page', rect: [0, 0, 1280, 600] },
        [card]: { tag: 'article', cls: 'card', rect: [24, 163, 400, 142] },
        [title]: {
          tag: 'h2',
          cls: 'card-title',
          rect: [41, 186, 350, 23],
          style: { color: i ? 'rgb(150, 30, 60)' : 'rgb(30, 60, 120)' },
        },
      },
    });
    writeCapture(path.join(root, side), 'shop@1280', map, PNG.sync.write(sources[i]));
  }
  const out = path.join(root, 'out');
  const result = generateStyleMapReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: out,
  });
  const region = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')).surfaces[0].regions[0];
  // The card, padded 12px: 424 × 166, grown to the 180px minimum around its centre → origin (12, 144).
  for (const [side, source] of [
    ['before', sources[0]],
    ['after', sources[1]],
  ]) {
    const crop = PNG.sync.read(fs.readFileSync(path.join(out, region.images[side])));
    assert.deepEqual([crop.width, crop.height], [424, 180], `${side} crop frames the whole card`);
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const a = (y * crop.width + x) * 4;
        const b = ((y + 144) * source.width + x + 12) * 4;
        assert.deepEqual(crop.data.subarray(a, a + 4), source.data.subarray(b, b + 4), `${side} pixel ${x},${y}`);
      }
    }
  }
  // The Where map still rings the title, not the card.
  assert.deepEqual(region.where[0].boxes, [[41, 186, 350, 23]]);
});

test('an element as large as the crop window keeps its own frame', (t) => {
  const root = mkTmp('styleproof-framing-own-');
  t.after(() => rmTmp(root));
  for (const [i, side] of ['before', 'after'].entries()) {
    const map = makeMap({
      elements: {
        'body > main:nth-child(1)': { tag: 'main', cls: 'page', rect: [0, 0, 1280, 600] },
        [card]: { tag: 'article', cls: 'card', rect: [24, 163, 400, 300], style: { padding: i ? '24px' : '16px' } },
      },
    });
    writeCapture(path.join(root, side), 'shop@1280', map, PNG.sync.write(capture(i)));
  }
  const out = path.join(root, 'out');
  const result = generateStyleMapReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: out,
  });
  const region = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')).surfaces[0].regions[0];
  const crop = PNG.sync.read(fs.readFileSync(path.join(out, region.images.after)));
  assert.deepEqual([crop.width, crop.height], [424, 324]);
});
