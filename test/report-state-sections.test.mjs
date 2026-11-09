import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

// Regression for the state-attribution bug (#1299's reproduction): three form controls in one
// area, each changed in its own forced state, and one state that restyles another element.
const checkbox = 'body > input:nth-child(1)';
const label = 'body > label:nth-child(2)';
const nickname = 'body > input:nth-child(3)';
const save = 'body > button:nth-child(4)';

function fixture(t, screenshots = true, hidden = false) {
  const root = mkTmp('styleproof-state-sections-');
  t.after(() => rmTmp(root));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  for (const dir of [beforeDir, afterDir]) {
    const color = dir === beforeDir ? 'rgb(20, 120, 60)' : 'rgb(160, 40, 40)';
    const map = makeMap({
      elements: {
        [checkbox]: { tag: 'input', cls: 'offers-check', rect: [20, 20, 20, 20] },
        [label]: { tag: 'label', cls: 'offers-label', rect: [40, 20, 100, 20] },
        [nickname]: { tag: 'input', cls: 'nickname', rect: [20, 45, 120, 25] },
        [save]: { tag: 'button', cls: 'save', rect: [20, 75, 100, 25] },
      },
      states: {
        [checkbox]: { checked: { [label]: { color } } },
        [nickname]: { 'placeholder-shown': { [nickname]: { 'border-color': color } } },
        [save]: { disabled: { [save]: { 'background-color': color } } },
      },
    });
    if (hidden) for (const entry of Object.values(map.elements)) entry.rect = [0, 0, 0, 0];
    writeCapture(dir, 'form@390', map, screenshots ? solidPng(390, 180) : undefined);
    if (screenshots) {
      for (const state of ['checked', 'disabled', 'placeholder-shown']) {
        fs.writeFileSync(
          path.join(dir, `form@390.${state}.png`),
          solidPng(390, 180, dir === beforeDir ? [20, 120, 60] : [160, 40, 40]),
        );
      }
    }
  }
  const result = generateReport({ beforeDir, afterDir, outDir: path.join(root, 'report') });
  return {
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

const sectionsOf = (md) =>
  Object.fromEntries(
    md
      .split(/^### /m)
      .slice(1)
      .map((section) => [section.split('\n')[0], section]),
  );

for (const [screenshots, hidden] of [
  [true, false],
  [false, false],
  [false, true],
]) {
  test(`each control gets its own change section named after the element that changed, screenshots=${screenshots}, hidden=${hidden}`, (t) => {
    const { md } = fixture(t, screenshots, hidden);
    const sections = sectionsOf(md);
    assert.deepEqual(
      Object.keys(sections),
      ['Offers label', 'Nickname', 'Save'],
      'page order, one per changed element',
    );
    assert.match(
      sections['Offers label'],
      /`label\.offers-label` · 1 element restyled · when `input\.offers-check` is `:checked`/,
    );
    assert.match(sections.Nickname, /`input\.nickname` · 1 element restyled/);
    assert.match(sections.Save, /`button\.save` · 1 element restyled/);
    assert.doesNotMatch(sections.Nickname, /:checked|:disabled/, 'no other state leaks into the field');
    assert.doesNotMatch(sections.Save, /:checked|placeholder/, 'no other state leaks into the button');
  });
}

test('a state that restyles another element names that element and the control driving it', (t) => {
  const { md, json } = fixture(t);
  const sections = sectionsOf(md);
  const offers = sections['Offers label'];
  assert.match(offers, /^On the offers label, the text colour changes from .+ when the offers check is checked\./m);
  assert.match(offers, /\*\*While checked\*\*/);
  assert.doesNotMatch(offers, /While disabled|While showing its placeholder/);
  assert.match(offers, /\| `:checked color` \|/, 'the CSS row is the label colour under :checked');
  assert.match(sections.Save, /\*\*While disabled\*\*/);
  assert.match(sections.Nickname, /\*\*While showing its placeholder\*\*/);
  // The Where map boxes the label that changed, never the checkbox that drives it.
  const region = json.surfaces[0].regions.find((r) => r.paths.includes(label));
  assert.deepEqual(region.paths, [label]);
  assert.deepEqual(
    region.where.flatMap((map) => map.boxes),
    [[40, 20, 100, 20]],
  );
});

test('machine findings keep the state owners', (t) => {
  const { json } = fixture(t);
  const owners = json.surfaces[0].findings.map((f) => [f.path, f.state, f.sub]).sort();
  assert.deepEqual(
    owners,
    [
      [checkbox, 'checked', label],
      [nickname, 'placeholder-shown', nickname],
      [save, 'disabled', save],
    ].sort(),
  );
});
