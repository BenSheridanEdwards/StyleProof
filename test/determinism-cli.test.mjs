// Source of truth — determinism at the gate. A clean diff of two NONDETERMINISTIC
// captures is meaningless: they might just happen to match. A green needs both sides
// PROVEN deterministic — self-checked (captured twice, matched) or replayed (rendered
// against a fixed HAR). An unproven capture blocks even on an empty diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_LEDGER } from '../dist/coverage.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'styleproof-diff.mjs');
const map = () => JSON.stringify({ defaults: {}, elements: {}, states: {} });

// base+head both capture one identical surface (clean style diff), each with a ledger
// carrying its determinism basis. `expected: null` keeps coverage "unasserted" so only
// determinism is under test. `undefined` = no field (an older bundle).
function fixture(baseDet, headDet) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-det-'));
  const base = path.join(root, 'base');
  const head = path.join(root, 'head');
  fs.mkdirSync(base);
  fs.mkdirSync(head);
  fs.writeFileSync(path.join(base, 'home@1440.json'), map());
  fs.writeFileSync(path.join(head, 'home@1440.json'), map());
  const ledger = (d) => ({ version: 1, expected: null, exclude: {}, ...(d ? { determinism: d } : {}) });
  fs.writeFileSync(path.join(base, COVERAGE_LEDGER), JSON.stringify(ledger(baseDet)));
  fs.writeFileSync(path.join(head, COVERAGE_LEDGER), JSON.stringify(ledger(headDet)));
  return { root, base, head };
}
function run(base, head) {
  try {
    return { code: 0, out: execFileSync('node', [BIN, base, head], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('both self-checked → determinism proven, clean greens (exit 0)', () => {
  const { root, base, head } = fixture('self-checked', 'self-checked');
  const { code, out } = run(base, head);
  assert.equal(code, 0, `proven determinism + clean diff = green\n${out}`);
  assert.match(out, /determinism proven/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the record-then-replay flow — base self-checked, head replayed — is proven (exit 0)', () => {
  const { root, base, head } = fixture('self-checked', 'replayed');
  const { code, out } = run(base, head);
  assert.equal(code, 0, `record-then-replay is deterministic by construction\n${out}`);
  assert.match(out, /determinism proven/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unproven HEAD capture BLOCKS (exit 1) even with a clean style diff', () => {
  const { root, base, head } = fixture('self-checked', 'unproven');
  const { code, out } = run(base, head);
  assert.equal(code, 1, `an unproven capture cannot certify a green\n${out}`);
  assert.match(out, /determinism NOT proven/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unproven BASE capture BLOCKS too (exit 1)', () => {
  const { root, base, head } = fixture('unproven', 'self-checked');
  const { code } = run(base, head);
  assert.equal(code, 1, 'both sides must be proven');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an older bundle with no determinism field degrades to "unknown" (exit 0, not a false red)', () => {
  const { root, base, head } = fixture(undefined, undefined);
  const { code, out } = run(base, head);
  assert.equal(code, 0, `absent field degrades gracefully\n${out}`);
  assert.match(out, /determinism basis unknown/);
  fs.rmSync(root, { recursive: true, force: true });
});
