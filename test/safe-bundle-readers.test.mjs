import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadStyleMap } from '../dist/capture.js';
import * as mapIo from '../dist/capture/map-io.js';
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
    assert.equal(readFatalCaptureFailure(bundle), undefined);
    assert.throws(() => loadStyleMap(path.join(bundle, 'home@1280.json')), /refusing symbolic-link filesystem entry/);
  } finally {
    rmTmp(workspace);
  }
});

test('loadStyleMap caps compressed reads and decompressed output, failing closed on a gzip bomb', () => {
  const workspace = mkTmp('styleproof-map-size-cap-');
  try {
    // ~4 MiB of zeros compresses to a few KiB: the classic bomb shape at test scale.
    const bomb = path.join(workspace, 'home@1280.json.gz');
    fs.writeFileSync(bomb, zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024)));
    assert.throws(
      () => loadStyleMap(bomb, { maxDecompressedBytes: 1024 * 1024 }),
      /larger than the 1048576-byte style-map limit once decompressed/,
    );
    const plain = path.join(workspace, 'about@1280.json');
    fs.writeFileSync(plain, JSON.stringify({ elements: {}, padding: 'x'.repeat(4096) }));
    assert.throws(() => loadStyleMap(plain, { maxFileBytes: 1024 }), /refusing oversized filesystem entry/);
    assert.throws(() => loadStyleMap(plain, { maxDecompressedBytes: 1024 }), /style-map limit/);
    // Normal maps are untouched by the default caps.
    assert.deepEqual(Object.keys(loadStyleMap(plain)), ['elements', 'padding']);
    assert.equal(mapIo.MAX_STYLE_MAP_FILE_BYTES, 256 * 1024 * 1024);
    assert.equal(mapIo.MAX_STYLE_MAP_DECOMPRESSED_BYTES, 1024 * 1024 * 1024);
  } finally {
    rmTmp(workspace);
  }
});
