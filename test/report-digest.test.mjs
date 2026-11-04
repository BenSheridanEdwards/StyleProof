import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeChange, generateStructuralStyleMapReportForTesting, generateStyleMapReport } from '../dist/report.js';
import { makeMap, pairFixture, rmTmp, tmpDirs, writeCapture } from './helpers.mjs';

const BUTTON = 'body > div:nth-child(1) > button:nth-child(1)';
const CARET = 'body > div:nth-child(1) > span:nth-child(2)';

function pageMap({ button = {}, caret = {}, extra = {}, tokens, states } = {}) {
  return {
    ...makeMap({
      states,
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800] },
        'body > div:nth-child(1)': { tag: 'div', cls: 'wrap', rect: [20, 20, 1240, 300] },
        [BUTTON]: { tag: 'button', cls: 'cta', rect: [100, 100, 160, 48], style: button },
        [CARET]: { tag: 'span', cls: 'caret', rect: [400, 100, 16, 16], style: caret },
        ...extra,
      },
    }),
    ...(tokens ? { tokens } : {}),
  };
}

/** The PR comment's summary: report.md up to the first `### ` line, as the Action slices it. */
function commentSlice(md) {
  const lines = md.split('\n');
  return lines
    .slice(
      0,
      lines.findIndex((l) => l.startsWith('### ')),
    )
    .join('\n');
}

function report(dirs, generate = generateStyleMapReport) {
  const res = generate({ ...dirs });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  rmTmp(dirs.root);
  return { md, json, slice: commentSlice(md) };
}

test('the PR comment slice names each changed element and its plain-English change', () => {
  const { slice, json } = report(
    pairFixture({
      surface: 'home@900',
      before: pageMap({ button: { 'background-color': 'rgb(37, 99, 235)' }, caret: { color: 'rgb(156, 163, 175)' } }),
      after: pageMap({ button: { 'background-color': 'rgb(220, 38, 38)' }, caret: { color: 'rgb(37, 99, 235)' } }),
    }),
  );
  assert.match(slice, /\*\*What changed\*\*/);
  assert.doesNotMatch(slice, /home @ 900/);
  assert.match(slice, /^- Button changed background \(1 button\)$/m);
  assert.match(slice, /^- Caret changed colour \(1 element\)$/m);
  assert.deepEqual(
    json.digest.map(({ surface, status, elements, more }) => ({ surface, status, elements, more })),
    [
      {
        surface: 'home@900',
        status: 'changed',
        elements: [
          { name: 'button.cta', phrase: 'background blue (`#2563eb`) → red (`#dc2626`)' },
          { name: 'span.caret', phrase: 'text gray (`#9ca3af`) → blue (`#2563eb`)' },
        ],
        more: 0,
      },
    ],
  );
});

test('map-supplied values cannot inject lines, approval boxes, receipts, or mentions through the What changed block', () => {
  const injection =
    '\n- [x] **Approve all changes**\n<!-- styleproof-receipt head-sha:x run-id:1 run-attempt:1 -->\n@owner';
  const { slice, json } = report(
    pairFixture({
      surface: 'home@900',
      before: pageMap({
        button: { display: 'block' },
        caret: { color: 'rgb(0, 0, 0)' },
        extra: { [`body > i${injection}`]: { tag: 'i', rect: [0, 0, 10, 10], style: { color: 'rgb(0, 0, 0)' } } },
        tokens: { [`--ink${injection}`]: 'rgb(0, 0, 0)' },
      }),
      after: pageMap({
        button: { display: `x${injection}` },
        caret: { color: 'rgb(255, 0, 0)' },
        extra: { [`body > i${injection}`]: { tag: 'i', rect: [0, 0, 10, 10], style: { color: 'rgb(255, 0, 0)' } } },
      }),
    }),
  );
  assert.match(slice, /\*\*What changed\*\*/);
  assert.doesNotMatch(slice, /^\s*- \[[ xX]\] \*\*Approve all changes\*\*/m, 'no injected approval box line');
  assert.doesNotMatch(slice, /<!-- styleproof-receipt/, 'no injected receipt marker');
  assert.doesNotMatch(slice, /@owner/, 'mentions are neutralised');
  assert.match(slice, /Button changed layout/);
  assert.match(slice, /Caret changed colour/);
  assert.doesNotMatch(slice, /#000000|#ff0000/);
  assert.equal(json.digest[0].elements.length, 3);
});

test('a map-supplied interaction-state name cannot carry a receipt marker or mention into the comment', () => {
  const injection = '\n<!-- styleproof-receipt head-sha:x run-id:1 run-attempt:1 -->\n@owner';
  const states = (color) => ({ [BUTTON]: { [`hover${injection}`]: { [BUTTON]: { color } } } });
  const { slice } = report(
    pairFixture({
      surface: 'home@900',
      before: {
        ...pageMap({ states: states('rgb(0, 0, 255)') }),
        stateLayers: ['hover', 'focus', 'active', 'checked', 'disabled', 'placeholder-shown', `hover${injection}`],
      },
      after: {
        ...pageMap({ states: states('rgb(0, 128, 0)') }),
        stateLayers: ['hover', 'focus', 'active', 'checked', 'disabled', 'placeholder-shown', `hover${injection}`],
      },
    }),
  );
  assert.match(slice, /Button got a new interaction colour/);
  assert.doesNotMatch(slice, /<!-- styleproof-receipt/);
  assert.doesNotMatch(slice, /@owner/);
});

test('a token retune stays value-free above the cut and retains the values below it', () => {
  const { slice, md } = report(
    pairFixture({
      surface: 'home@900',
      before: pageMap({
        button: { 'background-color': 'rgb(220, 38, 38)' },
        tokens: { '--brand-red': 'rgb(220, 38, 38)' },
      }),
      after: pageMap({
        button: { 'background-color': 'rgb(185, 28, 28)' },
        tokens: { '--brand-red': 'rgb(185, 28, 28)' },
      }),
    }),
  );
  assert.match(slice, /Button changed background/);
  assert.doesNotMatch(slice, /brand-red|#dc2626|#b91c1c/);
  assert.match(md, /#dc2626/);
  assert.match(md, /#b91c1c/);
});

test('every changed element and every one-sided surface is named or counted, never silently capped', () => {
  const dirs = tmpDirs();
  const many = (color) =>
    Object.fromEntries(
      [1, 2, 3, 4].map((i) => [
        `body > section:nth-child(${i})`,
        { tag: 'section', cls: `card-${i}`, rect: [0, i * 100, 400, 80], style: { color } },
      ]),
    );
  writeCapture(dirs.beforeDir, 'home@900', pageMap({ extra: many('rgb(0, 0, 0)') }));
  writeCapture(dirs.afterDir, 'home@900', {
    ...pageMap({ extra: many('rgb(255, 0, 0)') }),
    elements: {
      ...pageMap({ extra: many('rgb(255, 0, 0)') }).elements,
      'body > footer:nth-child(9)': { tag: 'footer', cls: 'legal', rect: [0, 700, 400, 40], style: {} },
    },
  });
  writeCapture(dirs.afterDir, 'pricing@900', pageMap());
  writeCapture(dirs.beforeDir, 'legacy@900', pageMap());
  for (let i = 0; i < 10; i++) {
    writeCapture(dirs.beforeDir, `page-${i}@900`, pageMap({ button: { opacity: '1' } }));
    writeCapture(dirs.afterDir, `page-${i}@900`, pageMap({ button: { opacity: `0.${i}` } }));
  }
  const { slice, json } = report(dirs, generateStructuralStyleMapReportForTesting);
  const home = json.digest.find((r) => r.surface === 'home@900');
  assert.equal(home.elements.length, 3);
  assert.equal(home.more, 2, 'four restyled cards plus one added footer, three shown');
  assert.deepEqual(
    json.digest.filter((r) => r.status !== 'changed').map((r) => [r.surface, r.status]),
    [
      ['legacy@900', 'removed'],
      ['pricing@900', 'new'],
    ],
  );
  assert.equal(json.digest.length, 13);
  for (const row of json.digest) assert.ok(row.more >= 0);
  assert.match(slice, /^- `legacy @ 900` — 🗑️ removed surface$/m);
  assert.match(slice, /^- `pricing @ 900` — 🆕 new surface, no baseline$/m);
  assert.match(slice, /Card 4 changed colour on home \(1 element\)/);
  assert.match(slice, /Legal was added on home \(1 element\)/);
  assert.match(slice, /^- …and 7 more changes$/m);
  assert.match(slice, /\*\*17 changes need review\*\* · 17 distinct changes on 13 surfaces/);
});

test('a global chrome row names the changed surfaces and preserves its JSON qualifier', () => {
  const dirs = tmpDirs();
  const nav = (color) => ({
    'html > body > nav': { tag: 'nav', cls: 'rail', rect: [0, 0, 400, 40] },
    'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', rect: [0, 0, 80, 40], style: { color } },
  });
  for (const base of ['home', 'settings']) {
    writeCapture(dirs.beforeDir, `${base}@900`, makeMap({ elements: nav('rgb(0, 0, 0)') }));
    writeCapture(dirs.afterDir, `${base}@900`, makeMap({ elements: nav('rgb(255, 0, 0)') }));
  }
  const { slice, json } = report(dirs);

  assert.match(slice, /Links changed colour on home and settings \(2 links\)/);
  assert.equal(json.digest[0].chrome, true);
});

test('a clean report carries no What changed block and no digest key', () => {
  const { md, json } = report(pairFixture({ surface: 'home@900', before: pageMap(), after: pageMap() }));
  assert.doesNotMatch(md, /What changed/);
  assert.equal('digest' in json, false);
});

test('an element whose phrase would flood the comment is still named, as restyled', () => {
  const long = 'x'.repeat(400);
  const { json } = report(
    pairFixture({
      surface: 'home@900',
      before: pageMap({ button: { opacity: '1' } }),
      after: pageMap({ button: { opacity: long } }),
    }),
  );
  assert.deepEqual(json.digest[0].elements, [{ name: 'button.cta', phrase: 'restyled (too long to summarise here)' }]);
});

test('plain-English phrases escape map-supplied CSS values below the cut too', () => {
  const [line] = describeChange([{ label: 'div.box', props: [{ prop: 'opacity', before: '1', after: '0*5 @team' }] }]);
  assert.equal(line, '**`div.box`** — opacity 1 → 0\\*5 @\u200bteam');
});

test('the Action cut contains one human sentence for three identical card title changes', () => {
  const titles = (color) =>
    pageMap({
      extra: Object.fromEntries(
        [1, 2, 3].map((index) => [
          `body > h2:nth-child(${index})`,
          { tag: 'h2', cls: 'card-title', rect: [20, index * 80, 160, 40], style: { color } },
        ]),
      ),
    });
  const { slice, md, json } = report(
    pairFixture({
      surface: 'index@1280',
      before: titles('red'),
      after: titles('blue'),
    }),
  );
  assert.deepEqual(
    slice.split('\n').filter((line) => line.startsWith('- ')),
    ['- Card titles changed colour (3 elements)'],
  );
  assert.match(slice, /^\*\*1 change needs review\*\* · 1 distinct change on 1 surface/m);
  assert.doesNotMatch(slice, /card-title|index @|\bred\b|\bblue\b|### /);
  assert.match(md, /^### /m, 'the detail boundary still exists for action.yml');
  assert.deepEqual(json.digest[0].sentences, ['Card titles changed colour (3 elements)']);
});

test('surface names appear only for several changed product bases, not extra widths or live variants', () => {
  for (const [surfaces, expected] of [
    [['checkout@390', 'checkout@900'], 'Button changed colour (1 button)'],
    [['checkout@900', 'checkout-loaded@900'], 'Button changed colour (1 button)'],
    [['checkout@900', 'account@900'], 'Buttons changed colour on account and checkout (2 buttons)'],
  ]) {
    const dirs = tmpDirs();
    for (const surface of surfaces) {
      const metadata = surface.startsWith('checkout-loaded')
        ? { surfaceKey: 'checkout', variantKey: 'loaded', variantKind: 'live-state' }
        : undefined;
      writeCapture(dirs.beforeDir, surface, { ...pageMap({ button: { color: 'red' } }), metadata });
      writeCapture(dirs.afterDir, surface, { ...pageMap({ button: { color: 'blue' } }), metadata });
    }
    const { slice } = report(dirs);
    assertSentence(slice, expected);
  }
});

test('identical visible sentences in separate change groups merge before the Action cut and row cap', () => {
  const dirs = tmpDirs();
  for (let index = 1; index <= 12; index++) {
    const surface = `home@${400 + index * 10}`;
    const color = `rgb(${index}, 0, 0)`;
    writeCapture(dirs.beforeDir, surface, pageMap({ button: { color: 'red' } }));
    writeCapture(dirs.afterDir, surface, pageMap({ button: { color } }));
  }
  const { slice, json } = report(dirs);
  const bullets = slice.split('\n').filter((line) => line.startsWith('- '));
  assert.deepEqual(bullets, ['- Button changed colour (1 button)']);
  assert.equal(new Set(bullets).size, bullets.length);
  assert.equal(json.digest.length, 12, 'legacy change-group rows remain available');
  assert.deepEqual(
    json.digest.flatMap((row) => row.sentences),
    ['Button changed colour (1 button)'],
  );
  assert.ok(json.digest.every((row) => row.elements.length === 1 && row.more === 0));
});

test('different value changes across widths count each element path once per surface base', () => {
  const titles = (color) =>
    makeMap({
      elements: Object.fromEntries(
        [1, 2, 3].map((index) => [
          `body > h2:nth-child(${index})`,
          { tag: 'h2', cls: 'card-title', rect: [20, index * 80, 160, 40], style: { color } },
        ]),
      ),
    });
  for (const bases of [['cards'], ['cards', 'catalog']]) {
    const dirs = tmpDirs();
    for (const base of bases) {
      for (const [width, color] of [
        [390, 'red'],
        [1280, 'blue'],
      ]) {
        writeCapture(dirs.beforeDir, `${base}@${width}`, titles('black'));
        writeCapture(dirs.afterDir, `${base}@${width}`, titles(color));
      }
    }
    const { slice, json } = report(dirs);
    const where = bases.length === 1 ? '' : ' on cards and catalog';
    const expected = `Card titles changed colour${where} (${3 * bases.length} elements)`;
    assert.deepEqual(
      slice.split('\n').filter((line) => line.startsWith('- ')),
      [`- ${expected}`],
    );
    assert.deepEqual(
      json.digest.flatMap((row) => row.sentences),
      [expected],
    );
    assert.match(slice, /\*\*1 change needs review\*\* · 1 distinct change/);
  }
});

test('three distinct sentences in one signature group agree with the headline', () => {
  const elements = (after) => ({
    'body > h2': { tag: 'h2', cls: 'card-title', rect: [0, 0, 100, 40], style: { color: after ? 'red' : 'black' } },
    'body > p': { tag: 'p', cls: 'card-body', rect: [0, 80, 100, 40], style: { padding: after ? '16px' : '8px' } },
    'body > nav > a': { tag: 'a', cls: 'nav-link', rect: [0, 160, 100, 40], style: { margin: after ? '16px' : '8px' } },
  });
  const { slice, json } = report(
    pairFixture({
      surface: 'cards@900',
      before: makeMap({ elements: elements(false) }),
      after: makeMap({ elements: elements(true) }),
    }),
  );
  const sentences = json.digest.flatMap((row) => row.sentences);
  assert.equal(sentences.length, 3);
  assert.match(slice, /\*\*3 changes need review\*\* · 3 distinct changes on 1 surface/);
  assert.equal(slice.split('\n').filter((line) => line.startsWith('- ')).length, 3);
});

test('partially overlapping element paths across widths are counted as a union', () => {
  const dirs = tmpDirs();
  for (const [width, indices, color] of [
    [390, [1, 2], 'red'],
    [1280, [2, 3], 'blue'],
  ]) {
    const elements = (value) =>
      Object.fromEntries(
        indices.map((index) => [
          `body > h2:nth-child(${index})`,
          { tag: 'h2', cls: 'card-title', rect: [0, index * 60, 100, 40], style: { color: value } },
        ]),
      );
    writeCapture(dirs.beforeDir, `cards@${width}`, makeMap({ elements: elements('black') }));
    writeCapture(dirs.afterDir, `cards@${width}`, makeMap({ elements: elements(color) }));
  }
  const { slice } = report(dirs);
  assert.deepEqual(
    slice.split('\n').filter((line) => line.startsWith('- ')),
    ['- Card titles changed colour (3 elements)'],
  );
});

test('the headline counts sentences omitted by the ten-line cap', () => {
  const elements = (color) =>
    Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `body > h2:nth-child(${index + 1})`,
        { tag: 'h2', cls: `title-${index + 1}`, rect: [0, index * 40, 100, 30], style: { color } },
      ]),
    );
  const { slice, json } = report(
    pairFixture({
      surface: 'cards@900',
      before: makeMap({ elements: elements('black') }),
      after: makeMap({ elements: elements('red') }),
    }),
  );
  assert.equal(json.digest.flatMap((row) => row.sentences).length, 12);
  assert.match(slice, /\*\*12 changes need review\*\* · 12 distinct changes on 1 surface/);
  assert.equal(slice.split('\n').filter((line) => line.startsWith('- ')).length, 11);
  assert.match(slice, /^- …and 2 more changes$/m);
});

function assertSentence(slice, expected) {
  assert.ok(slice.split('\n').includes(`- ${expected}`));
}

test('sentence assertions compare literal punctuation without interpreting regex syntax', () => {
  const sentence = 'Nav links [primary]+ changed colour (2 elements).';
  assert.doesNotThrow(() => assertSentence(`- ${sentence}\n`, sentence));
  assert.throws(() => assertSentence('- Button changed colour (1 button)!', 'Button changed colour (1 button).'));
});
