import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

const checkbox = 'body > input:nth-child(1)';
const label = 'body > label:nth-child(2)';
const nickname = 'body > input:nth-child(3)';
const save = 'body > button:nth-child(4)';
const expectedHeadings = [
  '### **Offers label** `label.offers-label` · 1 element restyled `:checked`',
  '### **Save** `button.save` · 1 element restyled `:disabled`',
  '### **Nickname** `input.nickname` · 1 element restyled `:placeholder-shown`',
];

function fixture(t, screenshots = true, hidden = false) {
  const root = mkTmp('styleproof-state-headings-');
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
        fs.writeFileSync(path.join(dir, `form@390.${state}.png`), solidPng(390, 180));
      }
    }
  }
  const result = generateReport({ beforeDir, afterDir, outDir: path.join(root, 'report') });
  return {
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

for (const [screenshots, hidden] of [
  [true, false],
  [false, false],
  [false, true],
]) {
  test(`state headings name only their own targets, screenshots=${screenshots}, hidden=${hidden}`, (t) => {
    const { md } = fixture(t, screenshots, hidden);
    assert.deepEqual(
      md
        .split('\n')
        .filter((line) => line.startsWith('### '))
        .sort(),
      [...expectedHeadings].sort(),
    );
  });
}

test('cross-element state prose, property title and annotation name the target and state owner', (t) => {
  const { md } = fixture(t);
  assert.ok(md.includes('`label.offers-label` restyled when `input.offers-check` is `:checked`.'));
  assert.ok(md.includes('**Offers label** `label.offers-label`\n\nInteractive-state changes:'));
  assert.ok(md.includes('changed: `label.offers-label`'));
  assert.ok(!md.includes('changed: `input.offers-check`'));
  assert.ok(!md.includes('**Offers check** `input.offers-check`\n\nInteractive-state changes:'));
});

test('machine findings and region paths retain the state owners', (t) => {
  const { json } = fixture(t);
  const surface = json.surfaces[0];
  assert.deepEqual(
    surface.findings.map((f) => [f.kind, f.path, f.sub, f.state]),
    [
      ['state', checkbox, label, 'checked'],
      ['state', nickname, nickname, 'placeholder-shown'],
      ['state', save, save, 'disabled'],
    ],
  );
  assert.deepEqual(
    surface.regions.map((region) => region.paths),
    [[checkbox, nickname, save]],
  );
});
