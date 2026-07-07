// Source of truth — completeness at the gate. A green must state its basis: "clean"
// is only certified against a declared registry, and a registered surface that was
// never captured BLOCKS even when the style diff is empty. This is the failure the
// gate couldn't catch before: a green over a surface it never looked at.
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

// v4: a two-directory diff refuses a map-bearing side without a manifest. These fixtures
// exercise the OTHER gates (coverage/determinism/inventory/residue), so stamp a matching
// manifest on both sides to get past the environment guard (same runtime → compatible).
function stampManifest(dir, sha) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: 'test',
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: 'testcompatkey0000',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

// base+head both capture `captured` (so the STYLE diff is empty — isolating coverage).
// head carries the coverage ledger { expected, exclude }.
function fixture(captured, expected, exclude = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cov-'));
  const base = path.join(root, 'base');
  const head = path.join(root, 'head');
  fs.mkdirSync(base);
  fs.mkdirSync(head);
  for (const k of captured) {
    fs.writeFileSync(path.join(base, `${k}@1440.json`), map());
    fs.writeFileSync(path.join(head, `${k}@1440.json`), map());
  }
  fs.writeFileSync(path.join(head, COVERAGE_LEDGER), JSON.stringify({ version: 1, expected, exclude }));
  stampManifest(base, 'base-sha');
  stampManifest(head, 'head-sha');
  return { root, base, head };
}
function run(base, head) {
  try {
    return { code: 0, out: execFileSync('node', [BIN, base, head], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('a registered surface never captured BLOCKS (exit 1) even with a clean style diff', () => {
  const { root, base, head } = fixture(['home', 'pricing'], ['home', 'pricing', 'about']);
  const { code, out } = run(base, head);
  assert.equal(code, 1, `incomplete coverage must gate\n${out}`);
  assert.match(out, /coverage INCOMPLETE/);
  assert.match(out, /missing: about/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('complete coverage certifies clean (exit 0) and states the basis', () => {
  const { root, base, head } = fixture(['home', 'pricing'], ['home', 'pricing']);
  const { code, out } = run(base, head);
  assert.equal(code, 0, `complete coverage + clean diff = green\n${out}`);
  assert.match(out, /coverage complete — all 2 registered surface\(s\) captured/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an excluded surface counts as covered (exit 0)', () => {
  const { root, base, head } = fixture(['home', 'pricing'], ['home', 'pricing', 'about'], {
    about: 'auth-gated — fixture pending',
  });
  const { code, out } = run(base, head);
  assert.equal(code, 0, `an excluded registered surface is covered\n${out}`);
  assert.match(out, /coverage complete/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('no registry → "completeness NOT asserted" (green, but honest about its basis)', () => {
  const { root, base, head } = fixture(['home'], null); // expected: null = the crawl / no-registry case
  const { code, out } = run(base, head);
  assert.equal(code, 0, `no registry still greens, but says so\n${out}`);
  assert.match(out, /completeness NOT asserted/);
  fs.rmSync(root, { recursive: true, force: true });
});
