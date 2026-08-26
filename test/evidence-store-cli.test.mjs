import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, rmTmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cli = path.join(root, 'bin', 'styleproof.mjs');

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

function writeBundle(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: '6.1.0',
      sha: 'd'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: 'spec-hash',
      platform: 'darwin',
      arch: 'arm64',
      nodeMajor: '22',
      screenshots: false,
      har: false,
      compatibilityKey: 'compat-cli',
      createdAt: '2026-08-26T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(path.join(directory, 'home@1280.json'), '{}');
  fs.writeFileSync(
    path.join(directory, 'styleproof-coverage.json'),
    JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
  );
}

test('styleproof store import creates an immutable capture and idempotent commit ref', () => {
  const workspace = mkTmp('styleproof-store-cli-');
  try {
    const bundle = path.join(workspace, 'bundle');
    const store = path.join(workspace, 'evidence');
    writeBundle(bundle);

    const first = run(['store', 'import', bundle, '--root', store, '--json'], workspace);
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(first.stdout);
    assert.match(receipt.capture.digest, /^[0-9a-f]{64}$/);
    assert.equal(receipt.trust.coverageBasis, 'complete');
    assert.equal(receipt.trust.determinismStatus, 'proven');
    assert.equal(receipt.ref, `commits/${'d'.repeat(40)}/compat-cli`);

    const second = run(['store', 'import', bundle, '--root', store, '--json'], workspace);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), receipt);
    assert.equal(fs.existsSync(path.join(store, 'refs', 'commits', 'd'.repeat(40), 'compat-cli.json')), true);

    const verified = run(['store', 'verify', receipt.ref, '--root', store, '--json'], workspace);
    assert.equal(verified.status, 0, verified.stderr);
    const verification = JSON.parse(verified.stdout);
    assert.equal(verification.status, 'verified');
    assert.equal(verification.files, 3);
    assert.deepEqual(verification.capture, receipt.capture);

    const restored = path.join(workspace, 'restored');
    const restore = run(['store', 'restore', receipt.ref, restored, '--root', store, '--json'], workspace);
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(JSON.parse(restore.stdout).status, 'restored');
    assert.equal(fs.readFileSync(path.join(restored, 'home@1280.json'), 'utf8'), '{}');
  } finally {
    rmTmp(workspace);
  }
});

test('styleproof store is discoverable through the primary CLI', () => {
  const result = run(['store', '--help'], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: styleproof store import/);
  assert.match(result.stdout, /styleproof store verify/);
  assert.match(result.stdout, /styleproof store restore/);
  assert.match(run(['--help'], root).stdout, /\bstore\b/);
});
