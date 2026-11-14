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

for (const layout of ['visual-first', 'legacy']) {
  for (const driven of [true, false]) {
    test(`${layout} preserves ${driven ? 'driven checked sibling' : 'parent and child'} changes once`, () => {
      const owner = driven ? 'body > input:nth-child(1)' : 'body > div:nth-child(1)';
      const target = driven ? 'body > label:nth-child(2)' : `${owner} > p:nth-child(1)`;
      const map = (changed) =>
        makeMap({
          elements: {
            [owner]: {
              tag: driven ? 'input' : 'div',
              cls: driven ? 'opt' : 'card',
              rect: [20, 20, 200, 100],
              style: driven ? {} : { padding: changed ? '16px' : '8px', height: changed ? '120px' : '100px' },
            },
            [target]: {
              tag: driven ? 'label' : 'p',
              cls: driven ? 'lbl' : 'title',
              rect: [30, 40, 100, 30],
              style: {
                color: !driven && changed ? '#ff0000' : '#000000',
                ...(!driven ? { height: changed ? '40px' : '30px' } : {}),
              },
            },
          },
          ...(driven
            ? { states: { [owner]: { checked: { [target]: { color: changed ? '#ff0000' : '#000000' } } } } }
            : {}),
        });
      const fixture = pairFixture({
        surface: 'home@1280',
        before: map(false),
        after: map(true),
        beforePng: solidPng(400, 300),
        afterPng: solidPng(400, 300),
      });
      try {
        const result = report({ ...fixture, layout, padBy: 0 });
        const md = fs.readFileSync(result.reportMdPath, 'utf8');
        assert.equal((md.match(/\| `color` \|/g) ?? []).length, 1, md);
        if (driven) {
          assert.match(md, /:checked/);
          if (layout === 'visual-first') assert.match(md, /### .*label/);
        } else {
          assert.match(md, /16px/);
          assert.equal((md.match(/\| `height` \| `30px` \| `40px` \|/g) ?? []).length, 1, md);
        }
      } finally {
        rmTmp(fixture.root);
      }
    });
  }
}
