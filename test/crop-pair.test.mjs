import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { renderCropPair } from '../dist/report/crop-pair.js';
import { mkTmp, rmTmp } from './helpers.mjs';

// Each row painted with its page y, so a crop's top row says which page rectangle it shows.
function page(width, height) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = y & 255;
      png.data[i + 1] = y >> 8;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

test('renderCropPair crops the same page rectangle on both sides when the page grew', () => {
  const outDir = mkTmp();
  try {
    fs.mkdirSync(path.join(outDir, 'crops'));
    const ctx = { outDir, img: (rel) => rel, minWidth: 320, minHeight: 180, maxHeight: 1600, zoomBelow: 0 };
    const result = renderCropPair(ctx, {
      surface: 'home@800',
      suffix: '1',
      box: { x: 100, y: 940, w: 200, h: 40 },
      pngA: page(800, 1000),
      pngB: page(800, 1600),
      rectsA: [],
      rectsB: [],
      captions: { pair: 'pair', annotated: 'annotated', zoom: () => 'zoom' },
      skipIdentical: true,
    });
    assert.equal(result, null, 'identical content at the same page rectangle is not a change');
  } finally {
    rmTmp(outDir);
  }
});

// A white page, optionally with a blue block, to find a change in the composite.
function white(width, height, block) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  if (block) {
    for (let y = block.y; y < block.y + block.h; y++) {
      for (let x = block.x; x < block.x + block.w; x++) png.data.writeUInt32BE(0x0000ffff, (y * width + x) * 4);
    }
  }
  return png;
}

test("renderCropPair still shows a change added below the shorter page's end", () => {
  const outDir = mkTmp();
  try {
    fs.mkdirSync(path.join(outDir, 'crops'));
    const ctx = { outDir, img: (rel) => rel, minWidth: 320, minHeight: 180, maxHeight: 1600, zoomBelow: 0 };
    const block = { x: 100, y: 1400, w: 200, h: 40 };
    const result = renderCropPair(ctx, {
      surface: 'home@800',
      suffix: '1',
      box: block,
      pngA: white(800, 1000),
      pngB: white(800, 1600, block),
      rectsA: [],
      rectsB: [[block.x, block.y, block.w, block.h]],
      captions: { pair: 'pair', annotated: 'annotated', zoom: () => 'zoom' },
      skipIdentical: true,
    });
    assert.ok(result, 'the added block is a visible difference, not an identical pair');
    const composite = PNG.sync.read(fs.readFileSync(path.join(outDir, result.images.composite)));
    let blue = 0;
    for (let i = 0; i < composite.data.length; i += 4) {
      if (composite.data[i] === 0 && composite.data[i + 1] === 0 && composite.data[i + 2] === 255) blue++;
    }
    assert.ok(blue > 0, 'the added block appears in the after panel');
  } finally {
    rmTmp(outDir);
  }
});
