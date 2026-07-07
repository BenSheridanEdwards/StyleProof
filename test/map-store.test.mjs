import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertCompatibleMapDirs,
  BROWSER_BUILD_SIDECAR,
  manifestlessNotice,
  manifestlessSide,
  MAP_MANIFEST,
  readMapManifest,
  writeBrowserBuildSidecar,
  writeMapManifest,
} from '../dist/map-store.js';
import { mkTmp, rmTmp } from './helpers.mjs';

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

test('manifestlessSide: names before / after / both when a manifest is missing', () => {
  const withManifest = manifestDir();
  const bare = mkTmp('styleproof-bare-');
  const bare2 = mkTmp('styleproof-bare-');
  try {
    assert.equal(manifestlessSide(bare, withManifest), 'before');
    assert.equal(manifestlessSide(withManifest, bare), 'after');
    assert.equal(manifestlessSide(bare, bare2), 'both');
  } finally {
    rmTmp(withManifest);
    rmTmp(bare);
    rmTmp(bare2);
  }
});

test('manifestlessNotice: names the side and points at styleproof-map', () => {
  assert.match(manifestlessNotice('before'), /before carries no styleproof-manifest\.json/);
  assert.match(manifestlessNotice('after'), /after carries no styleproof-manifest\.json/);
  assert.match(manifestlessNotice('both'), /before and after carry no styleproof-manifest\.json/);
  assert.match(manifestlessNotice('both'), /Capture via styleproof-map/);
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
