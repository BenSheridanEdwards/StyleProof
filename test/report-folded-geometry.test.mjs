// Issue #1140: report.md must not silently fold authored size/position rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { foldedGeometryFindings, renderCropChanges } from '../dist/report/markdown.js';
import { cleanFindingsForDisplay, derivedLonghandCount } from '../dist/findings-clean.js';
import { makeMap, pairFixture, rmTmp, writeCapture } from './helpers.mjs';

const element = (tag, rect, style, cls = tag) => ({ tag, cls, rect, style });
const prop = (prop, before = '10px', after = '20px') => ({ prop, before, after });

const styleFinding = (props, pseudo = null, path = 'aside', cls = 'sidebar') =>
  Object.assign({ kind: 'style', path, cls, pseudo }, { props });

const asidePath = 'body > aside:nth-child(1)';
const withHover = (map, style) => ({ ...map, states: { [asidePath]: { hover: { [asidePath]: style } } } });

const elementsMap = (entries) => makeMap({ elements: Object.fromEntries(entries) });

const sidebar = (width, color) =>
  elementsMap([
    ['body', element('body', [0, 0, 1280, 800], {}, '')],
    [asidePath, element('aside', [0, 0, parseInt(width, 10), 800], { width, color }, 'sidebar')],
  ]);

const fixtureFor = (t, before, after) => {
  const fixture = pairFixture({ surface: 's@1280', before, after });
  t.after(() => rmTmp(fixture.root));

  return fixture;
};

const hoverMap = (changed, baseColor = 'black') =>
  withHover(sidebar(changed ? '280px' : '240px', baseColor), {
    color: changed ? 'red' : 'black',
    height: changed ? '90px' : '80px',
  });

test('#1140 a width change beside a colour change is shown or counted in report.md', (t) => {
  const fixture = fixtureFor(t, sidebar('240px', 'rgb(0, 0, 0)'), sidebar('280px', 'rgb(255, 0, 0)'));
  const res = generateStyleMapReport(fixture);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /color/, 'the colour row is shown');
  const shown = /\bwidth\b[^\n]*240px[^\n]*280px/.test(md);
  const counted = /\+?1 (derived longhand|size\/position)/.test(md);
  assert.ok(shown || counted, `report.md neither shows nor counts the folded width row:\n${md}`);
  assert.match(md.split(/^### /m)[0], /\+1 size\/position row folded/, 'the PR-comment digest includes the count');
  assert.match(
    md,
    /<details>[\s\S]*Folded size\/position rows:[\s\S]*\| `width` \| `240px` \| `280px` \|[\s\S]*<\/details>/,
  );
  const html = fs.readFileSync(res.reportMdPath.replace(/report\.md$/, 'report.html'), 'utf8');
  assert.match(html, /\+1 size\/position row folded/);
  assert.match(html, /<td><code>width<\/code><\/td>.*<td><code>240px<\/code><\/td>.*<td><code>280px<\/code><\/td>/);
});

test('folded counts match the CLI for base, pseudo and forced-state geometry', () => {
  const raw = [
    styleFinding([prop('width'), prop('color')]),
    styleFinding([prop('left')], '::before'),
    Object.assign(styleFinding([prop('top'), prop('grid-template-columns')]), {
      kind: 'state',
      sub: 'aside > span',
      state: 'hover',
    }),
  ];

  const shown = cleanFindingsForDisplay(raw);
  const folded = foldedGeometryFindings(raw, shown);
  const count = derivedLonghandCount(raw) - derivedLonghandCount(shown);
  assert.equal(count, 4);
  assert.equal(derivedLonghandCount(folded), count);
  const md = renderCropChanges(shown, Infinity, {}, folded).join('\n');
  assert.match(md, /\+4 size\/position rows folded/);
  assert.match(md, /On `::before`/);
  assert.match(md, /`:hover` \| `top` \| `10px` → `20px`/);
  assert.match(md, /<details>[\s\S]*Folded size\/position rows:[\s\S]*<\/details>/);
  assert.deepEqual(foldedGeometryFindings(raw, raw), [], 'includeNoise leaves no folded rows');
});

test('geometry restored by the display fallback is not labelled folded', () => {
  const raw = [styleFinding([prop('width', '240px', '280px')])];
  const shown = cleanFindingsForDisplay(raw);
  assert.deepEqual(foldedGeometryFindings(raw, shown), []);
  assert.doesNotMatch(renderCropChanges(shown, 0, {}).join('\n'), /rows? folded/);
});

test('folded geometry on a narrow surface prevents identical surface grouping', (t) => {
  const fixture = fixtureFor(t, sidebar('240px', 'black'), sidebar('240px', 'red'));
  writeCapture(fixture.beforeDir, 's@375', sidebar('240px', 'black'));
  writeCapture(fixture.afterDir, 's@375', sidebar('280px', 'red'));
  const md = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
  assert.match(md, /\| `width` \| `240px` \| `280px` \|/);
  assert.match(md.split(/^### /m)[0], /\+1 size\/position row folded/);
  assert.doesNotMatch(md, /Identical across 2 surfaces/);
  assert.match(md, /375/);
});

test('folded geometry stays under its own element crop', (t) => {
  const map = (changed) =>
    elementsMap([
      ['body', element('body', [0, 0, 1280, 1600], {}, '')],
      ...['aside', 'footer'].map((tag, i) => [
        `body > ${tag}:nth-child(${i + 1})`,
        element(tag, [0, i * 1000, 240, 100], {
          color: changed ? 'red' : 'black',
          width: `${(changed ? 280 : 240) + i}px`,
        }),
      ]),
    ]);

  const fixture = fixtureFor(t, map(false), map(true));
  const md = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
  const crops = md.split(/^### /m).slice(1);
  assert.equal(crops.length, 2);
  assert.match(crops[0], /`width` \| `240px` \| `280px`/);
  assert.doesNotMatch(crops[0], /`241px`/);
  assert.match(crops[1], /`width` \| `241px` \| `281px`/);
  assert.doesNotMatch(crops[1], /`240px`/);
});

test('folded-only details retain the full count while capping element tables', () => {
  const folded = Array.from({ length: 42 }, (_, i) =>
    styleFinding([prop('width', `${i}px`, `${i + 1}px`)], null, `aside:nth-child(${i + 1})`, ''),
  );

  const md = renderCropChanges([], Infinity, {}, folded).join('\n');
  assert.match(md, /\+42 size\/position rows folded/);
  assert.match(md, /and 2 more size\/position rows folded/);
  assert.equal((md.match(/\| `width`/g) ?? []).length, 40);
});

test('base and hover folded rows stay under their respective headings', (t) => {
  const map = (changed) => hoverMap(changed, changed ? 'red' : 'black');
  const fixture = fixtureFor(t, map(false), map(true));
  const md = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
  const sections = md.split(/^### /m).slice(1);
  assert.equal(sections.length, 2);
  assert.doesNotMatch(sections[0].split('\n')[0], /:hover/);
  assert.match(sections[0], /`width` \| `240px` \| `280px`/);
  assert.doesNotMatch(sections[0], /`90px`/);
  assert.match(sections[1].split('\n')[0], /:hover/);
  assert.match(sections[1], /`height` \| `80px` → `90px`/);
  assert.doesNotMatch(sections[1], /`280px`/);
});

test('a folded base width keeps a hover colour region state-only', (t) => {
  const fixture = fixtureFor(t, hoverMap(false), hoverMap(true));
  const md = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
  const sections = md.split(/^### /m).slice(1);
  assert.equal(sections.length, 1);
  assert.match(sections[0].split('\n')[0], /:hover/);
  assert.doesNotMatch(sections[0].split('\n')[0], /size\/position only/);
  assert.match(sections[0], /`width` \| `240px` \| `280px`/);
  assert.match(sections[0], /`height` \| `80px` → `90px`/);
});

test('ancestor reflow uses one outside heading without consuming the crop budget', (t) => {
  const ancestors = ['html', 'body', 'main', 'section', 'div', 'div'];
  const paths = ancestors.map((_, i) => ancestors.slice(0, i + 1).join(' > '));

  const map = (changed) =>
    elementsMap([
      ...paths.map((path, i) => [
        path,
        element(ancestors[i], [0, 0, 1280, 800], {
          height: `${800 + i + (changed ? 20 : 0)}px`,
        }),
      ]),
      [
        `${paths.at(-1)} > button`,
        element('button', [20, 20, 200, 40], {
          'padding-top': changed ? '20px' : '10px',
        }),
      ],
    ]);

  const fixture = fixtureFor(t, map(false), map(true));
  const result = generateStyleMapReport({ ...fixture, maxCrops: 1 });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const sections = md.split(/^### /m).slice(1);
  assert.equal(sections.length, 2, 'one crop section and one outside section');
  assert.match(sections[1], /^Folded size\/position rows outside the crops/);
  assert.match(sections[1], /\+6 size\/position rows folded/);
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.equal(json.surfaces[0].regions.length, 1, 'maxCrops remains one');
});

test('a hover geometry-only surface remains beside a visible colour surface', (t) => {
  const map = (width) => withHover(sidebar('240px', 'black'), { width });
  const fixture = fixtureFor(t, sidebar('240px', 'black'), sidebar('240px', 'red'));
  writeCapture(fixture.beforeDir, 'geometry@1280', map('240px'));
  writeCapture(fixture.afterDir, 'geometry@1280', map('280px'));
  const result = generateStyleMapReport(fixture);
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const json = fs.readFileSync(result.reportJsonPath, 'utf8');
  assert.match(md, /### .*aside.*size\/position rows folded/);
  assert.doesNotMatch(md + json, /0 elements changed|not visible in the captured page|crop would be misleading/);
  assert.notEqual(
    JSON.parse(json).surfaces.find((s) => s.surfaces.includes('geometry@1280')).visualEvidence,
    'not-rendered',
  );
  assert.match(md.split(/^### /m)[0], /geometry[\s\S]*\+1 size\/position row folded/);
  assert.match(md.split(/^### /m).slice(1).join('\n'), /geometry[\s\S]*\+1 size\/position row folded/);
  assert.match(md, /`:hover` \| `width` \| `240px` → `280px`/);
  assert.match(md, /color/);
});
