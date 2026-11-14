import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sectionTitle } from '../dist/report/section-title.js';

test('section names describe repeated titles and shared button text', () => {
  const subject = { tag: 'h2', cls: 'card-title', path: 'h2', texts: ['', ''], count: 2, sameSelectorCount: 2 };
  assert.equal(sectionTitle(subject), 'Card titles');
  assert.equal(
    sectionTitle({ ...subject, tag: 'button', cls: '', texts: ['Add to basket', 'Add to basket'] }),
    'Add to basket buttons',
  );
});
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
      assert.match(md, layout === 'visual-first' ? /### .*Cards/ : /### .*div.card/);
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
          if (layout === 'visual-first') assert.match(md, /### Lbl/);
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

test('crop limit names all merged sections', () => {
  const map = (changed) =>
    makeMap({
      elements: {
        'h2.card-title': {
          tag: 'h2',
          cls: 'card-title',
          rect: [20, 20, 100, 30],
          style: { color: changed ? '#ff0000' : '#000000' },
        },
        'button.cta': {
          tag: 'button',
          cls: 'cta',
          rect: [20, 200, 100, 30],
          style: { padding: changed ? '16px' : '8px' },
        },
        'p.note': { tag: 'p', cls: 'note', rect: [20, 400, 100, 30], style: { fontSize: changed ? '20px' : '16px' } },
      },
    });
  const fixture = pairFixture({
    surface: 'home@1280',
    before: map(false),
    after: map(true),
    beforePng: solidPng(400, 600),
    afterPng: solidPng(400, 600),
  });
  try {
    const headings = (layout, maxCrops) => {
      const result = report({ ...fixture, layout, padBy: 0, maxCrops });
      return fs
        .readFileSync(result.reportMdPath, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('### '));
    };
    assert.deepEqual(headings('visual-first', 8), ['### Card title', '### Cta', '### Note']);
    const merged = headings('visual-first', 1);
    assert.equal(merged.length, 1);
    assert.match(merged[0], /### .*`[^`]*card-title[^`]*` · 3 elements restyled/);
    assert.deepEqual(headings('legacy', 1), merged);
  } finally {
    rmTmp(fixture.root);
  }
});
