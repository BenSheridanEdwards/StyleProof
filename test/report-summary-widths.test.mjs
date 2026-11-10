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
