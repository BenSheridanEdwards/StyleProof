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
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(args, cwd = root, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('package exposes one primary styleproof command', () => {
  assert.equal(manifest.bin.styleproof, './bin/styleproof.mjs');
});

test('styleproof help presents the complete workflow instead of implementation bins', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: styleproof <command>/);
  for (const command of [
    'setup',
    'capture',
    'crawl',
    'compare',
    'report',
    'variants',
    'affected',
    'ci',
    'prepush',
    'publish-report',
    'prune-reports',
    'prune-maps',
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`), `help omitted ${command}`);
  }
  assert.match(result.stdout, /styleproof setup/);
  assert.match(result.stdout, /styleproof capture/);
  assert.match(result.stdout, /styleproof report/);
});

test('styleproof routes public command names to existing implementation CLIs', () => {
  for (const [command, expectedUsage] of [
    ['setup', 'usage: styleproof setup'],
    ['capture', 'usage: styleproof-map'],
    ['crawl', 'usage: styleproof-capture'],
    ['compare', 'usage: styleproof-diff'],
    ['report', 'usage: styleproof-report'],
    ['variants', 'usage: styleproof-variants'],
    ['affected', 'usage: styleproof-affected'],
    ['ci', 'usage: styleproof-ci'],
    ['prepush', 'usage: styleproof-prepush'],
    ['publish-report', 'usage: styleproof-publish-report'],
    ['prune-reports', 'usage: styleproof-prune-reports'],
    ['prune-maps', 'usage: styleproof-prune-maps'],
  ]) {
    const result = run([command, '--help']);
    assert.equal(result.status, 0, `${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(expectedUsage));
  }
});

test('styleproof setup dry-run plans installation, browser, scaffold, and verification without writing', () => {
  const project = mkTmp('styleproof-setup-plan-');
  try {
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
    fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');

    const result = run(['setup', '--dry-run'], project);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /npm install .*styleproof@6\.1\.0.*@playwright\/test/);
    assert.match(result.stdout, /npm exec playwright install chromium/);
    assert.match(result.stdout, /styleproof-init/);
    assert.match(result.stdout, /styleproof-init --check/);
    assert.equal(fs.existsSync(path.join(project, 'e2e/styleproof.spec.ts')), false);
  } finally {
    rmTmp(project);
  }
});

test('README leads with one-command setup and the unified CLI workflow', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /npx styleproof setup/);
  for (const command of ['capture', 'crawl', 'compare', 'report', 'variants', 'affected', 'ci']) {
    assert.match(readme, new RegExp(`styleproof ${command}`), `README omitted styleproof ${command}`);
  }
});

test('styleproof rejects unknown commands with discoverable help', () => {
  const result = run(['warp-drive']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command: warp-drive/);
  assert.match(result.stderr, /styleproof --help/);
});
