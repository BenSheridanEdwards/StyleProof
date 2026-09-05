// Source of truth — #476: the five-run oracle must run IN the capture path, not sit in the
// package exports. `styleproof-map --prove-determinism` captures the whole surface set five
// times and requires every canonical map hash to match.
//
// These drive the real bin with a stub `playwright` on PATH, so the orchestration (five
// runs, hashing, verdict, ledger promotion, receipt, cleanup, publish gating) is exercised
// without a browser. The oracle's own maths is covered in determinism-oracle.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_LEDGER } from '../dist/coverage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'styleproof-map.mjs');
const RECEIPT = 'styleproof-determinism.json';

/**
 * A stub capture command. Writes one map + a coverage ledger into $STYLEPROOF_BASEDIR/
 * $STYLEMAP_DIR, exactly as the runner would. `driftOnRun` makes the Nth distinct output
 * directory render differently — the flake the two-capture self-check cannot see.
 */
function writeStubPlaywright(binDir, { driftOnRun = 0 } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(process.env.STYLEPROOF_BASEDIR, process.env.STYLEMAP_DIR);
fs.mkdirSync(dir, { recursive: true });
const counterPath = path.join(process.env.STYLEPROOF_BASEDIR, '.stub-runs');
const seen = fs.existsSync(counterPath) ? JSON.parse(fs.readFileSync(counterPath, 'utf8')) : [];
if (!seen.includes(process.env.STYLEMAP_DIR)) seen.push(process.env.STYLEMAP_DIR);
fs.writeFileSync(counterPath, JSON.stringify(seen));
const run = seen.indexOf(process.env.STYLEMAP_DIR) + 1;
const color = run === ${driftOnRun} ? 'blue' : 'red';
const map = { defaults: {}, elements: { body: { tag: 'body', style: { color: color } } } };
fs.writeFileSync(path.join(dir, 'home@1280.json'), JSON.stringify(map));
fs.writeFileSync(
  path.join(dir, ${JSON.stringify(COVERAGE_LEDGER)}),
  JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
);
`;
  const target = path.join(binDir, 'playwright');
  fs.writeFileSync(target, script);
  fs.chmodSync(target, 0o755);
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-oracle-cli-'));
  fs.mkdirSync(path.join(root, 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(root, 'e2e', 'styleproof.spec.ts'), '// stub spec\n');
  writeStubPlaywright(path.join(root, 'stub-bin'), options);
  return { root, maps: path.join(root, 'maps') };
}

function runMap({ root, maps }, extraArgs) {
  const result = spawnSync(
    process.execPath,
    [BIN, '--dir', 'head', '--base-dir', maps, '--no-upload', '--no-screenshots', ...extraArgs],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'stub-bin')}${path.delimiter}${process.env.PATH}` },
    },
  );
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('--prove-determinism runs five captures and records the oracle-proven basis', () => {
  const dirs = fixture();
  const { code, out } = runMap(dirs, ['--prove-determinism']);
  const bundle = path.join(dirs.maps, 'head');
  try {
    assert.equal(code, 0, `five identical runs must certify\n${out}`);
    assert.match(out, /determinism oracle run 5\/5/);
    assert.match(out, /determinism oracle PASSED — 5\/5 runs identical/);

    // The strongest basis reaches the ledger the gate reads.
    const ledger = JSON.parse(fs.readFileSync(path.join(bundle, COVERAGE_LEDGER), 'utf8'));
    assert.equal(ledger.determinism, 'oracle-proven');
    assert.deepEqual(ledger.expected, ['home'], 'promoting the basis must not rewrite the rest of the ledger');

    // The receipt is the durable proof, beside the maps it certifies.
    const receipt = JSON.parse(fs.readFileSync(path.join(bundle, RECEIPT), 'utf8'));
    assert.equal(receipt.producer, 'styleproof-map');
    assert.equal(receipt.verdict.status, 'deterministic');
    assert.equal(receipt.verdict.observedRuns, 5);
    assert.deepEqual(receipt.verdict.stateKeys, ['home@1280']);

    // The four extra bundles are scratch: none may survive to be mistaken for a baseline.
    const leaked = fs.readdirSync(dirs.maps).filter((entry) => entry.includes('oracle-run'));
    assert.deepEqual(leaked, [], 'oracle scratch bundles must be cleaned up');
    // The proven bundle is publishable: the manifest was stamped after the oracle passed.
    assert.ok(fs.existsSync(path.join(bundle, 'styleproof-manifest.json')));
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('--prove-determinism discards the bundle when the fifth run drifts', () => {
  const dirs = fixture({ driftOnRun: 5 });
  const { code, out } = runMap(dirs, ['--prove-determinism']);
  try {
    assert.equal(code, 1, `a flake must never become a baseline\n${out}`);
    assert.match(out, /determinism oracle FAILED \(mismatch\) — 4\/5 runs matched/);
    assert.match(out, /an unproven bundle must never become a baseline/);
    // Discarded, not published: no bundle and no scratch dirs survive.
    assert.equal(fs.existsSync(path.join(dirs.maps, 'head')), false, 'the drifting bundle must be discarded');
    const leaked = fs.readdirSync(dirs.maps).filter((entry) => entry.includes('oracle-run'));
    assert.deepEqual(leaked, []);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('without the flag the capture stays a single self-checked run', () => {
  const dirs = fixture();
  const { code, out } = runMap(dirs, []);
  const bundle = path.join(dirs.maps, 'head');
  try {
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /determinism oracle/);
    // The default basis is unchanged — the oracle is opt-in, and costs five capture runs.
    assert.equal(JSON.parse(fs.readFileSync(path.join(bundle, COVERAGE_LEDGER), 'utf8')).determinism, 'self-checked');
    assert.equal(fs.existsSync(path.join(bundle, RECEIPT)), false, 'no flag, no receipt');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
