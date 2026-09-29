// Own-text identity pairing (#753): an inserted sibling or a re-parented group must
// not read as a positional restyle swap or as remove + add.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { correspondBeforeMap, correspondContentShiftedPaths } from '../dist/path-correspondence.js';
import { diffContentMaps, diffStyleMaps, presentationDiffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, pairFixture, rmTmp } from './helpers.mjs';

const certify = (before, after) =>
  diffStyleMaps(correspondBeforeMap(before, after), after, { includeStructure: false });
const summary = (findings) => findings.map((f) => [f.kind, f.change ?? null, f.path, f.props.map((p) => p.prop)]);

// ── tab strip: same class on every tab, active state from an attribute ─────────────
const STRIP = 'body > main:nth-child(1) > div:nth-child(1)';
const tabPath = (position) => `${STRIP} > button:nth-child(${position})`;
const INACTIVE = { color: 'rgb(90, 90, 90)', 'border-bottom-color': 'rgba(0, 0, 0, 0)' };
const ACTIVE = { color: 'rgb(0, 80, 200)', 'border-bottom-color': 'rgb(0, 80, 200)' };

/** Labels share a length on purpose, so the own-text-length signature alone cannot tell them apart. */
function tabStrip(labels, active, restyle = {}) {
  const elements = {
    [STRIP]: { tag: 'div', cls: 'strip', rect: [0, 0, 800, 46], ownTextLength: 0, style: { display: 'flex' } },
  };
  labels.forEach((label, index) => {
    elements[tabPath(index + 1)] = {
      tag: 'button',
      cls: 'tab',
      rect: [8 + index * 72, 8, 64, 30],
      ownTextLength: label.length,
      text: label,
      style: { ...(label === active ? ACTIVE : INACTIVE), ...restyle[label] },
    };
  });
  return makeMap({ elements });
}

const TABS_BEFORE = tabStrip(['Alpha', 'Beta', 'Gamma', 'Delta'], 'Gamma');
const TABS_AFTER = tabStrip(['Alpha', 'Omega', 'Beta', 'Gamma', 'Delta'], 'Gamma');

test('an inserted tab does not certify a false active-state swap on its shifted siblings', () => {
  assert.deepEqual(summary(certify(TABS_BEFORE, TABS_AFTER)), []);
});

test('an inserted tab does not present a false active-state swap: only the new tab is one-sided', () => {
  assert.deepEqual(summary(presentationDiffStyleMaps(TABS_BEFORE, TABS_AFTER, { includeStructure: false })), []);
  const withStructure = presentationDiffStyleMaps(TABS_BEFORE, TABS_AFTER, { includeStructure: true });
  assert.deepEqual([...new Set(withStructure.map((f) => f.path))], [tabPath(2)]);
  assert.ok(withStructure.every((f) => f.kind !== 'style' || f.props.every((p) => p.before === '(unset)')));
});

test('an inserted tab is one added element in the content layer, not a run of relabels', () => {
  assert.deepEqual(diffContentMaps(TABS_BEFORE, TABS_AFTER), [
    { kind: 'structure', path: tabPath(2), cls: 'tab', change: 'added' },
  ]);
});

test('report: an inserted tab renders no colour/border change and one advisory added element', () => {
  const dirs = pairFixture({ surface: 'home@800', before: TABS_BEFORE, after: TABS_AFTER });
  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.equal(result.totalFindings, 0);
  assert.equal(result.contentChanges, 1);
  assert.doesNotMatch(md, /`color`|`border-bottom-color`/);
  assert.doesNotMatch(md, /- before: `/);
  assert.match(md, /- element added/);
  assert.ok(fs.existsSync(path.join(dirs.outDir, 'report.md')));
  rmTmp(dirs.root);
});

test('a real restyle on a shifted tab is still certified and presented at its head path', () => {
  const restyled = tabStrip(['Alpha', 'Omega', 'Beta', 'Gamma', 'Delta'], 'Gamma', {
    Delta: { color: 'rgb(200, 0, 0)' },
  });
  const expected = [['style', null, tabPath(5), ['color']]];
  assert.deepEqual(summary(certify(TABS_BEFORE, restyled)), expected);
  assert.deepEqual(summary(presentationDiffStyleMaps(TABS_BEFORE, restyled, { includeStructure: false })), expected);
});

test('the active state genuinely moving to another tab is still reported on both tabs', () => {
  const moved = tabStrip(['Alpha', 'Omega', 'Beta', 'Gamma', 'Delta'], 'Beta');
  assert.deepEqual(
    summary(certify(TABS_BEFORE, moved)).map(([, , p]) => p),
    [tabPath(3), tabPath(4)],
  );
});

test('an ambiguous own text stays unpaired by identity (fails closed to the existing passes)', () => {
  const before = tabStrip(['Alpha', 'Beta'], 'Beta');
  const after = tabStrip(['Alpha', 'Omega', 'Beta', 'Alpha'], 'Beta');
  const corresponded = correspondContentShiftedPaths(before, after);
  // Beta is unique on both sides and moves; the duplicated Alpha is never identity-paired.
  assert.equal(corresponded.elements[tabPath(3)]?.text, 'Beta');
  assert.equal(corresponded.elements[tabPath(1)]?.text, 'Alpha');
  assert.equal(corresponded.elements[tabPath(4)], undefined);
});

test('a text-less sibling displaced by an identified move still pairs through the nth-child shift', () => {
  // The label and the icon (both spans) swap places; the icon's own restyle must survive.
  const bar = 'body > div:nth-child(1)';
  const icon = { tag: 'span', cls: 'icon', rect: [0, 0, 16, 16], ownTextLength: 0 };
  const save = { tag: 'span', cls: 'label', rect: [20, 0, 60, 16], ownTextLength: 4, text: 'Save', style: INACTIVE };
  const before = makeMap({
    elements: { [`${bar} > span:nth-child(1)`]: { ...icon, style: INACTIVE }, [`${bar} > span:nth-child(2)`]: save },
  });
  const after = makeMap({
    elements: {
      [`${bar} > span:nth-child(1)`]: { ...save, rect: [0, 0, 60, 16] },
      [`${bar} > span:nth-child(2)`]: {
        ...icon,
        rect: [64, 0, 16, 16],
        style: { ...INACTIVE, color: 'rgb(200, 0, 0)' },
      },
    },
  });
  assert.deepEqual(summary(certify(before, after)), [['style', null, `${bar} > span:nth-child(2)`, ['color']]]);
});

test('certification never identity-pairs an element whose hashed identity was replaced', () => {
  const row = { tag: 'li', cls: 'row', rect: [0, 0, 400, 24], ownTextLength: 4, text: 'Kiwi' };
  const before = makeMap({ elements: { 'body > ul:nth-child(1) > li:sp-key(abc123)': { ...row, style: INACTIVE } } });
  const after = makeMap({
    elements: {
      'body > ul:nth-child(1) > li:nth-child(1)': { ...row, rect: [0, 30, 400, 24], style: ACTIVE },
      'body > ul:nth-child(1) > li:nth-child(2)': { ...row, text: 'Lime', style: INACTIVE },
    },
  });
  assert.deepEqual(summary(certify(before, after)), []);
});

// ── re-parenting: groups moved into a new wrapper ──────────────────────────────────
const LIST = 'body > main:nth-child(1) > div:nth-child(1)';
const WRAPPER = `${LIST} > div:nth-child(1)`;
const GROUP_STYLE = { display: 'flex', 'background-color': 'rgb(240, 240, 240)' };

/** Four groups, each a text-less section holding a unique label and a duplicated glyph. */
function groups(parent, x, restyle = {}) {
  const elements = {};
  for (let index = 1; index <= 4; index++) {
    const section = `${parent} > section:nth-child(${index})`;
    const y = 20 + index * 30;
    elements[section] = {
      tag: 'section',
      cls: 'group',
      rect: [x, y, 800 - 2 * x, 26],
      ownTextLength: 0,
      style: { ...GROUP_STYLE, ...restyle[`section${index}`] },
    };
    elements[`${section} > span:nth-child(1)`] = {
      tag: 'span',
      cls: '',
      rect: [x + 2, y + 2, 50, 20],
      ownTextLength: 6,
      text: `Item ${index}`,
      style: { color: 'rgb(20, 20, 20)' },
    };
    elements[`${section} > span:nth-child(2)`] = {
      tag: 'span',
      cls: '',
      rect: [x + 56, y + 2, 10, 20],
      ownTextLength: 1,
      text: 'x',
      style: { color: 'rgb(120, 120, 120)', ...restyle[`glyph${index}`] },
    };
  }
  return elements;
}

const listContainer = {
  tag: 'div',
  cls: 'list',
  rect: [0, 0, 800, 200],
  ownTextLength: 0,
  style: { display: 'block' },
};
const GROUPS_BEFORE = makeMap({ elements: { [LIST]: listContainer, ...groups(LIST, 8) } });
const reParented = (restyle) =>
  makeMap({
    elements: {
      [LIST]: listContainer,
      [WRAPPER]: { tag: 'div', cls: 'wrapper', rect: [8, 8, 784, 180], ownTextLength: 0, style: { padding: '12px' } },
      ...groups(WRAPPER, 20, restyle),
    },
  });

test('groups moved into a new wrapper are paired, not reported as removed', () => {
  const after = reParented({});
  assert.deepEqual(diffContentMaps(GROUPS_BEFORE, after), [
    { kind: 'structure', path: WRAPPER, cls: 'wrapper', change: 'added' },
  ]);
  assert.deepEqual(summary(certify(GROUPS_BEFORE, after)), []);
  assert.deepEqual(summary(presentationDiffStyleMaps(GROUPS_BEFORE, after, { includeStructure: false })), []);
});

test('a real restyle inside a re-parented group is still certified at its head path', () => {
  const after = reParented({
    section3: { 'background-color': 'rgb(255, 230, 230)' },
    glyph2: { color: 'rgb(200, 0, 0)' },
  });
  const expected = [
    ['style', null, `${WRAPPER} > section:nth-child(2) > span:nth-child(2)`, ['color']],
    ['style', null, `${WRAPPER} > section:nth-child(3)`, ['background-color']],
  ];
  assert.deepEqual(summary(certify(GROUPS_BEFORE, after)), expected);
  assert.deepEqual(summary(presentationDiffStyleMaps(GROUPS_BEFORE, after, { includeStructure: false })), expected);
});

test('a container is not re-paired when its identified children disagree about where it went', () => {
  // One label moved to the second card, the other stayed in the first: the first card
  // has no single destination, so it stays concrete rather than guessing.
  const card = (position) => `${LIST} > div:nth-child(${position})`;
  const cardEntry = { tag: 'div', cls: 'card', rect: [0, 0, 400, 60], ownTextLength: 0, style: GROUP_STYLE };
  const label = (text) => ({ tag: 'p', cls: '', rect: [0, 0, 100, 20], ownTextLength: text.length, text, style: {} });
  const before = makeMap({
    elements: {
      [card(1)]: cardEntry,
      [`${card(1)} > p:nth-child(1)`]: label('Item 1'),
      [`${card(1)} > p:nth-child(2)`]: label('Item 2'),
      [card(2)]: cardEntry,
    },
  });
  const after = makeMap({
    elements: {
      [card(1)]: cardEntry,
      [`${card(1)} > p:nth-child(2)`]: label('Item 2'),
      [card(2)]: cardEntry,
      [`${card(2)} > p:nth-child(1)`]: label('Item 1'),
    },
  });
  const corresponded = correspondContentShiftedPaths(before, after);
  assert.deepEqual(Object.keys(corresponded.elements).sort(), [
    card(1),
    `${card(1)} > p:nth-child(2)`,
    card(2),
    `${card(2)} > p:nth-child(1)`,
  ]);
  assert.equal(corresponded.elements[card(2)], before.elements[card(2)]);
});
