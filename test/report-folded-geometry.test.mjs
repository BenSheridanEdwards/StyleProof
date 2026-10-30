// Issue #1140: report.md must not silently fold authored size/position rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { cleanFindingsForDisplay, derivedLonghandCount } from '../dist/findings-clean.js';
import { foldedGeometryFindings, renderCropChanges } from '../dist/report/markdown.js';
import { makeMap, pairFixture, rmTmp, writeCapture } from './helpers.mjs';

const sidebar = (width, color) =>
  makeMap({
    elements: {
      body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} },
      'body > aside:nth-child(1)': {
        tag: 'aside',
        cls: 'sidebar',
        rect: [0, 0, Number.parseInt(width, 10), 800],
        style: { width, color },
      },
    },
  });

test('#1140 a width change beside a colour change is shown or counted in report.md', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before: sidebar('240px', 'rgb(0, 0, 0)'),
    after: sidebar('280px', 'rgb(255, 0, 0)'),
  });

  try {
    const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
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
  } finally {
    rmTmp(root);
  }
});

test('folded counts match the CLI for base, pseudo and forced-state geometry', () => {
  const prop = (name) => ({ prop: name, before: '10px', after: '20px' });

  const raw = [
    { kind: 'style', path: 'aside', cls: 'sidebar', pseudo: null, props: [prop('width'), prop('color')] },
    { kind: 'style', path: 'aside', cls: 'sidebar', pseudo: '::before', props: [prop('left')] },
    {
      kind: 'state',
      path: 'aside',
      cls: 'sidebar',
      sub: 'aside > span',
      state: 'hover',
      props: [prop('top'), prop('grid-template-columns')],
    },
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
  const raw = [
    {
      kind: 'style',
      path: 'aside',
      cls: 'sidebar',
      pseudo: null,
      props: [{ prop: 'width', before: '240px', after: '280px' }],
    },
  ];

  const shown = cleanFindingsForDisplay(raw);

  assert.deepEqual(foldedGeometryFindings(raw, shown), []);
  assert.doesNotMatch(renderCropChanges(shown, 0, {}).join('\n'), /rows? folded/);
});

test('folded geometry on a narrow surface prevents identical surface grouping', () => {
  const fixture = pairFixture({ surface: 's@1280', before: sidebar('240px', 'black'), after: sidebar('240px', 'red') });

  try {
    writeCapture(fixture.beforeDir, 's@375', sidebar('240px', 'black'));
    writeCapture(fixture.afterDir, 's@375', sidebar('280px', 'red'));
    const md = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
    assert.match(md, /\| `width` \| `240px` \| `280px` \|/);
    assert.match(md.split(/^### /m)[0], /\+1 size\/position row folded/);
    assert.doesNotMatch(md, /Identical across 2 surfaces/);
    assert.match(md, /375/);
  } finally {
    rmTmp(fixture.root);
  }
});

test('folded geometry stays under its own element crop', () => {
  const map = (changed) =>
    makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 1600], style: {} },
        ...Object.fromEntries(
          ['aside', 'footer'].map((tag, i) => [
            `body > ${tag}:nth-child(${i + 1})`,
            {
              tag,
              cls: tag,
              rect: [0, i * 1000, 240, 100],
              style: { color: changed ? 'red' : 'black', width: changed ? `${280 + i}px` : `${240 + i}px` },
            },
          ]),
        ),
      },
    });

  const fixture = pairFixture({ surface: 's@1280', before: map(false), after: map(true) });

  try {
    const md = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
    const crops = md.split(/^### /m).slice(1);
    assert.equal(crops.length, 2);
    assert.match(crops[0], /`width` \| `240px` \| `280px`/);
    assert.doesNotMatch(crops[0], /`241px`/);
    assert.match(crops[1], /`width` \| `241px` \| `281px`/);
    assert.doesNotMatch(crops[1], /`240px`/);
  } finally {
    rmTmp(fixture.root);
  }
});

test('folded-only details retain the full count while capping element tables', () => {
  const folded = Array.from({ length: 42 }, (_, i) => ({
    kind: 'style',
    path: `aside:nth-child(${i + 1})`,
    cls: '',
    pseudo: null,
    props: [{ prop: 'width', before: `${i}px`, after: `${i + 1}px` }],
  }));

  const md = renderCropChanges([], Infinity, {}, folded).join('\n');
  assert.match(md, /\+42 size\/position rows folded/);
  assert.match(md, /and 2 more element/);
  assert.equal((md.match(/\| `width`/g) ?? []).length, 40);
});

test('base and hover folded rows stay under their respective headings', () => {
  const map = (changed) => ({
    ...sidebar(changed ? '280px' : '240px', changed ? 'red' : 'black'),
    states: {
      'body > aside:nth-child(1)': {
        hover: {
          'body > aside:nth-child(1)': {
            color: changed ? 'red' : 'black',
            height: changed ? '90px' : '80px',
          },
        },
      },
    },
  });

  const fixture = pairFixture({ surface: 's@1280', before: map(false), after: map(true) });

  try {
    const md = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
    const sections = md.split(/^### /m).slice(1);
    assert.equal(sections.length, 2);
    assert.doesNotMatch(sections[0].split('\n')[0], /:hover/);
    assert.match(sections[0], /`width` \| `240px` \| `280px`/);
    assert.doesNotMatch(sections[0], /`90px`/);
    assert.match(sections[1].split('\n')[0], /:hover/);
    assert.match(sections[1], /`height` \| `80px` → `90px`/);
    assert.doesNotMatch(sections[1], /`280px`/);
  } finally {
    rmTmp(fixture.root);
  }
});
