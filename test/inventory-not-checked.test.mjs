// #478 — the navigable-removal gate must never report a check it did not run.
//
// With no captured inventory on either side, the audit is an empty diff of two empty
// sets, which is byte-identical to "nothing was removed". Reporting ✓ there states a
// guarantee StyleProof never earned. These tests pin the honest answer in all three
// places that speak about inventory: the library predicate, the rendered report, and
// the Action's gate step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateStyleMapReport } from '../dist/index.js';
import { hasCapturedInventory } from '../dist/inventory.js';
import { COVERAGE_LEDGER } from '../dist/coverage.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
const diffBin = fs.readFileSync(path.join(root, 'bin', 'styleproof-diff.mjs'), 'utf8');
const reportSrc = fs.readFileSync(path.join(root, 'src', 'report.ts'), 'utf8');

const nav = (keys) => keys.map((k) => ({ key: `nav-button:${k}`, kind: 'nav-button', label: k.toUpperCase() }));
const mapWith = (inventory) =>
  JSON.stringify({ defaults: {}, elements: {}, states: {}, ...(inventory ? { inventory } : {}) });

/** base/head bundle where only `withInventory` surfaces carry a nav inventory. */
function bundle({ baseNav, headNav, withInventory = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-inv-'));
  const base = path.join(dir, 'base');
  const head = path.join(dir, 'head');
  const out = path.join(dir, 'out');
  fs.mkdirSync(base);
  fs.mkdirSync(head);
  fs.writeFileSync(path.join(base, 'home@1440.json'), mapWith(withInventory ? nav(baseNav) : null));
  fs.writeFileSync(path.join(head, 'home@1440.json'), mapWith(withInventory ? nav(headNav) : null));
  for (const d of [base, head]) {
    fs.writeFileSync(
      path.join(d, COVERAGE_LEDGER),
      JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
    );
  }
  return { dir, base, head, out };
}
const readMd = (out) => fs.readFileSync(path.join(out, 'report.md'), 'utf8');

test('hasCapturedInventory is true only when a map actually carried affordances (#478)', () => {
  assert.equal(hasCapturedInventory([], []), false);
  assert.equal(hasCapturedInventory([undefined], [{}]), false);
  assert.equal(hasCapturedInventory([{ inventory: [] }], [{ inventory: [] }]), false);
  assert.equal(hasCapturedInventory([{ inventory: nav(['home']) }], [{ inventory: [] }]), true);
  assert.equal(hasCapturedInventory([{ inventory: [] }], [{ inventory: nav(['home']) }]), true);
  assert.equal(hasCapturedInventory([{ inventory: nav(['home']) }]), true, 'one side is enough');
});

test('a bundle with no captured inventory reports "not checked", never "unchanged" (#478)', () => {
  const { dir, base, head, out } = bundle({ baseNav: [], headNav: [], withInventory: false });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);

  assert.doesNotMatch(
    md,
    /navigable set unchanged/,
    'claiming the navigable set is unchanged asserts a check that never ran',
  );
  assert.match(md, /\*\*Inventory\*\* — ⚠ not checked/);
  assert.match(md, /set `inventory: true` in the capture spec/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a captured inventory with no removals still reports the ✓ it earned (#478)', () => {
  const { dir, base, head, out } = bundle({ baseNav: ['home', 'about'], headNav: ['home', 'about'] });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);

  assert.match(md, /\*\*Inventory\*\* — ✓ navigable set unchanged/);
  assert.doesNotMatch(md, /not checked/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a real removal still gates once an inventory was captured (#478 keeps the gate intact)', () => {
  const { dir, base, head, out } = bundle({ baseNav: ['home', 'billing'], headNav: ['home'] });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);

  assert.match(md, /\*\*Inventory\*\* — ⚠ 1 navigable affordance\(s\) removed, unacknowledged/);
  assert.match(md, /nav-button:billing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the Action names the armed-but-empty gate a COULD-NOT-RUN, not a pass (#478)', () => {
  const step = actionYml.match(
    /- name: Block on unacknowledged navigable removals[\s\S]*?(?=\n {4}# Canonical certification)/,
  );
  assert.ok(step, 'action.yml should still contain the inventory gate step');
  const gate = step[0];

  assert.match(gate, /gate-inventory-removals != 'false'/, 'the opt-out must still disarm the step');
  assert.match(gate, /::warning::StyleProof: inventory gate COULD NOT RUN/);
  assert.match(gate, /no captured map carried an inventory/);
  assert.doesNotMatch(
    gate,
    /::notice::StyleProof: inventory gate is on but/,
    'an armed gate with no data must not read as a reassuring notice',
  );
  // The armed-but-empty branch must still not fail the job: the README scopes the gate
  // to `inventory: true`, so specs that predate it keep working.
  const armedEmpty = gate.match(/inventory == null[\s\S]*?\n {8}fi/);
  assert.ok(armedEmpty, 'the armed-but-empty branch should be present');
  assert.match(armedEmpty[0], /exit 0/);
  assert.doesNotMatch(armedEmpty[0], /exit 1/);
  // A real removal is still a hard failure.
  assert.match(gate, /::error::StyleProof: \$\{count\} inventory gate failure\(s\)/);
  assert.match(gate, /exit 1/);
});

test('the report and the diff CLI decide "was it captured" through one predicate (#478)', () => {
  for (const [name, source] of [
    ['src/report.ts', reportSrc],
    ['bin/styleproof-diff.mjs', diffBin],
  ]) {
    assert.match(source, /hasCapturedInventory/, `${name} should use the shared predicate`);
  }
  assert.doesNotMatch(
    diffBin,
    /\.some\(\(m\) => m\.inventory\?\.length\)/,
    'the diff CLI must not keep a second, drifting copy of the rule',
  );
});
