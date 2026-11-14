import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMap, pairFixture, solidPng, rmTmp } from './helpers.mjs';
import { generateStructuralStyleMapReportForTesting as report } from '../dist/report.js';

const caret = 'body > header:nth-child(1) > span:nth-child(1)';
const cta = 'body > main:nth-child(2) > button:nth-child(1)';
test('visual-first crops name foreign changes inside the expanded window', () => {
  const map = (after) =>
    makeMap({
      elements: {
        'body > header:nth-child(1)': { tag: 'header', rect: [0, 0, 900, 48] },
        [caret]: {
          tag: 'span',
          cls: 'caret',
          rect: [150, 16, 12, 16],
          style: { color: after ? '#2563eb' : '#9ca3af' },
        },
        [cta]: {
          tag: 'button',
          cls: 'cta',
          rect: [40, 110, 180, 52],
          style: { 'background-color': after ? '#dc2626' : '#2563eb' },
        },
      },
    });
  const dirs = pairFixture({
    surface: 'page@900',
    before: map(false),
    after: map(true),
    beforePng: solidPng(900, 400),
    afterPng: solidPng(900, 400),
  });
  try {
    for (const layout of ['legacy', undefined, 'visual-first']) {
      const result = report({ ...dirs, padBy: 0, layout });
      const md = fs.readFileSync(result.reportMdPath, 'utf8');
      if (layout !== 'visual-first') {
        assert.doesNotMatch(md, /Also in view/);
        continue;
      }
      const regions = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')).surfaces[0].regions;
      assert.ok(regions.length >= 2);
      assert.ok(regions.some((r) => r.paths.includes(caret)));
      assert.ok(regions.some((r) => r.paths.includes(cta)));
      const section = md
        .split('\n### ')
        .slice(1)
        .find((s) => s.includes('caret'));
      assert.match(section, /Also in view:.*button\.cta/);
    }
  } finally {
    rmTmp(dirs.root);
  }
});
