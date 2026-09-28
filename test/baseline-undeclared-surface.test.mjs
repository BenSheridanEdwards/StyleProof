/**
 * A surface the pull request adds is new, not baseline repair debt.
 *
 * With a spec overlay the base side runs the head harness against base code, so a
 * surface added by the pull request is attempted on base and fails there. Git proves
 * the base never declared it: the failure is set aside and the surface is reviewed as
 * new. Everything else stays fail-closed: a surface declared on both sides whose base
 * capture failed is still PARTIAL_BASELINE, and so is a new surface the head failed.
 *
 * The fixture repository mirrors a monorepo adopter: the capture runs in `app/`, so the
 * manifests record `e2e/capture.spec.ts`, while the diff and report run from the
 * repository root (where a composite Action's steps run).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { MAP_MANIFEST, partitionBaselineFailures } from '../dist/map-store.js';
import { classifyStyleProofVerdict } from '../dist/verdict.js';
import { mkTmp, rmTmp, makeMap, solidPng, fixtureCompatibilityKey, spawnSyncBounded } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');
const REPORT = path.join(here, '..', 'bin', 'styleproof-report.mjs');
const SPEC = 'e2e/capture.spec.ts';
const PACKAGE_DIR = 'app';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

const specSource = (keys, extra = '') =>
  `export const surfaces = [\n${keys.map((k) => `  { key: '${k}', go: async () => {} },`).join('\n')}\n];\n${extra}`;

/** A two-commit repository: base declares `baseKeys`, head declares `headKeys`. */
function makeRepo(tmp, { baseKeys, headKeys, baseExtra = '', headExtra = '' }) {
  const repo = path.join(tmp, 'repo');
  const specFile = path.join(repo, PACKAGE_DIR, SPEC);
  fs.mkdirSync(path.dirname(specFile), { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(specFile, specSource(baseKeys, baseExtra));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const headSource = specSource(headKeys, headExtra);
  fs.writeFileSync(specFile, headSource);
  git(repo, 'commit', '-q', '-am', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  // Under a spec overlay both sides record the head spec's hash.
  return { repo, base, head, specHash: sha256(headSource) };
}

const map = makeMap({ elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } } });

function writeSide(dir, sha, specHash, keys, surfaceCaptureFailures = []) {
  fs.mkdirSync(dir, { recursive: true });
  for (const key of keys) {
    fs.writeFileSync(path.join(dir, `${key}.json.gz`), gzipSync(JSON.stringify(map)));
    fs.writeFileSync(path.join(dir, `${key}.png`), solidPng(100, 100));
  }
  fs.writeFileSync(
    path.join(dir, MAP_MANIFEST),
    JSON.stringify({
      version: 1,
      packageVersion: '7.1.0',
      sha,
      dirty: false,
      spec: SPEC,
      specHash,
      platform: 'linux',
      arch: 'x64',
      nodeMajor: '22',
      screenshots: true,
      har: false,
      compatibilityKey: fixtureCompatibilityKey('undeclared-on-base'),
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(surfaceCaptureFailures.length ? { surfaceCaptureFailures } : {}),
    }),
  );
}

const failure = (key) => ({ key, reason: 'locator.waitFor: Timeout', kind: 'capture' });

/** Run the diff CLI from the repository root, as the Action does. */
function runDiff(tmp, repo) {
  const jsonPath = path.join(tmp, 'diff.json');
  const r = spawnSyncBounded(
    process.execPath,
    [DIFF, path.join(tmp, 'before'), path.join(tmp, 'after'), '--json', jsonPath],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  );
  return { r, json: fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null };
}

function runReport(tmp, repo) {
  const outDir = path.join(tmp, 'report');
  const r = spawnSyncBounded(
    process.execPath,
    [REPORT, path.join(tmp, 'before'), path.join(tmp, 'after'), '--out', outDir],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  );
  assert.ok(fs.existsSync(path.join(outDir, 'report.json')), r.stderr + r.stdout);
  return {
    json: JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8')),
    md: fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'),
  };
}

/** The Action's trust state for the diff's baseline and surface receipts. These fixtures
 *  carry no coverage/determinism receipts, so certification evidence is stubbed as
 *  passing to isolate the baseline rule; `changed` mirrors the Action (exit 1 or 3). */
const verdictOf = (diff) =>
  classifyStyleProofVerdict(
    {
      sourceBinding: { status: 'bound' },
      coverage: { basis: 'complete' },
      determinism: { status: 'proven' },
      confidence: { counts: { inaccessible: 0 } },
      comparison: { blocksCertification: false },
      reportConsistency: { ok: true, reason: 'aligned' },
      statesUncertified: 0,
      reviewableCounts: diff.reviewableCounts,
      surfaces: diff.surfaces,
      partialBaseline: diff.partialBaseline,
      explainedMissingBaselineSurfaces: diff.explainedMissingBaselineSurfaces,
    },
    { gateInventoryRemovals: false, baseCaptureFailed: false, changed: true },
  ).state;

test('a surface the head adds is reviewed as new, not PARTIAL_BASELINE', () => {
  const tmp = mkTmp();
  try {
    const { repo, base, head, specHash } = makeRepo(tmp, { baseKeys: ['home'], headKeys: ['home', 'reports'] });
    writeSide(path.join(tmp, 'before'), base, specHash, ['home@1280'], [failure('reports@1280')]);
    writeSide(path.join(tmp, 'after'), head, specHash, ['home@1280', 'reports@1280']);

    const { r, json } = runDiff(tmp, repo);
    assert.ok(json, r.stderr + r.stdout);
    assert.deepEqual(json.baselineFailures, []);
    assert.equal(json.partialBaseline, false);
    assert.deepEqual(json.explainedMissingBaselineSurfaces, []);
    assert.deepEqual(json.undeclaredOnBase, ['reports@1280']);
    const added = json.surfaces.find((s) => s.surface === 'reports@1280');
    assert.equal(added.classification, 'genuinely-new');
    assert.equal(added.missing, 'before');
    assert.match(r.stdout, /not counted as baseline failures.*reports@1280/);
    // Needs a human sign-off like any other visual change.
    assert.equal(verdictOf(json), 'STYLE_REVIEW_REQUIRED');

    const report = runReport(tmp, repo);
    assert.equal(report.json.partialBaseline, false);
    assert.deepEqual(report.json.baselineFailures, []);
    assert.deepEqual(report.json.undeclaredOnBase, ['reports@1280']);
    const entry = report.json.surfaces.find((s) => s.surface === 'reports@1280');
    assert.equal(entry.baselineStatus, 'new');
    assert.equal(entry.isNew, true);
    assert.match(report.md, /new surface/i);
    assert.match(report.md, /never declared/);
    assert.doesNotMatch(report.md, /baseline repair needed/);
  } finally {
    rmTmp(tmp);
  }
});

test('a surface declared on both sides whose base capture failed stays PARTIAL_BASELINE', () => {
  const tmp = mkTmp();
  try {
    const { repo, base, head, specHash } = makeRepo(tmp, {
      baseKeys: ['home', 'pricing'],
      headKeys: ['home', 'pricing'],
      headExtra: '// head\n',
    });
    writeSide(path.join(tmp, 'before'), base, specHash, ['home@1280'], [failure('pricing@1280')]);
    writeSide(path.join(tmp, 'after'), head, specHash, ['home@1280', 'pricing@1280']);

    const { r, json } = runDiff(tmp, repo);
    assert.ok(json, r.stderr + r.stdout);
    assert.equal(json.partialBaseline, true);
    assert.deepEqual(json.explainedMissingBaselineSurfaces, ['pricing@1280']);
    assert.equal(json.undeclaredOnBase, undefined);
    assert.equal(json.surfaces.find((s) => s.surface === 'pricing@1280').classification, 'baseline-repair-debt');
    assert.equal(verdictOf(json), 'PARTIAL_BASELINE');
    assert.equal(runReport(tmp, repo).json.partialBaseline, true);
  } finally {
    rmTmp(tmp);
  }
});

test('a new surface whose head capture also failed still fails', () => {
  const tmp = mkTmp();
  try {
    const { repo, base, head, specHash } = makeRepo(tmp, { baseKeys: ['home'], headKeys: ['home', 'reports'] });
    writeSide(path.join(tmp, 'before'), base, specHash, ['home@1280'], [failure('reports@1280')]);
    writeSide(path.join(tmp, 'after'), head, specHash, ['home@1280'], [failure('reports@1280')]);

    const { r, json } = runDiff(tmp, repo);
    assert.ok(json, r.stderr + r.stdout);
    assert.equal(json.partialBaseline, true);
    assert.deepEqual(
      json.baselineFailures.map((f) => f.key),
      ['reports@1280'],
    );
    assert.equal(verdictOf(json), 'PARTIAL_BASELINE');
  } finally {
    rmTmp(tmp);
  }
});

test('absence is decided from git evidence only; anything unproven stays a baseline failure', () => {
  const tmp = mkTmp();
  try {
    const headKeys = new Set(['reports@1280']);
    const failures = [failure('reports@1280')];

    // The base harness mentions the name (here only in a comment): not proven absent.
    const mentioned = makeRepo(path.join(tmp, 'a'), {
      baseKeys: ['home'],
      headKeys: ['home', 'reports'],
      baseExtra: '// reports lands later\n',
    });
    const partition = ({ repo, base, head, specHash }, extra = {}) =>
      partitionBaselineFailures({
        failures,
        baseSha: base,
        headSha: head,
        baseSpec: SPEC,
        headSpec: SPEC,
        headSpecHash: specHash,
        headKeys,
        cwd: repo,
        ...extra,
      });
    assert.deepEqual(partition(mentioned).undeclaredOnBase, []);

    // The head declares the key without a literal `key:` (e.g. from a registry): no evidence.
    const computed = makeRepo(path.join(tmp, 'b'), {
      baseKeys: ['home'],
      headKeys: ['home'],
      headExtra: "surfaces.push({ key: ['rep', 'orts'].join('') });\n",
    });
    assert.deepEqual(partition(computed).undeclaredOnBase, []);

    const added = makeRepo(path.join(tmp, 'c'), { baseKeys: ['home'], headKeys: ['home', 'reports'] });
    assert.deepEqual(partition(added).undeclaredOnBase, ['reports@1280']);
    // Works from the package directory too.
    assert.deepEqual(partition(added, { cwd: path.join(added.repo, PACKAGE_DIR) }).undeclaredOnBase, ['reports@1280']);
    // Missing or inconsistent inputs keep the failure.
    for (const extra of [
      { baseSha: undefined },
      { headSha: added.base },
      { baseSha: 'f'.repeat(40) },
      { headSpec: 'other/capture.spec.ts' },
      // The located spec must be the one the head captured.
      { headSpecHash: sha256('some other spec') },
      { headSpecHash: undefined },
      { baseSpec: '../escape.spec.ts', headSpec: '../escape.spec.ts' },
      { headKeys: new Set() },
      { cwd: tmp },
      { failures: [failure('reports@auto')] },
    ]) {
      assert.equal(partition(added, extra).undeclaredOnBase.length, 0, JSON.stringify(extra));
    }
  } finally {
    rmTmp(tmp);
  }
});
