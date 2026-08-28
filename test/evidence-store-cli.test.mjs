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
// The complete Node suite runs hundreds of tests concurrently; leave enough
// room for process startup while still bounding a FIFO-open hang.
const fifoProbeTimeoutMs = 5_000;

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
      specHash: '1'.repeat(64),
      platform: 'darwin',
      arch: 'arm64',
      nodeMajor: '22',
      screenshots: false,
      har: false,
      compatibilityKey: '0000000000000000',
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
    assert.equal(receipt.ref, `commits/${'d'.repeat(40)}/0000000000000000`);

    const second = run(['store', 'import', bundle, '--root', store, '--json'], workspace);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), receipt);
    assert.equal(fs.existsSync(path.join(store, 'refs', 'commits', 'd'.repeat(40), '0000000000000000.json')), true);

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

test(
  'styleproof store import rejects a FIFO manifest before opening it',
  { skip: process.platform === 'win32' },
  () => {
    const workspace = mkTmp('styleproof-store-fifo-');
    try {
      const bundle = path.join(workspace, 'bundle');
      const store = path.join(workspace, 'evidence');
      fs.mkdirSync(bundle, { recursive: true });
      const manifest = path.join(bundle, 'styleproof-manifest.json');
      const fifo = spawnSync('mkfifo', [manifest], { encoding: 'utf8' });
      assert.equal(fifo.status, 0, fifo.stderr);

      const direct = spawnSync(process.execPath, [cli, 'store', 'import', bundle, '--root', store], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: fifoProbeTimeoutMs,
      });
      assert.equal(direct.error, undefined, direct.error?.message);
      assert.equal(direct.status, 2, direct.stderr);
      assert.match(direct.stderr, /refusing non-regular map bundle entry: styleproof-manifest\.json/);
      assert.equal(fs.existsSync(store), false, 'rejected input created evidence-store state');

      fs.rmSync(manifest);
      const targetFifo = path.join(workspace, 'outside-manifest-fifo');
      const target = spawnSync('mkfifo', [targetFifo], { encoding: 'utf8' });
      assert.equal(target.status, 0, target.stderr);
      fs.symlinkSync(targetFifo, manifest);
      const linked = spawnSync(process.execPath, [cli, 'store', 'import', bundle, '--root', store], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: fifoProbeTimeoutMs,
      });
      assert.equal(linked.error, undefined, linked.error?.message);
      assert.equal(linked.status, 2, linked.stderr);
      assert.match(linked.stderr, /refusing symbolic link in map bundle: styleproof-manifest\.json/);
      assert.equal(fs.existsSync(store), false, 'symlink rejection created evidence-store state');
    } finally {
      rmTmp(workspace);
    }
  },
);

test(
  'styleproof store import rejects every map-reader FIFO before opening it',
  { skip: process.platform === 'win32' },
  () => {
    const workspace = mkTmp('styleproof-store-map-fifo-');
    try {
      const bundle = path.join(workspace, 'bundle');
      const store = path.join(workspace, 'evidence');
      writeBundle(bundle);
      const unexpectedMap = path.join(bundle, 'x.json');
      const fifo = spawnSync('mkfifo', [unexpectedMap], { encoding: 'utf8' });
      assert.equal(fifo.status, 0, fifo.stderr);

      const result = spawnSync(process.execPath, [cli, 'store', 'import', bundle, '--root', store], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: fifoProbeTimeoutMs,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /refusing non-regular map bundle entry: x\.json/);
      assert.equal(fs.existsSync(store), false, 'rejected map-reader input created evidence-store state');
    } finally {
      rmTmp(workspace);
    }
  },
);

test('styleproof store is discoverable through the primary CLI', () => {
  const result = run(['store', '--help'], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: styleproof store import/);
  assert.match(result.stdout, /styleproof store verify/);
  assert.match(result.stdout, /styleproof store restore/);
  assert.match(run(['--help'], root).stdout, /\bstore\b/);
});
