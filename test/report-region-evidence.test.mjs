import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { elementPathTails, renderCropChanges } from '../dist/report/markdown.js';
import { makeMap, pairFixture, rmTmp, solidPng } from './helpers.mjs';

function reportPair(context, before, after, options = {}) {
  const directories = pairFixture({
    surface: 'evidence@600',
    before,
    after,
    beforePng: solidPng(600, 1800),
    afterPng: solidPng(600, 1800, [240, 240, 240]),
  });
  context.after(() => rmTmp(directories.root));
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
  assert.equal(report.surfaces[0].regions[0].cropFallback, 'top-most');
  const image = PNG.sync.read(
    fs.readFileSync(path.join(directories.outDir, report.surfaces[0].regions[0].images.annotated)),
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
  assert.equal(report.surfaces[0].regions[0].elements, undefined);
  assert.equal(report.surfaces[0].regions[0].paths.length, 2);
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
    fs.readFileSync(path.join(directories.outDir, report.surfaces[0].regions[0].images.annotated)),
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
  assert.equal(report.surfaces[0].regions[0].elements, undefined);
  assert.ok(report.surfaces[0].regions[0].paths.includes('body > p'));
});

test('a separate hidden addition does not force visible regions to collapse at the crop cap', (context) => {
  const map = (head) =>
    mapOf({
      'body > h2': element('h2', 'title', [40, 100, 100, 30], { color: head ? 'red' : 'blue' }),
      'body > h3': element('h3', 'subtitle', [40, 300, 100, 30], { color: head ? 'green' : 'blue' }),
      ...(head ? { 'body > p': element('p', 'copy', [40, 10, 100, 10], { visibility: 'hidden' }) } : {}),
    });
  const { report } = reportPair(context, map(false), map(true), { maxCrops: 2 });
  assert.equal(report.surfaces[0].regions.length, 3);
  assert.equal(report.surfaces[0].regions.filter((region) => region.images.composite).length, 2);
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
