// RV15-04 / QA15-01: a counted clause (owners of one selector the report cannot tell apart) names
// the owner count once, then says each owner's own change under it, echo-pruned and capped like
// every change line (two phrases, then "and N more"). It never lists owners' properties as flat
// "or" alternatives, and never leads with a colour echo the crop cannot show.
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

test('two identical controls read as two controls, each with its own change, echo pruned (QA15-01)', (t) => {
  // The first control's border follows its colour (a currentColor echo the crop cannot show).
  const line = sentence(t, [(i) => ({ color: G[i], ...border(G[i]) }), (i) => ({ 'background-color': W[i] })]);
  assert.equal(
    line,
    'On the opt label (Option 2), when one of the 2 `input.opt` controls is checked, one changes the text colour from green to red, while the other changes the background from white to dark indigo. At rest it looks the same.',
  );
  assert.doesNotMatch(line, / or the /, 'no flat "or" alternatives');
  assert.doesNotMatch(line, /border/, 'the echo is pruned');
});

test('two pairs of identical controls count each pair once (QA14-01 Pairs)', (t) => {
  const line = sentence(t, [
    (i) => ({ color: G[i] }),
    (i) => ({ color: G[i] }),
    (i) => ({ 'background-color': W[i] }),
    (i) => ({ 'background-color': W[i] }),
  ]);
  assert.equal(
    line,
    'On the opt label (Option 4), when one of the 4 `input.opt` controls is checked, 2 of them change the text colour from green to red, while the other 2 change the background from white to dark indigo. At rest it looks the same.',
  );
});

test('a counted clause is capped: two owners shown, each with at most two phrases, then "and N more" (QA15-01)', (t) => {
  const line = sentence(t, [
    (i) => ({ color: G[i], 'background-color': W[i], 'font-weight': ['400', '700'][i] }),
    (i) => ({ 'background-color': W[i] }),
    (i) => ({ 'outline-color': G[i] }),
    (i) => ({ 'font-weight': ['400', '700'][i] }),
  ]);
  assert.equal(
    line,
    'On the opt label (Option 4), when one of the 4 `input.opt` controls is checked, one changes the background from white to dark indigo, the text colour from green to red and 1 more property; one changes the background from white to dark indigo; and 2 more controls make other changes. At rest it looks the same.',
  );
  assert.equal((line.match(/ one changes /g) ?? []).length, 2, 'two owners shown');
});
