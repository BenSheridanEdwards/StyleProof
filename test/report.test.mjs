import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  generateStructuralStyleMapReportForTesting as generateStyleMapReport,
  summarizeProps,
  prettyLabel,
} from '../dist/report.js';
import { escapeInlineMarkdown } from '../dist/code-span.js';
import * as reportShared from '../dist/report/shared.js';
import { safeKey } from '../dist/surface-keys.js';
import { diffStyleMaps } from '../dist/diff.js';
import {
  cleanFindingsForDisplay,
  assessComparisonTruth,
  signatureOf,
  derivedLonghandCount,
} from '../dist/findings-clean.js';
import { makeMap, mkTmp, rmTmp, solidPng, pairFixture, tmpDirs, writeCapture, sceneMap } from './helpers.mjs';

// NOTE: summarizeProps and prettyLabel must be exported from report.ts (and
// re-exported from index.ts) for these direct unit tests. See the drafted
// one-line export changes. If that export is rejected, delete this block — the
// end-to-end generateStyleMapReport tests below still exercise both indirectly.

// ----------------------------------------------------------- summarizeProps

test('summarizeProps drops a logical longhand that matches its physical twin', () => {
  const out = summarizeProps([
    { prop: 'border-bottom-color', before: 'red', after: 'blue' },
    { prop: 'border-block-end-color', before: 'red', after: 'blue' },
  ]);
  assert.deepEqual(out, [{ prop: 'border-bottom-color', before: 'red', after: 'blue' }]);
});

test('summarizeProps drops a currentColor follower that echoes the color change', () => {
  const out = summarizeProps([
    { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'caret-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'row-rule-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
  ]);
  assert.deepEqual(out, [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' }]);
});

test('summarizeProps keeps a caret-color that diverges from color', () => {
  const out = summarizeProps([
    { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'caret-color', before: 'rgb(0, 0, 0)', after: 'rgb(0, 255, 0)' },
  ]);
  assert.equal(out.length, 2);
});

test('summarizeProps folds four equal padding sides to a 1-value shorthand', () => {
  const out = summarizeProps([
    { prop: 'padding-top', before: '26px', after: '28px' },
    { prop: 'padding-right', before: '26px', after: '28px' },
    { prop: 'padding-bottom', before: '26px', after: '28px' },
    { prop: 'padding-left', before: '26px', after: '28px' },
  ]);
  assert.deepEqual(out, [{ prop: 'padding', before: '26px', after: '28px' }]);
});

test('summarizeProps emits 2-value padding shorthand for vertical/horizontal pairs', () => {
  const out = summarizeProps([
    { prop: 'padding-top', before: '10px', after: '12px' },
    { prop: 'padding-right', before: '20px', after: '24px' },
    { prop: 'padding-bottom', before: '10px', after: '12px' },
    { prop: 'padding-left', before: '20px', after: '24px' },
  ]);
  assert.deepEqual(out, [{ prop: 'padding', before: '10px 20px', after: '12px 24px' }]);
});

test('summarizeProps emits 3- and 4-value padding shorthand correctly', () => {
  const three = summarizeProps([
    { prop: 'padding-top', before: '1px', after: '1px' },
    { prop: 'padding-right', before: '2px', after: '2px' },
    { prop: 'padding-bottom', before: '3px', after: '9px' },
    { prop: 'padding-left', before: '2px', after: '2px' },
  ]);
  // before: t=1 r=2 b=3 l=2 -> r===l -> "1px 2px 3px"; after: t=1 r=2 b=9 l=2 -> "1px 2px 9px"
  assert.deepEqual(three, [{ prop: 'padding', before: '1px 2px 3px', after: '1px 2px 9px' }]);
  const four = summarizeProps([
    { prop: 'padding-top', before: '1px', after: '1px' },
    { prop: 'padding-right', before: '2px', after: '2px' },
    { prop: 'padding-bottom', before: '3px', after: '3px' },
    { prop: 'padding-left', before: '4px', after: '5px' },
  ]);
  // after: 1 2 3 5 -> all distinct -> 4-value
  assert.deepEqual(four, [{ prop: 'padding', before: '1px 2px 3px 4px', after: '1px 2px 3px 5px' }]);
});

test('summarizeProps collapses equal row-gap and column-gap into one gap row', () => {
  const out = summarizeProps([
    { prop: 'row-gap', before: '16px', after: '24px' },
    { prop: 'column-gap', before: '16px', after: '24px' },
  ]);
  assert.deepEqual(out, [{ prop: 'gap', before: '16px', after: '24px' }]);
});

test('summarizeProps writes a two-token gap when row and column differ', () => {
  const out = summarizeProps([
    { prop: 'row-gap', before: '16px', after: '8px' },
    { prop: 'column-gap', before: '16px', after: '24px' },
  ]);
  assert.deepEqual(out, [{ prop: 'gap', before: '16px', after: '8px 24px' }]);
});

test('summarizeProps folds repeated tokens (368px 368px 368px -> 368px x3)', () => {
  const out = summarizeProps([
    { prop: 'grid-template-columns', before: '368px 368px 368px', after: '300px 300px 300px' },
  ]);
  assert.deepEqual(out, [{ prop: 'grid-template-columns', before: '368px ×3', after: '300px ×3' }]);
});

test('summarizeProps keeps decimals verbatim — no display rounding', () => {
  const out = summarizeProps([{ prop: 'line-height', before: '26.666px', after: '24.04px' }]);
  assert.deepEqual(out, [{ prop: 'line-height', before: '26.666px', after: '24.04px' }]);
});

test('summarizeProps keeps a real 0.18 → 0.2 alpha change (rounding used to erase it as a no-op)', () => {
  const out = summarizeProps([
    { prop: 'background-color', before: 'rgba(0, 20, 30, 0.18)', after: 'rgba(0, 20, 30, 0.2)' },
  ]);
  assert.deepEqual(out, [{ prop: 'background-color', before: 'rgba(0, 20, 30, 0.18)', after: 'rgba(0, 20, 30, 0.2)' }]);
});

test('summarizeProps maps fully-transparent black to the keyword transparent', () => {
  const out = summarizeProps([{ prop: 'background-color', before: 'rgba(0, 0, 0, 0)', after: 'rgb(255, 0, 0)' }]);
  assert.deepEqual(out, [{ prop: 'background-color', before: 'transparent', after: 'rgb(255, 0, 0)' }]);
});

test('summarizeProps does not fold tokens inside function notation', () => {
  const out = summarizeProps([{ prop: 'background-image', before: 'url(a) url(a)', after: 'none' }]);
  // contains no '(' check is on the whole string; url() has '(', so left intact
  assert.equal(out[0].before, 'url(a) url(a)');
});

test('summarizeProps drops a change between two non-values (— → (gone))', () => {
  const out = summarizeProps([
    { prop: 'color', before: '(state does not change it)', after: '(gone)' },
    { prop: 'background-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
  ]);
  assert.deepEqual(out, [{ prop: 'background-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' }]);
});

test('summarizeProps collapses an all-placeholder outline to one non-value, not a triple repeat', () => {
  const ph = '(state no longer changes it)';
  const out = summarizeProps([
    { prop: 'outline-width', before: ph, after: ph },
    { prop: 'outline-style', before: ph, after: ph },
    { prop: 'outline-color', before: ph, after: ph },
  ]);
  // both sides are non-values → the whole outline row is dropped (no `(...) (...) (...)`).
  assert.equal(out.length, 0);
});

// --------------------------------------------------------------- prettyLabel

test('prettyLabel uses the tag plus first semantic class', () => {
  assert.equal(prettyLabel('body > div:nth-child(2) > h3:nth-child(1)', 'who-grid card'), 'h3.who-grid');
});

test('prettyLabel falls back to bare tag for a non-identifier first class', () => {
  assert.equal(prettyLabel('body > div:nth-child(1)', 'Mixed_Case'), 'div');
});

test('prettyLabel returns the bare tag when there is no class', () => {
  assert.equal(prettyLabel('body > span:nth-child(3)', ''), 'span');
});

// -------------------------------------------------- generateStyleMapReport e2e

test('end-to-end: crop anchors on the real-change element, not the reflow casualty', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    after: sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 820 }),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 820),
  });

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 1);

  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  // The body (height-only) was stripped as a reflow casualty; the only region
  // is the button. Anchoring on body would have produced a body-sized box.
  const region = json.surfaces[0].regions[0];
  assert.deepEqual(region.paths, ['body > div:nth-child(1) > button:nth-child(1)']);
  // button rect [100,100,160,48] padded by 12 (default) -> x=88 y=88 w=184 h=72
  assert.deepEqual(region.before, { x: 88, y: 88, w: 184, h: 72 });
  rmTmp(root);
});

test('end-to-end: a tiny change gets a magnified zoom crop and the highlight shows by default', () => {
  const caret = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} },
        // 12×16 caret — far below the 64px zoom threshold, so a colour change here
        // is imperceptible at 1:1 and must get a magnified crop.
        'body > span:nth-child(1)': { tag: 'span', cls: 'caret', rect: [40, 40, 12, 16], style: { color } },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: caret('rgb(0, 0, 0)'),
    after: caret('rgb(255, 0, 0)'),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 1);

  const region = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8')).surfaces[0].regions[0];
  assert.match(region.images.zoom, /-zoom\.png$/, 'a zoom image is recorded for the tiny change');
  assert.match(region.images.annotated, /-annotated\.png$/);
  assert.ok(fs.existsSync(path.join(outDir, region.images.zoom)), 'the zoom png is actually written');

  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  for (const imagePath of Object.values(region.images)) {
    assert.match(imagePath, /^crops\//, 'report JSON records crop paths relative to report.md');
    assert.ok(md.includes(`](${imagePath})`), `report.md references committed relative crop ${imagePath}`);
  }
  assert.match(md, /🔬 magnified \d+× — change too small to see at 1:1/, 'zoom is captioned with its factor');
  assert.match(md, /🔍 magenta boxes mark each change/, 'the highlight overlay is present');
  assert.match(md, /changed: `span\.caret`/, 'the changed element is named next to the image');
  assert.match(md, /<summary>Show highlight overlay<\/summary>/, 'highlight sits under an optional toggle');
  rmTmp(root);
});

test('end-to-end: a large change gets no zoom crop (visible at 1:1)', () => {
  const panel = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'panel',
          rect: [0, 0, 400, 300], // well above the zoom threshold
          style: { 'background-color': color },
        },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: panel('rgb(0, 0, 0)'),
    after: panel('rgb(255, 0, 0)'),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const region = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8')).surfaces[0].regions[0];
  assert.equal(region.images.zoom, undefined, 'no zoom image for a clearly-visible change');
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.doesNotMatch(md, /🔬 magnified/, 'no zoom caption for a large change');
  assert.match(md, /🔍 magenta boxes mark each change/, 'highlight overlay still present under the toggle');
  rmTmp(root);
});

test('end-to-end: header counts the collapsed total, not the longhand explosion', () => {
  // Four padding longhands change but collapse to one `padding` shorthand row,
  // so the header must say 1 computed-style difference, not 4.
  function pads(v) {
    return makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'card',
          rect: [0, 0, 300, 150],
          style: { 'padding-top': v, 'padding-right': v, 'padding-bottom': v, 'padding-left': v },
        },
      },
    });
  }
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before: pads('26px'),
    after: pads('28px'),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  // Zero counts are dropped from the headline; only the real one shows.
  assert.match(md, /\*\*1 distinct change\*\* \(1 computed-style difference\(s\)\)/);
  assert.doesNotMatch(md, /0 DOM change\(s\)/);
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.deepEqual(json.counts, { dom: 0, style: 1, state: 0 });
  rmTmp(root);
});

test('end-to-end: identical siblings in one region collapse to a single block x N', () => {
  // Three siblings with the SAME overlapping rect so groupRegions merges them
  // into one region; identical findings then collapse to one `card` block x3.
  function card(i, color) {
    return [
      `body > ul:nth-child(1) > li:nth-child(${i})`,
      { tag: 'li', cls: 'card', rect: [0, 0, 300, 150], style: { color } },
    ];
  }
  function map(color) {
    return makeMap({
      elements: Object.fromEntries([
        ['body', { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} }],
        ['body > ul:nth-child(1)', { tag: 'ul', cls: '', rect: [0, 0, 1280, 800], style: {} }],
        card(1, color),
        card(2, color),
        card(3, color),
      ]),
    });
  }
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before: map('rgb(0, 0, 0)'),
    after: map('rgb(255, 0, 0)'),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /\*\*`li\.card`\*\* ×3/);
  rmTmp(root);
});

test('an identical change across surfaces collapses into one grouped section', () => {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  const box = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': { tag: 'div', cls: 'box', rect: [0, 0, 200, 100], style: { color } },
      },
    });
  // Same change captured at two widths — the change is identical, the rects are not.
  for (const surface of ['s@1280', 's@390']) {
    writeCapture(beforeDir, surface, box('rgb(0, 0, 0)'), solidPng(1280, 800));
    writeCapture(afterDir, surface, box('rgb(255, 0, 0)'), solidPng(1280, 800));
  }
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /1 changed surface base \(2 variants\) with an existing baseline/);
  assert.match(md, /Identical across 2 surfaces/);
  assert.equal(
    (md.match(/\*\*`div\.box`\*\* — /g) || []).length,
    1,
    'the element bullet renders once, not once per surface',
  );
  assert.equal(
    fs.readdirSync(path.join(outDir, 'crops')).filter((f) => f.endsWith('-composite.png')).length,
    1,
    'one composite image for the group, not one per surface',
  );
  rmTmp(root);
});

test('an added shared element prefers a visible page over a wider popup representative', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const before = () =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1440, 800], style: {} },
      },
    });
  const after = (visibility, metadata = undefined) => ({
    ...makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1440, 800], style: {} },
        'body > nav:nth-child(1) > a:nth-child(2)': {
          tag: 'a',
          cls: 'nav-item',
          rect: [24, 180, 120, 32],
          style: { display: 'flex', visibility },
        },
      },
    }),
    ...(metadata ? { metadata } : {}),
  });
  const popupMetadata = { variantKind: 'popup', variantKey: 'settings' };

  writeCapture(beforeDir, 'page@1280', before(), solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after('visible'), solidPng(1280, 800, [0, 220, 220]));
  writeCapture(beforeDir, 'settings-dialog@1440', { ...before(), metadata: popupMetadata }, solidPng(1440, 800));
  writeCapture(afterDir, 'settings-dialog@1440', after('hidden', popupMetadata), solidPng(1440, 800));

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.equal(
    report.surfaces[0].representative,
    'page@1280',
    'the crop should show the visible added element, not the wider popup that hides it',
  );
  rmTmp(root);
});

test('an added shared element prefers an on-canvas page over a wider off-canvas representative', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const itemPath = 'body > nav:nth-child(1) > a:nth-child(2)';
  const before = (width) =>
    makeMap({
      viewport: { width, height: 800 },
      elements: {
        body: { tag: 'body', rect: [0, 0, width, 800], style: {} },
      },
    });
  const after = (width, x) =>
    makeMap({
      viewport: { width, height: 800 },
      elements: {
        body: { tag: 'body', rect: [0, 0, width, 800], style: {} },
        [itemPath]: {
          tag: 'a',
          cls: 'nav-item',
          rect: [x, 180, 120, 32],
          style: { display: 'flex', visibility: 'visible' },
        },
      },
    });

  writeCapture(beforeDir, 'page@1024', before(1024), solidPng(1024, 800));
  writeCapture(afterDir, 'page@1024', after(1024, 24), solidPng(1024, 800));
  writeCapture(beforeDir, 'drawer@1440', before(1440), solidPng(1440, 800));
  writeCapture(afterDir, 'drawer@1440', after(1440, -241), solidPng(1440, 800));

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.equal(
    report.surfaces[0].representative,
    'page@1024',
    'the report should show the narrower on-canvas element, not unrelated pixels from the wider surface',
  );
  rmTmp(root);
});

test('an added shared element avoids a wider active-modal background representative', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const navItemPath = 'body > nav:nth-child(1) > a:nth-child(2)';
  const modalPath = 'body > div:nth-child(2)';
  const before = () =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1440, 800], style: {} },
      },
    });
  const after = () =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1440, 800], style: {} },
        [navItemPath]: {
          tag: 'a',
          cls: 'nav-item',
          rect: [24, 180, 120, 32],
          style: { display: 'flex', visibility: 'visible' },
        },
      },
    });
  const modal = {
    path: modalPath,
    tag: 'div',
    cls: 'settings-dialog',
    reason: 'role=dialog, aria-modal=true',
    role: 'dialog',
    ariaModal: 'true',
  };
  const modalMap = (map) => ({
    ...map,
    elements: {
      ...map.elements,
      [modalPath]: { tag: 'div', cls: 'settings-dialog', rect: [300, 80, 800, 640], style: { display: 'block' } },
    },
    overlays: [modal],
  });

  writeCapture(beforeDir, 'page@1280', before(), solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after(), solidPng(1280, 800, [0, 220, 220]));
  writeCapture(beforeDir, 'settings-dialog@1440', modalMap(before()), solidPng(1440, 800));
  writeCapture(afterDir, 'settings-dialog@1440', modalMap(after()), solidPng(1440, 800));

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.equal(
    report.surfaces[0].representative,
    'page@1280',
    'the crop should avoid a visible DOM node that is only modal-background content',
  );
  rmTmp(root);
});

test('a group without an exposed changed element keeps audit details but omits misleading crops', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const itemPath = 'body > nav:nth-child(1) > a:nth-child(2)';
  const before = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1024, 800], style: {} } } });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1024, 800], style: {} },
      [itemPath]: {
        tag: 'a',
        cls: 'nav-item',
        rect: [24, 180, 120, 32],
        style: { display: 'flex', visibility: 'hidden' },
      },
    },
  });
  writeCapture(beforeDir, 'page@1024', before, solidPng(1024, 800));
  writeCapture(afterDir, 'page@1024', after, solidPng(1024, 800));

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const markdown = fs.readFileSync(result.reportMdPath, 'utf8');
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.match(markdown, /before\/after crop would be misleading/);
  assert.match(markdown, /^### /m, 'the group keeps its heading (#952)');
  assert.match(markdown, /^_page @ 1024_$/m, 'the group names its surface (#952)');
  assert.doesNotMatch(markdown, /!\[before/);
  assert.equal(report.surfaces[0].visualEvidence, 'not-rendered');
  assert.equal(
    fs.readdirSync(path.join(outDir, 'crops')).filter((fileName) => fileName.endsWith('.png')).length,
    0,
    'no duplicate crop files are emitted',
  );
  rmTmp(root);
});

test('a change only on a display: none element keeps the PR comment verdict and digest (#952)', () => {
  const drawerPath = 'body > nav:nth-child(1)';
  const map = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 390, 800], style: { display: 'block' } },
        [drawerPath]: { tag: 'nav', cls: 'drawer', rect: [0, 0, 0, 0], style: { display: 'none', color } },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'settings@390',
    before: map('rgb(0, 0, 0)'),
    after: map('rgb(255, 0, 0)'),
    beforePng: solidPng(390, 800),
    afterPng: solidPng(390, 800),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const markdown = fs.readFileSync(result.reportMdPath, 'utf8');
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  // The PR comment summary, sliced exactly as action.yml does.
  const lines = markdown.split('\n');
  const headEnd = lines.findIndex((l) => l.startsWith('### '));
  const summary = headEnd > 0 ? lines.slice(0, headEnd).join('\n').trim() : '## 🗺️ StyleProof report';
  assert.match(summary, /\*\*1 change needs review\*\*/);
  assert.match(summary, /\*\*What changed\*\*/);
  assert.match(lines[headEnd], /`nav\.drawer`/, 'the heading names the changed element');
  assert.match(markdown, /^_settings @ 390_$/m, 'the group names its surface');
  assert.match(markdown, /before\/after crop would be misleading/);
  assert.doesNotMatch(markdown, /!\[before/);
  assert.equal(report.surfaces[0].visualEvidence, 'not-rendered');
  assert.ok(report.surfaces[0].reason, 'report.json keeps the not-rendered reason');
  rmTmp(root);
});

test('a mixed group omits only the off-canvas region crop and keeps its audit details', () => {
  const visiblePath = 'body > div:nth-child(1)';
  const offCanvasPath = 'body > div:nth-child(2)';
  const map = (color) =>
    makeMap({
      viewport: { width: 1024, height: 800 },
      elements: {
        body: { tag: 'body', rect: [0, 0, 1024, 900], style: {} },
        [visiblePath]: { tag: 'div', cls: 'visible-card', rect: [100, 100, 200, 80], style: { color } },
        [offCanvasPath]: { tag: 'div', cls: 'off-canvas-card', rect: [-241, 600, 76, 37], style: { color } },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'page@1024',
    before: map('rgb(0, 0, 0)'),
    after: map('rgb(255, 0, 0)'),
    beforePng: solidPng(1024, 900),
    afterPng: solidPng(1024, 900),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const markdown = fs.readFileSync(result.reportMdPath, 'utf8');
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const [visibleRegion, offCanvasRegion] = report.surfaces[0].regions;
  assert.ok(visibleRegion.images.composite, 'the visible finding keeps its screenshot proof');
  assert.deepEqual(offCanvasRegion.images, {});
  assert.equal(offCanvasRegion.visualEvidence, 'not-rendered');
  assert.match(offCanvasRegion.reason, /outside the screenshot canvas/);
  assert.match(markdown, /outside the screenshot canvas/);
  assert.match(markdown, /div\.off-canvas-card/);
  assert.equal(
    fs.readdirSync(path.join(outDir, 'crops')).filter((fileName) => fileName.endsWith('-composite.png')).length,
    1,
    'the off-canvas finding must not produce a crop of unrelated on-screen pixels',
  );
  rmTmp(root);
});

test('two far-apart changes become two crop sections, each holding only its own changes', () => {
  // A top-right `nav-cta` and a far-below `card` — non-overlapping rects, so the
  // report must split them into two screenshots, and the tables under each must
  // be exactly what that screenshot shows (no wall of changes spanning crops).
  const map = (radius, bg) =>
    makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 1000], style: {} },
        'body > a:nth-child(1)': {
          tag: 'a',
          cls: 'nav-cta',
          rect: [1080, 20, 140, 40],
          style: { 'border-radius': radius },
        },
        'body > div:nth-child(2)': {
          tag: 'div',
          cls: 'card',
          rect: [100, 600, 300, 200],
          style: { 'background-color': bg },
        },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'hero@1280',
    before: map('8px', 'rgb(7, 10, 14)'),
    after: map('9999px', 'rgb(14, 20, 29)'),
    beforePng: solidPng(1280, 1000),
    afterPng: solidPng(1280, 1000),
  });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');

  // One ### section per crop, each headed by the element it is anchored on.
  assert.match(md, /### (?:\*\*[^*]+\*\* )?`a\.nav-cta` · 1 element restyled/);
  assert.match(md, /### (?:\*\*[^*]+\*\* )?`div\.card` · 1 element restyled/);

  // Split on the headings and assert each section carries ONLY its own property.
  const sections = md.split(/\n### /).slice(1);
  const nav = sections.find((s) => s.includes('`a.nav-cta`'));
  const card = sections.find((s) => s.includes('`div.card`'));
  assert.ok(nav.includes('border-radius') && !nav.includes('background-color'), 'nav crop shows only its change');
  assert.ok(card.includes('background-color') && !card.includes('border-radius'), 'card crop shows only its change');

  // Crops read top-to-bottom: the nav-cta (y=20) section precedes the card (y=600).
  assert.ok(md.indexOf('`a.nav-cta`') < md.indexOf('`div.card`'), 'sections are in page order');
  assert.equal(
    fs.readdirSync(path.join(outDir, 'crops')).filter((f) => f.endsWith('-composite.png')).length,
    2,
    'one composite per crop',
  );
  rmTmp(root);
});

test('new surfaces are named in the summary that the PR comment slices', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  const baseMap = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 900, 700], style: {} } } });
  const workspaceMap = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 900, 900], style: {} },
      'body > main:nth-child(1)': {
        tag: 'main',
        cls: 'workspace-shell',
        rect: [0, 0, 900, 900],
        style: { display: 'grid' },
      },
    },
  });
  writeCapture(beforeDir, 'home@900', baseMap, solidPng(900, 700));
  writeCapture(afterDir, 'home@900', baseMap, solidPng(900, 700));
  writeCapture(afterDir, 'workspace@1280', workspaceMap, solidPng(1280, 900));
  writeCapture(afterDir, 'workspace@390', workspaceMap, solidPng(390, 900));

  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  const commentSummary = md.slice(0, md.indexOf('\n### '));
  assert.match(commentSummary, /🆕 \*\*2 new surface\(s\)\*\*/);
  assert.match(commentSummary, /`workspace @ 1280, 390`/);
  assert.doesNotMatch(commentSummary, /shown below for review/);
  rmTmp(root);
});

test('new surface details render before existing-surface change groups', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  const existingBefore = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 900, 700], style: {} },
      'body > nav:nth-child(1)': { tag: 'nav', cls: 'nav', rect: [0, 0, 900, 80], style: { color: 'rgb(0, 0, 0)' } },
    },
  });
  const existingAfter = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 900, 700], style: {} },
      'body > nav:nth-child(1)': { tag: 'nav', cls: 'nav', rect: [0, 0, 900, 80], style: { color: 'rgb(255, 0, 0)' } },
    },
  });
  const workspaceMap = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 900, 900], style: {} },
      'body > main:nth-child(1)': {
        tag: 'main',
        cls: 'workspace-shell',
        rect: [0, 0, 900, 900],
        style: { display: 'grid' },
      },
    },
  });
  writeCapture(beforeDir, 'home@900', existingBefore, solidPng(900, 700));
  writeCapture(afterDir, 'home@900', existingAfter, solidPng(900, 700));
  writeCapture(afterDir, 'workspace@900', workspaceMap, solidPng(900, 900));

  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  const newIdx = md.indexOf('`workspace@900` · new surface');
  const changedIdx = md.indexOf('`nav.nav` · 1 element restyled');
  assert.ok(newIdx > 0, 'new surface section is present');
  assert.ok(changedIdx > 0, 'changed-surface section is present');
  assert.ok(newIdx < changedIdx, 'new page evidence leads before existing-surface churn');
  const commentSummary = md.slice(0, md.indexOf('\n### '));
  assert.ok(
    commentSummary.indexOf('🆕 **1 new surface(s)**') < commentSummary.indexOf('**1 distinct change**'),
    'comment summary leads with the named new surface before aggregate existing-surface churn',
  );
  assert.match(commentSummary, /`workspace @ 900`/);
  rmTmp(root);
});

test('property tables fold under a <details> toggle with an essence line; foldDetailsAt keeps small changes inline', () => {
  const map = (radius) =>
    makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} },
        'body > a:nth-child(1)': { tag: 'a', cls: 'cta', rect: [20, 20, 120, 40], style: { 'border-radius': radius } },
      },
    });
  const f = pairFixture({
    surface: 's@1280',
    before: map('8px'),
    after: map('9999px'),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });

  // Default (foldDetailsAt: 0) folds always: plain-English bullets above, then the
  // table inside <details>. The blank lines around the table are mandatory or
  // GitHub renders it as literal text — assert them explicitly.
  const folded = fs.readFileSync(generateStyleMapReport({ ...f }).reportMdPath, 'utf8');
  assert.match(folded, /corners fully rounded/, 'plain-English summary above the fold');
  assert.match(folded, /<details>\n<summary>Show the property change<\/summary>\n\n/, 'blank line after </summary>');
  assert.match(folded, /\n\n<\/details>/, 'blank line before </details>');

  // foldDetailsAt: Infinity never folds the TABLES — they render inline, with no
  // "Show … property changes" toggle. (The annotated-image toggle is separate and
  // always present, so check the table fold specifically.)
  const inline = fs.readFileSync(
    generateStyleMapReport({ ...f, outDir: path.join(f.root, 'inline'), foldDetailsAt: Infinity }).reportMdPath,
    'utf8',
  );
  assert.ok(!inline.includes('<summary>Show the property'), 'foldDetailsAt: Infinity keeps the tables out of a fold');
  assert.match(inline, /\| `border-radius` \| `8px` \| `9999px` \|/, 'table is present inline');
  rmTmp(f.root);
});

test('a newly-added element shows the values its states take, not a bogus "before"', () => {
  const before = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } } });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > a:nth-child(1)': { tag: 'a', cls: 'link', rect: [0, 0, 80, 20], style: { color: 'rgb(0, 0, 0)' } },
    },
    states: { 'body > a:nth-child(1)': { hover: { 'body > a:nth-child(1)': { color: 'rgb(0, 0, 255)' } } } },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before,
    after,
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /\*\*Added\*\* (?:\*\*[^*]+\*\* )?`a\.link`/);
  assert.match(md, /Interactive states:/);
  assert.match(md, /\| State \| Property \| Value \|/);
  assert.match(md, /`:hover` \| `color` \| `#0000ff`/); // colours render as hex (with a GitHub swatch)
  assert.doesNotMatch(md, /state does not change it/, 'no jargon placeholder for a brand-new element');
  rmTmp(root);
});

test('an added element reports its full resting computed style, value-only', () => {
  const before = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } } });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'btn',
        rect: [0, 0, 90, 32],
        // resting computed style (the thing the old report dropped for added elements)
        style: { 'background-color': 'rgb(0, 90, 252)', padding: '6px 12px', 'border-radius': '4px' },
      },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before,
    after,
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  assert.match(md, /\*\*Added\*\* (?:\*\*[^*]+\*\* )?`button\.btn`/);
  assert.match(md, /Style inventory \(head-side — no baseline\)/);
  assert.match(md, /\| Property \| Value \|/); // value-only, no bogus Before column
  assert.doesNotMatch(md, /\| Property \| Before \| After \|/, 'added-node inventory is never a before→after table');
  assert.match(md, /`background-color` \| `#005afc`/);
  assert.match(md, /`padding` \| `6px 12px`/);
  assert.match(md, /`border-radius` \| `4px`/);
  rmTmp(root);
});

// Taxonomy: a brand-new node's full resting/state inventory must not be billed as
// matched-path computed-style / state-delta *differences*. Headline counts and copy
// must reserve those words for paths present on both sides.
test('add-only: headline counts DOM only — head-side inventory is not a restyle difference', () => {
  const before = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } } });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'btn',
        rect: [0, 0, 90, 32],
        style: {
          'background-color': 'rgb(0, 90, 252)',
          color: 'rgb(255, 255, 255)',
          padding: '6px 12px',
        },
      },
    },
    states: {
      'body > button:nth-child(1)': {
        hover: { 'body > button:nth-child(1)': { 'background-color': 'rgb(0, 60, 200)' } },
      },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before,
    after,
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  // Presentation counts: DOM add only. Style/state rows are inventory on the new node.
  assert.deepEqual(json.counts, { dom: 1, style: 0, state: 0 });
  assert.match(md, /\*\*1 distinct change\*\* \(1 DOM change\(s\)\)/);
  assert.doesNotMatch(md, /computed-style difference/);
  assert.doesNotMatch(md, /state-delta difference/);
  assert.match(md, /Style inventory \(head-side — no baseline\)/);
  assert.match(md, /Interactive states:/);
  assert.doesNotMatch(md, /Interactive-state changes:/);
  assert.doesNotMatch(md, /Before → After/);
  // Raw certification findings still carry the full inventory (backward compatible).
  assert.equal(json.rawCounts.dom, 1);
  assert.ok(json.rawCounts.style > 0 || json.reviewableCounts.style > 0, 'raw findings still inventory the added node');
  rmTmp(root);
});

test('matched-path restyle still counts as a computed-style difference (not inventory)', () => {
  const panel = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'panel',
          rect: [0, 0, 400, 300],
          style: { 'background-color': color },
        },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before: panel('rgb(0, 0, 0)'),
    after: panel('rgb(255, 0, 0)'),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.deepEqual(json.counts, { dom: 0, style: 1, state: 0 });
  assert.match(md, /\*\*1 distinct change\*\* \(1 computed-style difference\(s\)\)/);
  assert.match(md, /1 element restyled/);
  assert.match(md, /\| Property \| Before \| After \|/);
  assert.doesNotMatch(md, /Style inventory \(head-side/);
  assert.doesNotMatch(md, /no baseline/);
  rmTmp(root);
});

// Wrapper / nth-child path churn: insert a parent around existing content. Paths
// become one-sided adds/removes with full inventories — never matched-path restyles.
test('wrapper path-churn: inventory copy, not restyle differences', () => {
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta',
        rect: [10, 10, 120, 40],
        style: { 'background-color': 'rgb(0, 90, 252)', color: 'rgb(255, 255, 255)' },
      },
    },
  });
  // Wrap the button: old path removed, wrapper + button-at-new-path added.
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'wrap',
        rect: [0, 0, 200, 80],
        style: { padding: '8px' },
      },
      'body > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta',
        rect: [18, 18, 120, 40],
        style: { 'background-color': 'rgb(0, 90, 252)', color: 'rgb(255, 255, 255)' },
      },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before,
    after,
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.equal(json.counts.style, 0, 'wrapper path-churn inventories are not style differences');
  assert.equal(json.counts.state, 0);
  assert.ok(json.counts.dom >= 2, 'adds + remove are DOM changes');
  assert.match(md, /DOM change/);
  assert.doesNotMatch(md, /computed-style difference/);
  assert.doesNotMatch(md, /1 element restyled|elements restyled/);
  assert.match(md, /element(?:s)? added/);
  assert.match(md, /element(?:s)? removed/);
  assert.match(md, /Style inventory \(head-side — no baseline\)/);
  assert.doesNotMatch(md, /\| Property \| Before \| After \|/);
  rmTmp(root);
});

// Report-only path correspondence: when a removed base path and an added head path
// share a unique privacy-safe geometry signature (tag + x/y/width + ownTextLength)
// under a shared structural prefix, presentation pairs them. Certification raw
// findings / counts stay on concrete paths.
test('correspondence: wrapper insert with unchanged descendant collapses path move', () => {
  const button = {
    tag: 'button',
    cls: 'cta',
    rect: [10, 10, 120, 40],
    ownTextLength: 3,
    style: { 'background-color': 'rgb(0, 90, 252)', color: 'rgb(255, 255, 255)' },
  };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], ownTextLength: 0, style: {} },
      'body > button:nth-child(1)': button,
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], ownTextLength: 0, style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'wrap',
        rect: [0, 0, 200, 80],
        ownTextLength: 0,
        style: { padding: '8px' },
      },
      'body > div:nth-child(1) > button:nth-child(1)': { ...button },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before,
    after,
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  // Presentation: only the new wrapper (and its inventory) — not a button remove/add restyle.
  assert.equal(json.counts.style, 0, 'unchanged corresponded leaf is not a restyle');
  assert.equal(json.counts.state, 0);
  assert.ok(json.counts.dom >= 1, 'wrapper remains a DOM add');
  assert.doesNotMatch(md, /element(?:s)? removed/, 'corresponded removal collapses in presentation');
  assert.doesNotMatch(md, /1 element restyled|elements restyled/);
  assert.match(md, /element(?:s)? added/);
  // Raw certification still sees full path churn.
  assert.ok(json.rawCounts.dom >= 2, 'raw DOM still counts remove + adds');
  assert.ok(json.rawCounts.style > 0 || json.reviewableCounts.style > 0, 'raw still inventories one-sided paths');
  rmTmp(root);
});

test('correspondence: wrapper insert with true font-size delta shows paired before→after', () => {
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], ownTextLength: 0, style: {} },
      'body > span:nth-child(1)': {
        tag: 'span',
        cls: 'label',
        rect: [40, 40, 80, 14],
        ownTextLength: 4,
        style: { 'font-size': '12px', height: '14px' },
      },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], ownTextLength: 0, style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'wrap',
        rect: [30, 30, 100, 40],
        ownTextLength: 0,
        style: {},
      },
      'body > div:nth-child(1) > span:nth-child(1)': {
        tag: 'span',
        cls: 'label',
        rect: [40, 40, 80, 15],
        ownTextLength: 4,
        style: { 'font-size': '13.3333px', height: '15px' },
      },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before,
    after,
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir, includeLayoutNoise: true });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.ok(json.counts.style >= 1, 'paired leaf contributes computed-style differences');
  assert.match(md, /computed-style difference/);
  assert.match(md, /\| Property \| Before \| After \|/);
  assert.match(md, /`font-size` \| `12px` \| `13\.3333px`/);
  assert.match(md, /`height` \| `14px` \| `15px`/);
  assert.doesNotMatch(md, /Style inventory \(head-side — no baseline\).*font-size/s);
  // Gate tallies stay on the concrete-path certification differ.
  assert.ok(json.rawCounts.dom >= 2, 'raw still sees structural path churn');
  assert.deepEqual(Object.keys(json.rawCounts).sort(), ['dom', 'state', 'style']);
  assert.deepEqual(Object.keys(json.reviewableCounts).sort(), ['dom', 'state', 'style']);
  rmTmp(root);
});

test('correspondence: ambiguous duplicates stay unpaired; raw/reviewable gate counts intact', () => {
  const twin = {
    tag: 'button',
    cls: 'chip',
    rect: [0, 0, 64, 24],
    ownTextLength: 1,
    style: { color: 'rgb(0, 0, 0)' },
  };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: {} },
      'body > button:nth-child(1)': twin,
      'body > button:nth-child(2)': { ...twin },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: {} },
      'body > section:nth-child(1)': {
        tag: 'section',
        cls: 'row',
        rect: [0, 0, 400, 80],
        ownTextLength: 0,
        style: {},
      },
      'body > section:nth-child(1) > button:nth-child(1)': { ...twin },
      'body > section:nth-child(1) > button:nth-child(2)': { ...twin },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@400',
    before,
    after,
    beforePng: solidPng(400, 200),
    afterPng: solidPng(400, 200),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.equal(json.counts.style, 0, 'duplicates never invent paired restyles');
  assert.ok(json.counts.dom >= 3, 'unpaired removes + adds stay DOM');
  assert.match(md, /element(?:s)? removed/);
  assert.match(md, /element(?:s)? added/);
  assert.doesNotMatch(md, /1 element restyled|elements restyled/);
  // Certification truth is independent of presentation correspondence.
  assert.ok(json.rawCounts.dom >= 3);
  assert.equal(typeof json.reviewableCounts.dom, 'number');
  assert.equal(json.reportConsistency.ok, true);
  rmTmp(root);
});

test('correspondence: sibling reorder never reports identical while raw reviewable evidence remains', () => {
  const button = {
    tag: 'button',
    cls: 'action',
    rect: [10, 10, 80, 24],
    ownTextLength: 3,
    style: { color: 'rgb(0, 0, 0)' },
  };
  const label = {
    tag: 'span',
    cls: 'label',
    rect: [10, 50, 80, 20],
    ownTextLength: 4,
    style: { color: 'rgb(0, 0, 0)' },
  };
  const shell = { tag: 'div', cls: 'shell', rect: [0, 0, 200, 100], ownTextLength: 0, style: {} };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: {} },
      'body > div:nth-child(1)': shell,
      'body > div:nth-child(1) > button:nth-child(1)': button,
      'body > div:nth-child(1) > span:nth-child(2)': label,
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: {} },
      'body > div:nth-child(1)': shell,
      'body > div:nth-child(1) > span:nth-child(1)': label,
      'body > div:nth-child(1) > button:nth-child(2)': button,
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@400',
    before,
    after,
    beforePng: solidPng(400, 200),
    afterPng: solidPng(400, 200),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.deepEqual(json.counts, { dom: 0, style: 0, state: 0 });
  assert.equal(res.comparison.hasReviewableEvidence, true);
  assert.deepEqual(json.reportConsistency, {
    ok: false,
    reason: 'presentation_collapsed_while_raw_reviewable',
  });
  assert.deepEqual(res.reportConsistency, json.reportConsistency);
  assert.match(md, /Report consistency failure/);
  assert.match(md, /path correspondence collapsed every presentation finding/);
  assert.doesNotMatch(md, /✓ All surfaces identical/);
  rmTmp(root);
});

test('correspondence: nesting reparent elevates visible structure rather than reporting identical', () => {
  const outer = { tag: 'div', cls: 'outer', rect: [0, 0, 200, 100], ownTextLength: 0, style: { display: 'block' } };
  const inner = {
    tag: 'span',
    cls: 'inner',
    rect: [10, 10, 100, 20],
    ownTextLength: 4,
    style: { color: 'rgb(0, 0, 0)', display: 'inline' },
  };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: { display: 'block' } },
      'body > div:nth-child(1)': outer,
      'body > div:nth-child(1) > span:nth-child(1)': inner,
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: { display: 'block' } },
      'body > span:nth-child(1)': inner,
      'body > span:nth-child(1) > div:nth-child(1)': outer,
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@400',
    before,
    after,
    beforePng: solidPng(400, 200),
    afterPng: solidPng(400, 200),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir, includeContent: true });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  // Shown style counts stay clean; visible path add/remove elevates into reviewableCounts.dom.
  assert.deepEqual(json.counts, { dom: 0, style: 0, state: 0 });
  assert.equal(res.comparison.hasReviewableEvidence, true);
  assert.ok((res.comparison.reviewableCounts?.dom ?? 0) >= 1);
  assert.deepEqual(json.reportConsistency, { ok: true, reason: 'aligned' });
  assert.match(md, /visible element addition|needs review|STYLE_REVIEW_REQUIRED/i);
  assert.doesNotMatch(md, /✓ All surfaces identical/);
  assert.doesNotMatch(md, /Report consistency failure/);
  rmTmp(root);
});

// Regression, seen in a downstream report: a gradient diff rendered as the same
// "representative" rgba in BOTH cells — the real change (a dropped `0px` stop)
// was invisible. Long values must excerpt around the differing substring.
test('a long gradient diff excerpts the differing substring, never an equal pair', () => {
  const grad = (firstStop) =>
    `repeating-linear-gradient(0deg, rgba(0, 0, 0, 0)${firstStop}, rgba(0, 0, 0, 0) 2px, rgba(0, 20, 30, 0.18) 3px)`;
  const mapWith = (bg) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'scanlines',
          rect: [0, 0, 1280, 800],
          style: { 'background-image': bg },
        },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before: mapWith(grad(' 0px')),
    after: mapWith(grad('')),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  const row = md.split('\n').find((l) => l.startsWith('|') && l.includes('`background-image`'));
  assert.ok(row, 'background-image row present');
  const [, beforeCell, afterCell] = row
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
  assert.notEqual(beforeCell, afterCell, 'Before and After cells must actually differ');
  assert.match(beforeCell, /0px/, 'the dropped stop is visible in the Before excerpt');
  rmTmp(root);
});

test('captureComponent: an added element names its React component + props', () => {
  const before = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } } });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'btn',
        rect: [0, 0, 90, 32],
        style: { color: 'rgb(255, 255, 255)' },
        component: { name: 'Button', props: { variant: 'primary', size: 'sm' } },
      },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before,
    after,
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  assert.match(md, /React component: `Button` \(variant=primary, size=sm\)/);
  rmTmp(root);
});

test('end-to-end: a valid composite PNG of the expected size is written', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    after: sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const compositeRel = json.surfaces[0].regions[0].images.composite;
  assert.ok(compositeRel, 'composite image recorded in json');
  const compositePath = path.join(outDir, compositeRel);
  assert.ok(fs.existsSync(compositePath), 'composite png on disk');
  // Re-decode it: proves a real PNG, not an empty/corrupt file.
  const png = PNG.sync.read(fs.readFileSync(compositePath));
  // Crop is min 320x180; composite = PAD20 + w + GAP28 + w + PAD20 wide,
  // PAD20 + h + PAD20 tall (no accent strip). With w=320,h=180: 2*320+68=708 by 220.
  assert.equal(png.width, 708);
  assert.equal(png.height, 220);
  rmTmp(root);
});

test('end-to-end: composite PNG is pure UI chrome with no in-image direction labels', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    after: sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const compositePath = path.join(outDir, json.surfaces[0].regions[0].images.composite);
  const png = PNG.sync.read(fs.readFileSync(compositePath));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /◀ before {2}· {2}after ▶/, 'direction lives in the markdown caption');
  const label = [139, 148, 158];
  let labelPixels = 0;
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      if (png.data[offset] === label[0] && png.data[offset + 1] === label[1] && png.data[offset + 2] === label[2]) {
        labelPixels++;
      }
    }
  }
  assert.equal(labelPixels, 0, 'top pad band has no bitmap BEFORE/AFTER glyphs');
  rmTmp(root);
});

test('end-to-end: narrow crops stay panel-sized with no in-image direction labels', () => {
  const map = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1, 1], style: { color } },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'tiny@1',
    before: map('rgb(0, 0, 0)'),
    after: map('rgb(255, 0, 0)'),
    beforePng: solidPng(1, 1),
    afterPng: solidPng(1, 1),
  });
  const res = generateStyleMapReport({
    beforeDir,
    afterDir,
    outDir,
    crop: { pad: 0, minWidth: 1, minHeight: 1 },
  });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const compositePath = path.join(outDir, json.surfaces[0].regions[0].images.composite);
  const png = PNG.sync.read(fs.readFileSync(compositePath));
  // 1×1 panels: PAD20 + 1 + GAP28 + 1 + PAD20 = 70 wide, PAD20 + 1 + PAD20 = 41 tall.
  assert.equal(png.width, 70);
  assert.equal(png.height, 41);
  const label = [139, 148, 158];
  let labelPixels = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === label[0] && png.data[i + 1] === label[1] && png.data[i + 2] === label[2]) labelPixels++;
  }
  assert.equal(labelPixels, 0, 'narrow composite has no bitmap direction glyphs');
  rmTmp(root);
});

test('end-to-end: no differences certifies matched computed styles without claiming visual identity', () => {
  const same = sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 });
  const { beforeDir, afterDir, outDir, root } = pairFixture({ surface: 'home@1280', before: same, after: same });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 0);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /✓ No reviewable computed-style changes among semantically matched elements/);
  assert.match(md, /Content\/structure was not evaluated/);
  assert.doesNotMatch(md, /All surfaces identical|every computed style|visual changes/i);
  rmTmp(root);
});

test('end-to-end: a surface missing on one side renders by DIRECTION — head-only is new, base-only is removed', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  writeCapture(beforeDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  writeCapture(afterDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  writeCapture(beforeDir, 'about@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null); // base only
  writeCapture(afterDir, 'launch@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null); // head only
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.newSurfaces, 1);
  assert.equal(res.oneSidedSurfaces, 2);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  // Head-only: a NEW surface, carrying the marker + approve-forward guidance.
  assert.match(md, /### `launch@1280` · new surface <!-- styleproof-new -->/);
  assert.match(md, /🆕 \*\*1 new surface\(s\)\*\*/);
  // Base-only: a REMOVAL — previously mislabelled "new", inviting reviewers to
  // approve a disappearing feature as an addition.
  assert.match(md, /### `about@1280` · REMOVED surface 🗑️/);
  assert.match(md, /1 REMOVED surface\(s\)/);
  assert.doesNotMatch(md, /about@1280` · new surface/);
  assert.doesNotMatch(md, /0 DOM change\(s\)/); // no contradictory "0 changes" headline
  rmTmp(root);
});

test('a hostile surface key renders inertly — no Markdown injection into the report/comment', () => {
  // Surface keys come from artifact filenames — attacker-controlled in the fork
  // capture/report split — and flow into the privileged PR-comment summary. A key
  // crafted to break out of its inline-code span and inject a link must render as
  // plain text, never as an active `[label](url)` / `<img>` / table cell.
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  // Filename-safe (no path separators) yet Markdown/HTML-dangerous: a link
  // break-out, an inline image tag, and a table pipe.
  const hostile = 'x](evil)<img src=x>|@1280';
  writeCapture(beforeDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  writeCapture(afterDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  // Present only on the after side → rendered as a new surface, whose heading and
  // summary interpolate the key.
  writeCapture(afterDir, hostile, sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  // The Markdown/HTML control characters are stripped from every interpolation of
  // the key: no link parens, no closing bracket, no tag angle brackets, no table pipe.
  assert.doesNotMatch(md, /x\]\(evil\)/);
  assert.doesNotMatch(md, /<img src=x>/);
  // The sanitized, inert form is what appears instead.
  assert.match(md, /x--evil--img src=x-/);
  rmTmp(root);
});

test('end-to-end: a new surface is shown with its captured-side screenshot', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  // Present only on the after side, with a screenshot → rendered as an image.
  writeCapture(
    afterDir,
    'pricing@1280',
    sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    solidPng(1280, 600),
  );
  // A matching identical pair so the dir isn't all-missing (and the diff runs).
  writeCapture(beforeDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  writeCapture(afterDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const m = md.match(/!\[new surface — after\]\((crops\/[^)]+-new\.png)\)/);
  assert.ok(m, 'new-surface screenshot is embedded');
  assert.ok(fs.existsSync(path.join(outDir, m[1])), 'the crop file was written');
  rmTmp(root);
});

test('new surfaces render before ordinary element changes', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  writeCapture(beforeDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), solidPng(1280, 800));
  writeCapture(
    afterDir,
    'home@1280',
    sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
    solidPng(1280, 800),
  );
  writeCapture(
    afterDir,
    'pricing@1280',
    sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    solidPng(1280, 800),
  );

  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  const newSurfaceIndex = md.indexOf('`pricing@1280` · new surface');
  const changedElementIndex = md.search(/### \*\*.*\*\* `button|### `button/);
  assert.ok(newSurfaceIndex >= 0, 'new surface is present');
  assert.ok(changedElementIndex >= 0, 'ordinary changed element is present');
  assert.ok(newSurfaceIndex < changedElementIndex, 'the new page/surface is shown before lower-level element changes');
  rmTmp(root);
});

test('new-surface proof uses the captured viewport height instead of a blank full-page tail', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  writeCapture(beforeDir, 'home@1280', makeMap(), solidPng(1280, 600));
  writeCapture(afterDir, 'home@1280', makeMap(), solidPng(1280, 600));
  writeCapture(
    afterDir,
    'pricing@1280',
    { ...makeMap(), viewport: { width: 1280, height: 600 } },
    solidPng(1280, 1400),
  );

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const image = md.match(/!\[new surface — after\]\((crops\/[^)]+-new\.png)\)/)?.[1];
  assert.ok(image, 'new-surface image is present');
  assert.equal(PNG.sync.read(fs.readFileSync(path.join(outDir, image))).height, 600);
  rmTmp(root);
});

/** A tall page: grey above the fold, one magenta band far below it (the content #756 hid). */
function tallPageWithBelowFoldBand(width, height, bandTop) {
  const png = PNG.sync.read(solidPng(width, height));
  for (let y = bandTop; y < bandTop + 40; y++) {
    for (let x = 0; x < width; x++) png.data.set([255, 0, 200, 255], (y * width + x) << 2);
  }
  return PNG.sync.write(png);
}

const oneSidedImages = (md, alt) =>
  [...md.matchAll(new RegExp(`!\\[${alt}[^\\]]*\\]\\((crops/[^)]+)\\)`, 'g'))].map((m) => m[1]);

const hasBand = (outDir, rel) => {
  const png = PNG.sync.read(fs.readFileSync(path.join(outDir, rel)));
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 200) return true;
  }
  return false;
};

test('new-surface proof shows the whole captured page in viewport-height tiles, not only the top viewport (#756)', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  writeCapture(beforeDir, 'home@1280', makeMap(), solidPng(1280, 600));
  writeCapture(afterDir, 'home@1280', makeMap(), solidPng(1280, 600));
  const viewport = { width: 1280, height: 600 };
  writeCapture(afterDir, 'pricing@1280', { ...makeMap(), viewport }, tallPageWithBelowFoldBand(1280, 2100, 1900));
  writeCapture(beforeDir, 'about@1280', { ...makeMap(), viewport }, tallPageWithBelowFoldBand(1280, 1500, 1300));

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const tiles = oneSidedImages(md, 'new surface');
  assert.equal(tiles.length, 4, 'a 2100px page at a 600px viewport is shown as 4 tiles');
  const heights = tiles.map((rel) => PNG.sync.read(fs.readFileSync(path.join(outDir, rel))).height);
  assert.deepEqual(heights, [600, 600, 600, 300], 'tiles cover the full captured height');
  assert.ok(
    tiles.some((rel) => hasBand(outDir, rel)),
    'below-the-fold content appears in the report',
  );
  assert.doesNotMatch(md, /top viewport of page/);
  assert.match(md, /part 4 of 4 · 1800–2100 of 2100px/);

  const removedTiles = oneSidedImages(md, 'removed surface');
  assert.equal(removedTiles.length, 3, 'removed surfaces are tiled the same way');
  assert.ok(removedTiles.some((rel) => hasBand(outDir, rel)));

  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const entry = json.surfaces.find((s) => s.surface === 'pricing@1280');
  assert.equal(entry.image, tiles[0], 'image stays the first tile for older consumers');
  assert.deepEqual(entry.images, tiles);
  assert.equal(entry.shownHeight, 2100);
  assert.equal(entry.capturedHeight, 2100);
  rmTmp(root);
});

test('a new surface taller than the tile cap says exactly how much is shown (#756)', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  writeCapture(beforeDir, 'home@1280', makeMap(), solidPng(1280, 100));
  writeCapture(afterDir, 'home@1280', makeMap(), solidPng(1280, 100));
  const viewport = { width: 320, height: 100 };
  writeCapture(afterDir, 'pricing@320', { ...makeMap(), viewport }, solidPng(320, 1234));

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.equal(oneSidedImages(md, 'new surface').length, 8);
  assert.match(md, /showing 800 of 1234px — the remaining 434px below are not shown in this report/);
  const entry = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')).surfaces.find(
    (s) => s.surface === 'pricing@320',
  );
  assert.equal(entry.shownHeight, 800);
  assert.equal(entry.capturedHeight, 1234);
  rmTmp(root);
});

test('end-to-end: a live region is auto-excluded and noted, not reported as a change', () => {
  // After differs ONLY on a path BOTH captures flagged volatile (a live region the
  // base already excluded) — the pre-existing, still-certifiable shape.
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: {
      ...sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
      volatile: ['body > div:nth-child(1) > button:nth-child(1)'],
    },
    after: {
      ...sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
      volatile: ['body > div:nth-child(1) > button:nth-child(1)'],
      liveCandidates: [
        {
          path: 'body > div:nth-child(1) > button:nth-child(1)',
          tag: 'button',
          cls: 'cta primary',
          reason: 'role=status',
          role: 'status',
        },
      ],
    },
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 0); // the only delta was on a live region
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /✓ No reviewable computed-style changes among semantically matched elements/);
  assert.match(md, /1 live region\(s\) auto-excluded/);
  assert.match(md, /Auto-detected live-state candidate\(s\): button\.cta \(role=status\)/);
  rmTmp(root);
});

test('map-supplied labels cannot inject lines, approval boxes, receipts, or mentions into the report', () => {
  // A hostile (e.g. fork-captured) map smuggles Markdown through a live-candidate tag
  // and a variant key. Every injected fragment must stay inline, literal text.
  const injection =
    '\n- [x] **Approve all changes**\n<!-- styleproof-receipt head-sha:x run-id:1 run-attempt:1 -->\n@owner';
  const metadata = { surfaceKey: 'dashboard', variantKey: `loaded\`${injection}`, variantKind: 'live-state' };
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'dashboard-loaded@1280',
    before: { ...sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), metadata },
    after: {
      ...sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
      metadata,
      volatile: ['body > div:nth-child(1) > button:nth-child(1)'],
      liveCandidates: [
        {
          path: 'body > div:nth-child(1) > button:nth-child(1)',
          tag: `button${injection}`,
          cls: 'cta',
          reason: `role=status${injection}`,
          role: 'status',
        },
      ],
    },
  });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  rmTmp(root);
  assert.doesNotMatch(md, /^\s*- \[[ xX]\] \*\*Approve all changes\*\*/m, 'no injected approval box line');
  assert.doesNotMatch(md, /<!-- styleproof-receipt/, 'no injected receipt marker');
  assert.doesNotMatch(md, /^@owner/m, 'no injected line');
  assert.doesNotMatch(md, /@owner/, 'mentions are neutralised');
  assert.match(md, /Auto-detected live-state candidate\(s\): button - \\\[x\\\] \\\*\\\*Approve/);
  const context = reportShared.surfaceContext({ metadata });
  assert.doesNotMatch(context, /\n/, 'variant keys stay on one line');
  assert.match(context, /^live state ``loaded` - \[x\] .*``$/);
});

test('escapeInlineMarkdown and safeKey neutralise control characters without changing normal keys', () => {
  assert.equal(escapeInlineMarkdown('a\r\nb\tc'), 'a b c');
  assert.equal(escapeInlineMarkdown('<!-- x -->'), '&lt;\\!-- x --&gt;');
  assert.equal(escapeInlineMarkdown('[x](y) *b* _i_ `c` | #'), '\\[x\\](y) \\*b\\* \\_i\\_ \\`c\\` \\| \\#');
  assert.equal(escapeInlineMarkdown('@team'), '@​team');
  assert.equal(safeKey('home@1280'), 'home@1280');
  assert.equal(safeKey('pricing-nav-open@390'), 'pricing-nav-open@390');
  assert.equal(safeKey('a\nb\r\tc'), 'a-b--c');
});

test('end-to-end: a region volatile only on the head is named and never reads as a clean no-change', () => {
  // The base settled and compared the button; the head stopped settling it (a PR
  // that added an interval). Its colour change must not vanish into a green.
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    after: {
      ...sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
      volatile: ['body > div:nth-child(1) > button:nth-child(1)'],
    },
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.deepEqual(res.headOnlyVolatile, [
    { surface: 'home@1280', path: 'body > div:nth-child(1) > button:nth-child(1)' },
  ]);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.doesNotMatch(md, /✓ No reviewable computed-style changes/);
  assert.match(md, /✗ Not certified — a subtree became volatile on head/);
  assert.match(md, /1 subtree\(s\) newly volatile on head/);
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.equal(json.volatility.headOnly.length, 1);
  rmTmp(root);
});

test('end-to-end: live-state metadata labels the report surface', () => {
  const before = {
    ...sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    metadata: { surfaceKey: 'dashboard', variantKey: 'loaded', variantKind: 'live-state' },
  };
  const after = {
    ...sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
    metadata: { surfaceKey: 'dashboard', variantKey: 'loaded', variantKind: 'live-state' },
  };
  const { beforeDir, afterDir, outDir, root } = pairFixture({ surface: 'dashboard-loaded@1440', before, after });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  assert.match(md, /dashboard-loaded @ 1440 · live state `loaded`/);
  rmTmp(root);
});

test('end-to-end: state-recipe metadata labels the report surface with recipe provenance', () => {
  const metadata = {
    surfaceKey: 'dashboard',
    variantKey: 'press-open-menu-arrowdown',
    variantKind: 'state-recipe',
    stateRecipe: {
      stateKey: 'press-open-menu-arrowdown',
      action: 'press',
      selector: '#menu',
      key: 'ArrowDown',
    },
  };
  const before = { ...sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), metadata };
  const after = { ...sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }), metadata };
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'dashboard-press-open-menu-arrowdown@1440',
    before,
    after,
  });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  assert.match(md, /dashboard-press-open-menu-arrowdown @ 1440 · state recipe `press-open-menu-arrowdown`/);
  assert.doesNotMatch(md, /· variant `press-open-menu-arrowdown`/);
  rmTmp(root);
});

test('end-to-end: state coverage is a separate exact recipe ledger without invented percentages', () => {
  const metadata = {
    surfaceKey: 'dashboard',
    variantKey: 'toast-visible',
    variantKind: 'state-recipe',
    stateRecipe: {
      stateKey: 'toast-visible',
      action: 'click',
      selector: '#notify',
      observationMs: 250,
    },
  };
  const before = { ...sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), metadata };
  const after = { ...sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }), metadata };
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'dashboard-toast-visible@1440',
    before,
    after,
  });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');

  assert.match(md, /## State coverage/);
  assert.match(md, /Captured recipe states: 1 across 1 surface/);
  assert.match(md, /\| `dashboard` \| `toast-visible` \| `click` \| observation 250 ms \|/);
  assert.doesNotMatch(md, /State coverage[^#]*%/s);
  assert.doesNotMatch(md, /Route coverage/);
  rmTmp(root);
});

test('end-to-end: forced-state echoes are suppressed and the change reads in plain English', () => {
  // A button recoloured amber → cyan. Its :hover delta echoes that base change,
  // and a :focus delta leaks grid-template-columns as a (gone) artifact. Both are
  // noise: only the base recolour is a real, reviewable change.
  const el = (color) => ({
    tag: 'button',
    cls: 'on',
    rect: [10, 10, 120, 32],
    style: { color, 'border-color': color },
  });
  const states = (color, grid) => ({
    'body > button:nth-child(1)': {
      hover: { 'body > button:nth-child(1)': { color } },
      focus: { 'body > button:nth-child(1)': { 'grid-template-columns': grid } },
    },
  });
  const before = makeMap({
    elements: { 'body > button:nth-child(1)': el('rgb(255, 196, 77)') },
    states: states('rgb(255, 196, 77)', '380px'),
  });
  const after = makeMap({
    elements: { 'body > button:nth-child(1)': el('rgb(63, 233, 255)') },
    states: states('rgb(63, 233, 255)', '(gone)'),
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before,
    after,
    beforePng: solidPng(1280, 400),
    afterPng: solidPng(1280, 400),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.equal(json.counts.state, 0); // hover echo + (gone) focus delta both suppressed
  assert.equal(json.counts.style, 2); // color + border-color, the real change
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /recoloured/); // plain-English bullet, not a raw prop dump
  assert.doesNotMatch(md, /\(gone\)/);
  rmTmp(root);
});

// #917: only the proven auto margin echoes disappear; their own state's size stays reviewable.
function autoMarginResizeMap(width, color, sizeProp = 'width', changedMargins = true) {
  const owner = 'body > a:nth-child(1)';
  const child = `${owner} > div:nth-child(1)`;
  const margins = ['margin-left', 'margin-right', 'margin-inline-start', 'margin-inline-end'];
  const auto = Object.fromEntries(margins.map((prop) => [prop, 'auto']));
  const used = Object.fromEntries(margins.map((prop) => [prop, `${(1000 - width) / 2}px`]));
  return {
    ...makeMap({
      elements: {
        [owner]: { tag: 'a', rect: [0, 0, 1000, 100] },
        [child]: { tag: 'div', rect: [400, 0, 200, 100], computedValueStyle: auto },
        'body > h1:nth-child(2)': { tag: 'h1', rect: [0, 120, 200, 40], style: { color } },
      },
      states: {
        [owner]: {
          hover: {
            [child]: {
              [sizeProp]: `${width}px`,
              'transform-origin': `${width / 2}px 50px`,
              'perspective-origin': `${width / 2}px 50px`,
              ...(changedMargins ? used : {}),
            },
          },
        },
      },
    }),
    stateComputedValueStyle: { [owner]: { hover: { [child]: auto } } },
  };
}

for (const unrelatedColorChange of [false, true]) {
  for (const sizeProp of ['width', 'inline-size']) {
    test(`end-to-end: auto margin echo keeps hover ${sizeProp} reviewable (unrelated colour: ${unrelatedColorChange})`, () => {
      const before = autoMarginResizeMap(300, 'red', sizeProp);
      const after = autoMarginResizeMap(320, unrelatedColorChange ? 'blue' : 'red', sizeProp);
      const raw = diffStyleMaps(before, after);
      const display = cleanFindingsForDisplay(raw);
      const state = display.find((finding) => finding.kind === 'state');
      assert.deepEqual(state?.props, [
        { prop: sizeProp, before: '300px', after: '320px' },
        { prop: 'transform-origin', before: '150px 50px', after: '160px 50px' },
        { prop: 'perspective-origin', before: '150px 50px', after: '160px 50px' },
      ]);
      assert.equal(derivedLonghandCount(raw), 0, 'the affected state keeps all size/position evidence');
      assert.ok(raw.every((finding) => finding.props.every((p) => !p.prop.startsWith('margin'))));
      const truth = assessComparisonTruth([{ surface: 'home@1280', findings: raw }]);
      assert.deepEqual(truth.reviewableCounts, { dom: 0, style: Number(unrelatedColorChange), state: 3 });
      assert.equal(truth.hasReviewableEvidence, true);
      assert.equal(truth.rawOnlyNoReviewable, false);

      const { beforeDir, afterDir, outDir, root } = pairFixture({ surface: 'home@1280', before, after });
      try {
        const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
        const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
        assert.deepEqual(result.comparison.reviewableCounts, truth.reviewableCounts);
        assert.equal(result.comparison.hasReviewableEvidence, true);
        assert.equal(result.comparison.rawOnlyNoReviewable, false);
        assert.deepEqual(report.reportConsistency, { ok: true, reason: 'aligned' });
        assert.deepEqual(report.counts, truth.reviewableCounts);
        const shownState = report.surfaces.flatMap((surface) => surface.findings).find((f) => f.kind === 'state');
        assert.deepEqual(shownState?.props, state.props, 'the report JSON includes the size evidence');
        const md = fs.readFileSync(result.reportMdPath, 'utf8');
        assert.match(md, /hover/);
        assert.ok(md.includes(sizeProp), 'the size evidence reaches the rendered report');
        assert.doesNotMatch(md, /margin-(left|right|inline-start|inline-end)/);
      } finally {
        rmTmp(root);
      }
    });
  }
}

for (const unrelatedColorChange of [false, true]) {
  test(`end-to-end: a margin-only child keeps its container hover resize reviewable (unrelated colour: ${unrelatedColorChange})`, () => {
    const owner = 'body > a:nth-child(1)';
    const child = `${owner} > div:nth-child(1)`;
    const before = autoMarginResizeMap(300, 'red');
    const after = autoMarginResizeMap(320, unrelatedColorChange ? 'blue' : 'red');
    for (const [map, width, margin] of [
      [before, '300px', '50px'],
      [after, '320px', '60px'],
    ]) {
      map.states[owner].hover = {
        [owner]: { width, 'inline-size': width },
        [child]: Object.fromEntries(
          ['margin-left', 'margin-right', 'margin-inline-start', 'margin-inline-end'].map((prop) => [prop, margin]),
        ),
      };
    }
    const raw = diffStyleMaps(before, after);
    const display = cleanFindingsForDisplay(raw);
    const expectedState = {
      kind: 'state',
      path: owner,
      cls: '',
      state: 'hover',
      sub: owner,
      props: [
        { prop: 'width', before: '300px', after: '320px' },
        { prop: 'inline-size', before: '300px', after: '320px' },
      ],
      autoMarginEchoDropped: true,
    };
    assert.deepEqual(
      display.filter((f) => f.kind === 'state'),
      [expectedState],
    );
    assert.ok(
      raw.every((f) => f.kind !== 'state' || f.sub !== child),
      'the margin-only target stays omitted',
    );
    assert.equal(derivedLonghandCount(raw), 0);
    const truth = assessComparisonTruth([{ surface: 'home@1280', findings: raw }]);
    assert.deepEqual(truth.reviewableCounts, { dom: 0, style: Number(unrelatedColorChange), state: 2 });
    assert.equal(truth.hasReviewableEvidence, true);
    assert.equal(truth.rawOnlyNoReviewable, false);

    const { beforeDir, afterDir, outDir, root } = pairFixture({ surface: 'home@1280', before, after });
    try {
      const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
      const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
      assert.deepEqual(result.comparison.reviewableCounts, truth.reviewableCounts);
      assert.equal(result.comparison.hasReviewableEvidence, true);
      assert.equal(result.comparison.rawOnlyNoReviewable, false);
      assert.deepEqual(report.reportConsistency, { ok: true, reason: 'aligned' });
      assert.deepEqual(report.counts, truth.reviewableCounts);
      assert.deepEqual(
        report.surfaces.flatMap((surface) => surface.findings).filter((f) => f.kind === 'state'),
        [expectedState],
      );
      const md = fs.readFileSync(result.reportMdPath, 'utf8');
      assert.match(md, /hover/);
      assert.match(md, /width/);
      assert.match(md, /300px/);
      assert.match(md, /320px/);
      assert.doesNotMatch(md, /margin-(left|right|inline-start|inline-end)/);
    } finally {
      rmTmp(root);
    }
  });
}

test('auto margin retention covers other targets and position/grid evidence only in the affected owner and state', () => {
  const owner = 'body > a:nth-child(1)';
  const child = `${owner} > div:nth-child(1)`;
  const target = 'body > p:nth-child(3)';
  const before = autoMarginResizeMap(300, 'red', 'left');
  const after = autoMarginResizeMap(320, 'blue', 'left');
  for (const [map, left, tracks] of [
    [before, '10px', '100px 100px'],
    [after, '20px', '110px 110px'],
  ]) {
    map.elements[target] = { tag: 'p', cls: '', style: {} };
    const geometry = { left, 'grid-template-columns': tracks };
    map.states[owner].hover[target] = geometry;
    map.states[owner].focus = { [target]: geometry };
    map.states[target] = { hover: { [target]: geometry } };
  }
  const raw = diffStyleMaps(before, after);
  const affected = raw.filter((f) => f.kind === 'state' && f.path === owner && f.state === 'hover');
  assert.equal(affected.length, 2);
  assert.ok(affected.every((f) => f.autoMarginEchoDropped === true));
  const display = cleanFindingsForDisplay(raw);
  assert.deepEqual(
    display.filter((f) => f.kind === 'state'),
    affected,
  );
  assert.ok(affected.find((f) => f.sub === child).props.some((p) => p.prop === 'left'));
  assert.deepEqual(
    affected.find((f) => f.sub === target).props.map((p) => p.prop),
    ['left', 'grid-template-columns'],
  );
  const unmarked = raw.filter((f) => f.kind === 'state' && !affected.includes(f));
  assert.equal(unmarked.length, 2);
  assert.ok(unmarked.every((f) => !Object.hasOwn(f, 'autoMarginEchoDropped')));
  const legacyBefore = { ...before, stateComputedValueStyle: undefined };
  const legacyAfter = { ...after, stateComputedValueStyle: undefined };
  const legacyUnaffected = diffStyleMaps(legacyBefore, legacyAfter).filter(
    (f) => f.kind === 'state' && (f.path !== owner || f.state !== 'hover'),
  );
  assert.equal(JSON.stringify(unmarked), JSON.stringify(legacyUnaffected));
  assert.deepEqual(cleanFindingsForDisplay(unmarked), []);
  const truth = assessComparisonTruth([{ surface: 'home@1280', findings: raw }]);
  assert.equal(truth.hasReviewableEvidence, true);
  assert.equal(truth.rawOnlyNoReviewable, false);
});

test('retained auto-margin size evidence leaves unrelated style fallback and state stripping unchanged', () => {
  const before = autoMarginResizeMap(300, 'red');
  const after = autoMarginResizeMap(320, 'red');
  for (const [map, width] of [
    [before, '100px'],
    [after, '120px'],
  ]) {
    map.elements['body > p:nth-child(3)'] = { tag: 'p', cls: '', style: { width } };
    map.states['body > a:nth-child(1)'].focus = { 'body > p:nth-child(3)': { width } };
  }
  const raw = diffStyleMaps(before, after);
  const display = cleanFindingsForDisplay(raw);
  assert.deepEqual(
    display.map((f) => [f.kind, f.state, f.props.map((p) => p.prop)]),
    [
      ['style', undefined, ['width']],
      ['state', 'hover', ['width', 'transform-origin', 'perspective-origin']],
    ],
  );
  assert.deepEqual(assessComparisonTruth([{ surface: 'home@1280', findings: raw }]).reviewableCounts, {
    dom: 0,
    style: 1,
    state: 3,
  });
});

test('auto proof without removed margin rows keeps the existing state-strip behaviour', () => {
  const before = autoMarginResizeMap(300, 'red', 'width', false);
  const after = autoMarginResizeMap(320, 'blue', 'width', false);
  const raw = diffStyleMaps(before, after);
  const state = raw.find((finding) => finding.kind === 'state');
  assert.deepEqual(Object.keys(state), ['kind', 'path', 'cls', 'state', 'sub', 'props']);
  assert.deepEqual(
    cleanFindingsForDisplay(raw).map((finding) => finding.kind),
    ['style'],
  );
  const stateOnly = raw.filter((finding) => finding.kind === 'state');
  assert.deepEqual(cleanFindingsForDisplay(stateOnly), []);
  assert.equal(assessComparisonTruth([{ surface: 'home@1280', findings: stateOnly }]).rawOnlyNoReviewable, true);
  const legacyBefore = { ...before };
  const legacyAfter = { ...after };
  delete legacyBefore.stateComputedValueStyle;
  delete legacyAfter.stateComputedValueStyle;
  const legacyRaw = diffStyleMaps(legacyBefore, legacyAfter);
  assert.equal(JSON.stringify(raw), JSON.stringify(legacyRaw), 'unchanged finding bytes');
  assert.equal(signatureOf(raw), signatureOf(legacyRaw), 'unchanged signatures');
  const { beforeDir, afterDir, outDir, root } = pairFixture({ surface: 'home@1280', before, after });
  try {
    const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
    const reportBytes = fs.readFileSync(result.reportJsonPath, 'utf8');
    writeCapture(beforeDir, 'home@1280', legacyBefore, null);
    writeCapture(afterDir, 'home@1280', legacyAfter, null);
    const legacyResult = generateStyleMapReport({ beforeDir, afterDir, outDir });
    assert.equal(fs.readFileSync(legacyResult.reportJsonPath, 'utf8'), reportBytes, 'unchanged report.json bytes');
  } finally {
    rmTmp(root);
  }
});

test('end-to-end: includeLayoutNoise keeps the reflow-casualty element beside its driver', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    // Driver on the button (background-color) + casualty on body (height only):
    // the casualty folds by default and is kept only under includeLayoutNoise.
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    after: sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 820 }),
  });
  const off = generateStyleMapReport({ beforeDir, afterDir, outDir: path.join(outDir, 'off') });
  assert.equal(off.changedSurfaces, 1);
  const offJson = JSON.parse(fs.readFileSync(off.reportJsonPath, 'utf8'));
  assert.equal(offJson.counts.style, 1, 'casualty height folded behind the driver');
  const on = generateStyleMapReport({ beforeDir, afterDir, outDir: path.join(outDir, 'on'), includeLayoutNoise: true });
  const onJson = JSON.parse(fs.readFileSync(on.reportJsonPath, 'utf8'));
  assert.ok(onJson.counts.style > 1, 'noise mode keeps the casualty height row');
  rmTmp(root);
});

test('end-to-end: a derived-only change renders as reviewable evidence — verdict and report agree', () => {
  // Generic consumer-shaped pair: several surfaces, only derived longhands
  // differ (content-length drift). The differ gates on these, so the report must
  // RENDER them — labelled — instead of failing closed with no evidence; the
  // raw-only CERTIFICATION_FAILED backstop is reserved for shapes that truly
  // cannot render (state-strip-only deltas).
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  for (const surface of ['home@1280', 'about@1280', 'pricing@390']) {
    writeCapture(beforeDir, surface, sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), solidPng(400, 200));
    writeCapture(afterDir, surface, sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 900 }), solidPng(400, 200));
  }
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 3);
  assert.equal(res.newSurfaces, 0);
  assert.equal(res.comparison.rawOnlyNoReviewable, false);
  assert.ok(res.comparison.rawCounts.style >= 3, 'raw style diffs across surfaces');
  assert.ok(res.comparison.reviewableCounts.style >= 3, 'the same diffs are reviewable evidence');
  assert.equal(res.comparison.hasReviewableEvidence, true);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.doesNotMatch(md, /All surfaces identical/);
  assert.match(md, /size\/position only, no styling property changed/);
  assert.match(md, /content-length drift/);
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.equal(json.reportConsistency.ok, true);
  rmTmp(root);
});
