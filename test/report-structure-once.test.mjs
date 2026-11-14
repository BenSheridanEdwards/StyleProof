import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateStructuralStyleMapReportForTesting as report } from '../dist/report.js';
import { makeMap, writeCapture, mkTmp, rmTmp, solidPng } from './helpers.mjs';
test('visual-first section records clean images and Where receipts', (t) => {
  const root = mkTmp();
  t.after(() => rmTmp(root));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  for (const [i, dir] of [beforeDir, afterDir].entries()) {
    writeCapture(
      dir,
      'index@600',
      makeMap({
        elements: {
          'body > button': {
            tag: 'button',
            cls: 'cta',
            rect: [100, 100, 80, 40],
            style: { color: i ? 'blue' : 'red' },
          },
        },
      }),
      solidPng(600, 500),
    );
  }
  const result = report({ beforeDir, afterDir, outDir, layout: 'visual-first' });
  const region = JSON.parse(fs.readFileSync(result.reportJsonPath)).surfaces[0].regions[0];
  assert.deepEqual(Object.keys(region.images).sort(), ['after', 'before']);
  assert.equal(region.where[0].side, 'after');
  assert.ok(region.where[0].boxes.length);
  assert.ok(fs.existsSync(path.join(outDir, region.where[0].image)));
  assert.match(fs.readFileSync(result.reportMdPath, 'utf8'), /<sub>Where:/);
});
