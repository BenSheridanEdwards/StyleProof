import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { createCropBudget, cropBudgetNote, writeBudgetedPng } from '../dist/report/crop-budget.js';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { tmpDirs, makeMap, writeCapture, solidPng, rmTmp } from './helpers.mjs';

function noisePng(width, height, seed) {
  const png = new PNG({ width, height });
  let state = seed;

  for (let i = 0; i < png.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      png.data[i + channel] = state >>> 24;
    }

    png.data[i + 3] = 255;
  }

  return PNG.sync.write(png);
}

function surfaceMap(surface, shift, rect = [10, 20, 200, 40]) {
  return makeMap({
    elements: {
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: `change-${surface}`,
        rect,
        style: { color: `rgb(${surface + shift}, 0, 0)`, 'padding-top': `${surface + shift}px` },
      },
    },
  });
}

function report(dirs, name, options = {}) {
  const outDir = path.join(dirs.root, name);
  const result = generateStyleMapReport({ ...dirs, outDir, ...options });
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const files = fs.readdirSync(path.join(outDir, 'crops')).sort();
  const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(outDir, 'crops', file)).size, 0);

  return { outDir, result, json, md, files, bytes };
}

function sameFindings(actual, expected) {
  assert.deepEqual(
    actual.json.surfaces.map((surface) => surface.surface),
    expected.json.surfaces.map((surface) => surface.surface),
  );

  for (const key of ['totalFindings', 'changedSurfaces']) assert.equal(actual.result[key], expected.result[key]);

  for (const key of ['counts', 'comparison', 'reportConsistency']) {
    assert.deepEqual(actual.json[key], expected.json[key], key);
  }
}

test('whole-report crop budget preserves findings and certification', async (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const beforePng = noisePng(400, 480, 1);
  const afterPng = noisePng(400, 480, 2);

  for (let surface = 0; surface < 12; surface++) {
    writeCapture(dirs.beforeDir, `surface-${surface}@1280`, surfaceMap(surface, 0), beforePng);
    writeCapture(dirs.afterDir, `surface-${surface}@1280`, surfaceMap(surface, 30), afterPng);
  }

  writeCapture(dirs.afterDir, 'new@1280', surfaceMap(20, 0), afterPng);
  const full = report(dirs, 'full', { maxCropFiles: 1000, maxCropBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(full.json.surfaces.length, 13);
  assert.ok(full.result.totalFindings > 0);
  assert.ok(full.files.length > 5, 'fixture must exceed the file budget');
  assert.ok(full.bytes > 60_000, 'fixture must exceed the byte budget');
  assert.equal(Object.hasOwn(full.json, 'cropBudget'), false);

  await t.test('file cap is shared across all surfaces and names every omitted crop', () => {
    const capped = report(dirs, 'files', { maxCropFiles: 5 });
    assert.ok(capped.files.length <= 5, `wrote ${capped.files.length} crop files`);
    assert.ok(capped.json.cropBudget.omitted > 0);
    assert.equal(
      (capped.md.match(/Crop omitted: the report reached its crop budget/g) ?? []).length,
      capped.json.cropBudget.omitted,
    );
    assert.equal(capped.json.cropBudget.files, capped.files.length);
    assert.equal(capped.json.cropBudget.bytes, capped.bytes);
    sameFindings(capped, full);
  });

  await t.test('byte cap is hard even when the next PNG does not fit', () => {
    const capped = report(dirs, 'bytes', { maxCropBytes: 60_000 });
    assert.ok(capped.bytes <= 60_000, `wrote ${capped.bytes} crop bytes`);
    assert.equal(capped.json.cropBudget.maxBytes, 60_000);
    assert.equal(capped.json.cropBudget.bytes, capped.bytes);
    sameFindings(capped, full);
  });

  await t.test('capped markdown, JSON, HTML and crops are byte-identical across runs', () => {
    const first = report(dirs, 'deterministic-a', { maxCropFiles: 5 });
    const second = report(dirs, 'deterministic-b', { maxCropFiles: 5 });
    assert.ok(first.files.length <= 5);
    assert.deepEqual(first.files, second.files);

    for (const file of ['report.md', 'report.json', 'report.html', ...first.files.map((f) => `crops/${f}`)]) {
      assert.ok(
        fs.readFileSync(path.join(first.outDir, file)).equals(fs.readFileSync(path.join(second.outDir, file))),
        file,
      );
    }
  });

  await t.test('zero files keeps the allowed one-sided shape and announces the omission', () => {
    const capped = report(dirs, 'zero', { maxCropFiles: 0 });
    assert.deepEqual(capped.files, []);
    const added = capped.json.surfaces.find((surface) => surface.surface === 'new@1280');
    assert.deepEqual(
      Object.keys(added).sort(),
      ['surface', 'missing', 'isNew', 'isRemoved', 'baselineStatus', 'classification'].sort(),
    );
    assert.match(capped.md, /Crop omitted: the report reached its crop budget/);
    assert.doesNotMatch(capped.md, /no screenshot saved/);
    sameFindings(capped, full);
  });
});

test('one-sided pages retain partial tiles and the page-capped warning', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  fs.mkdirSync(dirs.beforeDir);
  const map = { ...surfaceMap(0, 0), viewport: { width: 1280, height: 800 } };
  writeCapture(dirs.afterDir, 'new@1280', map, solidPng(1280, 4000));
  const capped = report(dirs, 'partial', { maxCropFiles: 2 });
  const added = capped.json.surfaces[0];
  assert.equal(capped.files.length, 2);
  assert.equal(added.images.length, 2);
  assert.equal(added.shownHeight, 1600);
  assert.equal(added.capturedHeight, 4000);
  assert.ok(added.shownHeight < added.capturedHeight);
  assert.match(capped.md, /Page capped: showing 1600 of 4000px/);
});

test('a tall changed element has a composite clipped to the pixel cap', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const rect = [0, 0, 1280, 2000];
  writeCapture(dirs.beforeDir, 'tall@1280', surfaceMap(0, 0, rect), solidPng(1280, 2400));
  writeCapture(dirs.afterDir, 'tall@1280', surfaceMap(0, 30, rect), solidPng(1280, 2400, [100, 100, 100]));
  const capped = report(dirs, 'pixels');
  const composites = capped.files.filter((file) => file.endsWith('-composite.png'));
  assert.ok(composites.length > 0);

  for (const file of composites) {
    const png = PNG.sync.read(fs.readFileSync(path.join(capped.outDir, 'crops', file)));
    assert.ok(png.width <= 2 * 1280 + 68, `composite width ${png.width}`);
    assert.ok(png.height <= 800 + 40, `composite height ${png.height}`);
  }
});

test('clean maps write no crops or crop-budget metadata', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));

  for (const dir of [dirs.beforeDir, dirs.afterDir]) {
    writeCapture(dir, 'clean@1280', surfaceMap(0, 0), solidPng(400, 480));
  }

  const clean = report(dirs, 'clean', { maxCropFiles: 0 });
  assert.deepEqual(clean.files, []);
  assert.equal(Object.hasOwn(clean.json, 'cropBudget'), false);
  assert.equal(clean.result.totalFindings, 0);
});

test('an oversized one-sided tile does not block a later small tile', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  fs.mkdirSync(dirs.beforeDir);
  const png = PNG.sync.read(noisePng(400, 801, 1));
  png.data.fill(255, 400 * 800 * 4);
  const map = { ...surfaceMap(0, 0), viewport: { width: 400, height: 800 } };
  writeCapture(dirs.afterDir, 'new@400', map, PNG.sync.write(png));
  const capped = report(dirs, 'partial', { maxCropBytes: 100 });
  assert.equal(capped.files.length, 1);
  assert.match(capped.files[0], /new-2/);
  assert.doesNotMatch(capped.md, /the report reached its crop budget/);
});

test('a crop rejected after downscaling names the image limit and leaves room for smaller crops', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const crops = createCropBudget(60, 100);
  const ctx = { outDir: dirs.root, crops };
  assert.equal(writeBudgetedPng(ctx, 'large.png', PNG.sync.read(noisePng(400, 400, 1))), false);
  assert.equal(crops.exhausted, false);
  assert.match(cropBudgetNote(crops), /per-file size limit after downscaling/);
  assert.doesNotMatch(cropBudgetNote(crops), /reached its crop budget/);
  assert.equal(writeBudgetedPng(ctx, 'small.png', PNG.sync.read(solidPng(1, 1))), true);
});
