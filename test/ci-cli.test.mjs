import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ciOutputLines, classifyRestoreExit, detectPackageManagerPlan } from '../dist/ci.js';
import { mkTmp, rmTmp } from './helpers.mjs';

// styleproof-ci packages the workflow's restore → capture-on-miss → replay →
// publish bash. The decision rules the old init.test.mjs asserted against the
// generated bash are pinned here against the module instead.

const here = path.dirname(fileURLToPath(import.meta.url));
const CI = path.join(here, '..', 'bin', 'styleproof-ci.mjs');

function runCi(args, env = {}) {
  const merged = { ...process.env, ...env };
  // The driver keys its CI guard on this exact variable.
  if (!('CI' in env)) delete merged.CI;
  return spawnSync(process.execPath, [CI, ...args], { encoding: 'utf8', env: merged });
}

test('classifyRestoreExit: 0 hit, 4 genuine miss, anything else a loud fault', () => {
  assert.equal(classifyRestoreExit(0), 'hit');
  assert.equal(classifyRestoreExit(4), 'miss');
  // Neither 0 nor 4 is a PERSISTENT map-store/network fault (the restore CLI
  // already retried): fail loudly instead of silently paying a cold recapture.
  assert.equal(classifyRestoreExit(5), 'fault');
  assert.equal(classifyRestoreExit(1), 'fault');
  assert.equal(classifyRestoreExit(137), 'fault');
  assert.equal(classifyRestoreExit(null), 'fault', 'a killed child never reads as a verdict');
  assert.equal(classifyRestoreExit(undefined), 'fault');
});

test('ciOutputLines: the exact steps.maps.outputs.* contract the workflow bash emitted', () => {
  assert.deepEqual(ciOutputLines(true, true), ['base-hit=true', 'head-hit=true', 'capture-needed=false']);
  assert.deepEqual(ciOutputLines(true, false), ['base-hit=true', 'head-hit=false', 'capture-needed=true']);
  assert.deepEqual(ciOutputLines(false, false), ['base-hit=false', 'head-hit=false', 'capture-needed=true']);
});

test('detectPackageManagerPlan: lockfile detection at RUN time, commands as argv (no shell)', () => {
  const root = mkTmp('styleproof-ci-pm-');
  try {
    // npm by default; its --no-save/--package-lock=false exact install dirties nothing.
    const npm = detectPackageManagerPlan(root);
    assert.equal(npm.name, 'npm');
    assert.deepEqual(npm.install, ['npm', 'ci']);
    assert.deepEqual(npm.installExactStyleProof('9.9.9'), [
      'npm',
      'install',
      '--no-save',
      '--package-lock=false',
      'styleproof@9.9.9',
    ]);
    assert.deepEqual(npm.packageMetadataFiles, []);

    fs.writeFileSync(path.join(root, 'yarn.lock'), '');
    const yarn = detectPackageManagerPlan(root);
    assert.equal(yarn.name, 'yarn');
    assert.deepEqual(yarn.install, ['npx', '-y', 'yarn@1.22.22', 'install', '--frozen-lockfile', '--non-interactive']);
    assert.ok(yarn.installExactStyleProof('9.9.9').includes('styleproof@9.9.9'));
    assert.deepEqual(yarn.packageMetadataFiles, ['package.json', 'yarn.lock']);

    // pnpm outranks yarn when both lockfiles exist.
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    const pnpm = detectPackageManagerPlan(root);
    assert.equal(pnpm.name, 'pnpm');
    assert.deepEqual(pnpm.installExactStyleProof('1.2.3'), [
      'pnpm',
      'add',
      '--save-dev',
      '--save-exact',
      'styleproof@1.2.3',
    ]);
    assert.deepEqual(pnpm.packageMetadataFiles, ['package.json', 'pnpm-lock.yaml']);

    // bun outranks everything; only the bun lockfile that actually exists is restored.
    fs.writeFileSync(path.join(root, 'bun.lockb'), '');
    const bun = detectPackageManagerPlan(root);
    assert.equal(bun.name, 'bun');
    assert.deepEqual(bun.install, ['bun', 'install', '--frozen-lockfile']);
    assert.deepEqual(bun.packageMetadataFiles, ['package.json', 'bun.lockb']);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-ci: refuses to run outside CI without --force (it force-checkouts commits)', () => {
  const res = runCi(['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /refusing to run outside CI/);
  assert.match(res.stderr, /--force/);
});

test('styleproof-ci: usage errors exit 2', () => {
  assert.equal(runCi([]).status, 2, 'missing --base/--head');
  assert.match(runCi([]).stderr, /--base <sha> and --head <sha> are required/);
  assert.equal(runCi(['--base', 'x', '--head', 'y', '--nope']).status, 2, 'unknown flag');
});
