import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importMapBundleToEvidenceStore } from '../dist/evidence-import.js';
import { materializeEvidenceCapture, EvidenceStoreError } from '../dist/evidence-store.js';
import { mkTmp, rmTmp } from './helpers.mjs';

function writeBundle(root, options = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: '6.1.0',
      sha: 'c'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '1'.repeat(64),
      platform: 'darwin',
      arch: 'arm64',
      nodeMajor: '22',
      screenshots: true,
      har: true,
      compatibilityKey: '0000000000000000',
      createdAt: '2026-08-26T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(path.join(root, 'home@1280.json'), '{"surface":"home"}');
  fs.writeFileSync(path.join(root, 'home@1280.png'), Buffer.from([4, 3, 2, 1]));
  fs.writeFileSync(path.join(root, 'home@1280.har'), 'private-network-payload');
  fs.writeFileSync(path.join(root, 'secret.env'), 'SHOULD_NOT_LEAVE_THE_CAPTURE_DIRECTORY');
  if (options.coverage !== false) {
    const determinism = options.determinism ?? 'self-checked';
    fs.writeFileSync(
      path.join(root, 'styleproof-coverage.json'),
      options.coverage === 'malformed'
        ? '{broken'
        : JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism }),
    );
  }
}

test('v1 map import creates verified complete/proven v2 evidence and excludes HAR by default', () => {
  const workspace = mkTmp('styleproof-evidence-import-');
  try {
    const bundle = path.join(workspace, 'bundle');
    const store = path.join(workspace, 'store');
    const out = path.join(workspace, 'out');
    writeBundle(bundle);

    const imported = importMapBundleToEvidenceStore({ bundleDirectory: bundle, storeRoot: store });
    assert.deepEqual(imported.manifest.trust, { coverageBasis: 'complete', determinismStatus: 'proven' });
    assert.equal(imported.manifest.source.sha, 'c'.repeat(40));
    assert.equal(imported.manifest.source.compatibilityKey, '0000000000000000');
    assert.equal(
      imported.manifest.files.some((file) => file.path.endsWith('.har')),
      false,
    );
    assert.equal(
      imported.manifest.files.some((file) => file.path === 'secret.env'),
      false,
    );

    materializeEvidenceCapture(store, imported.capture, out);
    assert.equal(fs.readFileSync(path.join(out, 'home@1280.json'), 'utf8'), '{"surface":"home"}');
    assert.deepEqual(fs.readFileSync(path.join(out, 'home@1280.png')), Buffer.from([4, 3, 2, 1]));
  } finally {
    rmTmp(workspace);
  }
});

test('v1 map import includes only canonical flat surface-failure receipts', () => {
  const workspace = mkTmp('styleproof-evidence-import-failures-');
  try {
    const bundle = path.join(workspace, 'bundle');
    const failures = path.join(bundle, 'styleproof-surface-capture-failures');
    writeBundle(bundle);
    fs.mkdirSync(failures, { recursive: true });
    fs.writeFileSync(
      path.join(failures, 'about@900-deadbeef.json'),
      JSON.stringify({ key: 'about@900', reason: 'capture failed', kind: 'capture' }),
    );
    fs.writeFileSync(path.join(failures, 'secret.env'), 'DO_NOT_IMPORT');
    fs.mkdirSync(path.join(failures, 'nested'));
    fs.writeFileSync(path.join(failures, 'nested', 'looks-owned-deadbeef.json'), '{}');

    const imported = importMapBundleToEvidenceStore({
      bundleDirectory: bundle,
      storeRoot: path.join(workspace, 'store'),
    });
    const paths = imported.manifest.files.map((file) => file.path);
    assert.equal(paths.includes('styleproof-surface-capture-failures/about@900-deadbeef.json'), true);
    assert.equal(
      paths.some((file) => file.includes('secret.env')),
      false,
    );
    assert.equal(
      paths.some((file) => file.includes('/nested/')),
      false,
    );
  } finally {
    rmTmp(workspace);
  }
});

test('v1 map import preserves missing trust as unasserted/unknown and rejects malformed ledgers', () => {
  const workspace = mkTmp('styleproof-evidence-import-trust-');
  try {
    const missing = path.join(workspace, 'missing');
    const malformed = path.join(workspace, 'malformed');
    writeBundle(missing, { coverage: false });
    writeBundle(malformed, { coverage: 'malformed' });

    const imported = importMapBundleToEvidenceStore({
      bundleDirectory: missing,
      storeRoot: path.join(workspace, 'missing-store'),
    });
    assert.deepEqual(imported.manifest.trust, {
      coverageBasis: 'unasserted',
      determinismStatus: 'unknown',
    });
    assert.throws(
      () =>
        importMapBundleToEvidenceStore({
          bundleDirectory: malformed,
          storeRoot: path.join(workspace, 'malformed-store'),
        }),
      (error) => error instanceof EvidenceStoreError && /malformed styleproof-coverage\.json/.test(error.message),
    );
  } finally {
    rmTmp(workspace);
  }
});

// #518: importer maps oracle-proven determinism to proven trust status
test('v1 map import maps oracle-proven determinism to proven trust status (#518)', () => {
  const workspace = mkTmp('styleproof-evidence-import-oracle-proven-');
  try {
    const bundle = path.join(workspace, 'bundle');
    writeBundle(bundle, { determinism: 'oracle-proven' });

    const imported = importMapBundleToEvidenceStore({
      bundleDirectory: bundle,
      storeRoot: path.join(workspace, 'store'),
    });
    assert.equal(
      imported.manifest.trust.determinismStatus,
      'proven',
      'oracle-proven determinism should map to proven trust status',
    );
    assert.equal(imported.manifest.trust.coverageBasis, 'complete');
  } finally {
    rmTmp(workspace);
  }
});

// #519: integration test for oracle-proven import with byte-identical restoration
test('v1 oracle-proven bundle import preserves SHA, trust, byte-identical ledger, and idempotent identity (#519)', () => {
  const workspace = mkTmp('styleproof-evidence-import-oracle-proven-integration-');
  try {
    const bundle = path.join(workspace, 'bundle');
    const store = path.join(workspace, 'store');
    const restored = path.join(workspace, 'restored');

    const coverageLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'oracle-proven' };
    const originalLedgerBytes = Buffer.from(JSON.stringify(coverageLedger));
    const expectedSha = 'a'.repeat(40);
    const expectedCompatKey = '1111111111111111';

    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(
      path.join(bundle, 'styleproof-manifest.json'),
      JSON.stringify({
        version: 1,
        packageVersion: '6.2.0',
        sha: expectedSha,
        dirty: false,
        spec: 'e2e/styleproof.spec.ts',
        specHash: '2'.repeat(64),
        platform: 'linux',
        arch: 'x64',
        nodeMajor: '22',
        screenshots: true,
        har: false,
        compatibilityKey: expectedCompatKey,
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
    );
    fs.writeFileSync(path.join(bundle, 'home@1280.json'), JSON.stringify({ defaults: {}, elements: {}, states: {} }));
    fs.writeFileSync(path.join(bundle, 'home@1280.png'), Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(path.join(bundle, 'styleproof-coverage.json'), originalLedgerBytes);

    const firstImport = importMapBundleToEvidenceStore({ bundleDirectory: bundle, storeRoot: store });

    assert.equal(firstImport.manifest.source.sha, expectedSha, 'source SHA preserved');
    assert.equal(firstImport.manifest.source.compatibilityKey, expectedCompatKey, 'compatibility key preserved');
    assert.equal(firstImport.manifest.trust.determinismStatus, 'proven', 'trust status is proven');
    assert.equal(firstImport.manifest.trust.coverageBasis, 'complete', 'coverage basis is complete');

    materializeEvidenceCapture(store, firstImport.capture, restored);
    const restoredLedgerBytes = fs.readFileSync(path.join(restored, 'styleproof-coverage.json'));
    assert.equal(
      Buffer.compare(originalLedgerBytes, restoredLedgerBytes),
      0,
      'coverage ledger bytes are byte-identical after restoration',
    );

    const secondImport = importMapBundleToEvidenceStore({ bundleDirectory: bundle, storeRoot: store });

    assert.equal(
      firstImport.capture.digest,
      secondImport.capture.digest,
      'repeated import produces stable capture identity (idempotent)',
    );
    assert.deepEqual(firstImport.manifest, secondImport.manifest, 'repeated import manifest is identical');
  } finally {
    rmTmp(workspace);
  }
});
