import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStructuralStyleMapReportForTesting } from '../dist/report.js';
import { elementChangeSignature } from '../dist/report/identical-elements.js';
import { propertyGlanceLine } from '../dist/report/markdown.js';
import { makeMap, pairFixture, rmTmp, solidPng } from './helpers.mjs';
import { elementPath, render } from './report-grouped-fixture.mjs';

const change = (index, extra = {}) => ({
  kind: 'style',
  path: elementPath(index),
  cls: 'card-title',
  pseudo: null,
  props: [{ prop: 'color', before: 'rgb(30, 60, 120)', after: 'rgb(150, 30, 60)' }],
  ...extra,
});

const sections = (md) => md.match(/^### /gm) ?? [];
const signatureCount = (findings) => new Set(findings.map((finding) => elementChangeSignature([finding]))).size;

test('a missing focus screenshot preserves state findings, the shared table and available hover evidence', () => {
  const { md: markdown, json: report } = render({ states: true, missingStateScreenshot: 'focus' });
  const surface = report.surfaces[0];
  assert.equal(sections(markdown).length, 1);
  assert.match(markdown, /3 elements.*`:hover`, `:focus`/);
  assert.match(markdown, /No :focus screenshot in these capture sets/);
  assert.equal((markdown.match(/\| `background-color` \|/g) ?? []).length, 1);
  assert.equal((markdown.match(/\| `outline-width` \|/g) ?? []).length, 1);
  assert.equal(report.counts.state, 6);
  assert.equal(surface.findings.filter((finding) => finding.state === 'focus').length, 3);
  assert.deepEqual(Object.keys(surface.sections[0].stateImages), ['hover']);
  for (const region of surface.regions) {
    assert.deepEqual(region.stateImages, surface.sections[0].stateImages);
    assert.ok(markdown.includes(region.images.composite));
  }
  assert.equal(report.cropBudget, undefined);
});

test('identical changes separated by another change share the earliest frame and correct legacy indexes', () => {
  const { md: markdown, json: report } = render({
    different: true,
    rectangleOf: (index) => [20, (index === 2 ? 3 : index === 3 ? 2 : 1) * 90, 180, 20],
  });
  const surface = report.surfaces[0];
  assert.equal(sections(markdown).length, 2);
  assert.deepEqual(
    surface.regions.map((region) => region.paths),
    [[elementPath(1)], [elementPath(3)], [elementPath(2)]],
  );
  assert.deepEqual(
    surface.sections.map((section) => section.regionIndexes),
    [[0, 2], [1]],
  );
  assert.deepEqual(surface.sections[0].paths, [elementPath(1), elementPath(2)]);
  assert.equal(surface.sections[0].representativePath, elementPath(1));
  assert.deepEqual(surface.regions[0].images, surface.regions[2].images);
  assert.notEqual(surface.regions[0].images.composite, surface.regions[1].images.composite);
  assert.match(markdown, /Showing 1 of 2 elements/);
  assert.equal(report.counts.style, 3);
});

test('legacy region image fields match the ungrouped renderer and reuse each section crop', () => {
  for (const states of [false, true]) {
    const baseline = render({ count: 1, states }).json.surfaces[0].regions[0];
    const surface = render({ states }).json.surfaces[0];
    const section = surface.sections[0];
    for (const region of surface.regions) {
      assert.deepEqual(Object.keys(region.images), Object.keys(baseline.images));
      assert.deepEqual(region.images, section.images);
      if (states) {
        assert.deepEqual(Object.keys(region.stateImages), Object.keys(baseline.stateImages));
        assert.deepEqual(region.stateImages, section.stateImages);
        for (const state of ['hover', 'focus'])
          assert.deepEqual(Object.keys(region.stateImages[state]), Object.keys(baseline.stateImages[state]));
      }
    }
  }
});

test('legacy regions retain the ungrouped field shape when crops are omitted by the budget', () => {
  const baseline = render({ count: 1, maxCropFiles: 0 }).json.surfaces[0].regions[0];
  const surface = render({ maxCropFiles: 0 }).json.surfaces[0];
  assert.equal(baseline.cropOmitted, 'budget');
  for (const region of surface.regions) {
    assert.deepEqual(Object.keys(region).sort(), Object.keys(baseline).sort());
    assert.equal(region.cropOmitted, baseline.cropOmitted);
    assert.deepEqual(region.images, surface.sections[0].images);
  }
});

test('legacy regions retain unrendered evidence and reason alongside available state images', () => {
  const options = { states: true, restingChange: true, screenshotHeight: 50 };
  const baseline = render({ ...options, count: 1 }).json.surfaces[0].regions[0];
  const surface = render(options).json.surfaces[0];
  assert.equal(baseline.visualEvidence, 'not-rendered');
  assert.ok(baseline.reason);
  for (const region of surface.regions) {
    assert.deepEqual(Object.keys(region).sort(), Object.keys(baseline).sort());
    assert.equal(region.visualEvidence, baseline.visualEvidence);
    assert.equal(region.reason, baseline.reason);
    assert.deepEqual(region.stateImages, surface.sections[0].stateImages);
  }
});

test('compact grouped summaries retain a crop link for resting and interactive changes', () => {
  for (const states of [false, true])
    for (const maxReportBytes of [1500, 2000, 2500]) {
      const { md: markdown, json: report } = render({
        count: 6,
        states,
        maxReportBytes,
        heights: [21, 22, 23, 24, 25, 26],
      });
      assert.match(markdown, /^- `cards@390` · \d+ change\(s\) — \[crop\]\(crops\//m);
      assert.ok(markdown.includes(report.surfaces[0].sections[0].images.composite));
      assert.ok(Buffer.byteLength(markdown) <= maxReportBytes);
    }
});

test('a compact summary uses an available section crop when the first legacy region has none', () => {
  const { md: markdown, json: report } = render({
    different: true,
    rectangleOf: (index) => (index < 3 ? [20, 20, 350, 1000] : [20, 1100, 20, 20]),
    maxCropBytes: 300,
    maxReportBytes: 1500,
  });
  const surface = report.surfaces[0];
  assert.equal(surface.regions[0].images.composite, undefined);
  const shown = surface.sections.find((section) => section.images.composite);
  assert.ok(shown);
  assert.ok(markdown.includes(`— [crop](${shown.images.composite})`));
});

test('state targets normalize only the owner itself or a descendant after a path separator', () => {
  const path = 'body > li';
  const state = (owner, target) => ({
    kind: 'state',
    path: owner,
    sub: target,
    cls: 'item',
    state: 'hover',
    props: [{ prop: 'color', before: 'blue', after: 'red' }],
  });
  const target = `${path}:nth-child(10) > span`;
  assert.equal(
    elementChangeSignature([state(path, target)]),
    elementChangeSignature([state(`${path}:nth-child(1)`, target)]),
    'an unrelated target must retain its full path for either owner',
  );
  assert.equal(
    signatureCount([state(path, `${path} > span`), state(`${path}:nth-child(1)`, `${path}:nth-child(1) > span`)]),
    1,
  );
});

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
  assert.deepEqual(Object.keys(json.surfaces[0].sections[0].stateImages), ['hover', 'focus']);
  assert.match(json.surfaces[0].sections[0].stateImages.hover.composite, /-1-composite/);
  assert.match(json.surfaces[0].sections[0].stateImages.focus.composite, /-2-composite/);
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
  assert.equal(json.surfaces[0].sections[0].cropOmitted, 'budget');
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
      if (states) assert.deepEqual(Object.keys(json.surfaces[0].sections[0].stateImages), ['hover', 'focus']);
    }
});

test('mixed-change overlap regions retain the existing section behavior', () => {
  const { md, json } = render({ overlap: true, different: true });
  assert.equal(sections(md).length, 1);
  assert.equal(json.surfaces[0].regions[0].paths.length, 3);
  assert.equal(json.surfaces[0].regions[0].elements, undefined);
  assert.equal(json.surfaces[0].sections, undefined);
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
    assert.deepEqual(surface.regions[index].images, surface.sections[0].images);
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
  assert.deepEqual(surface.regions[0].images, surface.sections[0].images);
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
