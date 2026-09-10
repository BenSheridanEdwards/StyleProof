/**
 * Tests for the --migration flag on styleproof-diff and styleproof-report CLIs.
 * Issue #564: CLI --migration + two-SHA/two-dir wiring
 *
 * Exit code contract:
 * | Mode             | Structure changes | Exit code |
 * |------------------|-------------------|-----------|
 * | Certify (default)| advisory          | 0 if no style changes |
 * | Migration        | reviewable        | 1 if structure or style changes |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkTmp,
  rmTmp,
  makeMap,
  writeCapture,
  solidPng,
  fixtureCommitSha,
  fixtureCompatibilityKey,
} from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const diffCli = path.join(root, 'bin', 'styleproof-diff.mjs');
const reportCli = path.join(root, 'bin', 'styleproof-report.mjs');

function runDiff(args, cwd = root) {
  return spawnSync(process.execPath, [diffCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function runReport(args, cwd = root) {
  return spawnSync(process.execPath, [reportCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

/**
 * Write a v1-compliant manifest alongside captures. Required for v4 map
 * compatibility validation.
 */
function writeManifest(dir, { sha = 'base', compatibilityKey = 'compat' } = {}) {
  const manifest = {
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
    compatibilityKey: fixtureCompatibilityKey(compatibilityKey),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, 'styleproof-manifest.json'), JSON.stringify(manifest, null, 2));
}

/**
 * Create a before/after pair where the only change is structure (element added/removed).
 * No style changes. Should exit 0 in certify mode, exit 1 in migration mode.
 */
function structureOnlyFixture() {
  const tmp = mkTmp('migration-structure-');
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');

  // Before: just a body
  writeCapture(
    beforeDir,
    'home@1280',
    makeMap({
      elements: {
        body: { tag: 'body', style: { color: 'black' } },
      },
    }),
    solidPng(1280, 800),
  );
  writeManifest(beforeDir, { sha: 'base', compatibilityKey: 'compat' });

  // After: body + a new element added (structure change only)
  writeCapture(
    afterDir,
    'home@1280',
    makeMap({
      elements: {
        body: { tag: 'body', style: { color: 'black' } },
        'body > div:nth-child(1)': { tag: 'div', cls: 'new-elem', style: { color: 'blue' } },
      },
    }),
    solidPng(1280, 800),
  );
  writeManifest(afterDir, { sha: 'head', compatibilityKey: 'compat' });

  return { tmp, beforeDir, afterDir };
}

/**
 * Create a before/after pair with only style changes (no structural changes).
 * Should exit 1 in both certify and migration modes.
 */
function styleOnlyFixture() {
  const tmp = mkTmp('migration-style-');
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');

  // Before: body with red color
  writeCapture(
    beforeDir,
    'home@1280',
    makeMap({
      elements: {
        body: { tag: 'body', style: { color: 'red' } },
      },
    }),
    solidPng(1280, 800),
  );
  writeManifest(beforeDir, { sha: 'base', compatibilityKey: 'compat' });

  // After: body with blue color (style change)
  writeCapture(
    afterDir,
    'home@1280',
    makeMap({
      elements: {
        body: { tag: 'body', style: { color: 'blue' } },
      },
    }),
    solidPng(1280, 800),
  );
  writeManifest(afterDir, { sha: 'head', compatibilityKey: 'compat' });

  return { tmp, beforeDir, afterDir };
}

/**
 * Create a before/after pair with no changes at all.
 * Should exit 0 in both modes.
 */
function noChangeFixture() {
  const tmp = mkTmp('migration-nochange-');
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');

  const map = makeMap({
    elements: {
      body: { tag: 'body', style: { color: 'black' } },
    },
  });

  writeCapture(beforeDir, 'home@1280', map, solidPng(1280, 800));
  writeManifest(beforeDir, { sha: 'base', compatibilityKey: 'compat' });

  writeCapture(afterDir, 'home@1280', map, solidPng(1280, 800));
  writeManifest(afterDir, { sha: 'head', compatibilityKey: 'compat' });

  return { tmp, beforeDir, afterDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// Help text tests
// ─────────────────────────────────────────────────────────────────────────────

test('styleproof-diff --help documents the --migration flag', () => {
  const result = runDiff(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--migration/, 'help should document --migration flag');
});

test('styleproof-report --help documents the --migration flag', () => {
  const result = runReport(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--migration/, 'help should document --migration flag');
});

// ─────────────────────────────────────────────────────────────────────────────
// styleproof-diff: --migration flag behavior
// ─────────────────────────────────────────────────────────────────────────────

test('styleproof-diff: structure-only changes exit 0 in default certify mode', () => {
  const { tmp, beforeDir, afterDir } = structureOnlyFixture();
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    const result = runDiff(['--allow-unasserted', beforeDir, afterDir]);
    // In certify mode (default), structure changes are advisory, so exit 0
    assert.equal(
      result.status,
      0,
      `Expected exit 0 for advisory structure changes.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-diff --migration: structure-only changes exit 1', () => {
  const { tmp, beforeDir, afterDir } = structureOnlyFixture();
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    const result = runDiff(['--migration', '--allow-unasserted', beforeDir, afterDir]);
    // In migration mode, structure changes are reviewable, so exit 1
    assert.equal(
      result.status,
      1,
      `Expected exit 1 for reviewable structure changes in migration mode.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-diff: style changes exit 1 in default certify mode', () => {
  const { tmp, beforeDir, afterDir } = styleOnlyFixture();
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    const result = runDiff(['--allow-unasserted', beforeDir, afterDir]);
    // Style changes always exit 1 regardless of mode
    assert.equal(
      result.status,
      1,
      `Expected exit 1 for style changes.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-diff --migration: style changes exit 1', () => {
  const { tmp, beforeDir, afterDir } = styleOnlyFixture();
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    const result = runDiff(['--migration', '--allow-unasserted', beforeDir, afterDir]);
    // Style changes exit 1 in migration mode too
    assert.equal(
      result.status,
      1,
      `Expected exit 1 for style changes in migration mode.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-diff: no changes exit 0 in default certify mode', () => {
  const { tmp, beforeDir, afterDir } = noChangeFixture();
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    const result = runDiff(['--allow-unasserted', beforeDir, afterDir]);
    assert.equal(
      result.status,
      0,
      `Expected exit 0 for no changes.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-diff --migration: no changes exit 0', () => {
  const { tmp, beforeDir, afterDir } = noChangeFixture();
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    const result = runDiff(['--migration', '--allow-unasserted', beforeDir, afterDir]);
    assert.equal(
      result.status,
      0,
      `Expected exit 0 for no changes in migration mode.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-diff --migration: JSON output includes migration marker', () => {
  const { tmp, beforeDir, afterDir } = structureOnlyFixture();
  const jsonFile = path.join(tmp, 'diff.json');
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    runDiff(['--migration', '--allow-unasserted', beforeDir, afterDir, '--json', jsonFile]);
    const json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    assert.equal(json.migration, true, 'JSON output should include migration: true');
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-diff: JSON output without --migration does not include migration marker', () => {
  const { tmp, beforeDir, afterDir } = structureOnlyFixture();
  const jsonFile = path.join(tmp, 'diff.json');
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    runDiff(['--allow-unasserted', beforeDir, afterDir, '--json', jsonFile]);
    const json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    assert.equal(json.migration, undefined, 'JSON output should not include migration marker in certify mode');
  } finally {
    rmTmp(tmp);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// styleproof-report: --migration flag behavior
// ─────────────────────────────────────────────────────────────────────────────

test('styleproof-report --migration: accepts the flag without error', () => {
  const { tmp, beforeDir, afterDir } = noChangeFixture();
  const outDir = path.join(tmp, 'report');
  try {
    const result = runReport(['--migration', beforeDir, afterDir, '--out', outDir]);
    // Should not exit with 2 (usage error); report CLI may exit 0 or 1 depending on changes
    assert.notEqual(result.status, 2, `--migration should be accepted.\nstderr: ${result.stderr}`);
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-report --migration: report.json includes migration marker', () => {
  const { tmp, beforeDir, afterDir } = noChangeFixture();
  const outDir = path.join(tmp, 'report');
  try {
    runReport(['--migration', beforeDir, afterDir, '--out', outDir]);
    const reportJson = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(reportJson.migration, true, 'report.json should include migration: true');
  } finally {
    rmTmp(tmp);
  }
});

test('styleproof-report: report.json without --migration does not include migration marker', () => {
  const { tmp, beforeDir, afterDir } = noChangeFixture();
  const outDir = path.join(tmp, 'report');
  try {
    runReport([beforeDir, afterDir, '--out', outDir]);
    const reportJson = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(reportJson.migration, undefined, 'report.json should not include migration marker in certify mode');
  } finally {
    rmTmp(tmp);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward compatibility: existing behavior unchanged without --migration
// ─────────────────────────────────────────────────────────────────────────────

test('styleproof-diff: existing behavior unchanged when --migration is not passed', () => {
  const { tmp, beforeDir, afterDir } = structureOnlyFixture();
  try {
    // Use --allow-unasserted to bypass coverage/determinism checks for test fixtures
    const result = runDiff(['--allow-unasserted', beforeDir, afterDir]);
    // This test verifies the invariant: certify and style contracts remain
    // fail-closed and at least as strong. Structure changes are advisory.
    assert.equal(result.status, 0, 'Structure-only changes should not block in default certify mode');
    // In certify mode with --allow-unasserted, DOM changes may still appear in output
    // or may be suppressed depending on the settings. The key assertion is exit 0.
  } finally {
    rmTmp(tmp);
  }
});
