import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

// RV2-04: a crop left out for a limit is not an invisible element. The receipt says which limit.
const color = (side, i = 0) => (side === 'before' ? 'rgb(0, 0, 0)' : `rgb(${100 + i}, 0, 0)`);

function run(t, write, options) {
  const root = mkTmp('styleproof-crop-omitted-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) write(path.join(root, side), side);
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
    ...options,
  });
  return JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
}

test('a crop left out by the crop file budget is recorded as cropOmitted: budget, not as invisible', (t) => {
  const json = run(
    t,
    (dir, side) => {
      for (const s of ['alpha', 'beta', 'gamma']) {
        const elements = {
          [`body > h1.${s}`]: { tag: 'h1', cls: `t-${s}`, rect: [20, 20, 300, 60], style: { color: color(side) } },
        };
        writeCapture(
          dir,
          `${s}@1280`,
          makeMap({ elements }),
          solidPng(1280, 400, side === 'before' ? [240, 240, 240] : [230, 230, 250]),
        );
      }
    },
    { maxCropFiles: 4 },
  );
  const omitted = json.surfaces.filter((s) => s.regions?.some((r) => !r.images?.after));
  assert.ok(omitted.length > 0, 'the budget left some crops out');
  for (const s of omitted) {
    assert.equal(s.visualEvidence, undefined, `${s.surface}: group is not called invisible`);
    for (const r of s.regions) {
      assert.equal(r.visualEvidence, undefined);
      assert.equal(r.cropOmitted, 'budget');
    }
  }
});

test('sections past --max-crops are recorded as cropOmitted: max-crops, not as invisible', (t) => {
  const json = run(t, (dir, side) => {
    const elements = {};
    for (let i = 0; i < 10; i++) {
      elements[`body > div:nth-child(${i + 1})`] = {
        tag: 'div',
        cls: `widget-${i}`,
        rect: [20, 20 + i * 200, 300, 60],
        style: { color: color(side, i) },
      };
    }
    writeCapture(
      dir,
      'home@1280',
      makeMap({ elements }),
      solidPng(1280, 2100, side === 'before' ? [240, 240, 240] : [230, 230, 250]),
    );
  });
  const regions = json.surfaces.flatMap((s) => s.regions ?? []);
  assert.equal(regions.length, 10);
  assert.equal(regions.filter((r) => r.images?.after).length, 8);
  for (const r of regions.slice(8)) {
    assert.equal(r.visualEvidence, undefined);
    assert.equal(r.cropOmitted, 'max-crops');
  }
});
