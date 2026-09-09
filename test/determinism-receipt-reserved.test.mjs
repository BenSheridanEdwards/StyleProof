import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DETERMINISM_RECEIPT, isMapFile, isOwnedCaptureArtifact } from '../dist/map-store.js';
import { importMapBundleToEvidenceStore } from '../dist/evidence-import.js';
import { materializeEvidenceCapture } from '../dist/evidence-store.js';
import { mkTmp, rmTmp } from './helpers.mjs';

// #534: styleproof-determinism.json must be registered in RESERVED_BUNDLE_FILES
// This is the proof receipt written by the five-run oracle (--prove-determinism).
// During v2 import, the file must be treated as owned metadata, not a surface map.

test('styleproof-determinism.json is registered as a reserved bundle file (#534)', () => {
  assert.equal(typeof DETERMINISM_RECEIPT, 'string', 'DETERMINISM_RECEIPT constant must be exported');
  assert.equal(DETERMINISM_RECEIPT, 'styleproof-determinism.json', 'constant must be the determinism receipt filename');
  assert.equal(isMapFile(DETERMINISM_RECEIPT), false, 'the determinism receipt must never count as a surface map');
});

test('styleproof-determinism.json is treated as an owned capture artifact (#534)', () => {
  assert.equal(
    isOwnedCaptureArtifact(DETERMINISM_RECEIPT),
    true,
    'the determinism receipt must be recognized as an owned capture artifact',
  );
});

test('v1 map import preserves styleproof-determinism.json as owned metadata (#534)', () => {
  const workspace = mkTmp('styleproof-determinism-receipt-import-');
  try {
    const bundle = path.join(workspace, 'bundle');
    const store = path.join(workspace, 'store');
    const restored = path.join(workspace, 'restored');

    const determinismReceipt = {
      runs: 5,
      canonical: { 'home@1280': 'abcd1234' },
      verdict: 'deterministic',
    };
    const originalReceiptBytes = Buffer.from(JSON.stringify(determinismReceipt, null, 2));

    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(
      path.join(bundle, 'styleproof-manifest.json'),
      JSON.stringify({
        version: 1,
        packageVersion: '6.2.0',
        sha: 'b'.repeat(40),
        dirty: false,
        spec: 'e2e/styleproof.spec.ts',
        specHash: '3'.repeat(64),
        platform: 'linux',
        arch: 'x64',
        nodeMajor: '22',
        screenshots: true,
        har: false,
        compatibilityKey: '2222222222222222',
        createdAt: '2026-09-02T00:00:00.000Z',
      }),
    );
    fs.writeFileSync(
      path.join(bundle, 'styleproof-coverage.json'),
      JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'oracle-proven' }),
    );
    fs.writeFileSync(path.join(bundle, 'home@1280.json'), JSON.stringify({ defaults: {}, elements: {}, states: {} }));
    fs.writeFileSync(path.join(bundle, 'home@1280.png'), Buffer.from([5, 6, 7, 8]));
    fs.writeFileSync(path.join(bundle, 'styleproof-determinism.json'), originalReceiptBytes);

    const imported = importMapBundleToEvidenceStore({ bundleDirectory: bundle, storeRoot: store });

    const importedPaths = imported.manifest.files.map((file) => file.path);
    assert.equal(
      importedPaths.includes('styleproof-determinism.json'),
      true,
      'determinism receipt must be included in imported files',
    );

    materializeEvidenceCapture(store, imported.capture, restored);
    const restoredReceiptPath = path.join(restored, 'styleproof-determinism.json');
    assert.equal(fs.existsSync(restoredReceiptPath), true, 'determinism receipt must exist after restoration');

    const restoredReceiptBytes = fs.readFileSync(restoredReceiptPath);
    assert.equal(
      Buffer.compare(originalReceiptBytes, restoredReceiptBytes),
      0,
      'determinism receipt must be byte-identical after import and restoration',
    );
  } finally {
    rmTmp(workspace);
  }
});
