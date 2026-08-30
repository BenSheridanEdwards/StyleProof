import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfidenceLedger, CONFIDENCE_LEDGER, writeConfidenceLedger } from '../dist/confidence-ledger.js';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { diffStyleMapDirs } from '../dist/diff.js';
import { importMapBundleToEvidenceStore } from '../dist/evidence-import.js';
import { captureKeyParts } from '../dist/map-store.js';
import { PHASE0_REQUIRED_DOMAINS } from '../dist/phase0-contract.js';
import {
  parseReleaseConfidenceManifest,
  serializeReleaseConfidenceManifest,
  validateReleaseConfidenceManifest,
} from '../dist/release-confidence-manifest.js';
import { projectReleaseConfidence, ReleaseConfidenceProjectError } from '../dist/release-confidence-project.js';
import { fixtureCompatibilityKey, fixtureContentHash, makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const COMPAT = fixtureCompatibilityKey('rcm-project-control');
const SPEC_HASH = fixtureContentHash('e2e/styleproof.spec.ts');
const PRODUCT_STATE = { id: 'home-ready', revision: 'fixture-v2' };
const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');

function actionReportMergeScript() {
  const match = actionYml.match(/ {8}node --input-type=module <<'NODE'\n([\s\S]*?)\n {8}NODE/);
  assert.ok(match, 'action.yml should contain the report merge Node program');
  return `${match[1]
    .split('\n')
    .map((line) => line.replace(/^ {8}/, ''))
    .join('\n')}\n`;
}

function stampBundle(dir, sha, { coverage = true } = {}) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: '6.2.2',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: SPEC_HASH,
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: false,
      har: false,
      compatibilityKey: COMPAT,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  if (coverage) {
    fs.writeFileSync(
      path.join(dir, COVERAGE_LEDGER),
      JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
    );
  }
}

function matchingCapturePair({ coverage = true, captureKey = 'home@1280', surfaceKey } = {}) {
  const root = mkTmp('styleproof-rcm-project-');
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const map = {
    ...makeMap({
      elements: { 'body > button:nth-child(1)': { tag: 'button', style: { color: 'black' } } },
    }),
    metadata: { productState: PRODUCT_STATE, ...(surfaceKey ? { surfaceKey } : {}) },
  };
  writeCapture(beforeDir, captureKey, map, null);
  writeCapture(afterDir, captureKey, map, null);
  stampBundle(beforeDir, BASE_SHA, { coverage });
  stampBundle(afterDir, HEAD_SHA, { coverage });
  if (coverage) {
    for (const dir of [beforeDir, afterDir]) {
      writeConfidenceLedger(
        dir,
        buildConfidenceLedger({
          capturedKeys: ['home'],
          coverage: { version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' },
        }),
      );
    }
  }
  return { root, beforeDir, afterDir };
}

function projectMatching(dirs, evidence, overrides = {}) {
  return projectReleaseConfidence({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    manifestId: 'rcm-project-control',
    producerVersion: '6.2.2',
    releaseScope: 'release-home',
    expectedBeforeSha: BASE_SHA,
    expectedAfterSha: HEAD_SHA,
    evidence,
    ...overrides,
  });
}

test('projects matching 6.2 artifacts and verified evidence into one certifying manifest', () => {
  const dirs = matchingCapturePair();
  try {
    const storeRoot = path.join(dirs.root, 'evidence-store');
    const imported = importMapBundleToEvidenceStore({ bundleDirectory: dirs.afterDir, storeRoot });
    const produced = projectMatching(dirs, { storeRoot, capture: imported.capture });
    const { comparability } = diffStyleMapDirs(dirs.beforeDir, dirs.afterDir);
    const receipt = validateReleaseConfidenceManifest(produced.manifest);

    assert.equal(receipt.presence, 'present');
    assert.equal(receipt.certifies, true);
    assert.equal(produced.manifest.sourceSha, HEAD_SHA);
    assert.equal(produced.manifest.compatibilityKey, COMPAT);
    assert.deepEqual(
      [...produced.manifest.sourceRuns.map((run) => run.domain)].sort(),
      [...PHASE0_REQUIRED_DOMAINS].sort(),
    );
    assert.equal(produced.manifest.sourceRuns.length, 6);
    assert.equal(
      produced.manifest.sourceRuns
        .filter((run) => run.authority === 'styleproof')
        .every((run) => run.emptyUniverseProof === true),
      true,
    );
    assert.deepEqual(
      produced.manifest.comparability,
      comparability.map((entry) => ({
        surface: captureKeyParts(entry.surface).surface,
        status: entry.status,
        required: entry.required,
        reason: entry.reason,
      })),
    );
    assert.equal(produced.manifest.evidenceJoins.length, 1);
    assert.ok(
      produced.manifest.identities.some(
        (identity) =>
          identity.layer === 'product-state' && identity.id === 'home-ready' && identity.revision === 'fixture-v2',
      ),
    );
    assert.deepEqual(receipt.reasons, []);

    const sidecarPath = path.join(dirs.root, 'styleproof-release-confidence.json');
    fs.writeFileSync(sidecarPath, serializeReleaseConfidenceManifest(produced.manifest));
    assert.equal(
      validateReleaseConfidenceManifest(parseReleaseConfidenceManifest(fs.readFileSync(sidecarPath))).certifies,
      true,
    );

    const diffRun = spawnSync(
      process.execPath,
      [
        path.join(here, '..', 'bin/styleproof-diff.mjs'),
        dirs.beforeDir,
        dirs.afterDir,
        '--json',
        'styleproof-diff.json',
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: dirs.root, encoding: 'utf8' },
    );
    assert.equal(diffRun.status, 0, diffRun.stderr || diffRun.stdout);
    const reportRun = spawnSync(
      process.execPath,
      [
        path.join(here, '..', 'bin/styleproof-report.mjs'),
        dirs.beforeDir,
        dirs.afterDir,
        '--out',
        'styleproof-report',
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: dirs.root, encoding: 'utf8' },
    );
    assert.equal(reportRun.status, 0, reportRun.stderr || reportRun.stdout);

    const mergeScript = path.join(dirs.root, 'merge.mjs');
    const githubOutput = path.join(dirs.root, 'github-output');
    fs.writeFileSync(mergeScript, actionReportMergeScript());
    fs.writeFileSync(githubOutput, '');
    const mergeRun = spawnSync(process.execPath, [mergeScript], {
      cwd: dirs.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        STYLEPROOF_INCLUDE_CONTENT: 'false',
        STYLEPROOF_EXPECTED_BASE_SHA: BASE_SHA,
        STYLEPROOF_EXPECTED_HEAD_SHA: HEAD_SHA,
        GITHUB_ACTION_PATH: path.join(here, '..'),
        GITHUB_OUTPUT: githubOutput,
      },
    });
    assert.equal(mergeRun.status, 0, mergeRun.stderr || mergeRun.stdout);
    assert.equal(fs.existsSync(path.join(dirs.root, 'styleproof-report', 'report.json')), true);
    assert.equal(fs.existsSync(sidecarPath), true);
  } finally {
    rmTmp(dirs.root);
  }
});

test('semantic surface aliases must bind to their physical capture family', () => {
  const spoofed = matchingCapturePair({ captureKey: 'login@1280', surfaceKey: 'home' });
  try {
    const storeRoot = path.join(spoofed.root, 'evidence-store');
    const imported = importMapBundleToEvidenceStore({ bundleDirectory: spoofed.afterDir, storeRoot });
    assert.throws(
      () => projectMatching(spoofed, { storeRoot, capture: imported.capture }),
      (error) => error instanceof ReleaseConfidenceProjectError,
    );
  } finally {
    rmTmp(spoofed.root);
  }

  const expanded = matchingCapturePair({ captureKey: 'home-loading@1280', surfaceKey: 'home' });
  try {
    const storeRoot = path.join(expanded.root, 'evidence-store');
    const imported = importMapBundleToEvidenceStore({ bundleDirectory: expanded.afterDir, storeRoot });
    const produced = projectMatching(expanded, { storeRoot, capture: imported.capture });
    const receipt = validateReleaseConfidenceManifest(produced.manifest);

    assert.equal(receipt.certifies, true);
    assert.deepEqual(produced.manifest.declaredScope.surfaces, ['home']);
    assert.equal(
      produced.manifest.comparability.every((entry) => entry.surface === 'home'),
      true,
    );
    assert.equal(
      produced.manifest.obligations.every((entry) => entry.physicalCaptureKey === 'home-loading-1280'),
      true,
    );
  } finally {
    rmTmp(expanded.root);
  }
});

test('empty coverage registry cannot synthesize a certifying empty-universe proof', () => {
  const dirs = matchingCapturePair();
  try {
    const emptyCoverage = { version: 1, expected: [], exclude: {}, determinism: 'self-checked' };
    for (const dir of [dirs.beforeDir, dirs.afterDir]) {
      fs.writeFileSync(path.join(dir, COVERAGE_LEDGER), JSON.stringify(emptyCoverage));
      writeConfidenceLedger(dir, buildConfidenceLedger({ capturedKeys: ['home'], coverage: emptyCoverage }));
    }
    const storeRoot = path.join(dirs.root, 'evidence-store');
    const imported = importMapBundleToEvidenceStore({ bundleDirectory: dirs.afterDir, storeRoot });
    const produced = projectMatching(dirs, { storeRoot, capture: imported.capture });
    const receipt = validateReleaseConfidenceManifest(produced.manifest);
    const coverageRun = produced.manifest.sourceRuns.find((run) => run.domain === 'coverage-ledger');

    assert.equal(receipt.certifies, false);
    assert.equal(coverageRun.execution, 'partial');
    assert.equal(coverageRun.emptyUniverseProof, undefined);
  } finally {
    rmTmp(dirs.root);
  }
});

test('missing confidence ledger cannot certify complete coverage', () => {
  const dirs = matchingCapturePair();
  try {
    for (const dir of [dirs.beforeDir, dirs.afterDir]) {
      fs.rmSync(path.join(dir, CONFIDENCE_LEDGER));
    }
    const storeRoot = path.join(dirs.root, 'evidence-store');
    const imported = importMapBundleToEvidenceStore({ bundleDirectory: dirs.afterDir, storeRoot });
    const produced = projectMatching(dirs, { storeRoot, capture: imported.capture });
    const receipt = validateReleaseConfidenceManifest(produced.manifest);
    const coverageRun = produced.manifest.sourceRuns.find((run) => run.domain === 'coverage-ledger');

    assert.equal(receipt.certifies, false);
    assert.equal(coverageRun.execution, 'partial');
    assert.equal(coverageRun.emptyUniverseProof, undefined);
  } finally {
    rmTmp(dirs.root);
  }
});

test('either missing confidence ledger prevents certification', () => {
  const dirs = matchingCapturePair();
  try {
    fs.rmSync(path.join(dirs.beforeDir, CONFIDENCE_LEDGER));
    const storeRoot = path.join(dirs.root, 'evidence-store');
    const imported = importMapBundleToEvidenceStore({ bundleDirectory: dirs.afterDir, storeRoot });
    const produced = projectMatching(dirs, { storeRoot, capture: imported.capture });
    const receipt = validateReleaseConfidenceManifest(produced.manifest);
    const coverageRun = produced.manifest.sourceRuns.find((run) => run.domain === 'coverage-ledger');

    assert.equal(receipt.certifies, false);
    assert.equal(coverageRun.execution, 'partial');
  } finally {
    rmTmp(dirs.root);
  }
});

test('unasserted or limited confidence cannot certify complete coverage', () => {
  const completeCoverage = { version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' };
  const confidenceCases = [
    buildConfidenceLedger({ capturedKeys: ['home'], coverage: null }),
    buildConfidenceLedger({ capturedKeys: [], coverage: completeCoverage }),
  ];

  for (const confidence of confidenceCases) {
    const dirs = matchingCapturePair();
    try {
      writeConfidenceLedger(dirs.afterDir, confidence);
      const storeRoot = path.join(dirs.root, 'evidence-store');
      const imported = importMapBundleToEvidenceStore({ bundleDirectory: dirs.afterDir, storeRoot });
      const produced = projectMatching(dirs, { storeRoot, capture: imported.capture });
      const receipt = validateReleaseConfidenceManifest(produced.manifest);
      const coverageRun = produced.manifest.sourceRuns.find((run) => run.domain === 'coverage-ledger');

      assert.equal(receipt.certifies, false);
      assert.equal(coverageRun.execution, 'partial');
    } finally {
      rmTmp(dirs.root);
    }
  }
});

test('empty or wrong-universe asserted confidence cannot certify', () => {
  const confidenceCases = [
    {
      before: { version: 1, basis: 'asserted', entries: [] },
      after: { version: 1, basis: 'asserted', entries: [] },
    },
    {
      before: {
        version: 1,
        basis: 'asserted',
        entries: [{ surface: 'login', producer: 'capture', status: 'captured' }],
      },
      after: {
        version: 1,
        basis: 'asserted',
        entries: [{ surface: 'login', producer: 'capture', status: 'captured' }],
      },
    },
    {
      before: {
        version: 1,
        basis: 'asserted',
        entries: [{ surface: 'login', producer: 'capture', status: 'captured' }],
      },
      after: {
        version: 1,
        basis: 'asserted',
        entries: [{ surface: 'home', producer: 'capture', status: 'captured' }],
      },
    },
  ];

  for (const confidence of confidenceCases) {
    const dirs = matchingCapturePair();
    try {
      writeConfidenceLedger(dirs.beforeDir, confidence.before);
      writeConfidenceLedger(dirs.afterDir, confidence.after);
      const storeRoot = path.join(dirs.root, 'evidence-store');
      const imported = importMapBundleToEvidenceStore({ bundleDirectory: dirs.afterDir, storeRoot });
      const produced = projectMatching(dirs, { storeRoot, capture: imported.capture });
      const receipt = validateReleaseConfidenceManifest(produced.manifest);
      const coverageRun = produced.manifest.sourceRuns.find((run) => run.domain === 'coverage-ledger');

      assert.equal(receipt.certifies, false);
      assert.equal(coverageRun.execution, 'partial');
    } finally {
      rmTmp(dirs.root);
    }
  }
});

test('missing coverage ledger is an unasserted not-run envelope, never proved empty', () => {
  const dirs = matchingCapturePair({ coverage: false });
  try {
    const produced = projectMatching(dirs);
    const receipt = validateReleaseConfidenceManifest(produced.manifest);
    const coverageRun = produced.manifest.sourceRuns.find((run) => run.domain === 'coverage-ledger');
    const determinismRun = produced.manifest.sourceRuns.find((run) => run.domain === 'determinism');

    assert.equal(receipt.presence, 'present');
    assert.equal(receipt.certifies, false);
    assert.equal(coverageRun?.execution, 'not-run');
    assert.equal(coverageRun?.closure, 'unasserted');
    assert.equal(coverageRun?.emptyUniverseProof, undefined);
    assert.equal(coverageRun?.factCount, 0);
    assert.equal(determinismRun?.execution, 'not-run');
    assert.equal(determinismRun?.emptyUniverseProof, undefined);
    assert.equal(produced.manifest.gaps.sourceRuns.includes('run-coverage-ledger'), true);
  } finally {
    rmTmp(dirs.root);
  }
});

test('present malformed ledgers hard-fail distinctly from missing ledgers', () => {
  for (const file of [COVERAGE_LEDGER, CONFIDENCE_LEDGER]) {
    const dirs = matchingCapturePair();
    try {
      fs.writeFileSync(path.join(dirs.afterDir, file), '{');
      assert.throws(
        () => projectMatching(dirs),
        (error) =>
          error instanceof ReleaseConfidenceProjectError && error.message === 'release confidence projection failed',
      );
    } finally {
      rmTmp(dirs.root);
    }
  }
});

test('projector producer version must equal the exact capture package version', () => {
  const dirs = matchingCapturePair();
  try {
    const storeRoot = path.join(dirs.root, 'evidence-store');
    const imported = importMapBundleToEvidenceStore({ bundleDirectory: dirs.afterDir, storeRoot });
    assert.throws(
      () => projectMatching(dirs, { storeRoot, capture: imported.capture }, { producerVersion: '9.9.9' }),
      (error) =>
        error instanceof ReleaseConfidenceProjectError && error.message === 'release confidence projection failed',
    );
  } finally {
    rmTmp(dirs.root);
  }
});

test('verified evidence for the wrong source SHA hard-fails', () => {
  const dirs = matchingCapturePair();
  try {
    const storeRoot = path.join(dirs.root, 'evidence-store');
    const imported = importMapBundleToEvidenceStore({ bundleDirectory: dirs.beforeDir, storeRoot });
    assert.throws(
      () => projectMatching(dirs, { storeRoot, capture: imported.capture }),
      (error) =>
        error instanceof ReleaseConfidenceProjectError && error.message === 'release confidence projection failed',
    );
  } finally {
    rmTmp(dirs.root);
  }
});

test('exports the 6.2 projector from the package root', async () => {
  const root = await import('../dist/index.js');
  assert.equal(typeof root.projectReleaseConfidence, 'function');
});
