// QA12-01: every forced-state finding names the control the capture recorded for it (the oracle
// is test/state-attribution-oracle.mjs; its truth is report.json's per-finding owner and target,
// the data main renders). Hand-written combinations, including QA12's three probes, then a generated
// matrix over one or two controls, the same or different states, the element's own hover or not,
// and an already-approved re-run or not, checked in report.md and in the PR comment; then QA12's
// real Chromium capture. test/report-state-attribution.e2e.spec.ts captures every combination live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateStructuralStyleMapReportForTesting as generateStructural,
  generateStyleMapReport,
} from '../dist/report.js';
import { attributionCheck } from './state-attribution-oracle.mjs';
import { cases as OWNER_TRUTH_CASES } from './owner-truth-cases.mjs';
import { runActionComment } from './action-comment-harness.mjs';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { fixtureCompatibilityKey, makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pick = (before, a, b) => (before ? a : b);
const control = (n, cls = 'opt', tag = 'input') => ({ tag, cls, rect: [20, 20 + n * 40, 20, 20] });
const label = (n, cls = 'opt-label', text = `Option ${n}`) => ({
  tag: 'label',
  cls,
  text,
  rect: [40, 20 + n * 40, 100, 20],
});
const at = (tag, n) => `body > ${tag}:nth-child(${n})`;
const GREEN = ['rgb(20, 120, 60)', 'rgb(160, 40, 40)'];
const WHITE = ['rgb(255, 255, 255)', 'rgb(40, 40, 120)'];
const AMBER = ['rgb(250, 160, 0)', 'rgb(0, 160, 80)'];
const value = (before, pair) => pick(before, pair[0], pair[1]);

/** The combinations: each builds one side's map (`before` true for the base). */
const COMBINATIONS = {
  'own state only (a label hover)': (before) => ({
    elements: { [at('label', 1)]: label(0) },
    states: { [at('label', 1)]: { hover: { [at('label', 1)]: { 'background-color': value(before, WHITE) } } } },
  }),
  'one control, one state (a checkbox checked)': (before) => ({
    elements: { [at('input', 1)]: control(0), [at('label', 2)]: label(0) },
    states: { [at('input', 1)]: { checked: { [at('label', 2)]: { color: value(before, GREEN) } } } },
  }),
  // QA12 probe (a).
  'two controls in different states (checkbox checked, button focus)': (before) => ({
    elements: {
      [at('input', 1)]: control(0),
      [at('button', 2)]: control(1, 'toggle', 'button'),
      [at('label', 3)]: label(2),
    },
    states: {
      [at('input', 1)]: { checked: { [at('label', 3)]: { color: value(before, GREEN) } } },
      [at('button', 2)]: { focus: { [at('label', 3)]: { 'background-color': value(before, WHITE) } } },
    },
  }),
  // QA12 probe (b).
  'two controls in the same state (two checkboxes checked)': (before) => ({
    elements: { [at('input', 1)]: control(0), [at('input', 2)]: control(1, 'other'), [at('label', 3)]: label(2) },
    states: {
      [at('input', 1)]: { checked: { [at('label', 3)]: { color: value(before, GREEN) } } },
      [at('input', 2)]: { checked: { [at('label', 3)]: { 'background-color': value(before, WHITE) } } },
    },
  }),
  // QA12 probe (c).
  "own hover plus a control's hover": (before) => ({
    elements: { [at('input', 1)]: control(0), [at('label', 2)]: label(0) },
    states: {
      [at('label', 2)]: { hover: { [at('label', 2)]: { 'background-color': value(before, WHITE) } } },
      [at('input', 1)]: { hover: { [at('label', 2)]: { color: value(before, GREEN) } } },
    },
  }),
  "own hover plus a checkbox's checked (RV11-01)": (before) => ({
    elements: { [at('input', 1)]: control(0), [at('label', 2)]: label(0) },
    states: {
      [at('label', 2)]: { hover: { [at('label', 2)]: { 'background-color': value(before, WHITE) } } },
      [at('input', 1)]: { checked: { [at('label', 2)]: { color: value(before, GREEN) } } },
    },
  }),
  "own focus plus a radio's checked": (before) => ({
    elements: { [at('input', 1)]: control(0, 'choice'), [at('label', 2)]: label(0, 'choice-label') },
    states: {
      [at('label', 2)]: { focus: { [at('label', 2)]: { 'outline-color': value(before, AMBER) } } },
      [at('input', 1)]: { checked: { [at('label', 2)]: { 'font-weight': pick(before, '400', '700') } } },
    },
  }),
  'own focus plus a control focus on the same element': (before) => ({
    elements: { [at('button', 1)]: control(0, 'toggle', 'button'), [at('label', 2)]: label(0) },
    states: {
      [at('label', 2)]: { focus: { [at('label', 2)]: { 'outline-color': value(before, AMBER) } } },
      [at('button', 1)]: { focus: { [at('label', 2)]: { color: value(before, GREEN) } } },
    },
  }),
  'three controls': (before) => ({
    elements: {
      [at('input', 1)]: control(0),
      [at('button', 2)]: control(1, 'toggle', 'button'),
      [at('input', 3)]: control(2, 'other'),
      [at('label', 4)]: label(3),
    },
    states: {
      [at('input', 1)]: { checked: { [at('label', 4)]: { color: value(before, GREEN) } } },
      [at('button', 2)]: { focus: { [at('label', 4)]: { 'outline-color': value(before, AMBER) } } },
      [at('input', 3)]: { hover: { [at('label', 4)]: { 'background-color': value(before, WHITE) } } },
    },
  }),
  'a control nested inside the element it restyles': (before) => ({
    elements: {
      [at('label', 1)]: label(0),
      [`${at('label', 1)} > input:nth-child(1)`]: control(0),
    },
    states: {
      [`${at('label', 1)} > input:nth-child(1)`]: { checked: { [at('label', 1)]: { color: value(before, GREEN) } } },
    },
  }),
  'sibling controls, each restyling its own label': (before) => ({
    elements: {
      [at('input', 1)]: control(0),
      [at('label', 2)]: label(0),
      [at('input', 3)]: control(1),
      [at('label', 4)]: label(1),
    },
    states: {
      [at('input', 1)]: { checked: { [at('label', 2)]: { color: value(before, GREEN) } } },
      [at('input', 3)]: { checked: { [at('label', 4)]: { color: value(before, GREEN) } } },
    },
  }),
  'sibling controls with own hovers on their labels': (before) => ({
    elements: {
      [at('input', 1)]: control(0),
      [at('label', 2)]: label(0),
      [at('input', 3)]: control(1),
      [at('label', 4)]: label(1),
    },
    states: {
      [at('label', 2)]: { hover: { [at('label', 2)]: { 'background-color': value(before, WHITE) } } },
      [at('label', 4)]: { hover: { [at('label', 4)]: { 'background-color': value(before, WHITE) } } },
      [at('input', 1)]: { checked: { [at('label', 2)]: { color: value(before, GREEN) } } },
      [at('input', 3)]: { checked: { [at('label', 4)]: { color: value(before, GREEN) } } },
    },
  }),
  "a control's own hover beside the label it checks": (before) => ({
    elements: { [at('input', 1)]: control(0), [at('label', 2)]: label(0) },
    states: {
      [at('input', 1)]: {
        hover: { [at('input', 1)]: { 'border-color': pick(before, 'rgb(0, 0, 0)', 'rgb(200, 0, 0)') } },
        checked: { [at('label', 2)]: { color: value(before, GREEN) } },
      },
    },
  }),
};

function writeSides(root, build) {
  const dirs = ['before', 'after'].map((side) => path.join(root, side));
  for (const dir of dirs) {
    const before = dir === dirs[0];
    writeCapture(dir, 'form@390', makeMap(build(before)), solidPng(390, 220));
    for (const state of ['hover', 'focus', 'checked'])
      fs.writeFileSync(
        path.join(dir, `form@390.${state}.png`),
        solidPng(390, 220, before ? [20, 120, 60] : [160, 40, 40]),
      );
  }
  return dirs;
}

for (const [name, build] of Object.entries(COMBINATIONS)) {
  test(`each state finding names the control that produced it: ${name} (QA12-01)`, (t) => {
    const root = mkTmp('styleproof-attribution-');
    t.after(() => rmTmp(root));
    const [beforeDir, afterDir] = writeSides(root, build);
    const result = generateStructural({ beforeDir, afterDir, outDir: path.join(root, 'report') });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    assert.ok(
      (json.surfaces ?? []).some((s) => (s.findings ?? []).some((f) => f.kind === 'state')),
      'state findings exist',
    );
    assert.deepEqual(attributionCheck(md, json, name), []);
  });
}

test("each state finding names its control on QA12's real Chromium capture (QA12-01)", (t) => {
  const root = mkTmp('styleproof-attribution-real-');
  t.after(() => rmTmp(root));
  // The committed manifests carry no environment key (a secret scanner reads it as one); both
  // sides get the same key here, as two captures from one environment have.
  const dirs = ['base', 'head'].map((side) => {
    const dir = path.join(root, side);
    fs.cpSync(path.join(here, 'fixtures/report-state-drivers-shop', side), dir, { recursive: true });
    const manifest = path.join(dir, MAP_MANIFEST);
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    data.compatibilityKey = fixtureCompatibilityKey('report-state-drivers-shop');
    fs.writeFileSync(manifest, JSON.stringify(data));
    return dir;
  });
  const result = generateStyleMapReport({ beforeDir: dirs[0], afterDir: dirs[1], outDir: path.join(root, 'report') });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  // `.pick:checked ~ .summary { color }` and `.wrap:checked ~ .summary { background }`: two controls.
  assert.ok(
    json.surfaces[0].findings.some((f) => f.kind === 'state' && f.cls === 'wrap'),
    'the wrap finding exists',
  );
  assert.deepEqual(attributionCheck(md, json, 'real capture'), []);
});

/** The generated matrix: one label restyled by one or two controls, with or without its own hover. */
// Each control: its path, its element and the properties its state changes on the target. `opt2*`
// share `opt`'s selector (`input.opt`) but are other elements; `pickr`/`spickr` share a noun but not
// a selector (QA13-02).
const CONTROLS = {
  opt: { path: at('input', 1), entry: control(0), props: { color: GREEN } },
  toggle: { path: at('button', 2), entry: control(1, 'toggle', 'button'), props: { 'background-color': WHITE } },
  opt2diff: { path: at('input', 3), entry: control(2), props: { 'outline-color': AMBER } },
  opt2same: { path: at('input', 3), entry: control(2), props: { color: GREEN } },
  opt2overlap: { path: at('input', 3), entry: control(2), props: { color: GREEN, 'background-color': WHITE } },
  pickr: { path: at('input', 1), entry: control(0, 'pickr'), props: { color: GREEN } },
  spickr: { path: at('select', 2), entry: control(1, 'pickr', 'select'), props: { 'background-color': WHITE } },
};
const TARGET = at('label', 4);
const MATRIX = [];
for (const [controls, states] of [
  [['opt'], ['checked']],
  [['opt'], ['hover']],
  [
    ['opt', 'toggle'],
    ['checked', 'checked'],
  ],
  [
    ['opt', 'toggle'],
    ['checked', 'focus'],
  ],
  [
    ['opt', 'toggle'],
    ['hover', 'focus'],
  ],
  // Same selector, different elements (QA13-01): different, the same, and overlapping properties.
  [
    ['opt', 'opt2diff'],
    ['checked', 'checked'],
  ],
  [
    ['opt', 'opt2diff'],
    ['checked', 'hover'],
  ],
  [
    ['opt', 'opt2same'],
    ['checked', 'checked'],
  ],
  [
    ['opt', 'opt2same'],
    ['checked', 'hover'],
  ],
  [
    ['opt', 'opt2overlap'],
    ['checked', 'checked'],
  ],
  // Same noun, different selectors and elements (QA13-02).
  [
    ['pickr', 'spickr'],
    ['focus', 'focus'],
  ],
])
  for (const ownHover of [false, true]) MATRIX.push({ controls, states, ownHover });

const matrixBuild =
  ({ controls, states, ownHover }) =>
  (before) => {
    const elements = { [TARGET]: label(3) };
    const stateMap = {};
    controls.forEach((name, i) => {
      const c = CONTROLS[name];
      elements[c.path] = c.entry;
      const props = Object.fromEntries(Object.entries(c.props).map(([prop, values]) => [prop, value(before, values)]));
      stateMap[c.path] = { [states[i]]: { [TARGET]: props } };
    });
    if (ownHover) stateMap[TARGET] = { hover: { [TARGET]: { 'font-weight': pick(before, '400', '700') } } };
    return { elements, states: stateMap };
  };

for (const combo of MATRIX) {
  const name = `${combo.controls.map((c, i) => `${c}:${combo.states[i]}`).join(' + ')}${combo.ownHover ? ' + own hover' : ''}`;
  test(`matrix: ${name}, in report.md and the PR comment, approved or not (QA12-01, QA13-01/02/03)`, async (t) => {
    const root = mkTmp('styleproof-attribution-matrix-');
    t.after(() => rmTmp(root));
    const [beforeDir, afterDir] = writeSides(root, matrixBuild(combo));
    const outDir = path.join(root, 'report');
    const result = generateStructural({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const problems = attributionCheck(md, json, `${name} / report.md`);
    for (const approved of [false, true]) {
      const comment = await runActionComment({
        reportDir: outDir,
        mode: 'review-gate',
        trustState: 'STYLE_REVIEW_REQUIRED',
        approved,
      });
      assert.equal(comment.includes('- [x] **Approve all changes**'), approved, 'the approved re-run renders ticked');
      problems.push(...attributionCheck(comment, json, `${name} / comment${approved ? ' (approved)' : ''}`));
    }
    assert.deepEqual(problems, []);
  });
}

// The round-13 diagnosis's wrong-control cases (QA11 RV11-01, QA12-01 a/b/c, QA13-01/02/03/03b),
// through this oracle in report.md and in the PR comment.
for (const [name, build] of Object.entries(OWNER_TRUTH_CASES)) {
  test(`owner-path oracle: ${name}, in report.md and the PR comment`, async (t) => {
    const root = mkTmp('styleproof-attribution-cases-');
    t.after(() => rmTmp(root));
    const [beforeDir, afterDir] = writeSides(root, build);
    const outDir = path.join(root, 'report');
    const result = generateStructural({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const comment = await runActionComment({
      reportDir: outDir,
      mode: 'review-gate',
      trustState: 'STYLE_REVIEW_REQUIRED',
    });
    assert.deepEqual(
      [...attributionCheck(md, json, `${name} / report.md`), ...attributionCheck(comment, json, `${name} / comment`)],
      [],
    );
  });
}
