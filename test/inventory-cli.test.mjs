// Regression: the inventory guard must be SURFACED through the styleproof-diff CLI —
// a nav affordance that base offered and head no longer does has to BLOCK (exit 1),
// not sit in the maps ignored. This is the wiring the audit found missing: capture
// stored `inventory`, but the CLI never read it, so a removed Model Config passed
// "clean". These tests fail if that wiring regresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'styleproof-diff.mjs');

// Minimal valid StyleMap — loadStyleMap only JSON-parses; the diff needs
// defaults/elements/states. Identical on both sides so the ONLY signal is inventory.
const mapJson = (keys) =>
  JSON.stringify({
    defaults: {},
    elements: {},
    states: {},
    inventory: keys.map((k) => ({ key: `nav-button:${k}`, kind: 'nav-button', label: k.toUpperCase() })),
  });

function fixture(baseKeys, headKeys) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-inv-cli-'));
  const a = path.join(root, 'base');
  const b = path.join(root, 'head');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'home.json'), mapJson(baseKeys));
  fs.writeFileSync(path.join(b, 'home.json'), mapJson(headKeys));
  return { root, a, b };
}

function runDiff(a, b, cwd) {
  try {
    return { code: 0, out: execFileSync('node', [BIN, a, b], { cwd, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('styleproof-diff BLOCKS (exit 1) on an unacknowledged nav removal', () => {
  const { root, a, b } = fixture(['agents', 'model-config', 'faults'], ['agents', 'faults']);
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 1, `expected exit 1 on a silent nav removal, got ${code}\n${out}`);
  assert.match(out, /REMOVED, unacknowledged: nav-button:model-config/, out);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an acknowledged removal (styleproof.inventory.json) passes (exit 0)', () => {
  const { root, a, b } = fixture(['agents', 'model-config', 'faults'], ['agents', 'faults']);
  fs.writeFileSync(
    path.join(root, 'styleproof.inventory.json'),
    JSON.stringify({ 'nav-button:model-config': 'moved into the per-agent dossier' }),
  );
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 0, `expected exit 0 once acknowledged, got ${code}\n${out}`);
  assert.match(out, /acknowledged: moved into the per-agent dossier/, out);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unchanged navigable set does not block (exit 0)', () => {
  const { root, a, b } = fixture(['agents', 'faults'], ['agents', 'faults']);
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 0, `expected exit 0 when nothing removed, got ${code}\n${out}`);
  assert.match(out, /Inventory: navigable set unchanged/, out);
  fs.rmSync(root, { recursive: true, force: true });
});

// The inventory verdict must be machine-readable in --json (parallel to coverage /
// determinism), so a CI can hard-gate on `inventory.unacknowledged` instead of grepping
// human prose. Before this, --json carried coverage + determinism but NOT inventory.
test('styleproof-diff --json exposes the inventory verdict (the CI gating signal)', () => {
  const { root, a, b } = fixture(['agents', 'model-config', 'faults'], ['agents', 'faults']);
  const jsonPath = path.join(root, 'diff.json');
  assert.throws(
    () => execFileSync('node', [BIN, a, b, '--json', jsonPath], { cwd: root, encoding: 'utf8' }),
    (e) => e.status === 1, // the removal still gates via exit code
  );
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.ok(j.inventory, 'the --json payload carries an inventory verdict');
  assert.deepEqual(j.inventory.unacknowledged, ['nav-button:model-config'], 'names the gating removal');
  assert.deepEqual(j.inventory.removed, ['nav-button:model-config']);
  assert.deepEqual(j.inventory.added, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('styleproof-diff --json inventory is null when no capture carried inventory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-inv-json-'));
  const a = path.join(root, 'base');
  const b = path.join(root, 'head');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const noInv = JSON.stringify({ defaults: {}, elements: {}, states: {} });
  fs.writeFileSync(path.join(a, 'home.json'), noInv);
  fs.writeFileSync(path.join(b, 'home.json'), noInv);
  const jsonPath = path.join(root, 'diff.json');
  execFileSync('node', [BIN, a, b, '--json', jsonPath], { cwd: root, encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(j.inventory, null, 'no inventory in the maps → null verdict, nothing to gate on');
  fs.rmSync(root, { recursive: true, force: true });
});
