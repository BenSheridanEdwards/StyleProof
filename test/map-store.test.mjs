import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertCompatibleMapDirs,
  BROWSER_BUILD_SIDECAR,
  manifestlessError,
  manifestlessSide,
  MAP_MANIFEST,
  readMapManifest,
  workingTreeDirty,
  writeBrowserBuildSidecar,
  writeCaptureManifest,
  writeMapManifest,
} from '../dist/map-store.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

/** Write a manifest into `dir`, overriding defaults with `overrides`. */
function manifestDir(overrides = {}) {
  const dir = mkTmp('styleproof-manifest-');
  const manifest = {
    version: 1,
    packageVersion: 'test',
    sha: 'a'.repeat(40),
    dirty: false,
    spec: 'e2e/styleproof.spec.ts',
    specHash: 'test',
    platform: 'linux',
    arch: 'x64',
    nodeMajor: '20',
    screenshots: true,
    har: false,
    compatibilityKey: 'deadbeefdeadbeef',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, MAP_MANIFEST), JSON.stringify(manifest, null, 2));
  return dir;
}

test('workingTreeDirty: ignorePrefix skips the map output dir but still catches a source edit', () => {
  const repo = mkTmp('styleproof-dirty-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'src.txt'), 'v1');
    fs.mkdirSync(path.join(repo, '.styleproof/maps/current'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.styleproof/maps/current/home@1280.json'), '{}');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    assert.equal(workingTreeDirty(repo), false, 'clean tree');

    // A capture rewrites the map output — ignored by prefix, so still "clean".
    fs.writeFileSync(path.join(repo, '.styleproof/maps/current/home@1280.json'), '{"changed":1}');
    assert.equal(workingTreeDirty(repo), true, 'map write dirties the raw tree');
    assert.equal(workingTreeDirty(repo, '.styleproof/maps/current'), false, 'but is skipped by ignorePrefix');

    // A real source edit during the capture window is NOT skipped.
    fs.writeFileSync(path.join(repo, 'src.txt'), 'v2');
    assert.equal(workingTreeDirty(repo, '.styleproof/maps/current'), true, 'source edit still caught');
  } finally {
    rmTmp(repo);
  }
});

test('assertCompatibleMapDirs: differing browser build refuses to compare, naming both', () => {
  const before = manifestDir({ browserVersion: '124.0.6367.60', sha: 'b'.repeat(40) });
  const after = manifestDir({ browserVersion: '125.0.6422.60', sha: 'c'.repeat(40) });
  try {
    assert.throws(
      () => assertCompatibleMapDirs(before, after),
      (err) => {
        assert.match(err.message, /different runtime environments/);
        assert.match(err.message, /124\.0\.6367\.60/);
        assert.match(err.message, /125\.0\.6422\.60/);
        return true;
      },
    );
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

test('assertCompatibleMapDirs: both sides missing browser build stay compatible', () => {
  const before = manifestDir();
  const after = manifestDir();
  try {
    assert.doesNotThrow(() => assertCompatibleMapDirs(before, after));
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

test('assertCompatibleMapDirs: one side missing browser build stays compatible', () => {
  const before = manifestDir({ browserVersion: '124.0.6367.60' });
  const after = manifestDir(); // pre-field cached bundle
  try {
    assert.doesNotThrow(() => assertCompatibleMapDirs(before, after));
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

test('assertCompatibleMapDirs: same browser build compares clean', () => {
  const before = manifestDir({ browserVersion: '124.0.6367.60' });
  const after = manifestDir({ browserVersion: '124.0.6367.60' });
  try {
    assert.doesNotThrow(() => assertCompatibleMapDirs(before, after));
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

// A dir with a captured map but no manifest = a legacy committed-map bundle (v4 refuses).
function legacyMapDir() {
  const dir = mkTmp('styleproof-legacy-');
  writeCapture(dir, 'home@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  return dir;
}

test('manifestlessSide: both manifests present → null (guard is enforceable)', () => {
  const before = manifestDir();
  const after = manifestDir();
  try {
    assert.equal(manifestlessSide(before, after), null);
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

test('manifestlessSide: names before / after / both for a legacy bundle (maps, no manifest)', () => {
  const withManifest = manifestDir();
  const legacy = legacyMapDir();
  const legacy2 = legacyMapDir();
  try {
    assert.equal(manifestlessSide(legacy, withManifest), 'before');
    assert.equal(manifestlessSide(withManifest, legacy), 'after');
    assert.equal(manifestlessSide(legacy, legacy2), 'both');
  } finally {
    rmTmp(withManifest);
    rmTmp(legacy);
    rmTmp(legacy2);
  }
});

test('manifestlessSide: a bare dir with no maps is NOT flagged (empty ≠ legacy bundle)', () => {
  // A dir with zero maps is "no baseline yet", owned by the base/head-missing guards —
  // not a legacy committed-map bundle. The manifest refusal must not swallow it.
  const withManifest = manifestDir();
  const bare = mkTmp('styleproof-bare-');
  try {
    assert.equal(manifestlessSide(bare, withManifest), null);
    assert.equal(manifestlessSide(withManifest, bare), null);
    assert.equal(manifestlessSide(bare, mkTmp('styleproof-bare-')), null);
  } finally {
    rmTmp(withManifest);
    rmTmp(bare);
  }
});

test('manifestlessError: names the side and points at re-capturing (v4 refuses)', () => {
  assert.match(manifestlessError('before'), /before carries no styleproof-manifest\.json/);
  assert.match(manifestlessError('after'), /after carries no styleproof-manifest\.json/);
  assert.match(manifestlessError('both'), /before and after carry no styleproof-manifest\.json/);
  assert.match(manifestlessError('both'), /unsupported since v4/);
  assert.match(manifestlessError('both'), /Re-capture with current StyleProof/);
});

test('writeCaptureManifest: stamps a compat manifest, degrading git fields outside a repo', () => {
  // A one-shot styleproof-capture output dir under a NON-git tmp path — the design-mockup
  // case. The manifest must still carry the fields the same-environment guard consumes.
  const dir = mkTmp('styleproof-capture-manifest-');
  try {
    // cwd = the tmp dir itself (not a git repo) so the git fields degrade.
    const manifest = writeCaptureManifest({ dir, screenshots: true, cwd: dir });
    // Git fields degrade gracefully (tmp dir is not a git repo).
    assert.equal(manifest.sha, 'uncommitted');
    assert.equal(manifest.dirty, true);
    // The comparability fields are present and real.
    assert.equal(manifest.platform, process.platform);
    assert.equal(manifest.arch, process.arch);
    assert.equal(manifest.nodeMajor, process.versions.node.split('.')[0]);
    assert.match(manifest.compatibilityKey, /^[0-9a-f]{16}$/);
    assert.equal(manifest.screenshots, true);
    // And it round-trips through the reader, so a diff can pick it up on both sides.
    const read = readMapManifest(dir);
    assert.equal(read.compatibilityKey, manifest.compatibilityKey);
    // Two capture dirs stamped in the same environment are mutually compatible.
    const other = mkTmp('styleproof-capture-manifest-');
    try {
      writeCaptureManifest({ dir: other, screenshots: true, cwd: other });
      assert.doesNotThrow(() => assertCompatibleMapDirs(dir, other));
    } finally {
      rmTmp(other);
    }
  } finally {
    rmTmp(dir);
  }
});

test('writeBrowserBuildSidecar(undefined) CLEARS a stale sidecar so a version-less run stamps no browserVersion', () => {
  // Repro of the stale-fingerprint bug: a reused capture dir already holds a PRIOR
  // run's sidecar. This run records no browser version (handle unavailable / capture
  // test not reached). If the sidecar survived, writeMapManifest would fold the prior
  // build into this run's manifest and assertCompatibleMapDirs would trust it.
  const dir = mkTmp('styleproof-sidecar-');
  try {
    // A prior run left a sidecar behind.
    writeBrowserBuildSidecar(dir, '124.0.6367.60');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, BROWSER_BUILD_SIDECAR), 'utf8')).browserVersion,
      '124.0.6367.60',
    );
    // This run has no browser version → write-or-clear removes the stale sidecar.
    writeBrowserBuildSidecar(dir, undefined);
    assert.equal(fs.existsSync(path.join(dir, BROWSER_BUILD_SIDECAR)), false);
    // So the manifest this run writes carries NO browserVersion — no false fingerprint.
    const manifest = writeMapManifest({
      dir,
      spec: 'e2e/styleproof.spec.ts',
      sha: 'd'.repeat(40),
      screenshots: true,
      dirty: false,
    });
    assert.equal(manifest.browserVersion, undefined);
    assert.equal(readMapManifest(dir).browserVersion, undefined);
  } finally {
    rmTmp(dir);
  }
});
