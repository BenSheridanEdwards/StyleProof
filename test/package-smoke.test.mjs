import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

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

function peerVersion(name) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  assert.ok(version, `missing ${name} in package-lock.json`);
  return version;
}

test('packed package installs with its peer and exposes API plus CLI help', { timeout: 90_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-pack-smoke-'));
  try {
    const pack = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp], { cwd: root });
    assert.equal(pack.status, 0, pack.stderr);
    const [{ filename }] = JSON.parse(pack.stdout);
    const tarball = path.join(tmp, filename);
    assert.ok(fs.existsSync(tarball), `missing packed tarball at ${tarball}`);

    const app = path.join(tmp, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
    const install = run(
      'npm',
      ['install', '--ignore-scripts', tarball, `@playwright/test@${peerVersion('@playwright/test')}`],
      {
        cwd: app,
      },
    );
    assert.equal(install.status, 0, install.stderr);

    const importCheck = run(
      process.execPath,
      [
        '-e',
        "import('styleproof').then((m) => { if (typeof m.generateStyleMapReport !== 'function' || typeof m.defineStyleMapCapture !== 'function') process.exit(1); })",
      ],
      { cwd: app },
    );
    assert.equal(importCheck.status, 0, importCheck.stderr);

    for (const bin of ['styleproof-init', 'styleproof-map', 'styleproof-diff', 'styleproof-report']) {
      const help = run(process.execPath, [path.join(app, 'node_modules/styleproof/bin', `${bin}.mjs`), '--help'], {
        cwd: app,
      });
      assert.equal(help.status, 0, `${bin}\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`);
      assert.match(help.stdout, new RegExp(`usage: ${bin}`));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
