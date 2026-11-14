import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStructuralStyleMapReportForTesting as report } from '../dist/report.js';
import { makeMap, pairFixture, solidPng, rmTmp } from './helpers.mjs';

for (const layout of ['visual-first', 'legacy']) {
  test(`${layout} groups identical padding changes only when requested`, () => {
    const map = (padding) =>
      makeMap({
        elements: Object.fromEntries(
          [0, 1, 2].map((i) => [
            `div:nth-child(${i + 1})`,
            { cls: 'card', rect: [20, 20 + i * 180, 100, 80], style: { padding } },
          ]),
        ),
      });
    const fixture = pairFixture({
      surface: 'home@1280',
      before: map('8px'),
      after: map('16px'),
      beforePng: solidPng(400, 600),
      afterPng: solidPng(400, 600),
    });
    try {
      const result = report({ ...fixture, layout, padBy: 0 });
      const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
      const md = fs.readFileSync(result.reportMdPath, 'utf8');
      assert.equal(json.surfaces[0].regions.length, layout === 'visual-first' ? 1 : 3);
      assert.equal((md.match(/^### /gm) ?? []).length, layout === 'visual-first' ? 1 : 3);
    } finally {
      rmTmp(fixture.root);
    }
  });
}
