import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';

import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

// RV2-03: only one side of this pair is over the 300 KB per-file cap (noise does not compress).
// Halving that side alone would show a blur difference the change did not cause.
function page(noisy) {
  const png = new PNG({ width: 1280, height: 900 });
  let seed = 7;
  for (let i = 0; i < png.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    png.data[i] = noisy ? seed >>> 24 : 230;
    png.data[i + 1] = noisy ? (seed >>> 16) & 255 : 230;
    png.data[i + 2] = noisy ? (seed >>> 8) & 255 : 230;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('a pair is scaled together, never one side alone (RV2-03)', (t) => {
  const root = mkTmp('styleproof-pair-scale-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const map = makeMap({
      elements: {
        'body > section': {
          tag: 'section',
          cls: 'hero',
          rect: [0, 0, 1280, 600],
          style: { 'background-color': side === 'before' ? 'rgb(1, 2, 3)' : 'rgb(200, 2, 3)' },
        },
      },
    });
    writeCapture(path.join(root, side), 'home@1280', map, page(side === 'before'));
  }
  generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
    layout: 'visual-first',
  });
  const size = (file) => {
    const png = PNG.sync.read(fs.readFileSync(path.join(root, 'report', 'crops', file)));
    return `${png.width}x${png.height}`;
  };
  assert.equal(size('home-1280-1-before.png'), size('home-1280-1-after.png'));

  assert.notEqual(size('home-1280-1-after.png'), '1280x624', 'the pair was downscaled to fit');
});

test('an unaffordable pair leaves neither crop', (t) => {
  const root = mkTmp('styleproof-pair-budget-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const elements = {
      'body > section': {
        tag: 'section',
        rect: [0, 0, 1280, 600],
        style: { color: side === 'before' ? 'red' : 'blue' },
      },
    };
    writeCapture(path.join(root, side), 'home@1280', makeMap({ elements }), page(side === 'after'));
  }
  generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
    layout: 'visual-first',
    maxCropBytes: 10000,
  });
  assert.deepEqual(fs.readdirSync(path.join(root, 'report', 'crops')), []);
});

test('a pair whose sides differ in size records the size of each side (RV20-05)', (t) => {
  const root = mkTmp('styleproof-pair-sides-');
  t.after(() => rmTmp(root));
  // The base page is shorter than the crop, so the before crop is cut short and the after crop is not.
  for (const [side, height] of [
    ['before', 120],
    ['after', 600],
  ]) {
    const map = makeMap({
      elements: {
        'body > h1': {
          tag: 'h1',
          cls: 'title',
          rect: [20, 80, 200, 60],
          style: { color: side === 'before' ? 'rgb(0, 0, 0)' : 'rgb(200, 0, 0)' },
        },
      },
    });
    writeCapture(path.join(root, side), 'home@1280', map, solidPng(1280, height));
  }
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
    layout: 'visual-first',
  });
  const dims = (file) => {
    const png = PNG.sync.read(fs.readFileSync(path.join(root, 'report', file)));
    return [png.width, png.height];
  };
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  function find(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.images?.before && value.size) return value;
    return Object.values(value).map(find).find(Boolean);
  }
  const region = find(json);
  assert.ok(region, 'written pair sizes are in report.json');
  const [bw, bh] = dims(region.images.before);
  const [aw, ah] = dims(region.images.after);
  assert.notEqual(bh, ah);
  assert.deepEqual(region.size, { w: aw, h: ah, base: { w: bw, h: bh } });
});

test('default and legacy retain identical main-shaped report artifacts', (t) => {
  const root = mkTmp('styleproof-pair-legacy-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const elements = {
      'body > button': { tag: 'button', rect: [20, 20, 200, 60], style: { color: side === 'before' ? 'red' : 'blue' } },
    };
    writeCapture(path.join(root, side), 'home@1280', makeMap({ elements }), solidPng(1280, 400));
  }
  const reports = [undefined, 'legacy'].map((layout, i) => {
    const outDir = path.join(root, `out-${i}`);
    generateReport({
      beforeDir: path.join(root, 'before'),
      afterDir: path.join(root, 'after'),
      outDir,
      ...(layout ? { layout } : {}),
    });
    return outDir;
  });
  const crops = fs.readdirSync(path.join(reports[0], 'crops')).sort();
  assert.ok(crops.some((name) => name.endsWith('-composite.png')));
  assert.ok(crops.every((name) => !/-(before|after)\.png$/.test(name)));
  for (const file of ['report.md', 'report.json', ...crops.map((name) => `crops/${name}`)]) {
    assert.deepEqual(fs.readFileSync(path.join(reports[0], file)), fs.readFileSync(path.join(reports[1], file)));
  }
});
