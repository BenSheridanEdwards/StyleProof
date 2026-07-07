// Regression: the data-residue guard must be SURFACED through styleproof-diff — a data
// endpoint that FAILED during capture (fallback branch captured) has to BLOCK (exit 1)
// when the gate is armed and the failure is unacknowledged, render as a visible opt-out
// when acknowledged, and fail on a stale acknowledgement so the ledger can't rot. In
// warn-mode (default) it surfaces without gating. Mirrors inventory-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { residueKey } from '../dist/data-residue.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'styleproof-diff.mjs');

// Minimal valid StyleMap — loadStyleMap only JSON-parses; the diff needs
// defaults/elements/states. Identical on both sides so the ONLY signal is residue.
const mapJson = (residue) =>
  JSON.stringify({ defaults: {}, elements: {}, states: {}, ...(residue ? { dataResidue: residue } : {}) });

const failing = (surface, endpoint, reason = 'net::ERR_CONNECTION_REFUSED') => ({
  key: residueKey(surface, endpoint),
  surface,
  endpoint,
  reason,
});

// Build base/head dirs; head carries `residue` and a ledger armed per `gate`. When `gate`
// is false the head opts down to the explicit `dataResidue: 'warn'` (the v4 opt-out) — the
// same non-arming the diff also infers for an older bundle with no field at all.
function fixture({ residue, gate }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-residue-cli-'));
  const a = path.join(root, 'base');
  const b = path.join(root, 'head');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'dashboard@1440.json'), mapJson(null));
  fs.writeFileSync(path.join(b, 'dashboard@1440.json'), mapJson(residue));
  const ledger = {
    version: 1,
    expected: null,
    exclude: {},
    determinism: 'self-checked',
    dataResidue: gate ? 'gate' : 'warn',
  };
  fs.writeFileSync(path.join(b, COVERAGE_LEDGER), JSON.stringify(ledger));
  fs.writeFileSync(
    path.join(a, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: null, exclude: {}, determinism: 'self-checked' }),
  );
  return { root, a, b };
}

function runDiff(a, b, cwd) {
  try {
    return { code: 0, out: execFileSync('node', [BIN, a, b], { cwd, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const KEY = residueKey('dashboard', '/api/probe');

test('armed gate + unacknowledged failing endpoint BLOCKS (exit 1) with a named line', () => {
  const { root, a, b } = fixture({ residue: [failing('dashboard', '/api/probe')], gate: true });
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 1, `expected exit 1 on an unacknowledged failing endpoint, got ${code}\n${out}`);
  assert.match(out, /dashboard · \/api\/probe/, out);
  assert.match(out, /unacknowledged/, out);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an acknowledged failing endpoint passes (exit 0) and renders as a visible opt-out', () => {
  const { root, a, b } = fixture({ residue: [failing('dashboard', '/api/probe')], gate: true });
  fs.writeFileSync(
    path.join(root, 'styleproof.data-residue.json'),
    JSON.stringify({ [KEY]: 'staging probe is intentionally offline' }),
  );
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 0, `expected exit 0 once acknowledged, got ${code}\n${out}`);
  assert.match(out, /acknowledged: staging probe is intentionally offline/, out);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a stale acknowledgement (endpoint no longer failing) BLOCKS under an armed gate', () => {
  // Head is clean (fixtured), but the ack lingers → stale → exit 1.
  const { root, a, b } = fixture({ residue: null, gate: true });
  fs.writeFileSync(path.join(root, 'styleproof.data-residue.json'), JSON.stringify({ [KEY]: 'was down' }));
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 1, `expected exit 1 on a stale acknowledgement, got ${code}\n${out}`);
  assert.match(out, /stale acknowledgement/, out);
  fs.rmSync(root, { recursive: true, force: true });
});

test('warn opt-out (gate not armed): a failing endpoint is SURFACED but does NOT block (exit 0)', () => {
  const { root, a, b } = fixture({ residue: [failing('dashboard', '/api/probe')], gate: false });
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 0, `warn opt-out must not gate, got ${code}\n${out}`);
  assert.match(out, /dashboard · \/api\/probe/, out);
  assert.match(out, /dataResidue: "warn"/, out);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a pre-v4 bundle (ledger with NO dataResidue field) reads as warn — never gated retroactively', () => {
  // The gate-by-default flip must not reach back into bundles captured before the
  // field existed: absence is the legacy shape, and it must arm nothing.
  const { root, a, b } = fixture({ residue: [failing('dashboard', '/api/probe')], gate: false });
  fs.writeFileSync(
    path.join(b, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: null, exclude: {}, determinism: 'self-checked' }),
  );
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 0, `a legacy field-less bundle must not gate retroactively, got ${code}\n${out}`);
  assert.match(out, /dashboard · \/api\/probe/, out);
  assert.doesNotMatch(out, /unacknowledged/, out);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clean healthy run (no residue, not armed) prints nothing about residue and exits 0', () => {
  const { root, a, b } = fixture({ residue: null, gate: false });
  const { code, out } = runDiff(a, b, root);
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.doesNotMatch(out, /Data residue/, 'no residue section when nothing failed and gate not armed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('--json carries an additive dataResidue field with the gating set', () => {
  const { root, a, b } = fixture({ residue: [failing('dashboard', '/api/probe')], gate: true });
  const jsonPath = path.join(root, 'out.json');
  try {
    execFileSync('node', [BIN, a, b, '--json', jsonPath], { cwd: root, encoding: 'utf8' });
  } catch {
    // exit 1 expected; the JSON is still written before exit.
  }
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(json.dataResidue.armed, true);
  assert.deepEqual(json.dataResidue.unacknowledged, [KEY]);
  assert.equal(json.dataResidue.blocking, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
