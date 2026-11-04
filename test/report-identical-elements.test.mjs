import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStyleMapReport, generateStructuralStyleMapReportForTesting } from '../dist/report.js';
import { elementChangeSignature } from '../dist/report/identical-elements.js';
import { propertyGlanceLine } from '../dist/report/markdown.js';
import { makeMap, pairFixture, rmTmp, solidPng } from './helpers.mjs';

const elementPath = (index) => `html > body > article:nth-child(${index}) > h2`;
const change = (index, extra = {}) => ({
  kind: 'style',
  path: elementPath(index),
  cls: 'card-title',
  pseudo: null,
  props: [{ prop: 'color', before: 'rgb(30, 60, 120)', after: 'rgb(150, 30, 60)' }],
  ...extra,
});

function render({
  count = 3,
  different = false,
  overlap = false,
  overlapCount = 0,
  states = false,
  maxCropFiles,
  maxCrops = 30,
  heights,
  pathOf = elementPath,
  targetOf,
} = {}) {
  const map = (after) =>
    makeMap({
      elements: Object.fromEntries(
        Array.from({ length: count }, (_, offset) => {
          const index = offset + 1;
          return [
            pathOf(index),
            {
              tag: 'h2',
              cls: 'card-title',
              rect: [20, overlap || index <= overlapCount ? 20 : index * 90, 180, 20],
              style: {
                ...(heights ? { height: `${after ? heights[offset] : 20}px` } : {}),
                color:
                  after && !states
                    ? different && index === 3
                      ? 'rgb(0, 128, 0)'
                      : 'rgb(150, 30, 60)'
                    : 'rgb(30, 60, 120)',
              },
            },
          ];
        }),
      ),
      states: states
        ? Object.fromEntries(
            Array.from({ length: count }, (_, offset) => {
              const owner = pathOf(offset + 1);
              const target = targetOf ? targetOf(owner, offset + 1) : owner;
              return [
                owner,
                {
                  hover: { [target]: { 'background-color': after ? 'rgb(255, 0, 0)' : 'rgb(0, 0, 255)' } },
                  focus: { [owner]: { 'outline-width': after ? '3px' : '1px' } },
                },
              ];
            }),
          )
        : {},
    });
  const captureMap = (after) => {
    const result = map(after);
    if (targetOf)
      for (let index = 1; index <= count; index++) {
        const target = targetOf(pathOf(index), index);
        result.elements[target] = { tag: 'span', cls: '', rect: [20, index * 90, 20, 20], style: {} };
      }
    return result;
  };
  const dirs = pairFixture({
    surface: 'cards@390',
    before: captureMap(false),
    after: captureMap(true),
    beforePng: solidPng(390, 1200),
    afterPng: solidPng(390, 1200, [150, 30, 60]),
  });
  if (states)
    for (const directory of [dirs.beforeDir, dirs.afterDir])
      for (const state of ['hover', 'focus']) {
        fs.writeFileSync(`${directory}/cards@390.${state}.png`, solidPng(390, 1200));
      }
  try {
    const result = generateStyleMapReport({ ...dirs, maxCrops, maxCropFiles });
    return {
      md: fs.readFileSync(result.reportMdPath, 'utf8'),
      json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
    };
  } finally {
    rmTmp(dirs.root);
  }
}

const sections = (md) => md.match(/^### /gm) ?? [];
const signatureCount = (findings) => new Set(findings.map((finding) => elementChangeSignature([finding]))).size;

test('identical separated elements have one representative section, element list and property table', () => {
  const { md, json } = render();
  assert.equal(sections(md).length, 1);
  assert.match(md, /### \*\*Card title\*\* `h2.card-title` · 3 elements restyled/);
  assert.match(md, /Showing 1 of 3 elements for the grouped change above\./);
  assert.match(md, /- `article:nth-child\(1\) > h2` \(shown\)/);
  assert.match(md, /- `article:nth-child\(3\) > h2`/);
  assert.equal((md.match(/\| `color` \|/g) ?? []).length, 1);
  const regions = json.surfaces[0].regions;
  assert.equal(regions.length, 3);
  assert.deepEqual(regions[0].paths, [elementPath(1)]);
  assert.equal(json.surfaces[0].sections[0].representativePath, elementPath(1));
  assert.equal(json.surfaces[0].sections[0].elements.length, 3);
  assert.deepEqual(json.counts, { dom: 0, style: 3, state: 0 });
});

test('different before/after values remain separate sections', () => {
  const { md } = render({ different: true });
  assert.equal(sections(md).length, 2);
});

test('identical state bundles share one heading, one list and one property table', () => {
  const { md, json } = render({ states: true });
  assert.equal(sections(md).length, 1);
  assert.match(md, /### .*3 elements.*`:hover`, `:focus`/);
  assert.equal((md.match(/\(shown\)/g) ?? []).length, 1);
  assert.equal((md.match(/\| `background-color` \|/g) ?? []).length, 1);
  assert.equal((md.match(/\| `outline-width` \|/g) ?? []).length, 1);
  assert.equal((md.match(/\| State \| Property \|/g) ?? []).length, 1);
  assert.deepEqual(Object.keys(json.surfaces[0].regions[0].stateImages), ['hover', 'focus']);
  assert.match(json.surfaces[0].regions[0].stateImages.hover.composite, /-1-composite/);
  assert.match(json.surfaces[0].regions[0].stateImages.focus.composite, /-2-composite/);
  assert.equal(json.counts.state, 6);
});

test('element lists stay open through five, fold after five and truncate after ten', () => {
  const five = render({ count: 5 }).md;
  assert.doesNotMatch(five, /<summary>Elements/);
  const six = render({ count: 6 }).md;
  assert.match(six, /<details>\n<summary>Elements \(6\)<\/summary>/);
  const { md } = render({ count: 12 });
  assert.match(md, /<summary>Elements \(12\)<\/summary>/);
  assert.equal((md.match(/^- `article:nth-child/gm) ?? []).length, 10);
  assert.match(md, /… and 2 more/);
});

test('overlap regions keep their crop and collapse identical glance lines without a multiplier', () => {
  const { md, json } = render({ overlap: true });
  assert.equal(sections(md).length, 1);
  assert.equal(json.surfaces[0].regions[0].paths.length, 3);
  assert.match(md, /`color` `#1e3c78` → `#961e3c`/);
  assert.doesNotMatch(md, /×3/);
});

test('glance collapse preserves different values and pseudo/state prefixes', () => {
  const findings = [
    change(1),
    change(2),
    change(3, { pseudo: '::before' }),
    change(4, {
      props: [{ prop: 'color', before: 'black', after: 'green' }],
    }),
  ];
  assert.equal(propertyGlanceLine(findings).split('<br>\n').length, 3);
  assert.doesNotMatch(propertyGlanceLine(findings), /×2/);
});

test('element identity ignores paths and property ordering but retains labels, kinds, pseudo and state targets', () => {
  const properties = [
    { prop: 'color', before: 'black', after: 'red' },
    { prop: 'opacity', before: '1', after: '0.5' },
  ];
  assert.equal(signatureCount([change(1, { props: properties }), change(2, { props: [...properties].reverse() })]), 1);
  const state = (index, overrides = {}) => ({
    kind: 'state',
    path: elementPath(index),
    sub: elementPath(index),
    cls: 'card-title',
    state: 'hover',
    props: properties,
    ...overrides,
  });
  assert.equal(signatureCount([state(1), state(2)]), 1);
  assert.equal(
    signatureCount([
      state(1, { sub: `${elementPath(1)} > span:nth-child(1)` }),
      state(2, { sub: `${elementPath(2)} > span:nth-child(2)` }),
    ]),
    2,
  );
  assert.equal(signatureCount([state(1), state(2, { state: 'focus' })]), 2);
  assert.equal(signatureCount([state(1), state(2, { sub: `${elementPath(2)} > span` })]), 2);
  assert.equal(
    signatureCount([change(1), change(2, { cls: 'other' }), change(3, { pseudo: '::before' }), state(4)]),
    4,
  );
});

test('equal grid track counts with different summarized values stay separate', () => {
  const grid = (index, before) =>
    change(index, { props: [{ prop: 'grid-template-columns', before, after: '120px 120px' }] });
  assert.equal(signatureCount([grid(1, '80px 80px'), grid(2, '100px 100px')]), 2);
});

test('a representative region preserves the existing crop budget omission field', () => {
  const { json } = render({ maxCropFiles: 0 });
  assert.equal(json.surfaces[0].regions[0].cropOmitted, 'budget');
  assert.equal(json.surfaces[0].sections[0].elements.length, 3);
});

test('folded height rows survive for every grouped element, including non-representatives', () => {
  for (const heights of [
    [20, 22, 20],
    [21, 22, 23],
  ]) {
    const { md } = render({ heights });
    assert.equal(sections(md).length, 1);
    assert.doesNotMatch(md, /Folded size\/position rows outside the crops/);
    assert.equal((md.match(/\| `height` \|/g) ?? []).length, heights.filter((height) => height !== 20).length);
    for (const height of heights.filter((height) => height !== 20))
      assert.ok(md.includes(`| \`20px\` | \`${height}px\` |`));
    assert.doesNotMatch(md, /the other 2 changed identically/);
  }
});

test('different relative state targets stay separate even with the same tag and values', () => {
  const { md } = render({ count: 2, states: true, targetOf: (owner, index) => `${owner} > span:nth-child(${index})` });
  assert.equal(sections(md).length, 4);
});

test('identical overlapping and separated regions share one counted section and element list', () => {
  for (const states of [false, true])
    for (const options of [{ overlap: true }, { overlapCount: 2 }]) {
      const { md, json } = render({ states, ...options });
      assert.equal(sections(md).length, 1);
      assert.match(md, /### .* · 3 elements restyled/);
      assert.equal((md.match(/^- `article:nth-child/gm) ?? []).length, 3);
      assert.equal(json.surfaces[0].sections[0].paths.length, 3);
      assert.equal(json.surfaces[0].sections[0].elements.length, 3);
      assert.equal((md.match(/\(shown\)/g) ?? []).length, options.overlap ? 3 : 2);
      if (states) assert.deepEqual(Object.keys(json.surfaces[0].regions[0].stateImages), ['hover', 'focus']);
    }
});

test('mixed-change overlap regions retain the existing section behavior', () => {
  const { md, json } = render({ overlap: true, different: true });
  assert.equal(sections(md).length, 1);
  assert.equal(json.surfaces[0].regions[0].paths.length, 3);
  assert.equal(json.surfaces[0].regions[0].elements, undefined);
});

test('path tails are the shortest unique suffix across the whole element list', () => {
  const pathOf = (index) => `html > body > section:nth-child(${index}) > article > h2`;
  const { md } = render({ pathOf });
  for (let index = 1; index <= 3; index++) assert.ok(md.includes(`- \`section:nth-child(${index}) > article > h2\``));
  assert.doesNotMatch(md, /- `html/);
  const long = render({ count: 12, pathOf }).md;
  assert.ok(long.includes('- `section:nth-child(10) > article > h2`'));
  assert.match(long, /… and 2 more/);
});

test('JSON sections retain every covered element and identify the representative separately', () => {
  const { json } = render();
  assert.deepEqual(json.surfaces[0].sections[0].paths, [1, 2, 3].map(elementPath));
  assert.equal(json.surfaces[0].sections[0].representativePath, elementPath(1));
});

test('omitted representative crops never mark elements as shown', () => {
  const { md, json } = render({ maxCropFiles: 0 });
  assert.doesNotMatch(md, /\(shown\)|<sub>Showing/);
  assert.deepEqual(json.surfaces[0].sections[0].cropPaths, []);
});

test('grouped folded rows stay inside their section and identify each element by its list tail', () => {
  const { md } = render({ heights: [21, 22, 23] });
  assert.equal(sections(md).length, 1);
  assert.doesNotMatch(md, /Folded size\/position rows outside the crops/);
  for (let index = 1; index <= 3; index++) {
    const label = `**\`article:nth-child(${index}) > h2\`**`;
    const start = md.indexOf(label);
    assert.ok(start >= 0, label);
    const end = md.indexOf('**`article:nth-child(', start + label.length);
    const element = md.slice(start, end < 0 ? undefined : end);
    assert.ok(element.includes(`| \`20px\` | \`${20 + index}px\` |`));
    for (const other of [21, 22, 23].filter((height) => height !== 20 + index))
      assert.ok(!element.includes(`| \`${other}px\` |`));
  }
});

test('DOM grouping retains retag detail and React component identity independently', () => {
  const dom = (index, extra = {}) => ({
    kind: 'dom',
    path: elementPath(index),
    cls: 'label',
    change: 'retagged',
    detail: 'div → span',
    component: { name: 'PromoLabel', props: { size: 'small' } },
    ...extra,
  });
  assert.equal(signatureCount([dom(1), dom(2, { detail: 'p → span' })]), 2);
  assert.equal(signatureCount([dom(1), dom(2, { component: { name: 'AdLabel', props: { size: 'small' } } })]), 2);
  assert.equal(signatureCount([dom(1), dom(2, { component: { name: 'PromoLabel', props: { size: 'large' } } })]), 2);
  assert.equal(signatureCount([dom(1), dom(2)]), 1);
});

test('legacy JSON region membership and boxes remain per original region with additive sections', () => {
  const { json } = render();
  const surface = json.surfaces[0];
  assert.equal(surface.regions.length, 3);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(surface.regions[index].paths, [elementPath(index + 1)]);
    assert.equal(surface.regions[index].before.y, (index + 1) * 90 - 12);
    assert.deepEqual(surface.regions[index].before, surface.regions[index].after);
    assert.ok(surface.regions[index].images.composite);
    assert.match(surface.regions[index].images.composite, new RegExp(`-${index + 1}-composite`));
  }
  assert.equal(surface.sections.length, 1);
  assert.deepEqual(surface.sections[0].regionIndexes, [0, 1, 2]);
  assert.deepEqual(surface.sections[0].paths, [1, 2, 3].map(elementPath));
});

test('glance lines use no element multiplier for either separated or overlapping sections', () => {
  const single = propertyGlanceLine([change(1)]);
  assert.equal(propertyGlanceLine([change(1), change(2), change(3)]), single);
  for (const overlap of [false, true]) {
    const { md } = render({ overlap });
    assert.doesNotMatch(md.split('Showing')[0], /×3/);
    assert.match(md, /3 elements restyled/);
  }
});

test('JSON retains the original crop-cap union even when a section uses a smaller representative frame', () => {
  const { json } = render({ maxCrops: 2 });
  const surface = json.surfaces[0];
  assert.equal(surface.regions.length, 1);
  assert.deepEqual(surface.regions[0].paths, [1, 2, 3].map(elementPath));
  assert.deepEqual(surface.regions[0].before, { x: 8, y: 78, w: 204, h: 224 });
  assert.ok(surface.regions[0].images.composite);
  assert.deepEqual(surface.sections[0].before, { x: 8, y: 78, w: 204, h: 44 });
  assert.deepEqual(surface.sections[0].regionIndexes, [0]);
});

test('retagged elements keep both source tags and both React components in the rendered report', () => {
  const paths = [1, 2].map((index) => `html > body > section:nth-child(${index}) > span`);
  const map = (after) =>
    makeMap({
      elements: Object.fromEntries(
        paths.map((path, index) => [
          path,
          {
            tag: after ? 'span' : index === 0 ? 'div' : 'p',
            cls: 'label',
            rect: [20, 100 + index * 200, 100, 20],
            style: {},
            ...(after ? { component: { name: index === 0 ? 'PromoLabel' : 'AdLabel' } } : {}),
          },
        ]),
      ),
    });
  const dirs = pairFixture({
    surface: 'labels@390',
    before: map(false),
    after: map(true),
    beforePng: solidPng(390, 800),
    afterPng: solidPng(390, 800),
  });
  try {
    const result = generateStructuralStyleMapReportForTesting(dirs);
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    assert.equal(sections(md).length, 2);
    assert.ok(md.includes('&lt;div&gt; → &lt;span&gt;'));
    assert.ok(md.includes('&lt;p&gt; → &lt;span&gt;'));
    assert.ok(md.includes('React component: `PromoLabel`'));
    assert.ok(md.includes('React component: `AdLabel`'));
  } finally {
    rmTmp(dirs.root);
  }
});
