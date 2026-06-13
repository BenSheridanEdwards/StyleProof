import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStyleMapReport, summarizeProps, prettyLabel } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, pairFixture, writeCapture } from './helpers.mjs';

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

test('summarizeProps rounds decimals to one place', () => {
  const out = summarizeProps([{ prop: 'line-height', before: '26.666px', after: '24.04px' }]);
  assert.deepEqual(out, [{ prop: 'line-height', before: '26.7px', after: '24px' }]);
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
  // button rect [100,100,160,48] padded by 24 -> x=76 y=76 w=208 h=96
  assert.deepEqual(region.before, { x: 76, y: 76, w: 208, h: 96 });
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
  assert.match(md, /\*\*0 DOM change\(s\) · 1 computed-style difference\(s\) · 0 state-delta difference\(s\)\*\*/);
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
  // PAD20 + BAR6 + h + PAD20 tall. With w=320,h=180: 2*320+68=708 by 226.
  assert.equal(png.width, 708);
  assert.equal(png.height, 226);
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

test('end-to-end: a surface missing on one side is reported, not crashed on', () => {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  writeCapture(beforeDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  writeCapture(afterDir, 'home@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  writeCapture(beforeDir, 'about@1280', sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), null);
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /captured only in the \*\*before\*\* set/);
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
  // With noise: the height change surfaces.
  const on = generateStyleMapReport({ beforeDir, afterDir, outDir: path.join(outDir, 'on'), includeLayoutNoise: true });
  assert.equal(on.changedSurfaces, 1);
  rmTmp(root);
});
