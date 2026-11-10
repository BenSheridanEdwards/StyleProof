import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { createCropBudget, cropGapReason, writeBudgetedPng } from '../dist/report/crop-budget.js';
import { cropGapLines } from '../dist/report/headline.js';
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
  const beforePng = noisePng(64, 64, 1);
  const afterPng = noisePng(64, 64, 2);

  for (let surface = 0; surface < 3; surface++) {
    writeCapture(dirs.beforeDir, `surface-${surface}@1280`, surfaceMap(surface, 0), beforePng);
    writeCapture(dirs.afterDir, `surface-${surface}@1280`, surfaceMap(surface, 30), afterPng);
  }

  writeCapture(dirs.afterDir, 'new@1280', surfaceMap(20, 0), afterPng);
  const full = report(dirs, 'full', { maxCropFiles: 1000, maxCropBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(full.json.surfaces.length, 4);
  assert.ok(full.result.totalFindings > 0);
  assert.ok(full.files.length > 5, 'fixture must exceed the file budget');
  assert.ok(full.bytes > 6_000, 'fixture must exceed the byte budget');
  assert.equal(Object.hasOwn(full.json, 'cropBudget'), false);

  await t.test('file cap is shared across all surfaces and names every omitted crop', () => {
    const capped = report(dirs, 'files', { maxCropFiles: 5 });
    assert.ok(capped.files.length <= 5, `wrote ${capped.files.length} crop files`);
    assert.ok(capped.json.cropBudget.omitted > 0);
    // Rule 5: one opening line states every crop left out, with the true total and the option.
    assert.equal((capped.md.match(/missing crops\*\*/g) ?? []).length, 1);
    const line = capped.md.match(/\*\*(\d+) changes? (?:is|are) missing crops\*\*[^\n]*/);
    const sectionsOmitted = capped.json.surfaces
      .flatMap((s) => s.regions ?? [])
      .filter((r) => r.cropOmitted === 'budget').length;
    const pagesOmitted = capped.json.surfaces.filter((s) => (s.isNew || s.isRemoved) && !s.image).length;
    assert.equal(Number(line[1]), sectionsOmitted + pagesOmitted);
    assert.match(
      line[0],
      /past the report's crop budget \(5 files \/ 0\.9 MB\)[^\n]*raise `--max-crop-files` or `--max-crop-bytes`/,
    );
    assert.equal(capped.json.cropBudget.files, capped.files.length);
    assert.equal(capped.json.cropBudget.bytes, capped.bytes);
    sameFindings(capped, full);
  });

  await t.test('byte cap is hard even when the next PNG does not fit', () => {
    const capped = report(dirs, 'bytes', { maxCropBytes: 6_000 });
    assert.ok(capped.bytes <= 6_000, `wrote ${capped.bytes} crop bytes`);
    assert.equal(capped.json.cropBudget.maxBytes, 6_000);
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

  await t.test('zero bytes disables crops and preserves findings', () => {
    const capped = report(dirs, 'zero-bytes', { maxCropBytes: 0 });
    assert.deepEqual(capped.files, []);
    assert.match(capped.md, /missing crops\*\*[^\n]*past the report's crop budget/);
    sameFindings(capped, full);
  });

  await t.test('zero files keeps the allowed one-sided shape and announces the omission', () => {
    const capped = report(dirs, 'zero', { maxCropFiles: 0 });
    assert.deepEqual(capped.files, []);
    const added = capped.json.surfaces.find((surface) => surface.surface === 'new@1280');
    assert.deepEqual(
      Object.keys(added).sort(),
      ['surface', 'missing', 'isNew', 'isRemoved', 'baselineStatus', 'classification'].sort(),
    );
    assert.match(capped.md, /missing crops\*\*[^\n]*past the report's crop budget/);
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
  assert.match(capped.md, /part 2 of 2 · 800–1600 of 4000px/);
  // The crop budget cut this page, so the line names it and the option that shows more of it.
  assert.match(
    capped.md,
    /📏 \*\*Only part of 1 page is shown:\*\* `new @ 1280` \(1600 of 4000px, [^\n]*crop budget ran out; raise `--max-crop-files` or `--max-crop-bytes`/,
  );
});

test('a tall changed element has clean crops clipped to the pixel cap', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const rect = [0, 0, 1280, 801];
  writeCapture(dirs.beforeDir, 'tall@1280', surfaceMap(0, 0, rect), solidPng(1280, 801));
  writeCapture(dirs.afterDir, 'tall@1280', surfaceMap(0, 30, rect), solidPng(1280, 801, [100, 100, 100]));
  const capped = report(dirs, 'pixels');
  const crops = capped.files.filter((file) => /-(before|after)\.png$/.test(file));
  assert.ok(crops.length > 0);

  for (const file of crops) {
    const png = PNG.sync.read(fs.readFileSync(path.join(capped.outDir, 'crops', file)));
    assert.ok(png.width <= 1280, `crop width ${png.width}`);
    assert.ok(png.height <= 800, `crop height ${png.height}`);
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
  assert.doesNotMatch(capped.md, /crop budget \(/);
});

test('a crop rejected after downscaling names the report byte limit and leaves room for smaller crops', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const crops = createCropBudget(60, 100);
  const ctx = { outDir: dirs.root, crops };
  assert.equal(writeBudgetedPng(ctx, 'large.png', PNG.sync.read(noisePng(400, 400, 1))), false);
  assert.equal(crops.exhausted, false);
  assert.equal(cropGapReason(crops), 'size');
  const [, line] = cropGapLines([{ reason: cropGapReason(crops), where: 'home@1280' }], {
    maxCrops: 8,
    maxFiles: crops.maxFiles,
    maxBytes: crops.maxBytes,
  });
  assert.match(line, /report byte limit after downscaling/);
  assert.doesNotMatch(line, /crop budget/);
  assert.equal(writeBudgetedPng(ctx, 'small.png', PNG.sync.read(solidPng(1, 1))), true);
});

test('zero crop bytes skips encoding and reports an exhausted budget', () => {
  const crops = createCropBudget(60, 0);

  const png = {
    get width() {
      throw new Error('disabled crops must not be encoded');
    },
  };

  assert.equal(writeBudgetedPng({ crops }, 'disabled.png', png), false);
  assert.equal(crops.exhausted, true);
  assert.equal(cropGapReason(crops), 'budget');
});

test('advisory content crops do not take the crop budget from reviewable style crops', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const map = (color, text) =>
    makeMap({
      elements: {
        'body > div:nth-child(1)': { tag: 'div', cls: 'card', rect: [10, 20, 200, 40], style: { color } },
        'body > p:nth-child(2)': { tag: 'p', cls: 'lead', rect: [10, 300, 200, 40], text },
      },
    });
  writeCapture(dirs.beforeDir, 'home@1280', map('rgb(0, 0, 0)', 'Original demo copy'), noisePng(400, 400, 1));
  writeCapture(dirs.afterDir, 'home@1280', map('rgb(255, 0, 0)', 'Updated demo copy'), noisePng(400, 400, 2));
  const isContent = (file) => file.includes('content');
  const full = report(dirs, 'full', { includeContent: true, maxCropBytes: Number.MAX_SAFE_INTEGER });
  const styleFiles = full.files.filter((file) => !isContent(file));
  assert.ok(styleFiles.length > 0 && full.files.some(isContent), 'the fixture renders style and content crops');
  const styleBytes = styleFiles.reduce((sum, file) => sum + fs.statSync(path.join(full.outDir, 'crops', file)).size, 0);

  const capped = report(dirs, 'capped', { includeContent: true, maxCropBytes: styleBytes });
  assert.deepEqual(capped.files, styleFiles, 'the budget goes to the reviewable style change first');
  assert.equal(capped.json.cropBudget.omitted, 1, 'the advisory content crop is the one left out');
  assert.match(capped.md, /Updated demo copy/, 'the content change is still listed');
});

test('a section with a resting and a hover pair counts as one change missing crops (RV11-02)', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const link = 'body > a.docs';
  for (const [dir, color, hover, fill] of [
    [dirs.beforeDir, 'rgb(0, 0, 0)', 'rgb(255, 255, 255)', [20, 120, 60]],
    [dirs.afterDir, 'rgb(200, 30, 30)', 'rgb(40, 40, 120)', [160, 40, 40]],
  ]) {
    const map = makeMap({
      elements: { [link]: { tag: 'a', cls: 'docs', text: 'Docs', rect: [20, 20, 80, 20], style: { color } } },
      states: { [link]: { hover: { [link]: { 'background-color': hover } } } },
    });
    writeCapture(dir, 'docs@1280', map, solidPng(1280, 400, fill));
    fs.writeFileSync(path.join(dir, 'docs@1280.hover.png'), solidPng(1280, 400, fill));
  }
  for (const limits of [{ maxCropFiles: 0 }, { maxCropBytes: 10 }]) {
    const capped = report(dirs, `pairs-${Object.keys(limits)[0]}`, limits);
    assert.match(capped.md, /\*\*1 change to review\*\*/);
    // The count of changes, whatever the wording: never the 2 image pairs.
    const line = capped.md.match(
      /\*\*(\d+) changes? (?:is missing crops|are missing crops|has no crop|have no crop)\*\*/,
    );
    assert.ok(line, capped.md.slice(0, 600));
    assert.equal(Number(line[1]), 1, line[0]);
  }
});
