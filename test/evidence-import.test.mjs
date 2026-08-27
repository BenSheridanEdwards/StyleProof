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
      specHash: 'spec-hash',
      platform: 'darwin',
      arch: 'arm64',
      nodeMajor: '22',
      screenshots: true,
      har: true,
      compatibilityKey: 'compat-import',
      createdAt: '2026-08-26T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(path.join(root, 'home@1280.json'), '{"surface":"home"}');
  fs.writeFileSync(path.join(root, 'home@1280.png'), Buffer.from([4, 3, 2, 1]));
  fs.writeFileSync(path.join(root, 'home@1280.har'), 'private-network-payload');
  fs.writeFileSync(path.join(root, 'secret.env'), 'SHOULD_NOT_LEAVE_THE_CAPTURE_DIRECTORY');
  if (options.coverage !== false) {
    fs.writeFileSync(
      path.join(root, 'styleproof-coverage.json'),
      options.coverage === 'malformed'
        ? '{broken'
        : JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
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
    assert.equal(imported.manifest.source.compatibilityKey, 'compat-import');
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
