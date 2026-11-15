// Slice 22 adds combinations, matrix, every owner-truth owner-path case, PR-comment checks,
// and the real Chromium capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateStructural } from '../dist/report.js';
import { attributionCheck, elementsIn } from './state-attribution-oracle.mjs';
import { cases as OWNER_TRUTH_CASES } from './owner-truth-cases.mjs';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

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

// QA18-02 / RV18-03: the oracle itself rejects an owner named apart by an invented word ("the first
// opt") and a lone owner named by its noun beside a ×N clause of the same selector and noun.
for (const [name, from, to] of [
  ['QA12-01b two-controls-same-state', 'when the opt is checked', 'when the first opt is checked'],
  ['QA18-01 lone-owner-beside-x2', /when `input\.opt` is checked/, 'when the opt is checked'],
  ['QA17-02 two-owners-overlapping-drawn', /when `input\.duo` is checked/, 'when the first duo is checked'],
])
  test(`the oracle rejects ${to.includes('first') ? 'an invented ordinal' : 'a noun beside a ×N clause'}: "${to}" (QA18-02)`, (t) => {
    const root = mkTmp('styleproof-attribution-mutant-');
    t.after(() => rmTmp(root));
    const [beforeDir, afterDir] = writeSides(root, OWNER_TRUTH_CASES[name]);
    const result = generateStructural({
      layout: 'visual-first',
      beforeDir,
      afterDir,
      outDir: path.join(root, 'report'),
    });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const elements = elementsIn(beforeDir, afterDir);
    assert.deepEqual(attributionCheck(md, json, name, elements), [], 'the real line passes');
    const mutant = md.replace(from, to);
    assert.notEqual(mutant, md, 'the mutation applies');
    assert.ok(attributionCheck(mutant, json, name, elements).length > 0, `the oracle rejects "${to}"`);
  });
