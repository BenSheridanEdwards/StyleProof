import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { propertyGlanceLine } from '../dist/report/markdown.js';
import { makeMap, pairFixture, rmTmp, solidPng, writeCapture } from './helpers.mjs';

function fixture(
  t,
  {
    count = 3,
    positions,
    different = false,
    states = false,
    elementPaths,
    foldedWidths = false,
    extra = {},
    options = {},
  } = {},
) {
  const paths =
    elementPaths ?? Array.from({ length: count }, (_, index) => `body > article:nth-child(${index + 1}) > h2`);
  const map = (head) => ({
    ...makeMap({
      elements: Object.fromEntries(
        paths.map((elementPath, index) => [
          elementPath,
          {
            tag: 'h2',
            cls: 'card-title',
            rect: [40, positions?.[index] ?? 40 + index * 130, 150, 35],
            style: states
              ? {}
              : {
                  ...(foldedWidths ? { width: head ? `${30 + index}px` : '20px' } : {}),
                  color: head ? (different && index === 1 ? 'rgb(0, 128, 0)' : 'rgb(150, 30, 60)') : 'rgb(30, 60, 120)',
                },
          },
        ]),
      ),
      states: states
        ? Object.fromEntries(
            paths.map((elementPath) => [
              elementPath,
              {
                hover: { [elementPath]: { 'background-color': head ? 'red' : 'blue' } },
                focus: { [elementPath]: { 'outline-color': head ? 'black' : 'white' } },
              },
            ]),
          )
        : {},
    }),
    viewport: { width: 600, height: 400 },
  });
  const dirs = pairFixture({
    surface: 'home@600',
    before: map(false),
    after: map(true),
    beforePng: solidPng(600, 1800),
    afterPng: solidPng(600, 1800, [240, 240, 240]),
  });
  t.after(() => rmTmp(dirs.root));
  if (states)
    for (const dir of [dirs.beforeDir, dirs.afterDir])
      for (const state of ['hover', 'focus']) {
        fs.writeFileSync(path.join(dir, `home@600.${state}.png`), solidPng(600, 1800));
      }
  const result = generateReport({ ...dirs, ...extra, ...options });
  return {
    paths,
    dirs,
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

const sections = (md) => md.match(/^### /gm) ?? [];

test('identical separated elements share one section, union crop and property table', (t) => {
  const { md, json, paths, dirs } = fixture(t);
  assert.equal(sections(md).length, 1);
  assert.match(md, /### \*\*Card title\*\* `h2.card-title` · 3 elements restyled/);
  assert.match(md, /All 3 changed elements are marked\./);
  assert.match(md, /<summary>3 elements<\/summary>/);
  for (let index = 1; index <= 3; index++) assert.ok(md.includes(`- \`article:nth-child(${index}) > h2\``));
  assert.equal((md.match(/\| `color` \|/g) ?? []).length, 1);
  assert.equal((md.match(/`color` `#1e3c78` → `#961e3c`/g) ?? []).length, 1);
  const region = json.surfaces[0].regions[0];
  assert.deepEqual(region.paths, paths);
  assert.equal(region.after.h, 319);
  const image = PNG.sync.read(fs.readFileSync(path.join(dirs.outDir, region.images.annotated)));
  // Each separated element contributes magenta pixels in its own horizontal band.
  for (const row of [32, 162, 292]) {
    assert.ok(
      Array.from({ length: image.width }, (_, x) => (row * image.width + x) * 4).some(
        (offset) => image.data[offset] === 255 && image.data[offset + 1] === 0 && image.data[offset + 2] === 200,
      ),
    );
  }
});

test('different before/after values remain separate sections when regions do not overlap', (t) => {
  const { md } = fixture(t, { different: true });
  assert.equal(sections(md).length, 2);
  assert.match(md, /2 elements restyled/);
  assert.match(md, /1 element restyled/);
});

test('matching state changes share one heading, two combined state crops and one table', (t) => {
  const { md, json } = fixture(t, { states: true });
  assert.equal(sections(md).length, 1);
  assert.match(md, /3 elements · `:hover`, `:focus`/);
  assert.equal((md.match(/\| State \| Property \|/g) ?? []).length, 1);
  assert.equal((md.match(/All 3 changed elements are marked\./g) ?? []).length, 4);
  const region = json.surfaces[0].regions[0];
  assert.deepEqual(Object.keys(region.stateImages), ['hover', 'focus']);
  assert.match(region.stateImages.hover.composite, /-1-composite.png$/);
  assert.match(region.stateImages.focus.composite, /-2-composite.png$/);
});

test('an unreadable union uses the top-most crop and tells the reviewer', (t) => {
  const { md, json } = fixture(t, { positions: [1400, 40, 700] });
  assert.equal(sections(md).length, 1);
  assert.match(md, /Top-most of 3 changed elements is marked.*combined crop would be unreadable/);
  assert.equal(json.surfaces[0].regions[0].cropFallback, 'top-most');
  assert.equal(json.surfaces[0].regions[0].after.h, 1419, 'JSON retains the union geometry');
});

test('crop dimension limits also trigger the readable fallback', (t) => {
  const { md } = fixture(t, { options: { maxHeight: 100 } });
  assert.match(md, /Top-most of 3 changed elements is marked/);
});

test('the folded element list stops at ten and counts the rest', (t) => {
  const { md } = fixture(t, { count: 12 });
  assert.match(md, /<summary>12 elements<\/summary>/);
  assert.equal((md.match(/^- `article:nth-child/gm) ?? []).length, 10);
  assert.match(md, /… and 2 more/);
});

test('identical glance lines collapse without a count while distinct states stay visible', () => {
  const findings = ['first', 'second', 'third'].map((elementPath) => ({
    kind: 'style',
    path: elementPath,
    cls: '',
    pseudo: null,
    props: [{ prop: 'padding', before: '16px', after: '24px' }],
  }));
  assert.equal(propertyGlanceLine(findings), '`padding` `16px` → `24px`');
  assert.match(
    propertyGlanceLine([
      { ...findings[0], kind: 'state', state: 'hover' },
      { ...findings[1], kind: 'state', state: 'focus' },
    ]),
    /`:hover`.*<br>\n`:focus`/,
  );
});

test('element grouping retains kind, label, pseudo, state and summarized values', async () => {
  const { groupByElementChange } = await import('../dist/findings-clean.js');
  const first = {
    kind: 'style',
    path: 'body > h2:nth-child(1)',
    cls: 'title',
    pseudo: null,
    props: [{ prop: 'color', before: 'red', after: 'blue' }],
  };
  const second = { ...first, path: 'body > article > h2:nth-child(2)' };
  assert.equal(groupByElementChange([first, second]).length, 1);
  for (const changed of [
    { ...second, cls: 'subtitle' },
    { ...second, path: 'body > h3' },
    { ...second, pseudo: '::before' },
    { ...second, kind: 'state', state: 'hover', sub: second.path },
    { ...second, props: [{ prop: 'color', before: 'black', after: 'blue' }] },
    { ...second, props: [{ prop: 'color', before: 'red', after: 'green' }] },
  ])
    assert.equal(groupByElementChange([first, changed]).length, 2);
  const hover = { ...first, kind: 'state', state: 'hover', sub: first.path };
  assert.equal(groupByElementChange([hover, { ...hover, path: second.path, sub: second.path }]).length, 1);
  assert.equal(
    groupByElementChange([hover, { ...hover, path: second.path, sub: second.path, state: 'focus' }]).length,
    2,
  );
  const grid = { ...first, props: [{ prop: 'grid-template-columns', before: '100px 100px', after: '120px 120px' }] };
  assert.equal(
    groupByElementChange([
      grid,
      { ...second, props: [{ prop: 'grid-template-columns', before: '200px 200px', after: '220px 220px' }] },
    ]).length,
    2,
  );
  const shorthand = { ...first, props: [{ prop: 'padding', before: '16px', after: '24px' }] };
  const longhands = {
    ...second,
    props: ['top', 'right', 'bottom', 'left'].map((side) => ({
      prop: `padding-${side}`,
      before: '16px',
      after: '24px',
    })),
  };
  assert.equal(groupByElementChange([shorthand, longhands]).length, 1);
});

test('different semantic sections respect the crop count cap without combining their changes', (t) => {
  const { md, json } = fixture(t, { different: true, options: { maxCrops: 1 } });
  assert.equal(sections(md).length, 2);
  assert.equal(json.surfaces[0].regions.filter((region) => region.images.composite).length, 1);
  assert.match(md, /Crop omitted: this surface reached the `--max-crops` limit/);
  assert.equal((md.match(/\| `color` \|/g) ?? []).length, 2);
});

test('a combined section keeps its list and values when the image budget is exhausted', (t) => {
  const { md, json } = fixture(t, { options: { maxCropFiles: 0 } });
  assert.match(md, /crop budget/);
  assert.match(md, /<summary>3 elements<\/summary>/);
  assert.match(md, /\| `color` \|/);
  assert.deepEqual(json.surfaces[0].regions[0].images, {});
});

test('separated page areas fall back even below the union height threshold', (t) => {
  const { md, json } = fixture(t, { positions: [40, 600, 620] });
  assert.ok(json.surfaces[0].regions[0].after.h < 1000);
  assert.match(md, /Top-most of 3 changed elements is marked/);
});

test('a shared property table is not repeated when the original property order differs', async () => {
  const { renderCropChanges } = await import('../dist/report/markdown.js');
  const props = [
    { prop: 'color', before: 'red', after: 'blue' },
    { prop: 'padding', before: '16px', after: '24px' },
  ];
  const findings = [
    { kind: 'style', path: 'body > h2:nth-child(1)', cls: 'title', pseudo: null, props },
    { kind: 'style', path: 'body > h2:nth-child(2)', cls: 'title', pseudo: null, props: [...props].reverse() },
  ];
  const markdown = renderCropChanges(findings, Infinity, {}).join('\n');
  assert.equal((markdown.match(/\| Property \| Before \| After \|/g) ?? []).length, 1);
  assert.match(markdown, /×2/);
});

test('folded descendant states do not inflate the combined heading element count', (t) => {
  const owners = [1, 2, 3].map((index) => `body > button:nth-child(${index})`);
  const map = (head) =>
    makeMap({
      elements: Object.fromEntries(
        owners.flatMap((owner, index) => [
          [owner, { tag: 'button', cls: 'btn', rect: [20, 40 + index * 100, 150, 40], style: {} }],
          [
            `${owner} > span`,
            { tag: 'span', cls: 'measure', rect: [25, 45 + index * 100, 40, 20], style: { width: '40px' } },
          ],
        ]),
      ),
      states: Object.fromEntries(
        owners.flatMap((owner) => [
          [owner, { hover: { [owner]: { 'background-color': head ? 'red' : 'blue' } } }],
          [`${owner} > span`, { hover: { [`${owner} > span`]: { width: head ? '50px' : '40px' } } }],
        ]),
      ),
    });
  const dirs = pairFixture({ surface: 'home@600', before: map(false), after: map(true) });
  t.after(() => rmTmp(dirs.root));
  const result = generateReport(dirs);
  const markdown = fs.readFileSync(result.reportMdPath, 'utf8');
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.match(markdown, /### \*\*Btn\*\* `button.btn` · 3 elements · `:hover`/);
  assert.deepEqual(report.counts, { dom: 0, style: 0, state: 3 });
  assert.match(markdown, /size\/position rows folded/);
  assert.match(markdown, /`width`/);
  const covered = report.surfaces[0].regions[0].paths;
  for (const owner of owners) assert.ok(covered.includes(`${owner} > span`));
});

test('different full relative state targets never collapse to the same tag', async () => {
  const { groupByElementChange } = await import('../dist/findings-clean.js');
  const owner = 'body > button:nth-child(1)';
  const other = 'body > button:nth-child(2)';
  const finding = {
    kind: 'state',
    path: owner,
    cls: 'btn',
    state: 'hover',
    sub: `${owner} > span:nth-child(1) > em`,
    props: [{ prop: 'color', before: 'red', after: 'blue' }],
  };
  assert.equal(
    groupByElementChange([finding, { ...finding, path: other, sub: `${other} > span:nth-child(2) > em` }]).length,
    2,
  );
  assert.equal(
    groupByElementChange([finding, { ...finding, path: other, sub: `${other} > span:nth-child(1) > em` }]).length,
    1,
  );
});

test('element tails are the shortest suffix unique among every section member', (t) => {
  const elementPaths = ['body > main > article > h2', 'body > aside > article > h2', 'body > footer > h2'];
  const { md } = fixture(t, { elementPaths });
  for (const tail of ['main > article > h2', 'aside > article > h2', 'footer > h2'])
    assert.ok(md.includes(`- \`${tail}\``));
  assert.ok(!md.includes('- `article > h2`'));
});

test('non-representative elements retain their distinct folded geometry rows', (t) => {
  const { md } = fixture(t, { foldedWidths: true });
  assert.match(md, /3 elements restyled/);
  assert.match(md, /3 size\/position rows folded/);
  for (const width of ['30px', '31px', '32px']) assert.ok(md.includes(`| \`width\` | \`20px\` | \`${width}\` |`));
});

test('nearby identical state changes share one counted section and list', (t) => {
  const { md, json, paths } = fixture(t, { states: true, positions: [40, 45, 50] });
  assert.equal(sections(md).length, 1);
  assert.match(md, /3 elements · `:hover`, `:focus`/);
  assert.match(md, /<summary>3 elements<\/summary>/);
  assert.deepEqual(json.surfaces[0].regions[0].paths, paths);
});

test('a mixed overlap region preserves main layout instead of combining across its boundary', (t) => {
  const { md, json } = fixture(t, { different: true, positions: [40, 45, 50] });
  assert.equal(json.surfaces[0].regions.length, 1);
  assert.match(md, /\+ 2 more/);
  assert.doesNotMatch(md, /<summary>3 elements<\/summary>/);
});

test('folded grid values cannot claim identical surfaces just because track counts match', (t) => {
  const { dirs } = fixture(t, { states: true });
  const make = (width, head) =>
    makeMap({
      elements: { button: { tag: 'button', cls: 'btn', rect: [10, 20, 100, 30], style: {} } },
      states: {
        button: {
          hover: {
            button: {
              color: head ? 'red' : 'blue',
              'grid-template-columns': head ? `${width}px ${width}px` : '50px 50px',
            },
          },
        },
      },
    });
  for (const width of [600, 900]) {
    writeCapture(dirs.beforeDir, `other@${width}`, make(width, false));
    writeCapture(dirs.afterDir, `other@${width}`, make(width, true));
  }
  const result = generateReport(dirs);
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.ok(md.includes('`600px ×2`') && md.includes('`900px ×2`'), md);
  assert.doesNotMatch(md, /Identical across 2 surfaces/);
});
