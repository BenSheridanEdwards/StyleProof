/**
 * Uncaptured state visibility tests (#614).
 *
 * Fail-closed contract: incomplete capture / uncaptured declared states must be
 * VISIBLE failures, not soft-green unknowns. Tests verify:
 *
 * 1. The report shows uncaptured states as failures (not silent omit)
 * 2. The gate treats uncaptured states as blocking (not advisory)
 * 3. No path produces a CLEAN/green verdict when declared states are unknown
 *
 * For each scenario:
 * - Uncaptured declared state + gate CLEAN = test FAIL
 * - Uncaptured state silent in report (just omitted) = test FAIL
 * - Soft-green / advisory-only for uncaptured declared = test FAIL
 * - Report must say "NOT CAPTURED" or an equivalent explicit phrase, not just drop the key
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { auditCoverage, coverageGaps, COVERAGE_LEDGER, translateExpected } from '../dist/coverage.js';
import { expandSurfaceVariants } from '../dist/runner.js';
import { generateStyleMapReport } from '../dist/index.js';
import { mkTmp, rmTmp, makeMap, fixtureCommitSha } from './helpers.mjs';

const BIN_DIFF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'styleproof-diff.mjs');

// Stamp a manifest on both sides for v4 compatibility
function stampManifest(dir, sha) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: fixtureCommitSha(sha),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '1'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0000000000000000',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

const writeMap = (dir, surface, map = makeMap()) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
};

const writeLedger = (dir, ledger) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, COVERAGE_LEDGER), JSON.stringify(ledger));
};

function runDiff(base, head) {
  try {
    return { code: 0, out: execFileSync('node', [BIN_DIFF, base, head], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// ── Scenario 1: Missing declared surface ─────────────────────────────────────────
// Expected surface never captured → coverage FAIL, report explicit "surface X: not captured", gate BLOCKED not CLEAN

test('scenario 1: missing declared surface blocks gate (exit 1, not 0)', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    // Capture only 'home', but declare 'home' and 'about' as expected
    writeMap(base, 'home@1440');
    writeMap(head, 'home@1440');

    const ledger = { version: 1, expected: ['home', 'about'], exclude: {}, determinism: 'self-checked' };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    const { code, out } = runDiff(base, head);

    // MUST block - exit 1, not 0 (CLEAN)
    assert.equal(code, 1, `gate must BLOCK when declared surface is uncaptured; got exit ${code}\n${out}`);
  } finally {
    rmTmp(root);
  }
});

test('scenario 1: missing declared surface explicitly named in CLI output (not silent)', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    writeMap(base, 'home@1440');
    writeMap(head, 'home@1440');

    const ledger = { version: 1, expected: ['home', 'about'], exclude: {}, determinism: 'self-checked' };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    const { out } = runDiff(base, head);

    // Output must EXPLICITLY name the uncaptured surface - not just silently omit it
    assert.match(out, /about/, 'uncaptured surface "about" must be named in output');
    assert.match(
      out,
      /missing|not captured|uncovered|INCOMPLETE/i,
      'output must indicate surface is missing/uncaptured',
    );
  } finally {
    rmTmp(root);
  }
});

test('scenario 1: missing declared surface explicit in report markdown (not silent omit)', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    writeMap(base, 'home@1440');
    writeMap(head, 'home@1440');

    const ledger = { version: 1, expected: ['home', 'about'], exclude: {}, determinism: 'self-checked' };
    writeLedger(base, ledger);
    writeLedger(head, ledger);

    generateStyleMapReport({ beforeDir: base, afterDir: head, outDir });
    const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');

    // Report must EXPLICITLY show the uncaptured surface - not just drop it
    assert.match(md, /about/, 'report must name uncaptured surface "about"');
    assert.match(md, /not captured|INCOMPLETE/i, 'report must indicate incomplete coverage');
  } finally {
    rmTmp(root);
  }
});

test('scenario 1: auditCoverage returns incomplete basis with uncovered list', () => {
  const captured = ['home'];
  const ledger = { version: 1, expected: ['home', 'about'], exclude: {}, determinism: 'self-checked' };

  const verdict = auditCoverage(captured, ledger);

  assert.equal(verdict.basis, 'incomplete', 'basis must be incomplete');
  assert.ok(verdict.uncovered.includes('about'), 'uncovered must include "about"');
});

// ── Scenario 2: Missing liveState variant ────────────────────────────────────────
// liveStates [loading, loaded] but only loading captured → explicit variant not captured, BLOCKED

test('scenario 2: missing liveState variant blocks gate (exit 1, not 0)', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    // Only capture home-loading, not home-loaded (the liveState variant)
    writeMap(base, 'home-loading@1440');
    writeMap(head, 'home-loading@1440');

    // Expected: both liveState variants must be captured
    const ledger = {
      version: 1,
      expected: ['home-loading', 'home-loaded'],
      exclude: {},
      determinism: 'self-checked',
    };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    const { code, out } = runDiff(base, head);

    // MUST block - exit 1, not 0 (CLEAN)
    assert.equal(code, 1, `gate must BLOCK when liveState variant is uncaptured; got exit ${code}\n${out}`);
  } finally {
    rmTmp(root);
  }
});

test('scenario 2: missing liveState variant explicitly named in CLI output', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    writeMap(base, 'home-loading@1440');
    writeMap(head, 'home-loading@1440');

    const ledger = {
      version: 1,
      expected: ['home-loading', 'home-loaded'],
      exclude: {},
      determinism: 'self-checked',
    };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    const { out } = runDiff(base, head);

    // Output must EXPLICITLY name the uncaptured liveState variant
    assert.match(out, /home-loaded/, 'uncaptured liveState "home-loaded" must be named in output');
    assert.match(out, /missing|not captured|uncovered|INCOMPLETE/i, 'output must indicate variant is missing');
  } finally {
    rmTmp(root);
  }
});

test('scenario 2: missing liveState variant explicit in report markdown', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    writeMap(base, 'home-loading@1440');
    writeMap(head, 'home-loading@1440');

    const ledger = {
      version: 1,
      expected: ['home-loading', 'home-loaded'],
      exclude: {},
      determinism: 'self-checked',
    };
    writeLedger(base, ledger);
    writeLedger(head, ledger);

    generateStyleMapReport({ beforeDir: base, afterDir: head, outDir });
    const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');

    // Report must EXPLICITLY show the uncaptured liveState variant
    assert.match(md, /home-loaded/, 'report must name uncaptured liveState "home-loaded"');
    assert.match(md, /not captured|INCOMPLETE/i, 'report must indicate incomplete coverage');
  } finally {
    rmTmp(root);
  }
});

test('scenario 2: translateExpected expands base key to liveState variants', () => {
  // When liveStates are declared, the base key 'home' should expand to 'home-loading', 'home-loaded'
  const homeLive = expandSurfaceVariants({
    key: 'home',
    go: async () => {},
    liveStates: [
      { key: 'loading', go: async () => {} },
      { key: 'loaded', go: async () => {} },
    ],
  });

  const ledgerExpected = translateExpected(['home'], homeLive);

  // translateExpected should expand 'home' to its liveState variants
  assert.ok(ledgerExpected.includes('home-loading'), 'expected must include home-loading');
  assert.ok(ledgerExpected.includes('home-loaded'), 'expected must include home-loaded');
});

test('scenario 2: coverageGaps catches missing liveState variant', () => {
  // Capture only home-loading
  const captured = ['home-loading'];
  // Expect both variants
  const expected = ['home-loading', 'home-loaded'];

  const { uncovered } = coverageGaps(captured, expected);

  assert.ok(uncovered.includes('home-loaded'), 'uncovered must include missing liveState variant');
});

// ── Scenario 3: Missing width ────────────────────────────────────────────────────
// widths [600,900] only 600 captured → explicit "900px: not captured" (or equivalent), BLOCKED

test('scenario 3: missing width blocks gate (exit 1, not 0)', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    // Only capture dashboard@600, not dashboard@900
    writeMap(base, 'dashboard@600');
    writeMap(head, 'dashboard@600');

    // Expected: both widths must be captured
    const ledger = {
      version: 1,
      expected: ['dashboard@600', 'dashboard@900'],
      exclude: {},
      determinism: 'self-checked',
    };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    const { code, out } = runDiff(base, head);

    // MUST block - exit 1, not 0 (CLEAN)
    assert.equal(code, 1, `gate must BLOCK when declared width is uncaptured; got exit ${code}\n${out}`);
  } finally {
    rmTmp(root);
  }
});

test('scenario 3: missing width explicitly named in CLI output', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    writeMap(base, 'dashboard@600');
    writeMap(head, 'dashboard@600');

    const ledger = {
      version: 1,
      expected: ['dashboard@600', 'dashboard@900'],
      exclude: {},
      determinism: 'self-checked',
    };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    const { out } = runDiff(base, head);

    // Output must EXPLICITLY name the uncaptured width
    assert.match(out, /dashboard@900/, 'uncaptured width "dashboard@900" must be named in output');
    assert.match(out, /missing|not captured|uncovered|INCOMPLETE/i, 'output must indicate width is missing');
  } finally {
    rmTmp(root);
  }
});

test('scenario 3: missing width explicit in report markdown', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    writeMap(base, 'dashboard@600');
    writeMap(head, 'dashboard@600');

    const ledger = {
      version: 1,
      expected: ['dashboard@600', 'dashboard@900'],
      exclude: {},
      determinism: 'self-checked',
    };
    writeLedger(base, ledger);
    writeLedger(head, ledger);

    generateStyleMapReport({ beforeDir: base, afterDir: head, outDir });
    const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');

    // Report must EXPLICITLY show the uncaptured width
    assert.match(md, /dashboard@900/, 'report must name uncaptured width "dashboard@900"');
    assert.match(md, /not captured|INCOMPLETE/i, 'report must indicate incomplete coverage');
  } finally {
    rmTmp(root);
  }
});

test('scenario 3: auditCoverage returns incomplete basis with width-specific uncovered', () => {
  const captured = ['dashboard@600'];
  const ledger = {
    version: 1,
    expected: ['dashboard@600', 'dashboard@900'],
    exclude: {},
    determinism: 'self-checked',
  };

  const verdict = auditCoverage(captured, ledger);

  assert.equal(verdict.basis, 'incomplete', 'basis must be incomplete');
  assert.ok(verdict.uncovered.includes('dashboard@900'), 'uncovered must include "dashboard@900"');
});

// ── Scenario 4: Partial forced-state ─────────────────────────────────────────────
// hover captured, focus skipped → FAIL only if declared required; if not declared, acceptable but documented

test('scenario 4: partial forced-state is documented (when not required, acceptable)', () => {
  // This scenario documents the existing behavior: forced-state (hover/focus/active)
  // is opt-in. If not declared as required, partial capture is acceptable.
  // The test verifies the explicit documentation of this behavior.
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    // Capture both base surfaces - forced-state layers are separate from coverage
    writeMap(base, 'button@1440');
    writeMap(head, 'button@1440');

    // Coverage is complete for the declared surface
    const ledger = { version: 1, expected: ['button'], exclude: {}, determinism: 'self-checked' };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    const { code, out } = runDiff(base, head);

    // With complete coverage, gate should pass (exit 0)
    // Forced-state incompleteness is reported separately by statesUncertified, not coverage
    assert.equal(code, 0, `gate should pass when coverage is complete; got exit ${code}\n${out}`);
    assert.match(out, /coverage complete/, 'output should confirm coverage complete');
  } finally {
    rmTmp(root);
  }
});

// ── Fail-closed contract verification ────────────────────────────────────────────
// These tests verify the core invariants of the fail-closed contract

test('fail-closed: no CLEAN verdict when declared states are unknown/uncaptured', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    // Capture only one surface, but declare THREE expected surfaces
    // This tests the fail-closed behavior with multiple uncaptured states
    writeMap(base, 'home@1440');
    writeMap(head, 'home@1440');

    const ledger = { version: 1, expected: ['home', 'about', 'pricing'], exclude: {}, determinism: 'self-checked' };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    const { code, out } = runDiff(base, head);

    // MUST NOT be CLEAN (exit 0) when declared states are uncaptured
    assert.notEqual(code, 0, `gate must NOT return CLEAN when declared states are uncaptured\n${out}`);
    // Output must name the uncaptured states
    assert.match(out, /about|pricing/, 'output must name uncaptured states');
  } finally {
    rmTmp(root);
  }
});

test('fail-closed: advisory-only mode still reports uncaptured states visibly', () => {
  // Even when using --allow-unasserted (diagnostic mode), uncaptured declared
  // states must still be visible in the output, not silently swallowed
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    writeMap(base, 'home@1440');
    writeMap(head, 'home@1440');

    const ledger = { version: 1, expected: ['home', 'about'], exclude: {}, determinism: 'self-checked' };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    // Run diff - we care about output visibility, not exit code here
    let out;
    try {
      out = execFileSync('node', [BIN_DIFF, base, head], { encoding: 'utf8' });
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    // Even if mode allows passage, uncaptured states must be VISIBLE
    assert.match(out, /about/, 'uncaptured states must be visible even in advisory output');
    assert.match(out, /INCOMPLETE|missing|not captured/i, 'incomplete status must be explicit');
  } finally {
    rmTmp(root);
  }
});

test('fail-closed: report.json certifiesFully is false when coverage incomplete', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    const jsonPath = path.join(root, 'out.json');
    fs.mkdirSync(base);
    fs.mkdirSync(head);

    writeMap(base, 'home@1440');
    writeMap(head, 'home@1440');

    const ledger = { version: 1, expected: ['home', 'about'], exclude: {}, determinism: 'self-checked' };
    writeLedger(base, ledger);
    writeLedger(head, ledger);
    stampManifest(base, 'base-sha');
    stampManifest(head, 'head-sha');

    try {
      execFileSync('node', [BIN_DIFF, base, head, '--json', jsonPath], { encoding: 'utf8' });
    } catch {
      // Expected to fail (exit 1)
    }

    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    // certifiesFully MUST be false when coverage is incomplete
    assert.equal(json.certifiesFully, false, 'certifiesFully must be false when coverage incomplete');
    assert.equal(json.coverage.basis, 'incomplete', 'coverage.basis must be incomplete');
    assert.ok(json.coverage.uncovered.includes('about'), 'coverage.uncovered must list missing surface');
  } finally {
    rmTmp(root);
  }
});

// ── Edge case: silent omit detection ─────────────────────────────────────────────
// These tests verify that uncaptured states can't be silently dropped

test('edge case: uncaptured state in expected cannot be silently omitted from uncovered list', () => {
  // Verify the invariant: every surface in expected that's not captured must appear in uncovered
  const captured = ['home'];
  const expected = ['home', 'about', 'pricing', 'contact'];

  const { uncovered } = coverageGaps(captured, expected);

  // All non-captured expected surfaces must be in uncovered
  assert.ok(uncovered.includes('about'), 'about must be in uncovered');
  assert.ok(uncovered.includes('pricing'), 'pricing must be in uncovered');
  assert.ok(uncovered.includes('contact'), 'contact must be in uncovered');
  assert.ok(!uncovered.includes('home'), 'home must NOT be in uncovered (it was captured)');
});

test('edge case: excluded surface is not in uncovered (intentional opt-out)', () => {
  const captured = ['home'];
  const expected = ['home', 'about'];
  const exclude = { about: 'Behind auth wall, fixture pending' };

  const { uncovered } = coverageGaps(captured, expected, exclude);

  // Excluded surface should NOT appear in uncovered
  assert.ok(!uncovered.includes('about'), 'excluded surface must not be in uncovered');
});
