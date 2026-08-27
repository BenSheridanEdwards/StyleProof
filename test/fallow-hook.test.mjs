import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hook = readFileSync(new URL('../.husky/pre-commit', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/fallow.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('pre-commit runs the same audit and production complexity gates as CI', () => {
  const syntax = spawnSync('sh', ['-n', '.husky/pre-commit'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  assert.match(hook, /git diff --cached --unified=0/);
  assert.match(hook, /npx --no-install fallow audit --base HEAD --health-baseline/);
  assert.match(hook, /npx --no-install fallow health/);
  assert.match(hook, /--production/);
  assert.match(hook, /--baseline \.fallow\/health-baseline\.json/);
  assert.match(hook, /--changed-since HEAD/);
  assert.match(hook, /--diff-file "\$FALLOW_STAGED_DIFF"/);
  assert.match(hook, /--fail-on-issues/);
});

test('pre-commit fails closed when a static gate fails before Fallow', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'styleproof-hook-'));
  try {
    const npm = join(fakeBin, 'npm');
    writeFileSync(npm, '#!/bin/sh\n[ "$2" = "lint" ] && exit 23\nexit 0\n');
    chmodSync(npm, 0o755);

    const result = spawnSync('sh', ['.husky/pre-commit'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 23, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /› fallow/);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('CI complexity uses the exact pinned CLI and its baseline-aware exit semantics', () => {
  const complexityGate = workflow.match(/ {6}- name: Complexity gate\n([\s\S]*?)(?=\n {6}- |\n?$)/)?.[1];
  assert.ok(complexityGate, 'Fallow workflow should contain a named complexity gate');
  assert.doesNotMatch(complexityGate, /uses:\s*fallow-rs\/fallow@/);
  assert.match(complexityGate, /\.\/node_modules\/\.bin\/fallow health/);
  assert.match(complexityGate, /--production/);
  assert.match(complexityGate, /--changed-since "\$BASE_SHA"/);
  assert.match(complexityGate, /--baseline \.fallow\/health-baseline\.json/);
  assert.match(complexityGate, /--no-cache/);
  assert.match(complexityGate, /--fail-on-issues/);
});

test('local Fallow is exactly pinned so pre-commit and CI resolve the same release', () => {
  assert.equal(pkg.devDependencies.fallow, '3.19.0');
  assert.equal(lock.packages[''].devDependencies.fallow, '3.19.0');
  assert.equal(lock.packages['node_modules/fallow'].version, '3.19.0');
});
