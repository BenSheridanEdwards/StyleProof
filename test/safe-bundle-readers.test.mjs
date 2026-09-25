import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadStyleMap } from '../dist/capture.js';
import { readConfidenceLedger, readCoverageLedgerLenient } from '../dist/confidence-ledger.js';
import {
  BASELINE_PROVENANCE_FILE,
  FATAL_CAPTURE_MARKER,
  MAP_MANIFEST,
  readBaselineProvenance,
  readFatalCaptureFailure,
  readMapManifest,
} from '../dist/map-store.js';
import { mkTmp, rmTmp } from './helpers.mjs';

function linkExternalJson(directory, name, value) {
  const target = path.join(path.dirname(directory), `external-${name}`);
  fs.writeFileSync(target, JSON.stringify(value));
  fs.symlinkSync(target, path.join(directory, name));
}

test('readFatalCaptureFailure: absent is undefined; present-but-unreadable throws (fail closed)', () => {
  const workspace = mkTmp('styleproof-fatal-marker-');
  try {
    assert.equal(readFatalCaptureFailure(workspace), undefined, 'a missing marker is no failure');
    fs.mkdirSync(path.join(workspace, FATAL_CAPTURE_MARKER));
    assert.throws(() => readFatalCaptureFailure(workspace), /unreadable fatal capture marker/);
    fs.rmdirSync(path.join(workspace, FATAL_CAPTURE_MARKER));
    fs.writeFileSync(path.join(workspace, FATAL_CAPTURE_MARKER), 'self-check failed\n');
    assert.equal(readFatalCaptureFailure(workspace), 'self-check failed');
  } finally {
    rmTmp(workspace);
  }
});

test('bundle readers refuse symlink targets and manifests fail closed as invalid evidence', () => {
  const workspace = mkTmp('styleproof-safe-readers-');
  try {
    const bundle = path.join(workspace, 'bundle');
    fs.mkdirSync(bundle);
    linkExternalJson(bundle, MAP_MANIFEST, { version: 1 });
    linkExternalJson(bundle, BASELINE_PROVENANCE_FILE, { sourceSha: 'a'.repeat(40) });
    linkExternalJson(bundle, 'styleproof-confidence.json', { version: 1, basis: 'asserted', entries: [] });
    linkExternalJson(bundle, 'styleproof-coverage.json', { version: 1, expected: [], exclude: {} });
    linkExternalJson(bundle, FATAL_CAPTURE_MARKER, 'external fatal marker');
    linkExternalJson(bundle, 'home@1280.json', {});

    assert.throws(() => readMapManifest(bundle), /invalid styleproof-manifest\.json/);
    assert.equal(readBaselineProvenance(bundle), null);
    assert.equal(readConfidenceLedger(bundle), null);
    assert.equal(readCoverageLedgerLenient(bundle), null);
    assert.throws(() => readFatalCaptureFailure(bundle), /unreadable fatal capture marker/);
    assert.throws(() => loadStyleMap(path.join(bundle, 'home@1280.json')), /refusing symbolic-link filesystem entry/);
  } finally {
    rmTmp(workspace);
  }
});
