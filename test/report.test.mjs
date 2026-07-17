import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  generateStyleMapReport,
  summarizeProps,
  prettyLabel,
  describeChange,
  colorName,
  tokenIndex,
  toHex,
} from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, pairFixture, tmpDirs, writeCapture } from './helpers.mjs';

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

function sceneMap({ buttonColor, bodyHeight }) {
  // body is a reflow casualty: its only change is height (a DERIVED prop).
  // The real, styling-intent change is the button's background-color.
  return makeMap({
    defaults: {},
    elements: {
      body: { tag: 'body', cls: '', rect: [0, 0, 1280, bodyHeight], style: { height: `${bodyHeight}px` } },
      'body > div:nth-child(1)': { tag: 'div', cls: 'wrap', rect: [20, 20, 1240, 300], style: { display: 'block' } },
      'body > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta primary',
        rect: [100, 100, 160, 48],
        style: { 'background-color': buttonColor },
      },
    },
  });
}

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
  assert.match(md, /🔬 magnified \d+× — change too small to see at 1:1/, 'zoom is captioned with its factor');
  assert.match(md, /🔍 magenta boxes mark each change/, 'the highlight is shown by default');
  assert.match(md, /changed: `span\.caret`/, 'the changed element is named next to the image');
  assert.doesNotMatch(
    md,
    /<summary>🔍 Highlight what changed<\/summary>/,
    'highlight is no longer hidden behind a toggle',
  );
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
  assert.match(md, /🔍 magenta boxes mark each change/, 'highlight still shown by default');
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
  assert.match(md, /\*\*1 computed-style difference\(s\)\*\* across/);
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
  assert.doesNotMatch(markdown, /!\[before/);
  assert.equal(report.surfaces[0].visualEvidence, 'not-rendered');
  assert.equal(
    fs.readdirSync(path.join(outDir, 'crops')).filter((fileName) => fileName.endsWith('.png')).length,
    0,
    'no duplicate crop files are emitted',
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
  assert.match(md, /### `a\.nav-cta` · 1 element restyled/);
  assert.match(md, /### `div\.card` · 1 element restyled/);

  // Split on the headings and assert each section carries ONLY its own property.
  const sections = md.split(/\n### /).slice(1);
  const nav = sections.find((s) => s.startsWith('`a.nav-cta`'));
  const card = sections.find((s) => s.startsWith('`div.card`'));
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
    commentSummary.indexOf('🆕 **1 new surface(s)**') < commentSummary.indexOf('**1 computed-style difference(s)**'),
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
  assert.ok(!inline.includes('<summary>Show'), 'foldDetailsAt: Infinity keeps the tables out of a fold');
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
  assert.match(md, /\*\*Added\*\* `a\.link`/);
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
  assert.match(md, /\*\*Added\*\* `button\.btn`/);
  assert.match(md, /Style:/);
  assert.match(md, /\| Property \| Value \|/); // value-only, no bogus Before column
  assert.match(md, /`background-color` \| `#005afc`/);
  assert.match(md, /`padding` \| `6px 12px`/);
  assert.match(md, /`border-radius` \| `4px`/);
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
  const row = md.split('\n').find((l) => l.includes('`background-image`'));
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

test('end-to-end: no differences yields the all-identical report and zero surfaces', () => {
  const same = sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 });
  const { beforeDir, afterDir, outDir, root } = pairFixture({ surface: 'home@1280', before: same, after: same });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 0);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /✓ All surfaces identical/);
  rmTmp(root);
});

test('end-to-end: a surface missing on one side is reported as a new surface, not crashed on', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  writeCapture(beforeDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  writeCapture(afterDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  writeCapture(beforeDir, 'about@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  // Framed as a new surface, carrying the marker the PR comment uses for approval
  // policy — never the misleading "0 changes".
  assert.match(md, /### `about@1280` · new surface <!-- styleproof-new -->/);
  assert.match(md, /🆕 \*\*1 new surface\(s\)\*\*/);
  assert.match(md, /Approve them before they become the baseline/);
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
  const changedElementIndex = md.indexOf('### `button');
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
  assert.match(md, /top viewport of page/);
  rmTmp(root);
});

test('end-to-end: a live region is auto-excluded and noted, not reported as a change', () => {
  // After differs ONLY on a path the after-capture flagged volatile (a live region).
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
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
  assert.match(md, /✓ All surfaces identical/);
  assert.match(md, /1 live region\(s\) auto-excluded/);
  assert.match(md, /Auto-detected live-state candidate\(s\): button\.cta \(role=status\)/);
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

test('end-to-end: includeLayoutNoise keeps the reflow-casualty element', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    after: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 820 }), // only body height differs
  });
  // Without noise: body-only height change is stripped -> no real change.
  const off = generateStyleMapReport({ beforeDir, afterDir, outDir: path.join(outDir, 'off') });
  assert.equal(off.changedSurfaces, 0);
  // Consistency: raw certification deltas exist but no reviewable crops.
  assert.equal(off.comparison.rawOnlyNoReviewable, true);
  assert.ok(off.comparison.rawCounts.style > 0);
  assert.equal(off.comparison.reviewableCounts.style, 0);
  const mdOff = fs.readFileSync(off.reportMdPath, 'utf8');
  assert.match(mdOff, /Report consistency failure|raw_only|derived\/reflow/i);
  assert.doesNotMatch(mdOff, /All surfaces identical/);
  const jsonOff = JSON.parse(fs.readFileSync(off.reportJsonPath, 'utf8'));
  assert.equal(jsonOff.reportConsistency.ok, false);
  assert.equal(jsonOff.reportConsistency.reason, 'raw_only_no_reviewable');
  // No crops for a raw-only inconsistency (nothing reviewable to approve).
  const cropsOff = fs.existsSync(path.join(outDir, 'off', 'crops'))
    ? fs.readdirSync(path.join(outDir, 'off', 'crops'))
    : [];
  assert.equal(cropsOff.length, 0);
  // With noise: the height change surfaces.
  const on = generateStyleMapReport({ beforeDir, afterDir, outDir: path.join(outDir, 'on'), includeLayoutNoise: true });
  assert.equal(on.changedSurfaces, 1);
  assert.equal(on.comparison.rawOnlyNoReviewable, false);
  rmTmp(root);
});

test('end-to-end: multi-surface raw-only reflow cannot claim identical or produce crops', () => {
  // Generic dogfood-shaped pair: several surfaces, only derived longhands differ.
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  for (const surface of ['home@1280', 'about@1280', 'pricing@390']) {
    writeCapture(beforeDir, surface, sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), solidPng(400, 200));
    writeCapture(afterDir, surface, sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 900 }), solidPng(400, 200));
  }
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 0);
  assert.equal(res.newSurfaces, 0);
  assert.equal(res.comparison.rawOnlyNoReviewable, true);
  assert.ok(res.comparison.rawCounts.style >= 3, 'raw style diffs across surfaces');
  assert.equal(res.comparison.reviewableCounts.style, 0);
  assert.equal(res.comparison.hasReviewableEvidence, false);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.doesNotMatch(md, /All surfaces identical/);
  assert.match(md, /CERTIFICATION_FAILED|consistency failure/i);
  const crops = fs.existsSync(path.join(outDir, 'crops')) ? fs.readdirSync(path.join(outDir, 'crops')) : [];
  assert.equal(crops.length, 0, 'no crops when nothing is reviewable');
  rmTmp(root);
});

// ------------------------------------------------- describeChange / colorName
// (plain-English summariser, re-exported from report.js so this stays a single
// dist import — see report.ts)

test('colorName maps rgb to a legible palette word', () => {
  assert.equal(colorName('rgb(38, 198, 218)'), 'cyan');
  assert.equal(colorName('rgb(33, 110, 233)'), 'blue');
  assert.equal(colorName('rgba(0, 0, 0, 0)'), 'transparent');
  assert.equal(colorName('transparent'), 'transparent');
  assert.equal(colorName('none'), null); // not a colour
});

test('describeChange names a grid column-count change', () => {
  const out = describeChange([
    { label: 'div.grid', props: [{ prop: 'grid-template-columns', before: '380px ×2', after: '253px 253px 253px' }] },
  ]);
  assert.ok(
    out.some((l) => /columns: 2 → 3/.test(l)),
    out.join('\n'),
  );
});

test('describeChange describes a centered flex layout switch in English', () => {
  const out = describeChange([
    {
      label: 'span.led',
      props: [
        { prop: 'display', before: 'block', after: 'flex' },
        { prop: 'justify-content', before: 'normal', after: 'center' },
        { prop: 'align-items', before: 'normal', after: 'center' },
      ],
    },
  ]);
  assert.ok(
    out.some((l) => /centered.*flex/.test(l)),
    out.join('\n'),
  );
});

test('describeChange collapses an identical recolour across many elements to ×N', () => {
  const recolor = (label) => ({
    label,
    props: [
      { prop: 'color', before: 'rgb(255, 196, 77)', after: 'rgb(63, 233, 255)' },
      { prop: 'border-color', before: 'rgb(255, 196, 77)', after: 'rgb(63, 233, 255)' },
    ],
  });
  const out = describeChange(Array.from({ length: 14 }, (_, i) => recolor(`button.b${i}`)));
  const recolorLines = out.filter((l) => /recoloured/.test(l));
  assert.equal(recolorLines.length, 1, out.join('\n'));
  assert.match(recolorLines[0], /×14/);
});

test('describeChange labels a single restyled element and flags interaction-state changes', () => {
  const out = describeChange([
    { label: 'button.on', props: [{ prop: 'border-radius', before: '50%', after: '8px' }], states: ['hover', 'focus'] },
  ]);
  assert.ok(
    out.some((l) => /\*\*`button\.on`\*\* —/.test(l)),
    out.join('\n'),
  );
  assert.ok(
    out.some((l) => /interaction states.*:hover.*:focus/.test(l)),
    out.join('\n'),
  );
});

test('describeChange reports added/removed counts', () => {
  const out = describeChange([
    { label: 'div.a', added: true, props: [] },
    { label: 'div.b', added: true, props: [] },
    { label: 'span.c', removed: true, props: [] },
  ]);
  assert.ok(out.some((l) => /\*\*2\*\* elements added/.test(l)));
  assert.ok(out.some((l) => /\*\*1\*\* element removed/.test(l)));
});

// ------------------------------------------------ colour tokens / hex / folding

test('toHex renders opaque colours as #hex and keeps alpha as rgba', () => {
  assert.equal(toHex('rgb(254, 226, 226)'), '#fee2e2');
  assert.equal(toHex('rgba(0, 0, 0, 0.5)'), 'rgba(0, 0, 0, 0.5)');
  assert.equal(toHex('none'), 'none'); // non-colour untouched
  // A colour EMBEDDED in a longer value must not stand in for the whole value
  // (seen downstream: a gradient rendered as the same rgba on both sides of a real diff).
  const g = 'repeating-linear-gradient(0deg, rgba(0, 0, 0, 0), rgba(0, 20, 30, 0.18) 3px)';
  assert.equal(toHex(g), g);
  assert.equal(toHex('rgba(0, 0, 0, 0.5) 0px 2px 4px'), 'rgba(0, 0, 0, 0.5) 0px 2px 4px');
});

test('tokenIndex prefers the scale token over an alias with the same value', () => {
  const idx = tokenIndex({
    '--red-200': 'rgb(254, 202, 202)',
    '--primary-background': 'rgb(254, 202, 202)', // alias
  });
  assert.equal(idx.get('254,202,202,1'), 'red-200');
});

test('describeChange names the theme token behind a colour change', () => {
  const ctx = {
    tokensBefore: tokenIndex({ '--red-100': 'rgb(254, 226, 226)' }),
    tokensAfter: tokenIndex({ '--red-200': 'rgb(254, 202, 202)' }),
  };
  const out = describeChange(
    [
      {
        label: 'div.card',
        props: [{ prop: 'background-color', before: 'rgb(254, 226, 226)', after: 'rgb(254, 202, 202)' }],
      },
    ],
    ctx,
  );
  assert.ok(
    out.some((l) => /background `red-100` \(`#fee2e2`\) → `red-200` \(`#fecaca`\)/.test(l)),
    out.join('\n'),
  );
});

test('describeChange shows hex-only for a colour whose word does not change (no white → white)', () => {
  const out = describeChange([
    { label: 'p', props: [{ prop: 'color', before: 'rgb(255, 255, 255)', after: 'rgb(250, 250, 250)' }] },
  ]);
  const line = out.find((l) => /text/.test(l));
  assert.ok(line, out.join('\n'));
  assert.match(line, /text `#ffffff` → `#fafafa`/);
  assert.doesNotMatch(line, /white → white/);
});

test('describeChange folds near-identical same-label elements to ×N with shared changes', () => {
  const led = (bg) => ({
    label: 'span.led',
    props: [
      { prop: 'border-radius', before: '50%', after: '8px' },
      { prop: 'background-color', before: bg, after: 'rgb(0, 0, 0)' },
    ],
  });
  const out = describeChange([led('rgb(254, 226, 226)'), led('rgb(255, 255, 0)')]);
  const ledLine = out.find((l) => /span\.led/.test(l));
  assert.ok(ledLine, out.join('\n'));
  assert.match(ledLine, /×2/);
  assert.match(ledLine, /corners squared off/); // the shared change
  assert.match(ledLine, /details vary/); // the differing background
});

test('describeChange caps an element to a few phrases plus a +N more count', () => {
  const out = describeChange([
    {
      label: 'div.busy',
      props: [
        { prop: 'display', before: 'block', after: 'flex' },
        { prop: 'border-radius', before: '0px', after: '8px' },
        { prop: 'color', before: 'rgb(0,0,0)', after: 'rgb(255,0,0)' },
        { prop: 'box-shadow', before: 'none', after: '0 1px 2px black' },
        { prop: 'opacity', before: '1', after: '0.5' },
        { prop: 'font-size', before: '16px', after: '18px' },
      ],
    },
  ]);
  const line = out.find((l) => /div\.busy/.test(l));
  assert.ok(line, out.join('\n'));
  assert.match(line, /\+\d+ more/);
});

// ----------------------------------------------- describe polish (1.7.1)

test('describeChange does not repeat a role word that equals the token name', () => {
  const ctx = {
    tokensBefore: tokenIndex({ '--text': 'rgb(191, 233, 245)' }), // #bfe9f5
    tokensAfter: tokenIndex({ '--cyan-bright': 'rgb(141, 246, 255)' }), // #8df6ff
  };
  const out = describeChange(
    [{ label: 'span', props: [{ prop: 'color', before: 'rgb(191, 233, 245)', after: 'rgb(141, 246, 255)' }] }],
    ctx,
  );
  const joined = out.join('\n');
  assert.doesNotMatch(joined, /text `text`/); // no "text `text`"
  assert.match(joined, /`text` \(`#bfe9f5`\) → `cyan-bright` \(`#8df6ff`\)/);
});

test('describeChange folds same-label elements with no shared change to "e.g. … vary"', () => {
  const out = describeChange([
    { label: 'span.v', props: [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' }] },
    { label: 'span.v', props: [{ prop: 'border-radius', before: '0px', after: '8px' }] },
  ]);
  const line = out.find((l) => /span\.v/.test(l));
  assert.ok(line, out.join('\n'));
  assert.match(line, /×2/);
  assert.match(line, /e\.g\./); // names the most common changes, not just "restyled"
  assert.match(line, /vary/);
});

// --------------------------------------------- responsive grouping (1.7.2)

test('end-to-end: responsive grids (same track count, different px) collapse to one section', () => {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  // The SAME change at two widths: grid-template-rows computes to different px but
  // the same track count (2), plus an identical colour change. One section, not two.
  const map = (rows, color) =>
    makeMap({
      elements: {
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'netgrid',
          rect: [0, 0, 400, 200],
          style: { 'grid-template-rows': rows, color },
        },
      },
    });
  writeCapture(beforeDir, 'agents@1024', map('282px 282px', 'rgb(0, 0, 0)'), solidPng(1024, 400));
  writeCapture(afterDir, 'agents@1024', map('295px 295px', 'rgb(255, 0, 0)'), solidPng(1024, 400));
  writeCapture(beforeDir, 'agents@1440', map('282px 228px', 'rgb(0, 0, 0)'), solidPng(1440, 400));
  writeCapture(afterDir, 'agents@1440', map('295px 228px', 'rgb(255, 0, 0)'), solidPng(1440, 400));
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.equal((md.match(/^### `div\.netgrid`/gm) || []).length, 1, 'one grouped section, not one per width');
  assert.match(md, /Identical across 2 surfaces/);
  rmTmp(root);
});

// ---------------------------------------------- annotated crops (1.8.0)

function highlightPixelsBySide(filePath) {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  const dividerWidth = 12;
  const halfWidth = (png.width - dividerWidth) / 2;
  let before = 0;
  let after = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      if (png.data[offset] !== 255 || png.data[offset + 1] !== 0 || png.data[offset + 2] !== 200) continue;
      if (x < halfWidth) before++;
      else if (x >= halfWidth + dividerWidth) after++;
    }
  }
  return { before, after };
}

test('end-to-end: each crop shows a clean image plus a highlighted twin by default', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    after: sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /!\[before ◀ │ ▶ after\]\(crops\/[^)]+-composite\.png\)/, 'clean composite shown');
  assert.doesNotMatch(md, /<summary>🔍 Highlight what changed<\/summary>/, 'highlight is not hidden behind a toggle');
  assert.match(md, /!\[highlighted[^\]]*\]\(crops\/[^)]+-annotated\.png\)/, 'highlighted image shown by default');
  const crops = fs.readdirSync(path.join(outDir, 'crops'));
  const ann = crops.find((f) => f.endsWith('-annotated.png'));
  assert.ok(ann && crops.some((f) => f.endsWith('-composite.png')), 'both image files written');
  // The annotated twin actually contains the magenta highlight outline.
  const png = PNG.sync.read(fs.readFileSync(path.join(outDir, 'crops', ann)));
  let hasHilite = false;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 200) {
      hasHilite = true;
      break;
    }
  }
  assert.ok(hasHilite, 'annotated crop contains the highlight colour');
  rmTmp(root);
});

test('end-to-end: sibling insertion highlights the real addition, not path-shifted content', () => {
  const before = makeMap({
    elements: {
      body: { tag: 'body', cls: '', rect: [0, 0, 640, 400], style: {} },
      'body > main:nth-child(1)': { tag: 'main', cls: 'page', rect: [0, 0, 640, 400], style: {} },
      'body > main:nth-child(1) > div:nth-child(1)': {
        tag: 'div',
        cls: 'toolbar',
        rect: [20, 20, 600, 40],
        style: { display: 'flex', 'background-color': 'rgb(0, 0, 0)' },
      },
      'body > main:nth-child(1) > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'filter',
        rect: [30, 30, 80, 20],
        style: { color: 'rgb(255, 255, 255)' },
      },
      'body > main:nth-child(1) > div:nth-child(2)': {
        tag: 'div',
        cls: 'grid',
        rect: [20, 80, 600, 240],
        style: { display: 'grid' },
      },
      'body > main:nth-child(1) > div:nth-child(2) > article:nth-child(1)': {
        tag: 'article',
        cls: 'card',
        rect: [20, 80, 280, 200],
        style: { 'background-color': 'rgb(8, 18, 32)' },
      },
      'body > main:nth-child(1) > div:nth-child(2) > article:nth-child(1) > span:nth-child(1)': {
        tag: 'span',
        cls: 'title',
        rect: [30, 90, 120, 20],
        style: { color: 'rgb(255, 255, 255)' },
      },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', cls: '', rect: [0, 0, 640, 460], style: {} },
      'body > main:nth-child(1)': { tag: 'main', cls: 'page', rect: [0, 0, 640, 460], style: {} },
      'body > main:nth-child(1) > div:nth-child(1)': {
        tag: 'div',
        cls: 'switch',
        rect: [420, 20, 200, 40],
        style: { display: 'flex', 'background-color': 'rgb(30, 10, 40)' },
      },
      'body > main:nth-child(1) > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'scope',
        rect: [430, 30, 80, 20],
        style: { color: 'rgb(255, 0, 200)' },
      },
      'body > main:nth-child(1) > div:nth-child(2)': {
        tag: 'div',
        cls: 'toolbar',
        rect: [20, 80, 600, 40],
        style: { display: 'flex', 'background-color': 'rgb(0, 0, 0)' },
      },
      'body > main:nth-child(1) > div:nth-child(2) > button:nth-child(1)': {
        tag: 'button',
        cls: 'filter',
        rect: [30, 90, 80, 20],
        style: { color: 'rgb(255, 255, 255)' },
      },
      'body > main:nth-child(1) > div:nth-child(3)': {
        tag: 'div',
        cls: 'grid',
        rect: [20, 140, 600, 240],
        style: { display: 'grid' },
      },
      'body > main:nth-child(1) > div:nth-child(3) > article:nth-child(1)': {
        tag: 'article',
        cls: 'card',
        rect: [20, 140, 280, 200],
        style: { 'background-color': 'rgb(8, 18, 32)' },
      },
      'body > main:nth-child(1) > div:nth-child(3) > article:nth-child(1) > span:nth-child(1)': {
        tag: 'span',
        cls: 'title',
        rect: [30, 150, 120, 20],
        style: { color: 'rgb(255, 255, 255)' },
      },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@640',
    before,
    after,
    beforePng: solidPng(640, 400),
    afterPng: solidPng(640, 460),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPath = report.surfaces[0].regions[0].images.annotated;
  const annotated = PNG.sync.read(fs.readFileSync(path.join(outDir, annotatedPath)));
  const dividerWidth = 12;
  const halfWidth = (annotated.width - dividerWidth) / 2;
  let beforeHighlights = 0;
  let afterHighlights = 0;
  for (let y = 0; y < annotated.height; y++) {
    for (let x = 0; x < annotated.width; x++) {
      const offset = (y * annotated.width + x) * 4;
      if (annotated.data[offset] !== 255 || annotated.data[offset + 1] !== 0 || annotated.data[offset + 2] !== 200)
        continue;
      if (x < halfWidth) beforeHighlights++;
      else if (x >= halfWidth + dividerWidth) afterHighlights++;
    }
  }

  assert.equal(beforeHighlights, 0, 'unchanged elements displaced to new paths are not boxed as removals');
  assert.ok(afterHighlights > 0, 'the genuinely inserted control remains highlighted');
  assert.ok(report.counts.dom > 0, 'structural findings remain in the certification report');
  rmTmp(root);
});

test('end-to-end: duplicate siblings that swap styles keep both annotation sides', () => {
  const item = (index, color) => ({
    tag: 'li',
    cls: 'item',
    rect: [20, 20 + index * 40, 200, 30],
    style: { color },
  });
  const map = (first, second) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 400, 160], style: {} },
        'body > ul:nth-child(1)': { tag: 'ul', rect: [0, 0, 400, 160], style: {} },
        'body > ul:nth-child(1) > li:nth-child(1)': item(0, first),
        'body > ul:nth-child(1) > li:nth-child(2)': item(1, second),
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'duplicate-swap@400',
    before: map('rgb(255, 0, 0)', 'rgb(0, 0, 255)'),
    after: map('rgb(0, 0, 255)', 'rgb(255, 0, 0)'),
    beforePng: solidPng(400, 160),
    afterPng: solidPng(400, 160),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPath = report.surfaces[0].regions[0].images.annotated;
  assert.match(annotatedPath, /-annotated\.png$/);
  const annotated = PNG.sync.read(fs.readFileSync(path.join(outDir, annotatedPath)));
  const dividerWidth = 12;
  const halfWidth = (annotated.width - dividerWidth) / 2;
  let beforeHighlights = 0;
  let afterHighlights = 0;
  for (let y = 0; y < annotated.height; y++) {
    for (let x = 0; x < annotated.width; x++) {
      const offset = (y * annotated.width + x) * 4;
      if (annotated.data[offset] !== 255 || annotated.data[offset + 1] !== 0 || annotated.data[offset + 2] !== 200)
        continue;
      if (x < halfWidth) beforeHighlights++;
      else if (x >= halfWidth + dividerWidth) afterHighlights++;
    }
  }

  assert.equal(report.counts.style, 2);
  assert.ok(beforeHighlights > 0, 'a real duplicate restyle keeps its before annotation');
  assert.ok(afterHighlights > 0, 'a real duplicate restyle keeps its after annotation');
  rmTmp(root);
});

test('end-to-end: an inserted duplicate sibling remains annotated as an addition', () => {
  const card = (index) => ({
    tag: 'article',
    cls: 'card',
    rect: [20, 20 + index * 100, 200, 80],
    style: { 'background-color': 'rgb(255, 255, 255)' },
  });
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 300, 160], style: {} },
      'body > main:nth-child(1)': { tag: 'main', rect: [0, 0, 300, 160], style: {} },
      'body > main:nth-child(1) > article:nth-child(1)': card(0),
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 300, 260], style: {} },
      'body > main:nth-child(1)': { tag: 'main', rect: [0, 0, 300, 260], style: {} },
      'body > main:nth-child(1) > article:nth-child(1)': card(0),
      'body > main:nth-child(1) > article:nth-child(2)': card(1),
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'duplicate-insertion@300',
    before,
    after,
    beforePng: solidPng(300, 160),
    afterPng: solidPng(300, 260),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPath = report.surfaces[0].regions[0].images.annotated;
  assert.match(annotatedPath, /-annotated\.png$/);
  const annotated = PNG.sync.read(fs.readFileSync(path.join(outDir, annotatedPath)));
  const dividerWidth = 12;
  const halfWidth = (annotated.width - dividerWidth) / 2;
  let beforeHighlights = 0;
  let afterHighlights = 0;
  for (let y = 0; y < annotated.height; y++) {
    for (let x = 0; x < annotated.width; x++) {
      const offset = (y * annotated.width + x) * 4;
      if (annotated.data[offset] !== 255 || annotated.data[offset + 1] !== 0 || annotated.data[offset + 2] !== 200)
        continue;
      if (x < halfWidth) beforeHighlights++;
      else if (x >= halfWidth + dividerWidth) afterHighlights++;
    }
  }

  assert.equal(report.counts.dom, 1);
  assert.ok(beforeHighlights === 0, 'the unchanged side of an addition stays unboxed');
  assert.ok(afterHighlights > 0, 'the inserted duplicate remains highlighted');
  rmTmp(root);
});

test('end-to-end: duplicate sibling removal keeps one deterministic removal highlighted', () => {
  const button = { tag: 'button', cls: 'same', rect: [20, 20, 100, 30], style: {} };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 640, 400], style: {} },
      'body > button:nth-child(1)': button,
      'body > button:nth-child(2)': { ...button, rect: [140, 20, 100, 30] },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 640, 400], style: {} },
      'body > button:nth-child(1)': button,
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'duplicate-removal@640',
    before,
    after,
    beforePng: solidPng(640, 400),
    afterPng: solidPng(640, 400),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPath = report.surfaces[0].regions[0].images.annotated;
  assert.ok(annotatedPath, 'duplicate removal keeps an annotated crop');
  const highlights = highlightPixelsBySide(path.join(outDir, annotatedPath));
  assert.ok(highlights.before > 0, 'one deterministic unmatched removal is highlighted before');
  assert.equal(highlights.after, 0, 'the unchanged after side stays clean');
  assert.equal(report.counts.dom, 1, 'the structural removal remains in the report');
  rmTmp(root);
});

test('end-to-end: a stable-path forced-state change stays annotated', () => {
  const element = { tag: 'button', cls: 'same', rect: [20, 20, 100, 30], style: {} };
  const before = makeMap({
    elements: { body: { tag: 'body', rect: [0, 0, 640, 400], style: {} }, 'body > button:nth-child(1)': element },
    states: { 'body > button:nth-child(1)': { hover: { 'body > button:nth-child(1)': { color: 'rgb(0, 0, 0)' } } } },
  });
  const after = makeMap({
    elements: { body: { tag: 'body', rect: [0, 0, 640, 400], style: {} }, 'body > button:nth-child(1)': element },
    states: {
      'body > button:nth-child(1)': { hover: { 'body > button:nth-child(1)': { color: 'rgb(255, 0, 0)' } } },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'state-change@640',
    before,
    after,
    beforePng: solidPng(640, 400),
    afterPng: solidPng(640, 400),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPath = report.surfaces[0].regions[0].images.annotated;
  assert.ok(annotatedPath, 'a genuine forced-state change keeps an annotated crop');
  assert.equal(report.counts.state, 1);
  rmTmp(root);
});

test('end-to-end: unchanged forced-state movement is suppressed as path churn', () => {
  const element = { tag: 'button', cls: 'same', rect: [20, 20, 100, 30], style: {} };
  const before = makeMap({
    elements: { body: { tag: 'body', rect: [0, 0, 640, 400], style: {} }, 'body > button:nth-child(1)': element },
    states: { 'body > button:nth-child(1)': { hover: { 'body > button:nth-child(1)': { color: 'rgb(0, 0, 0)' } } } },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 640, 400], style: {} },
      'body > button:nth-child(2)': { ...element, rect: [140, 20, 100, 30] },
    },
    states: { 'body > button:nth-child(2)': { hover: { 'body > button:nth-child(2)': { color: 'rgb(0, 0, 0)' } } } },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'state-movement@640',
    before,
    after,
    beforePng: solidPng(640, 400),
    afterPng: solidPng(640, 400),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.ok(report.surfaces[0].regions.length > 0, 'structural findings remain reportable');
  assert.ok(
    report.surfaces[0].regions.every((region) => !region.images.annotated),
    'path churn has no annotation',
  );
  assert.equal(report.counts.state, 2, 'state findings remain in the audit data');
  rmTmp(root);
});

test('end-to-end: moved forced-state changes stay annotated', () => {
  const element = { tag: 'button', cls: 'same', rect: [20, 20, 100, 30], style: {} };
  const before = makeMap({
    elements: { body: { tag: 'body', rect: [0, 0, 640, 400], style: {} }, 'body > button:nth-child(1)': element },
    states: { 'body > button:nth-child(1)': { hover: { 'body > button:nth-child(1)': { color: 'rgb(0, 0, 0)' } } } },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 640, 400], style: {} },
      'body > button:nth-child(2)': { ...element, rect: [140, 20, 100, 30] },
    },
    states: { 'body > button:nth-child(2)': { hover: { 'body > button:nth-child(2)': { color: 'rgb(255, 0, 0)' } } } },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'state-movement-change@640',
    before,
    after,
    beforePng: solidPng(640, 400),
    afterPng: solidPng(640, 400),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPaths = report.surfaces[0].regions.map((region) => region.images.annotated).filter(Boolean);
  assert.ok(annotatedPaths.length > 0, 'a moved forced-state change keeps annotated crops');
  const highlights = annotatedPaths
    .map((annotatedPath) => highlightPixelsBySide(path.join(outDir, annotatedPath)))
    .reduce((total, current) => ({ before: total.before + current.before, after: total.after + current.after }), {
      before: 0,
      after: 0,
    });
  assert.ok(highlights.before > 0, 'the changed before state remains visible in proof');
  assert.ok(highlights.after > 0, 'the changed after state remains visible in proof');
  assert.equal(report.counts.state, 2, 'state findings remain in the audit data');
  rmTmp(root);
});

test('end-to-end: owner pseudo-element state movement is suppressed as path churn', () => {
  const element = {
    tag: 'button',
    cls: 'same',
    rect: [20, 20, 100, 30],
    style: {},
    pseudo: { '::before': { color: 'rgb(0, 0, 0)' } },
  };
  const before = makeMap({
    elements: { body: { tag: 'body', rect: [0, 0, 640, 400], style: {} }, 'body > button:nth-child(1)': element },
    states: {
      'body > button:nth-child(1)': {
        hover: { 'body > button:nth-child(1)::before': { color: 'rgb(0, 0, 0)' } },
      },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 640, 400], style: {} },
      'body > button:nth-child(2)': { ...element, rect: [140, 20, 100, 30] },
    },
    states: {
      'body > button:nth-child(2)': {
        hover: { 'body > button:nth-child(2)::before': { color: 'rgb(0, 0, 0)' } },
      },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'pseudo-state-movement@640',
    before,
    after,
    beforePng: solidPng(640, 400),
    afterPng: solidPng(640, 400),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.ok(report.surfaces[0].regions.length > 0, 'structural findings remain reportable');
  assert.ok(
    report.surfaces[0].regions.every((region) => !region.images.annotated),
    'owner pseudo-element path churn has no annotation',
  );
  assert.equal(report.counts.state, 2, 'pseudo-element state findings remain in the audit data');
  rmTmp(root);
});

test('end-to-end: moved owner pseudo-element state changes stay annotated', () => {
  const element = {
    tag: 'button',
    cls: 'same',
    rect: [20, 20, 100, 30],
    style: {},
    pseudo: { '::before': { color: 'rgb(0, 0, 0)' } },
  };
  const before = makeMap({
    elements: { body: { tag: 'body', rect: [0, 0, 640, 400], style: {} }, 'body > button:nth-child(1)': element },
    states: {
      'body > button:nth-child(1)': {
        hover: { 'body > button:nth-child(1)::before': { color: 'rgb(0, 0, 0)' } },
      },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 640, 400], style: {} },
      'body > button:nth-child(2)': { ...element, rect: [140, 20, 100, 30] },
    },
    states: {
      'body > button:nth-child(2)': {
        hover: { 'body > button:nth-child(2)::before': { color: 'rgb(255, 0, 0)' } },
      },
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'pseudo-state-movement-change@640',
    before,
    after,
    beforePng: solidPng(640, 400),
    afterPng: solidPng(640, 400),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPaths = report.surfaces[0].regions.map((region) => region.images.annotated).filter(Boolean);
  assert.ok(annotatedPaths.length > 0, 'a moved pseudo-element state change keeps annotated crops');
  const highlights = annotatedPaths
    .map((annotatedPath) => highlightPixelsBySide(path.join(outDir, annotatedPath)))
    .reduce((total, current) => ({ before: total.before + current.before, after: total.after + current.after }), {
      before: 0,
      after: 0,
    });
  assert.ok(highlights.before > 0, 'the changed before pseudo-state remains visible in proof');
  assert.ok(highlights.after > 0, 'the changed after pseudo-state remains visible in proof');
  assert.equal(report.counts.state, 2, 'pseudo-element state findings remain in the audit data');
  rmTmp(root);
});

test('end-to-end: a highlight outside the crop does not publish the clean image twice', () => {
  const map = (color) =>
    makeMap({
      elements: {
        'body > a:nth-child(1)': {
          tag: 'a',
          cls: 'link',
          rect: [-500, 20, 80, 20],
          style: { color },
        },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: map('rgb(0, 0, 0)'),
    after: map('rgb(255, 0, 0)'),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.doesNotMatch(md, /highlighted before/);
  assert.equal(fs.readdirSync(path.join(outDir, 'crops')).filter((file) => file.endsWith('-annotated.png')).length, 0);
  rmTmp(root);
});

test('end-to-end: annotation boxes the changed CHILD, not its changed container', () => {
  // Both the container (border-radius) and a small child (color) change. The
  // highlight should trace the child, not the whole container — so the magenta
  // footprint is small (a 40px box), not a ~400px container outline.
  const map = (radius, childColor) =>
    makeMap({
      elements: {
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'box',
          rect: [10, 10, 400, 300],
          style: { 'border-radius': radius },
        },
        'body > div:nth-child(1) > span:nth-child(1)': {
          tag: 'span',
          cls: 'dot',
          rect: [30, 30, 40, 40],
          style: { color: childColor },
        },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: map('0px', 'rgb(0, 0, 0)'),
    after: map('8px', 'rgb(255, 0, 0)'),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  generateStyleMapReport({ beforeDir, afterDir, outDir });
  const ann = fs.readdirSync(path.join(outDir, 'crops')).find((f) => f.endsWith('-annotated.png'));
  const png = PNG.sync.read(fs.readFileSync(path.join(outDir, 'crops', ann)));
  let hilite = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 200) hilite++;
  }
  // A 40px child box (both sides) is a few hundred px; a 400px container outline
  // would be thousands. Generous bound that still distinguishes the two.
  assert.ok(hilite > 0, 'child is highlighted');
  assert.ok(hilite < 1500, `highlight footprint ${hilite} should be child-sized, not container-sized`);
  rmTmp(root);
});

// ---------------------------------------- bounded report (always GitHub-renderable)

test('report.md stays under its byte budget (GitHub-renderable); report.json keeps every surface', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const N = 40;
  const M = 15;
  // Each surface carries a DISTINCT change (values keyed by surface index) so they
  // don't collapse into one "identical across N surfaces" group — N real detail blocks.
  const surfaceMap = (s, shift) =>
    makeMap({
      elements: Object.fromEntries(
        Array.from({ length: M }, (_, k) => [
          `body > div:nth-child(${k + 1})`,
          {
            tag: 'div',
            cls: `s${s}-c${k}`,
            rect: [10, 20 + k * 30, 200, 24],
            style: {
              color: `rgb(${(shift + s) % 256}, ${k}, 0)`,
              'padding-top': `${10 + shift + s}px`,
              'font-size': `${12 + k}px`,
              'margin-top': `${4 + shift}px`,
            },
          },
        ]),
      ),
    });
  for (let s = 0; s < N; s++) {
    const surface = `surface-${s}@1280`;
    writeCapture(beforeDir, surface, surfaceMap(s, 0), solidPng(1280, 800));
    writeCapture(afterDir, surface, surfaceMap(s, 5), solidPng(1280, 800));
  }

  const budget = 15_000;
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir, maxReportBytes: budget });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  assert.ok(md.length < budget * 2, `report.md must stay bounded near the budget (was ${md.length})`);
  assert.match(md, /summarized to keep this report renderable/, 'the cap is announced, not silent');
  assert.match(md, /· \d+ change\(s\)/, 'capped surfaces appear as one-line summaries');
  assert.equal(json.surfaces.length, N, 'report.json keeps every surface — the cap relocates detail, never drops it');

  // The cap must actually shrink a large report (uncapped is far bigger).
  const full = generateStyleMapReport({
    beforeDir,
    afterDir,
    outDir: path.join(root, 'out2'),
    maxReportBytes: Infinity,
  });
  const mdFull = fs.readFileSync(full.reportMdPath, 'utf8');
  assert.ok(
    mdFull.length > md.length * 2,
    `uncapped report should be far larger (capped ${md.length}, full ${mdFull.length})`,
  );
  rmTmp(root);
});

// ----------------------------------------------- hostile CSS values are escaped

// A CSS property value is author/attacker-influenced. A `|` would split a report
// table row; a backtick would close the code span and leak live Markdown. The
// render boundary must escape both so the value renders as ONE intact code cell.
test('end-to-end: a hostile CSS value renders as one intact row with no live markdown', () => {
  // A value carrying a pipe (row-splitter) AND a backtick (span-closer), plus a
  // second backtick to exercise the fence-widening path.
  const HOSTILE_BEFORE = 'counter(a) "|`x`|"';
  const HOSTILE_AFTER = 'counter(b) "|`y`|"';
  const boxWith = (content) =>
    makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'box',
          rect: [40, 40, 200, 60],
          style: { content },
        },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: boxWith(HOSTILE_BEFORE),
    after: boxWith(HOSTILE_AFTER),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 1);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Find the table row carrying the hostile value.
  const contentRow = md.split('\n').find((l) => l.includes('content') && l.includes('counter'));
  assert.ok(contentRow, 'the content change is rendered as a table row');

  // A GitHub table row is a single line with exactly the cell pipes it declares:
  // `| content | <before> | <after> |` → the only UNESCAPED pipes are the four
  // structural ones. Every pipe from the value must be backslash-escaped.
  const structuralPipes = (contentRow.match(/(^|[^\\])\|/g) ?? []).length;
  assert.equal(structuralPipes, 4, `row must keep exactly its 4 cell separators, got: ${contentRow}`);
  assert.ok(contentRow.includes('\\|'), 'the value pipes are backslash-escaped, not raw');

  // The value's literal text survives, readable (escape, not strip).
  assert.ok(md.includes('counter(a)') && md.includes('counter(b)'), 'both hostile values are shown verbatim');
  rmTmp(root);
});

// -------------------------------------------------- shared-chrome tier (#193)

test('report promotes a frame-wide change to a chrome callout, leaves a one-view change in place', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  // A persistent nav is on every view; head adds a second nav link on every view
  // (the shared frame). `home` additionally restyles its own h1 (view content).
  const nav = (extra) => ({
    'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
    'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } },
    ...extra,
  });
  const a2 = { 'html > body > nav > a:nth-child(2)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } } };
  for (const v of ['settings', 'reports']) {
    writeCapture(beforeDir, `${v}@1280`, makeMap({ elements: nav({}) }), solidPng(1280, 400));
    writeCapture(afterDir, `${v}@1280`, makeMap({ elements: nav(a2) }), solidPng(1280, 400));
  }
  writeCapture(
    beforeDir,
    'home@1280',
    makeMap({
      elements: {
        ...nav({}),
        'html > body > main > h1': { tag: 'h1', cls: 'title', style: { color: 'rgb(0, 0, 0)' } },
      },
    }),
    solidPng(1280, 400),
  );
  writeCapture(
    afterDir,
    'home@1280',
    makeMap({
      elements: {
        ...nav(a2),
        'html > body > main > h1': { tag: 'h1', cls: 'title', style: { color: 'rgb(255, 0, 0)' } },
      },
    }),
    solidPng(1280, 400),
  );

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  // One global-chrome callout at the top for the nav addition.
  assert.match(md, /## 🧱 Global chrome change/, md.slice(0, 1200));
  assert.match(md, /rode the shared frame every view draws/);
  // The home h1 restyle is still shown — never hidden under the banner.
  assert.match(md, /title/);
  // Counts and exit-relevant results are unchanged by the presentational tier.
  assert.equal(res.newSurfaces, 0);
  rmTmp(root);
});

test('report headline and global chrome use surface-base counts with variant detail (#193)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const nav = (extra) => ({
    'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
    'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } },
    ...extra,
  });
  const a2 = { 'html > body > nav > a:nth-child(2)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } } };
  for (const base of ['home', 'settings']) {
    for (const w of [1280, 390]) {
      writeCapture(beforeDir, `${base}@${w}`, makeMap({ elements: nav({}) }), solidPng(w, 400));
      writeCapture(afterDir, `${base}@${w}`, makeMap({ elements: nav(a2) }), solidPng(w, 400));
    }
  }

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const summary = md.slice(0, md.indexOf('\n### '));
  assert.match(summary, /2 changed surface bases \(4 variants\) with an existing baseline/);
  assert.match(summary, /Surface base.*@width/);
  assert.match(md, /## 🧱 Global chrome change — across all 2 captured surface base\(s\)/);
  rmTmp(root);
});

test('report headline counts live-state variants under metadata.surfaceKey product base', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const el = (color) => ({
    body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
    'body > button:nth-child(1)': {
      tag: 'button',
      cls: 'cta',
      rect: [10, 10, 120, 32],
      style: { color },
    },
  });
  const baseMap = (color) => makeMap({ elements: el(color) });
  const loadedMeta = { surfaceKey: 'dashboard', variantKey: 'loaded', variantKind: 'live-state' };
  writeCapture(beforeDir, 'dashboard@1280', baseMap('rgb(0, 0, 0)'), solidPng(1280, 800));
  writeCapture(afterDir, 'dashboard@1280', baseMap('rgb(255, 0, 0)'), solidPng(1280, 800));
  writeCapture(
    beforeDir,
    'dashboard-loaded@1280',
    { ...baseMap('rgb(0, 0, 0)'), metadata: loadedMeta },
    solidPng(1280, 800),
  );
  writeCapture(
    afterDir,
    'dashboard-loaded@1280',
    { ...baseMap('rgb(255, 0, 0)'), metadata: loadedMeta },
    solidPng(1280, 800),
  );

  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  const summary = md.slice(0, md.indexOf('\n### ') >= 0 ? md.indexOf('\n### ') : md.length);
  assert.match(summary, /1 changed surface base \(2 variants\) with an existing baseline/);
  rmTmp(root);
});

test('report does NOT promote a change that hit only some hosting surfaces (#193)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const nav = (color) => ({
    'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
    'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color } },
  });
  // nav on 3 views; the link recolours on only 2 → partial, never chrome.
  writeCapture(beforeDir, 'home@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), solidPng(1280, 300));
  writeCapture(afterDir, 'home@1280', makeMap({ elements: nav('rgb(255, 0, 0)') }), solidPng(1280, 300));
  writeCapture(beforeDir, 'settings@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), solidPng(1280, 300));
  writeCapture(afterDir, 'settings@1280', makeMap({ elements: nav('rgb(255, 0, 0)') }), solidPng(1280, 300));
  writeCapture(beforeDir, 'reports@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), solidPng(1280, 300));
  writeCapture(afterDir, 'reports@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), solidPng(1280, 300));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.doesNotMatch(md, /Global chrome/, 'a change on only some hosting surfaces is not chrome');
  rmTmp(root);
});

// A cross-path annotation match is a MOVE claim, so it may suppress annotations
// only when the displacement is provable: the container where the paths diverge
// gained or lost captured children, or a same-container slide into a vacated
// slot. The three tests below pin the unprovable cases the reconciler must NOT
// swallow, and the provable one it must.

test('end-to-end: a size-changing duplicate style swap keeps annotated proof', () => {
  const item = (y, h, color) => ({ tag: 'li', cls: 'item', rect: [20, y, 200, h], style: { color } });
  const swapMap = (firstH, firstC, secondH, secondC) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 400, 200], style: {} },
        'body > ul:nth-child(1)': { tag: 'ul', rect: [0, 0, 400, 200], style: {} },
        'body > ul:nth-child(1) > li:nth-child(1)': item(20, firstH, firstC),
        'body > ul:nth-child(1) > li:nth-child(2)': item(80, secondH, secondC),
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'sized-swap@400',
    before: swapMap(30, 'rgb(255, 0, 0)', 40, 'rgb(0, 0, 255)'),
    after: swapMap(40, 'rgb(0, 0, 255)', 30, 'rgb(255, 0, 0)'),
    beforePng: solidPng(400, 200),
    afterPng: solidPng(400, 200),
  });
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPaths = report.surfaces[0].regions.map((region) => region.images.annotated).filter(Boolean);
  assert.ok(report.counts.style >= 2, 'the diff itself still records the restyle');
  assert.ok(annotatedPaths.length > 0, 'a restyle that could be a swap keeps annotated proof');
  rmTmp(root);
});

test('end-to-end: uniform-shell list insertion leaves unchanged displaced items unboxed', () => {
  const item = (y, color) => ({ tag: 'li', cls: 'item', rect: [20, y, 200, 30], style: { color } });
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 300], style: {} },
      'body > ul:nth-child(1)': { tag: 'ul', rect: [0, 0, 400, 300], style: {} },
      'body > ul:nth-child(1) > li:nth-child(1)': item(20, 'rgb(255, 0, 0)'),
      'body > ul:nth-child(1) > li:nth-child(2)': item(60, 'rgb(0, 0, 255)'),
      'body > ul:nth-child(1) > li:nth-child(3)': item(100, 'rgb(0, 128, 0)'),
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 300], style: {} },
      'body > ul:nth-child(1)': { tag: 'ul', rect: [0, 0, 400, 300], style: {} },
      'body > ul:nth-child(1) > li:nth-child(1)': item(20, 'rgb(255, 255, 0)'),
      'body > ul:nth-child(1) > li:nth-child(2)': item(60, 'rgb(255, 0, 0)'),
      'body > ul:nth-child(1) > li:nth-child(3)': item(100, 'rgb(0, 0, 255)'),
      'body > ul:nth-child(1) > li:nth-child(4)': item(140, 'rgb(0, 128, 0)'),
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'uniform-insertion@400',
    before,
    after,
    beforePng: solidPng(400, 300),
    afterPng: solidPng(400, 300),
  });
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPaths = report.surfaces[0].regions.map((region) => region.images.annotated).filter(Boolean);
  const highlights = annotatedPaths
    .map((annotatedPath) => highlightPixelsBySide(path.join(outDir, annotatedPath)))
    .reduce((total, current) => ({ before: total.before + current.before, after: total.after + current.after }), {
      before: 0,
      after: 0,
    });
  assert.equal(highlights.before, 0, 'unchanged displaced items must not be boxed on the before side');
  assert.ok(highlights.after > 0, 'the inserted item itself stays annotated');
  rmTmp(root);
});

test('end-to-end: a removal and an identical addition in different containers both stay annotated', () => {
  const card = (y) => ({ tag: 'div', cls: 'card', rect: [20, y, 200, 80], style: { color: 'rgb(0, 0, 0)' } });
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 600, 500], style: {} },
      'body > section:nth-child(1)': { tag: 'section', rect: [0, 0, 600, 200], style: {} },
      'body > section:nth-child(1) > div:nth-child(1)': card(20),
      'body > section:nth-child(2)': { tag: 'section', rect: [0, 200, 600, 200], style: {} },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 600, 500], style: {} },
      'body > section:nth-child(1)': { tag: 'section', rect: [0, 0, 600, 200], style: {} },
      'body > section:nth-child(2)': { tag: 'section', rect: [0, 200, 600, 200], style: {} },
      'body > section:nth-child(2) > div:nth-child(1)': card(220),
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'cross-container@600',
    before,
    after,
    beforePng: solidPng(600, 500),
    afterPng: solidPng(600, 500),
  });
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPaths = report.surfaces[0].regions.map((region) => region.images.annotated).filter(Boolean);
  assert.equal(report.counts.dom, 2, 'both structural findings remain in the audit');
  assert.ok(annotatedPaths.length > 0, 'independent changes in different containers keep visual proof');
  rmTmp(root);
});
