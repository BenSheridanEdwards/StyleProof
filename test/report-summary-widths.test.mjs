// RV15-11: the summary line lists up to three widths (SPEC § Summary line), as it does pages; past
// three it counts them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

for (const [widths, expected] of [
  [[390, 768, 1280], / at 390, 768 and 1280px wide: 1 element\.$/m],
  [[390, 768, 1024, 1280], / at 4 widths: 1 element\.$/m],
]) {
  test(`${widths.length} widths ${widths.length <= 3 ? 'are listed' : 'are counted'} in the summary line (RV15-11)`, (t) => {
    const root = mkTmp('styleproof-widths-');
    t.after(() => rmTmp(root));
    for (const side of ['before', 'after'])
      for (const width of widths) {
        const map = makeMap({
          elements: {
            'body > h1': {
              tag: 'h1',
              cls: 'title',
              rect: [20, 20, 200, 40],
              style: { color: side === 'before' ? 'rgb(0, 0, 0)' : 'rgb(200, 0, 0)' },
            },
          },
        });
        writeCapture(path.join(root, side), `home@${width}`, map, solidPng(width, 300));
      }
    const result = generateReport({
      beforeDir: path.join(root, 'before'),
      afterDir: path.join(root, 'after'),
      outDir: path.join(root, 'report'),
    });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    assert.match(md.split('\n').find((l) => l.startsWith('**')) ?? md, expected);
  });
}

test('a new or removed surface is in the summary scope its count includes (RV19-05)', (t) => {
  const root = mkTmp('styleproof-scope-one-sided-');
  t.after(() => rmTmp(root));
  const title = (color) =>
    makeMap({ elements: { 'body > h1': { tag: 'h1', cls: 'title', rect: [20, 20, 200, 40], style: { color } } } });
  writeCapture(path.join(root, 'before'), 'home@900', title('rgb(0, 0, 0)'), solidPng(900, 300));
  writeCapture(path.join(root, 'after'), 'home@900', title('rgb(200, 0, 0)'), solidPng(900, 300));
  writeCapture(path.join(root, 'after'), 'pricing@900', title('rgb(0, 0, 0)'), solidPng(900, 300));
  writeCapture(path.join(root, 'before'), 'legacy@1280', title('rgb(0, 0, 0)'), solidPng(1280, 300));
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  // One restyled title on home, one new surface and one removed one: three changes on three pages.
  assert.match(
    md.split('\n').find((l) => l.startsWith('**')) ?? md,
    /^\*\*3 changes to review\*\* on `home`, `legacy` and `pricing` at 900 and 1280px wide: 1 element\.$/,
  );
});

test('a summary whose changes are all new or removed surfaces still names their pages and widths (RV20-03)', (t) => {
  const root = mkTmp('styleproof-scope-one-sided-only-');
  t.after(() => rmTmp(root));
  const title = makeMap({
    elements: { 'body > h1': { tag: 'h1', cls: 'title', rect: [20, 20, 200, 40], style: { color: 'rgb(0, 0, 0)' } } },
  });
  for (const side of ['before', 'after']) writeCapture(path.join(root, side), 'home@1280', title, solidPng(1280, 300));
  writeCapture(path.join(root, 'after'), 'pricing@900', title, solidPng(900, 300));
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.match(
    md.split('\n').find((l) => l.startsWith('**')) ?? md,
    /^\*\*1 change to review\*\* on `pricing` at 900px wide\.$/,
  );
});
