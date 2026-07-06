import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertCompatibleMapDirs, MAP_MANIFEST } from '../dist/map-store.js';
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
