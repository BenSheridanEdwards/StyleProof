// The CPO's round-18 fallback (QA17-01…04): several owners of one element are said in main's own
// per-owner wording, one clause per owner path, named as main names them (owners of one selector
// main cannot tell apart read alike, `input.opt`, with nothing invented), and owners of one
// selector that stated the same changes are one clause, as main collapses identical blocks to ×N.
// No line counts owners ("one of the N", "either of", "each … also") and none has an "and N more"
// tail: every change is named in its owner's clause, a colour the element draws included. The
// element's own state is always its own clause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';
import { cases } from './owner-truth-cases.mjs';

const G = ['rgb(20, 120, 60)', 'rgb(160, 40, 40)'];
const W = ['rgb(255, 255, 255)', 'rgb(40, 40, 120)'];
const at = (tag, n) => `body > ${tag}:nth-child(${n})`;
const opt = (n) => ({ tag: 'input', cls: 'opt', rect: [20, 20 + n * 40, 20, 20] });
const label = (n) => ({ tag: 'label', cls: 'opt-label', text: `Option ${n}`, rect: [60, 20 + n * 40, 100, 20] });
const border = (value) =>
  Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) => [`border-${side}-color`, value]));

/** The label's sentence for owners `changes` (each a props builder for one `input.opt`), all :checked. */
function sentence(t, changes) {
  const root = mkTmp('styleproof-counted-');
  t.after(() => rmTmp(root));
  const target = at('label', changes.length + 1);
  for (const side of ['before', 'after']) {
    const before = side === 'before';
    const elements = { [target]: label(changes.length) };
    const states = {};
    changes.forEach((props, i) => {
      elements[at('input', i + 1)] = opt(i);
      states[at('input', i + 1)] = { checked: { [target]: props(before ? 0 : 1) } };
    });
    const dir = path.join(root, side);
    writeCapture(dir, 'form@390', makeMap({ elements, states }), solidPng(390, 260));
    fs.writeFileSync(
      path.join(dir, 'form@390.checked.png'),
      solidPng(390, 260, before ? [20, 120, 60] : [160, 40, 40]),
    );
  }
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  return md.split('\n').find((l) => l.startsWith('On the opt label')) ?? md;
}

const PER_OWNER = [
  [
    'two controls of one selector, a colour echo pruned (QA15-01)',
    [(i) => ({ color: G[i], ...border(G[i]) }), (i) => ({ 'background-color': W[i] })],
    'On the opt label (Option 2), the text colour changes from green to red when `input.opt` is checked, and the background changes from white to dark indigo when `input.opt` is checked. At rest it looks the same.',
  ],
  [
    'two identical pairs, each pair one ×2 clause (QA14-01 Pairs)',
    [
      (i) => ({ color: G[i] }),
      (i) => ({ color: G[i] }),
      (i) => ({ 'background-color': W[i] }),
      (i) => ({ 'background-color': W[i] }),
    ],
    'On the opt label (Option 4), the text colour changes from green to red when `input.opt` ×2 is checked, and the background changes from white to dark indigo when `input.opt` ×2 is checked. At rest it looks the same.',
  ],
  [
    'four owners, every change named, no tail (QA17-01)',
    [
      (i) => ({ color: G[i], 'background-color': W[i], 'font-weight': ['400', '700'][i] }),
      (i) => ({ 'background-color': W[i] }),
      (i) => ({ 'outline-color': G[i] }),
      (i) => ({ 'font-weight': ['400', '700'][i] }),
    ],
    'On the opt label (Option 4), the background changes from white to dark indigo, text colour from green to red and text weight from `400` to `700` when `input.opt` is checked, the background changes from white to dark indigo when `input.opt` is checked, the outline colour changes from green to red when `input.opt` is checked, and the text weight changes from `400` to `700` when `input.opt` is checked. At rest it looks the same.',
  ],
  [
    'one owner with three changes names all three (QA17-01)',
    [
      (i) => ({ color: G[i], 'background-color': W[i], 'font-weight': ['400', '700'][i] }),
      (i) => ({ 'outline-color': G[i] }),
    ],
    'On the opt label (Option 2), the background changes from white to dark indigo, text colour from green to red and text weight from `400` to `700` when `input.opt` is checked, and the outline colour changes from green to red when `input.opt` is checked. At rest it looks the same.',
  ],
];

for (const [name, changes, expected] of PER_OWNER)
  test(`${name}: one clause per owner path`, (t) => {
    const line = sentence(t, changes);
    assert.equal(line, expected);
    assert.doesNotMatch(line, /one of the \d+|either of|any of the|each changes|also change|and \d+ more| or the /);
  });

/** The first sentence line QA16's live shapes (test/owner-truth-cases.mjs) render. */
function caseLine(t, build) {
  const root = mkTmp('styleproof-counted-case-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const dir = path.join(root, side);
    writeCapture(dir, 'form@390', makeMap(build(side === 'before')), solidPng(390, 260));
    for (const state of ['hover', 'checked'])
      fs.writeFileSync(path.join(dir, `form@390.${state}.png`), solidPng(390, 260));
  }
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
  });
  return fs
    .readFileSync(result.reportMdPath, 'utf8')
    .split('\n')
    .find((l) => /^(?:On|The) /.test(l));
}

// QA16 and QA17's live Chromium shapes (check/round-16/qa/site-r16, check/round-17/qa/site-r17,
// site-r17c), as owner-truth cases: each owner path its own clause; a colour the element draws (a
// border, an outline) named; the element's own state its own clause.
for (const [name, expected] of [
  [
    'QA16-01 visible-border-same-as-colour',
    'On the opt label (Option 2), the border colour changes from green to red and text colour from green to red when `input.opt` is checked, and the text colour changes from green to red when `input.opt` is checked. At rest it looks the same.',
  ],
  [
    'QA16-02 own-hover-plus-two-control-hovers',
    'On the Chip link, the text colour changes from green to red when hovered, the text colour changes from green to red when `input.pick` is hovered, and the background changes from white to dark indigo when `input.pick` is hovered. At rest it looks the same.',
  ],
  [
    'QA16-04 counted-after-resting-change',
    'The opt label (Option 2) changes text size from `12px` to `16px`. Its text colour changes from green to red when `input.opt` is checked, and background changes from white to dark indigo when `input.opt` is checked.',
  ],
  [
    'QA17-01 three-owners-drawn-border',
    'On the chips (Chip result), the text colour changes from green to red when `input.tri` is checked, the background changes from white to dark indigo when `input.tri` is checked, and the border colour changes from green to dark indigo when `input.tri` is checked. At rest it looks the same.',
  ],
  [
    'QA17-02 two-owners-overlapping-drawn',
    'On the pill (Pill), the border colour changes from green to red and text colour from green to red when `input.duo` is checked, and the background changes from white to dark indigo and text colour from green to red when `input.duo` is checked. At rest it looks the same.',
  ],
  [
    'QA17-03 drawn-outline-one-owner',
    'On the ring (Ring), the text colour changes from green to red and outline colour from green to red when the ringon is checked. At rest it looks the same.',
  ],
  [
    'QA17-03 drawn-outline-two-owners',
    'On the ring2 (Ring two), the text colour changes from green to red and outline colour from green to red when `input.rg` is checked, and the text colour changes from green to red when `input.rg` is checked. At rest it looks the same.',
  ],
  [
    'QA18-01 lone-owner-beside-x2',
    'On the opt label (Option 3), the text colour changes from green to red when `input.opt` is checked, and the background changes from white to dark indigo when `input.opt` ×2 is checked. At rest it looks the same.',
  ],
  [
    'QA18-01 lone-save-button-beside-x2',
    'On the panel (Panel), the text colour changes from green to red when `button.btn` is hovered, and the background changes from white to dark indigo when `button.btn` ×2 is hovered. At rest it looks the same.',
  ],
  [
    'QA17-04 own-plus-two-identical',
    'On the Twin link, the background changes from white to dark indigo when hovered, and the background changes from white to dark indigo when `input.twin` ×2 is hovered. At rest it looks the same.',
  ],
])
  test(`${name}: each owner path its own clause, every drawn change named`, (t) => {
    assert.equal(caseLine(t, cases[name]), expected);
  });
