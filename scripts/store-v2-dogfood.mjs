import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureEvidenceReceipt } from '../dist/map-store.js';

const cli = fileURLToPath(new URL('../bin/styleproof-store.mjs', import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Exercise the store CLI against the oracle-backed, unasserted example fixture. */
export function verifyV2StoreRoundTrip(bundleDirectory, workspace, expectedSha) {
  const manifest = read(path.join(bundleDirectory, 'styleproof-manifest.json'));
  assert.equal(manifest.sha, expectedSha, 'capture must belong to the checked-out source SHA');
  const ledger = read(path.join(bundleDirectory, 'styleproof-coverage.json'));
  assert.equal(ledger.determinism, 'oracle-proven', 'fixture must carry five-run proof');
  assert.equal(ledger.expected, null, 'example coverage must remain unasserted');
  const oracle = read(path.join(bundleDirectory, 'styleproof-determinism.json'));
  assert.equal(oracle.verdict.status, 'deterministic');
  for (const key of ['requiredRuns', 'observedRuns', 'matchingRuns']) assert.equal(oracle.verdict[key], 5);
  const root = path.join(workspace, 'objects');
  const run = (...args) =>
    JSON.parse(execFileSync(process.execPath, [cli, ...args, '--root', root, '--json'], { encoding: 'utf8' }));
  const imported = run('import', bundleDirectory);
  assert.deepEqual(imported.trust, { coverageBasis: 'unasserted', determinismStatus: 'proven' });
  assert.equal(imported.ref, `commits/${expectedSha}/${manifest.compatibilityKey}`);
  assert.deepEqual(run('import', bundleDirectory), imported, 'repeated import must retain capture identity');
  const verified = run('verify', imported.ref);
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.capture, imported.capture);
  assert.deepEqual(verified.trust, imported.trust);
  const output = path.join(workspace, 'restored');
  const restored = run('restore', imported.ref, output);
  assert.equal(restored.status, 'restored');
  assert.deepEqual(restored.capture, imported.capture);
  const sourceBytes = captureEvidenceReceipt(bundleDirectory);
  assert.ok(sourceBytes.mapCount > 0, 'fixture must contain captured maps');
  assert.deepEqual(captureEvidenceReceipt(output), sourceBytes, 'all bundle paths and bytes must survive migration');
  assert.equal(verified.files, sourceBytes.fileCount);
  assert.equal(restored.files, sourceBytes.fileCount);
  return {
    schemaVersion: 1,
    sourceSha: expectedSha,
    transport: 'local-v2',
    capture: imported.capture,
    trust: imported.trust,
    evidence: sourceBytes,
    repeatedImport: 'identical',
    restoredBytes: 'identical',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [bundle, workspace, sha] = process.argv.slice(2);
  assert.ok(bundle && workspace && sha, 'usage: store-v2-dogfood.mjs <bundle> <workspace> <source-sha>');
  process.stdout.write(`${JSON.stringify(verifyV2StoreRoundTrip(bundle, workspace, sha), null, 2)}\n`);
}
