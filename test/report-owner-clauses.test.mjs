import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

const G = ['rgb(20, 120, 60)', 'rgb(160, 40, 40)'];
const W = ['rgb(255, 255, 255)', 'rgb(40, 40, 120)'];
const at = (tag, n) => `body > ${tag}:nth-child(${n})`;
const opt = (n) => ({ tag: 'input', cls: 'opt', rect: [20, 20 + n * 40, 20, 20] });
const label = (n) => ({ tag: 'label', cls: 'opt-label', text: `Option ${n}`, rect: [60, 20 + n * 40, 100, 20] });
const border = (value) =>
  Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) => [`border-${side}-color`, value]));

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
    fs.writeFileSync(path.join(dir, 'form@390.checked.png'), solidPng(390, 260));
  }
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
    layout: 'visual-first',
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
