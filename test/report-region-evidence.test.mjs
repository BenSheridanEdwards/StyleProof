import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { elementPathTails, propertyGlanceLine, renderCropChanges } from '../dist/report/markdown.js';
import { renderChangeGroup } from '../dist/report/regions.js';
import { createMapLoader } from '../dist/report/shared.js';
import { createCropBudget } from '../dist/report/crop-budget.js';
import { emptyLiveTextAudit } from '../dist/live-text.js';
import { ReportMarkdown } from '../dist/report/sections.js';
import { makeMap, pairFixture, rmTmp, solidPng } from './helpers.mjs';

const displayedSections = (report) => report.surfaces[0].sections ?? report.surfaces[0].regions;

function reportPair(context, before, after, options = {}, stateLayers = []) {
  const directories = pairFixture({
    surface: 'evidence@600',
    before,
    after,
    beforePng: solidPng(600, 1800),
    afterPng: solidPng(600, 1800, [240, 240, 240]),
  });
  context.after(() => rmTmp(directories.root));
  for (const directory of [directories.beforeDir, directories.afterDir])
    for (const state of stateLayers)
      fs.writeFileSync(path.join(directory, `evidence@600.${state}.png`), solidPng(600, 1800));
  const result = generateReport({ ...directories, ...options });
  return {
    directories,
    markdown: fs.readFileSync(result.reportMdPath, 'utf8'),
    report: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

const element = (tag, classes, rectangle, style) => ({ tag, cls: classes, rect: rectangle, style });
const mapOf = (elements, states = {}) => ({ ...makeMap({ elements, states }), viewport: { width: 600, height: 400 } });

test('a fallback caption counts the nested elements actually outlined in its crop', (context) => {
  const paths = ['body > div', 'body > div > div', 'body > footer > div'];
  const map = (head) =>
    mapOf(
      Object.fromEntries(
        paths.map((elementPath, index) => [
          elementPath,
          element(
            'div',
            'card',
            [
              [40, 40, 300, 180],
              [60, 80, 100, 30],
              [40, 1400, 100, 30],
            ][index],
            { color: head ? 'red' : 'blue' },
          ),
        ]),
      ),
    );
  const { markdown, report, directories } = reportPair(context, map(false), map(true));
  assert.match(markdown, /The top-most crop marks 2 of 3 changed elements/);
  assert.equal(displayedSections(report)[0].cropFallback, 'top-most');
  const image = PNG.sync.read(
    fs.readFileSync(path.join(directories.outDir, displayedSections(report)[0].images.annotated)),
  );
  for (const [x, y] of [
    [32, 32],
    [52, 72],
  ]) {
    const offset = (y * image.width + x) * 4;
    assert.deepEqual([...image.data.subarray(offset, offset + 3)], [255, 0, 200]);
  }
});

test('mixed overlapping tags retain paths without advertising combined elements', (context) => {
  const map = (head) =>
    mapOf({
      'body > h2': element('h2', 'title', [40, 40, 100, 30], { color: head ? 'red' : 'blue' }),
      'body > p': element('p', 'copy', [40, 50, 100, 30], { color: head ? 'green' : 'blue' }),
    });
  const { report, markdown } = reportPair(context, map(false), map(true));
  assert.equal(displayedSections(report)[0].elements, undefined);
  assert.equal(displayedSections(report)[0].paths.length, 2);
  assert.match(markdown, /\+ 1 more/);
  assert.doesNotMatch(markdown, /<summary>2 elements<\/summary>/);
});

test('fallback counts use the saved crop bounds after a height cap', (context) => {
  const paths = ['body > div', 'body > div > div', 'body > footer > div'];
  const map = (head) =>
    mapOf(
      Object.fromEntries(
        paths.map((elementPath, index) => [
          elementPath,
          element(
            'div',
            'card',
            [
              [40, 40, 300, 180],
              [60, 50, 100, 20],
              [40, 1400, 100, 30],
            ][index],
            { color: head ? 'red' : 'blue' },
          ),
        ]),
      ),
    );
  const { markdown, report, directories } = reportPair(context, map(false), map(true), { maxHeight: 80 });
  assert.match(markdown, /The top-most crop marks 1 of 3 changed elements/);
  const image = PNG.sync.read(
    fs.readFileSync(path.join(directories.outDir, displayedSections(report)[0].images.annotated)),
  );
  assert.ok(image.height <= 120);
});

test('partly hidden matching elements get exposure counts without an outside-canvas claim', (context) => {
  for (const exposed of [1, 2]) {
    const paths = [1, 2, 3].map((index) => `body > h2:nth-child(${index})`);
    const map = (head) =>
      mapOf(
        Object.fromEntries(
          paths.map((elementPath, index) => [
            elementPath,
            element('h2', 'title', [40, 40 + index * 130, 100, 30], {
              color: head ? 'red' : 'blue',
              ...(index >= exposed ? { visibility: 'hidden' } : {}),
            }),
          ]),
        ),
      );
    const { markdown } = reportPair(context, map(false), map(true));
    assert.ok(
      markdown.includes(
        exposed === 1 ? 'The exposed changed element is marked.' : 'All 2 exposed changed elements are marked.',
      ),
    );
    assert.ok(
      markdown.includes(
        `${3 - exposed} of 3 elements ${exposed === 1 ? 'are' : 'is'} not exposed in the captured page.`,
      ),
    );
    assert.doesNotMatch(markdown, /outside the captured screenshot|combined crop would be unreadable/);
  }
});

test('a hidden addition in a mixed region keeps its missing-side evidence explicit', (context) => {
  const before = mapOf({ 'body > h2': element('h2', 'title', [40, 40, 100, 30], { color: 'blue' }) });
  const after = mapOf({
    'body > h2': element('h2', 'title', [40, 40, 100, 30], { color: 'red' }),
    'body > p': element('p', 'copy', [40, 50, 100, 30], { color: 'green', visibility: 'hidden' }),
  });
  const { markdown, report } = reportPair(context, before, after);
  assert.match(markdown, /1 of 2 elements is not exposed in the captured page/);
  assert.equal(displayedSections(report)[0].elements, undefined);
  assert.ok(displayedSections(report)[0].paths.includes('body > p'));
});

test('a separate hidden addition does not force visible regions to collapse at the crop cap', (context) => {
  const map = (head) =>
    mapOf({
      'body > h2': element('h2', 'title', [40, 100, 100, 30], { color: head ? 'red' : 'blue' }),
      'body > h3': element('h3', 'subtitle', [40, 300, 100, 30], { color: head ? 'green' : 'blue' }),
      ...(head ? { 'body > p': element('p', 'copy', [40, 10, 100, 10], { visibility: 'hidden' }) } : {}),
    });
  const { report } = reportPair(context, map(false), map(true), { maxCrops: 2 });
  assert.equal(displayedSections(report).length, 3);
  assert.equal(displayedSections(report).filter((region) => region.images.composite).length, 2);
});

test('an unsupported state capture still retains the property evidence below the comment cut', (context) => {
  const owner = 'body > button';
  const map = (head) =>
    mapOf(
      { [owner]: element('button', 'button', [40, 40, 100, 30], {}) },
      { [owner]: { press: { [owner]: { color: head ? 'red' : 'blue' } } } },
    );
  const { markdown } = reportPair(context, map(false), map(true));
  assert.match(markdown, /### /);
  assert.ok(markdown.includes('| `:press` | `color` | `blue` → `red` |'));
});

test('interactive currentColor followers remain visible under their primary property', () => {
  const markdown = renderCropChanges(
    [
      {
        kind: 'state',
        path: 'body > button',
        cls: 'button',
        state: 'hover',
        sub: 'body > button',
        props: [
          { prop: 'color', before: 'red', after: 'blue' },
          { prop: 'outline-color', before: 'red', after: 'blue' },
        ],
      },
    ],
    Infinity,
    {},
  ).join('\n');
  assert.ok(markdown.includes('↳ `outline-color` _(currentColor)_'));
  assert.ok(markdown.includes('`red` → `blue`'));
});

test('folded rows keep their full count when attribution reaches the table cap', () => {
  const folded = Array.from({ length: 42 }, (_, index) => ({
    kind: 'style',
    path: `body > h2:nth-child(${index + 1})`,
    cls: 'title',
    pseudo: null,
    props: [{ prop: 'width', before: '20px', after: '30px' }],
  }));
  const markdown = renderCropChanges([], Infinity, {}, folded).join('\n');
  assert.match(markdown, /42 size\/position rows folded/);
  assert.ok(markdown.includes('`h2:nth-child(40)`'));
  assert.ok(!markdown.includes('`h2:nth-child(41)`'));
  assert.match(markdown, /2 more size\/position rows folded/);
});

test('uncollapsible changed-element blocks retain an accurate capped remainder', () => {
  const findings = Array.from({ length: 41 }, (_, index) => ({
    kind: 'style',
    path: `body > h2:nth-child(${index + 1})`,
    cls: 'title',
    pseudo: null,
    props: [{ prop: 'color', before: 'red', after: `rgb(${index}, 1, 2)` }],
  }));
  const markdown = renderCropChanges(findings, Infinity, {}).join('\n');
  assert.match(markdown, /1 more element\(s\)/);
  assert.equal((markdown.match(/\| `color` \|/g) ?? []).length, 40);
});

test('a root path and its suffix collision keep unique full-path labels', () => {
  assert.deepEqual(
    [...elementPathTails(['h2', 'body > h2'])],
    [
      ['h2', 'h2'],
      ['body > h2', 'body > h2'],
    ],
  );
});

test('long matching values share one glance line while retaining the differing text', () => {
  for (const differingLength of [0, 200]) {
    const findings = [1, 2].map((index) => ({
      kind: 'style',
      path: `body > h2:nth-child(${index})`,
      cls: 'title',
      pseudo: null,
      props: [
        {
          prop: 'font-family',
          before: 'A'.repeat(100) + 'old-family' + 'x'.repeat(differingLength) + 'Z'.repeat(100),
          after: 'A'.repeat(100) + 'new-family' + 'y'.repeat(differingLength) + 'Z'.repeat(100),
        },
      ],
    }));
    const glance = propertyGlanceLine(findings);
    assert.ok(!glance.includes('<br>'), 'matching long values have one glance line');
    const values = glance
      .split('`')
      .filter((_, index) => index % 2 === 1)
      .slice(1);
    assert.equal(values.length, 2);
    assert.ok(values[0].includes('old-family'));
    assert.ok(values[1].includes('new-family'));
    assert.notEqual(values[0], values[1]);
    assert.ok(values.every((value) => value.startsWith('…') && value.endsWith('…') && value.length <= 98));
  }
});

test('equivalent displayed colours retain both member counts and currentColor rows', () => {
  const findings = ['#ff0000', 'rgb(255, 0, 0)'].map((before, index) => ({
    kind: 'style',
    path: `body > h2:nth-child(${index + 1})`,
    cls: 'title',
    pseudo: null,
    props: ['color', 'outline-color'].map((prop) => ({ prop, before, after: 'rgb(0, 0, 255)' })),
  }));
  const markdown = renderCropChanges(findings, Infinity, {}).join('\n');
  assert.match(markdown, /×2/);
  assert.equal(markdown.split('| `color` |').length - 1, 1);
  assert.ok(markdown.includes('↳ `outline-color` _(currentColor)_'));
});

test('added component metadata stays escaped beside the head-side property inventory', () => {
  const owner = 'body > article';
  const markdown = renderCropChanges(
    [
      { kind: 'dom', path: owner, cls: 'card', change: 'added', component: { name: 'Card', props: { label: 'a|b*' } } },
      {
        kind: 'style',
        path: owner,
        cls: 'card',
        pseudo: null,
        props: [{ prop: 'color', before: '(unset)', after: 'red' }],
      },
    ],
    Infinity,
    {},
  ).join('\n');
  assert.ok(markdown.includes('React component: `Card` (label=a\\|b\\*)'));
  assert.ok(markdown.includes('| Property | Value |'));
  assert.ok(!markdown.includes('| Before |'));
});

test('matching states keep one member list and table when only one state has screenshots', (context) => {
  const owners = ['body > button:nth-child(1)', 'body > button:nth-child(2)'];
  const map = (head) =>
    mapOf(
      Object.fromEntries(
        owners.map((owner, index) => [owner, element('button', 'action', [40, 40 + index * 130, 100, 30], {})]),
      ),
      Object.fromEntries(
        owners.map((owner) => [
          owner,
          {
            hover: { [owner]: { 'background-color': head ? 'red' : 'blue' } },
            focus: { [owner]: { 'outline-color': head ? 'black' : 'white' } },
          },
        ]),
      ),
    );
  const { markdown, report } = reportPair(context, map(false), map(true), {}, ['hover']);
  assert.equal(markdown.split('<summary>2 elements</summary>').length - 1, 1);
  assert.equal(markdown.split('| State | Property |').length - 1, 1);
  assert.ok(markdown.includes('2 elements · `:hover`, `:focus`'));
  assert.ok(markdown.includes('No :focus screenshot'));
  assert.ok(markdown.includes('| `:focus` | `outline-color` |'));
  assert.deepEqual(Object.keys(displayedSections(report)[0].stateImages), ['hover']);
  assert.ok(displayedSections(report)[0].stateImages.hover.composite);
  assert.equal(displayedSections(report)[0].stateImages.focus, undefined);
});

test('state crops omitted after a resting picture retain their changes and single member list', (context) => {
  const owners = ['body > button:nth-child(1)', 'body > button:nth-child(2)'];
  const map = (head) =>
    mapOf(
      Object.fromEntries(
        owners.map((owner, index) => [
          owner,
          element('button', 'action', [40, 40 + index * 130, 100, 30], { color: head ? 'red' : 'blue' }),
        ]),
      ),
      Object.fromEntries(
        owners.map((owner) => [owner, { hover: { [owner]: { 'background-color': head ? 'black' : 'white' } } }]),
      ),
    );
  const { markdown, report } = reportPair(context, map(false), map(true), { maxCropFiles: 2 }, ['hover']);
  assert.equal(markdown.split('<summary>2 elements</summary>').length - 1, 1);
  assert.ok(markdown.includes('crop budget'));
  assert.ok(markdown.includes('| `:hover` | `background-color` |'));
  assert.ok(displayedSections(report)[0].images.composite);
  assert.equal(displayedSections(report)[0].stateImages?.hover, undefined);
});

test('zero crop threshold unions different exposed state changes without combined metadata', (context) => {
  const owners = ['body > button:nth-child(1)', 'body > button:nth-child(2)'];
  const map = (head) =>
    mapOf(
      Object.fromEntries(
        owners.map((owner, index) => [owner, element('button', 'action', [40, 40 + index * 130, 100, 30], {})]),
      ),
      Object.fromEntries(
        owners.map((owner, index) => [
          owner,
          { hover: { [owner]: { 'background-color': head ? ['red', 'green'][index] : 'blue' } } },
        ]),
      ),
    );
  const { markdown, report } = reportPair(context, map(false), map(true), { maxCrops: 0 }, ['hover']);
  assert.equal(displayedSections(report).length, 1);
  assert.ok(displayedSections(report)[0].stateImages.hover.composite);
  assert.deepEqual(displayedSections(report)[0].paths, owners);
  assert.equal(displayedSections(report)[0].elements, undefined);
  assert.ok(markdown.includes('`blue` → `red`'));
  assert.ok(markdown.includes('`blue` → `green`'));
});

test('a prepared folded-only section keeps its rows without consuming crop numbering', (context) => {
  const owner = 'body > article';
  const map = (width) => mapOf({ [owner]: element('article', 'card', [40, 40, 100, 30], { width }) });
  const { directories } = reportPair(context, map('100px'), map('120px'));
  const sequence = { crop: 0 };
  const folded = [
    {
      kind: 'style',
      path: owner,
      cls: 'card',
      pseudo: null,
      props: [{ prop: 'width', before: '100px', after: '120px' }],
    },
  ];
  const result = renderChangeGroup(
    {
      ...directories,
      img: (relative) => relative,
      load: createMapLoader(),
      padBy: 12,
      minWidth: 320,
      minHeight: 120,
      maxHeight: 1600,
      zoomBelow: 0,
      maxCrops: 8,
      crops: createCropBudget(60, 5_000_000),
      foldDetailsAt: Infinity,
      liveText: emptyLiveTextAudit(),
      includeNoise: false,
      requireStateIdentity: false,
    },
    { surfaces: ['evidence@600'], rep: { sd: { surface: 'evidence@600' }, findings: [], folded }, findings: [] },
    sequence,
  );
  const markdown = result.md.join('\n');
  assert.ok(markdown.includes('size/position rows folded'));
  assert.ok(markdown.includes('| `width` | `100px` | `120px` |'));
  assert.equal(sequence.crop, 0);
  assert.deepEqual(result.json.regions, []);
  assert.ok(!markdown.includes('0 elements'));
});

test('combined section summaries fit the Markdown budget without dropping the evidence tail', () => {
  const markdown = new ReportMarkdown(1000);
  markdown.append(['## Changes']);
  for (let index = 1; index <= 5; index++)
    markdown.detail([`### Group ${index} · 3 elements`, 'property value '.repeat(60)], `- Group ${index} · 3 elements`);
  markdown.finish(['## Evidence', 'Source binding is unverified.']);
  const text = markdown.lines.join('\n');
  assert.ok(Buffer.byteLength(`${text}\n`) <= 1000);
  assert.ok(text.includes('display budget'));
  assert.ok(text.includes('Source binding is unverified.'));
  assert.equal(markdown.lines.filter((line) => line.startsWith('- Group ')).length, 5);
  assert.ok(!text.includes('property value'));
});

test('a tiny detail budget counts unlisted combined sections and names omitted evidence', () => {
  const markdown = new ReportMarkdown(400);
  markdown.append(['## Changes']);
  for (let index = 1; index <= 20; index++)
    markdown.detail([`### Group ${index} · 3 elements`, 'property value '.repeat(60)], `- Group ${index} · 3 elements`);
  markdown.finish(['## Evidence', 'A long capture warning. '.repeat(100)]);
  const text = markdown.lines.join('\n');
  assert.ok(Buffer.byteLength(`${text}\n`) <= 400);
  assert.ok(text.includes('Evidence (warnings & failures) omitted at the 400-byte display budget'));
  const omitted = Number(/…and (\d+) more section\(s\)/.exec(text)?.[1]);
  assert.ok(omitted > 0);
  assert.equal(markdown.lines.filter((line) => line.startsWith('- Group ')).length + omitted, 20);
});

test('a JSON findings cap preserves combined member paths even when its outline cannot fit', (context) => {
  const owners = ['body > h2:nth-child(1)', 'body > h2:nth-child(2)'];
  const map = (head) =>
    mapOf(
      Object.fromEntries(
        owners.map((owner, index) => [
          owner,
          element('h2', 'title', [40, 40 + index * 130, 100, 30], { color: head ? 'red' : 'blue' }),
        ]),
      ),
    );
  const { report, markdown } = reportPair(context, map(false), map(true), { maxJsonBytes: 1 });
  assert.equal(report.findingsBudget.listed, 0);
  assert.equal(report.findingsBudget.omitted, 2);
  assert.deepEqual(displayedSections(report)[0].paths, owners);
  assert.deepEqual(
    displayedSections(report)[0].elements,
    owners.map((elementPath) => ({ path: elementPath })),
  );
  assert.ok(markdown.includes('omitted from report.json at its byte budget'));
});
