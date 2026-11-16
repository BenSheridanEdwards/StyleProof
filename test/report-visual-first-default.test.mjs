import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/report.js';
import { generateStructuralStyleMapReportForTesting } from '../dist/report.js';
import { makeMap, solidPng, pairFixture, rmTmp } from './helpers.mjs';

function caretPair() {
  const caret = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} },
        'body > span:nth-child(1)': { tag: 'span', cls: 'caret', rect: [40, 40, 12, 16], style: { color } },
      },
    });
  return pairFixture({
    surface: 'home@1280',
    before: caret('rgb(0, 0, 0)'),
    after: caret('rgb(255, 0, 0)'),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
}

test('omitting layout writes the visual-first report', () => {
  const { beforeDir, afterDir, outDir, root } = caretPair();
  try {
    const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(res.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
    assert.match(md, /styleproof-section /);
    const region = json.surfaces[0].regions[0];
    assert.ok(region.images.before);
    assert.ok(region.images.after);
    assert.equal(region.images.zoom, undefined);
    assert.equal(region.images.composite, undefined);
    assert.equal(region.images.annotated, undefined);
  } finally {
    rmTmp(root);
  }
});

test('layout: legacy still writes the previous default crops and wording', () => {
  const { beforeDir, afterDir, outDir, root } = caretPair();
  try {
    const res = generateStyleMapReport({ beforeDir, afterDir, outDir, layout: 'legacy' });
    const md = fs.readFileSync(res.reportMdPath, 'utf8');
    const region = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8')).surfaces[0].regions[0];
    assert.match(region.images.zoom, /-zoom\.png$/);
    assert.doesNotMatch(md, /styleproof-section /);
  } finally {
    rmTmp(root);
  }
});

test('zoomBelow and foldDetailsAt are ignored on the default layout', () => {
  const { beforeDir, afterDir, outDir, root } = caretPair();
  try {
    const a = generateStructuralStyleMapReportForTesting({
      beforeDir,
      afterDir,
      outDir,
      zoomBelow: 64,
      foldDetailsAt: Infinity,
    });
    const b = generateStructuralStyleMapReportForTesting({
      beforeDir,
      afterDir,
      outDir: outDir + '-b',
      zoomBelow: 0,
      foldDetailsAt: 0,
    });
    assert.equal(fs.readFileSync(a.reportMdPath, 'utf8'), fs.readFileSync(b.reportMdPath, 'utf8'));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(a.reportJsonPath, 'utf8')).surfaces[0].regions,
      JSON.parse(fs.readFileSync(b.reportJsonPath, 'utf8')).surfaces[0].regions,
    );
  } finally {
    rmTmp(root);
  }
});
