import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      ...options.env,
    },
    ...options,
  });
}

function runNpm(args, options = {}) {
  return run(npmCommand, args, {
    shell: process.platform === 'win32',
    ...options,
  });
}

function commandFailure(result) {
  return result.stderr || result.error?.message || result.stdout;
}

function peerVersion(name) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  assert.ok(version, `missing ${name} in package-lock.json`);
  return version;
}

// Stage the package (its `files` allowlist + a lifecycle-stripped manifest) into `dest`
// and pack THAT, never the live checkout. `npm pack` runs the `prepare` script (tsc) even
// under --ignore-scripts, and tsc truncates each dist/*.js to zero bytes before rewriting
// it. When the smoke test packed the live repo, a concurrently-spawned CLI in another
// test could read a half-written dist module and die with a static ESM link error
// (`does not provide an export named …`) — the systemic unit-suite flake (#190). Packing a
// copy whose manifest has no `prepare` means pack cannot rebuild, so the shared dist is
// never mutated mid-suite. The suite already built dist (`npm test` = build && node --test),
// so the staged copy is the real artifact.
function stagePackageDir(dest) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = [
    'dist',
    'bin',
    'example/styleproof-approve.yml',
    'docs/demo-composite.png',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
  ];
  for (const rel of files) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue; // `dist` is guaranteed present (the suite built it); assets are optional
    fs.cpSync(src, path.join(dest, rel), { recursive: true });
  }
  // Strip ALL lifecycle scripts so `npm pack` cannot run tsc/husky against the staged copy.
  delete manifest.scripts;
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(manifest, null, 2));
  return dest;
}

test('packed package installs with its peer and exposes API plus CLI help', { timeout: 90_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-pack-smoke-'));
  try {
    // Pack a staged copy, not the live checkout — see stagePackageDir: packing the repo
    // runs `prepare` (tsc), which truncates the shared dist/*.js mid-suite and flakes
    // concurrently-spawned CLIs (#190).
    const stage = stagePackageDir(path.join(tmp, 'pkg'));
    const pack = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', tmp, stage], { cwd: root });
    assert.equal(pack.status, 0, commandFailure(pack));
    const [{ filename }] = JSON.parse(pack.stdout);
    const tarball = path.join(tmp, filename);
    assert.ok(fs.existsSync(tarball), `missing packed tarball at ${tarball}`);

    const app = path.join(tmp, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
    const install = runNpm(
      ['install', '--ignore-scripts', tarball, `@playwright/test@${peerVersion('@playwright/test')}`],
      {
        cwd: app,
      },
    );
    assert.equal(install.status, 0, commandFailure(install));

    const importCheck = run(
      process.execPath,
      [
        '-e',
        "import('styleproof').then((m) => { if (typeof m.generateStyleMapReport !== 'function' || typeof m.defineStyleMapCapture !== 'function') process.exit(1); })",
      ],
      { cwd: app },
    );
    assert.equal(importCheck.status, 0, importCheck.stderr);

    for (const bin of [
      'styleproof-init',
      'styleproof-map',
      'styleproof-capture',
      'styleproof-diff',
      'styleproof-report',
      'styleproof-variants',
      'styleproof-prepush',
      'styleproof-affected',
      'styleproof-ci',
    ]) {
      const installedShim = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? `${bin}.cmd` : bin);
      assert.ok(fs.existsSync(installedShim), `${bin} is missing from the installed package bin manifest`);
      const help = run(process.execPath, [path.join(app, 'node_modules/styleproof/bin', `${bin}.mjs`), '--help'], {
        cwd: app,
      });
      assert.equal(help.status, 0, `${bin}\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`);
      assert.match(help.stdout, new RegExp(`usage: ${bin}`));
    }

    const scaffold = path.join(tmp, 'scaffold');
    fs.mkdirSync(scaffold);
    const init = run(process.execPath, [path.join(app, 'node_modules/styleproof/bin/styleproof-init.mjs')], {
      cwd: scaffold,
    });
    assert.equal(init.status, 0, commandFailure(init));
    assert.ok(
      fs.existsSync(path.join(scaffold, '.github/workflows/styleproof-approve.yml')),
      'the packed approval-workflow template is missing',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
