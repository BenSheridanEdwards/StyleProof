// Issue #1140: report.md must not silently fold authored size/position rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { cleanFindingsForDisplay, derivedLonghandCount } from '../dist/findings-clean.js';
import { foldedGeometryFindings, renderCropChanges } from '../dist/report/markdown.js';
import { makeMap, pairFixture, rmTmp } from './helpers.mjs';

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
