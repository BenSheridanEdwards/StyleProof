import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  generateStructuralStyleMapReportForTesting as generateStyleMapReport,
  describeChange,
  colorName,
  tokenIndex,
  toHex,
  propertyGlanceLine,
} from '../dist/report.js';
import {
  makeMap,
  mkTmp,
  rmTmp,
  solidPng,
  pairFixture,
  writeCapture,
  sceneMap,
  highlightPixelsBySide,
} from './helpers.mjs';

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

test('describeChange only calls a border gained or lost when every side is zero', () => {
  const say = (before, after) =>
    describeChange([{ label: 'div.card', props: [{ prop: 'border-width', before, after }] }])[0];
  assert.match(say('0.5px', '1px'), /border 0\.5px → 1px/);
  assert.match(say('1px', '0.5px'), /border 1px → 0\.5px/);
  assert.match(say('1px', '0px 1px'), /border 1px → 0px 1px/);
  assert.match(say('0px', '1px'), /gains a 1px border/);
  assert.match(say('1px', '0px'), /loses its border/);
  assert.match(say('(unset)', '2px'), /gains a 2px border/);
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

test('describeChange never bills added-node inventory as a restyle or state change', () => {
  const out = describeChange([
    {
      label: 'button.btn',
      added: true,
      props: [
        { prop: 'background-color', before: '(unset)', after: 'rgb(0, 90, 252)' },
        { prop: 'color', before: '(unset)', after: 'rgb(255, 255, 255)' },
      ],
      states: ['hover'],
    },
  ]);
  assert.ok(out.some((l) => /\*\*1\*\* element added/.test(l)));
  assert.ok(!out.some((l) => /button\.btn/.test(l) && /—/.test(l)), 'no restyle phrase for an added node');
  assert.ok(!out.some((l) => /interaction states/.test(l)), 'added-node states are inventory, not changes');
  assert.ok(!out.some((l) => /restyled/.test(l)));
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
  assert.equal(
    (md.match(/^### (?:\*\*[^*]+\*\* )?`div\.netgrid`/gm) || []).length,
    1,
    'one grouped section, not one per width',
  );
  assert.match(md, /Identical across 2 surfaces/);
  rmTmp(root);
});

// ---------------------------------------------- annotated crops (1.8.0)

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
  assert.match(md, /<summary>Show highlight overlay<\/summary>/, 'highlight sits under an optional toggle');
  assert.match(md, /!\[highlighted[^\]]*\]\(crops\/[^)]+-annotated\.png\)/, 'highlighted image still emitted');
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

test('propertyGlanceLine is one line per property, no bullets, no blank lines', () => {
  const line = propertyGlanceLine([
    {
      kind: 'style',
      path: 'button',
      cls: 'btn',
      pseudo: null,
      props: [
        { prop: 'background-color', before: 'rgb(20, 184, 166)', after: 'rgb(220, 38, 38)' },
        { prop: 'font-size', before: '13px', after: '16px' },
      ],
    },
    {
      kind: 'state',
      path: 'button',
      cls: 'btn',
      state: 'hover',
      sub: '',
      props: [{ prop: 'color', before: 'rgb(94, 234, 212)', after: 'rgb(254, 202, 202)' }],
    },
  ]);
  const rows = line.split('\n');
  assert.equal(rows.length, 3);
  assert.ok(
    rows.every((r) => r.length > 0),
    'no blank lines between properties',
  );
  assert.ok(
    rows[0].endsWith('<br>') && rows[1].endsWith('<br>'),
    'GitHub hard-breaks so they do not wrap into one paragraph',
  );
  assert.ok(!rows[2].includes('<br>'), 'last property has no trailing break');
  assert.ok(!line.includes(' · '), 'not smashed onto one middot line');
  assert.ok(!line.includes('- '), 'no bullets');
  assert.match(rows[0], /`background-color`/);
  assert.match(rows[1], /`font-size`/);
  assert.match(rows[2], /`:hover` `color`/);
});

test('state-only change crops hover vs hover, not rest vs rest', () => {
  const link = (hoverColor) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 400, 200], style: {} },
        'body > a:nth-child(1)': {
          tag: 'a',
          cls: 'link',
          rect: [20, 20, 80, 20],
          style: { color: 'rgb(126, 214, 208)' },
        },
      },
      states: {
        'body > a:nth-child(1)': { hover: { 'body > a:nth-child(1)': { color: hoverColor } } },
      },
    });
  const dirs = pairFixture({
    surface: 'demo@900',
    before: link('rgb(165, 243, 252)'),
    after: link('rgb(252, 165, 165)'),
    beforePng: solidPng(400, 200, [13, 17, 23]),
    afterPng: solidPng(400, 200, [13, 17, 23]),
  });
  fs.writeFileSync(path.join(dirs.beforeDir, 'demo@900.hover.png'), solidPng(400, 200, [165, 243, 252]));
  fs.writeFileSync(path.join(dirs.afterDir, 'demo@900.hover.png'), solidPng(400, 200, [252, 165, 165]));
  const md = fs.readFileSync(generateStyleMapReport(dirs).reportMdPath, 'utf8');
  assert.match(md, /Both sides are :hover/);
  assert.match(md, /base :hover/);
  assert.match(md, /head :hover/);
  assert.ok(!md.includes('◀ before  ·  after ▶'), 'state-only must not use the rest crop');
  const crops = fs.readdirSync(path.join(dirs.outDir, 'crops')).filter((f) => f.endsWith('-composite.png'));
  assert.equal(crops.length, 1);
  const png = PNG.sync.read(fs.readFileSync(path.join(dirs.outDir, 'crops', crops[0])));
  assert.match(md, /◀ base :hover {2}· {2}head :hover ▶/, 'state direction lives in the markdown caption');
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
  assert.equal(labelPixels, 0, 'state composite has no in-image BASE/HEAD glyphs');
  let sawCyan = false;
  let sawPink = false;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === 165 && png.data[i + 1] === 243 && png.data[i + 2] === 252) sawCyan = true;
    if (png.data[i] === 252 && png.data[i + 1] === 165 && png.data[i + 2] === 165) sawPink = true;
  }
  assert.ok(sawCyan && sawPink, 'composite is the hover layer (cyan vs pink), not rest');
  rmTmp(dirs.root);
});

test('state-only change without layer screenshots does not pretend rest is hover', () => {
  const link = (hoverColor) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 400, 200], style: {} },
        'body > a:nth-child(1)': {
          tag: 'a',
          cls: 'link',
          rect: [20, 20, 80, 20],
          style: { color: 'rgb(126, 214, 208)' },
        },
      },
      states: {
        'body > a:nth-child(1)': { hover: { 'body > a:nth-child(1)': { color: hoverColor } } },
      },
    });
  const dirs = pairFixture({
    surface: 'demo@900',
    before: link('rgb(165, 243, 252)'),
    after: link('rgb(252, 165, 165)'),
    beforePng: solidPng(400, 200, [13, 17, 23]),
    afterPng: solidPng(400, 200, [13, 17, 23]),
  });
  const md = fs.readFileSync(generateStyleMapReport(dirs).reportMdPath, 'utf8');
  assert.match(md, /No :hover screenshot/);
  assert.doesNotMatch(md, /!\[before/);
  rmTmp(dirs.root);
});

test('property changes sit on one line above the crop, not only under the fold', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }),
    after: sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });
  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  const img = md.indexOf('![before');
  assert.ok(img > 0, 'report still has a crop');
  const above = md.slice(0, img);
  assert.match(above, /`background-color`/, 'the property is readable before the picture');
  assert.match(above, /→/, 'before → after is on the glance line');
  assert.ok(!above.includes('<details>'), 'glance is not inside the diamond fold');
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
    beforePng: solidPng(640, 400, [0, 0, 0]),
    afterPng: solidPng(640, 400, [0, 0, 0]),
  });
  fs.writeFileSync(path.join(beforeDir, 'state-change@640.hover.png'), solidPng(640, 400, [0, 0, 0]));
  fs.writeFileSync(path.join(afterDir, 'state-change@640.hover.png'), solidPng(640, 400, [255, 0, 0]));

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
  // Presentation counts reserve style/state for matched-path restyles; one-sided
  // inventories stay in raw/reviewable audit tallies.
  assert.equal(report.counts.state, 0, 'path-churn state inventory is not a matched-path state-delta');
  assert.ok(
    report.rawCounts.state >= 2 || report.reviewableCounts.state >= 2,
    'state findings remain in the audit data',
  );
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
  assert.equal(report.counts.state, 0, 'one-sided path inventories are not matched-path state-deltas');
  assert.ok(
    report.rawCounts.state >= 2 || report.reviewableCounts.state >= 2,
    'state findings remain in the audit data',
  );
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
  assert.equal(report.counts.state, 0, 'path-churn pseudo state inventory is not a matched-path state-delta');
  assert.ok(
    report.rawCounts.state >= 2 || report.reviewableCounts.state >= 2,
    'pseudo-element state findings remain in the audit data',
  );
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
  assert.equal(report.counts.state, 0, 'one-sided path inventories are not matched-path state-deltas');
  assert.ok(
    report.rawCounts.state >= 2 || report.reviewableCounts.state >= 2,
    'pseudo-element state findings remain in the audit data',
  );
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
