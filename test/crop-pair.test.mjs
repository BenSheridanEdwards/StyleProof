import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { renderCropPair } from '../dist/report/crop-pair.js';
import { createCropBudget } from '../dist/report/crop-budget.js';
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
    const ctx = { outDir, img: (rel) => rel, padBy: 0, minWidth: 320, minHeight: 180, maxHeight: 1600, zoomBelow: 0 };
    ctx.crops = createCropBudget(60, 5_000_000);
    const result = renderCropPair(ctx, {
      surface: 'home@800',
      suffix: '1',
      box: { x: 100, y: 940, w: 200, h: 40 },
      pngA: page(800, 1000),
      pngB: page(800, 1600),
      what: 'the changed element',
      skipIdentical: true,
    });
    assert.equal(result, null, 'identical content at the same page rectangle is not a change');
  } finally {
    rmTmp(outDir);
  }
});

// A white page, optionally with a blue block, to find a change in the after crop.
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
    const ctx = { outDir, img: (rel) => rel, padBy: 0, minWidth: 320, minHeight: 180, maxHeight: 1600, zoomBelow: 0 };
    const block = { x: 100, y: 1400, w: 200, h: 40 };
    ctx.crops = createCropBudget(60, 5_000_000);
    const result = renderCropPair(ctx, {
      surface: 'home@800',
      suffix: '1',
      box: block,
      pngA: white(800, 1000),
      pngB: white(800, 1600, block),
      what: 'the changed element',
      skipIdentical: true,
    });
    assert.ok(result, 'the added block is a visible difference, not an identical pair');
    const after = PNG.sync.read(fs.readFileSync(path.join(outDir, result.images.after)));
    let blue = 0;
    for (let i = 0; i < after.data.length; i += 4) {
      if (after.data[i] === 0 && after.data[i + 1] === 0 && after.data[i + 2] === 255) blue++;
    }
    assert.ok(blue > 0, 'the added block appears in the after crop');
  } finally {
    rmTmp(outDir);
  }
});

// Boxes reach renderCropPair padded by ctx.padBy, so a full-width, right-edge or
// bottom-flush element's box runs off the screenshot by its padding alone (#954).
function paddedRowsPair(outDir, box, skipIdentical) {
  fs.mkdirSync(path.join(outDir, 'crops'));
  const ctx = { outDir, img: (rel) => rel, padBy: 12, minWidth: 320, minHeight: 180, maxHeight: 1600, zoomBelow: 0 };
  ctx.crops = createCropBudget(60, 5_000_000);
  return renderCropPair(ctx, {
    surface: 'home@800',
    suffix: '1',
    box,
    pngA: page(800, 1000),
    pngB: page(800, 1600),
    what: 'the changed element',
    skipIdentical,
  });
}

for (const [element, box] of [
  ['a full-width element', { x: -12, y: 928, w: 824, h: 64 }],
  ['a right-edge element', { x: 588, y: 928, w: 224, h: 64 }],
  ["an element flush with the shorter page's bottom", { x: 88, y: 948, w: 224, h: 64 }],
]) {
  test(`renderCropPair aligns ${element} whose padding runs off the screenshot`, () => {
    const outDir = mkTmp();
    try {
      assert.equal(
        paddedRowsPair(outDir, box, true),
        null,
        'identical content at the same page rectangle is not a change',
      );
    } finally {
      rmTmp(outDir);
    }
  });
}

test('renderCropPair crops both panels of a full-width element from the same page y', () => {
  const outDir = mkTmp();
  try {
    const result = paddedRowsPair(outDir, { x: -12, y: 928, w: 824, h: 64 }, false);
    // Each clean crop's top row is its first page row.
    const topPageY = (side) => {
      const crop = PNG.sync.read(fs.readFileSync(path.join(outDir, result.images[side])));
      return crop.data[0] + (crop.data[1] << 8);
    };
    assert.deepEqual({ before: topPageY('before'), after: topPageY('after') }, { before: 820, after: 820 });
  } finally {
    rmTmp(outDir);
  }
});
