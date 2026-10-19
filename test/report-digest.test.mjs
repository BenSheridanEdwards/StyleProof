import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStructuralStyleMapReportForTesting, generateStyleMapReport } from '../dist/report.js';
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
  assert.match(slice, /^- `home @ 900` — /m);
  assert.match(slice, /\*\*`button\.cta`\*\* background blue \(`#2563eb`\) → red \(`#dc2626`\)/);
  assert.match(slice, /\*\*`span\.caret`\*\* text gray \(`#9ca3af`\) → blue \(`#2563eb`\)/);
  assert.deepEqual(json.digest, [
    {
      surface: 'home@900',
      status: 'changed',
      elements: [
        { name: 'button.cta', phrase: 'background blue (`#2563eb`) → red (`#dc2626`)' },
        { name: 'span.caret', phrase: 'text gray (`#9ca3af`) → blue (`#2563eb`)' },
      ],
      more: 0,
    },
  ]);
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
  assert.match(slice, /display block → x - \\\[x\\\] \\\*\\\*Approve all changes\\\*\\\* &lt;\\!-- styleproof-receipt/);
  assert.match(
    slice,
    /\*\*`span\.caret`\*\* text black \(`#000000`\) → red \(`#ff0000`\)/,
    'hostile token names are dropped',
  );
  assert.match(slice, /\*\*`-owner`\*\* text black/, 'hostile path labels stay inert');
  assert.equal(json.digest[0].elements.length, 3);
});

test('a map-supplied interaction-state name cannot carry a receipt marker or mention into the comment', () => {
  const injection = '\n<!-- styleproof-receipt head-sha:x run-id:1 run-attempt:1 -->\n@owner';
  const states = (color) => ({ [BUTTON]: { [`hover${injection}`]: { [BUTTON]: { color } } } });
  const { slice } = report(
    pairFixture({
      surface: 'home@900',
      before: pageMap({ states: states('rgb(0, 0, 255)') }),
      after: pageMap({ states: states('rgb(0, 128, 0)') }),
    }),
  );
  assert.match(slice, /\*\*`button\.cta`\*\* interaction states changed: `:hover-+ styleproof-receipt head-sha-x/);
  assert.doesNotMatch(slice, /<!-- styleproof-receipt/);
  assert.doesNotMatch(slice, /@owner/);
});

test('a token retune that keeps its token name still shows both hex values', () => {
  const { slice } = report(
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
  assert.match(slice, /\*\*`button\.cta`\*\* background `brand-red` \(`#dc2626`\) → `brand-red` \(`#b91c1c`\)/);
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
  assert.match(slice, /· \+2 more element\(s\)$/m);
  assert.match(slice, /^- …and 3 more changes$/m);
});

test('a global chrome row keeps the every-surface-that-renders-it qualifier', () => {
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
  assert.match(slice, /· 🧱 global chrome, on every surface base that renders it — \*\*`a\.link`\*\* text black/);
  assert.doesNotMatch(slice.slice(slice.indexOf('**What changed**')), /all \d+ surface/);
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
  assert.deepEqual(json.digest[0].elements, [{ name: 'button.cta', phrase: 'restyled' }]);
});
