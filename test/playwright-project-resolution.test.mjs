import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { projectPlaywright } from '../bin/project-playwright.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = new URL('../bin/styleproof-map.mjs', import.meta.url);
const ciSource = fs.readFileSync(new URL('../bin/styleproof-ci.mjs', import.meta.url), 'utf8');
// Run the real CI installer in isolation: no checkout, package installation, or browser download.
const ciInstaller = `
  import path from 'node:path';
  import { projectPlaywright } from ${JSON.stringify(new URL('../bin/project-playwright.mjs', import.meta.url).href)};
  const env = process.env;
  const log = console.error;
  ${ciSource.match(/^const binFirstPath = .*;$/m)[0]}
  ${ciSource.slice(ciSource.indexOf('function playwrightInstall('), ciSource.indexOf('\nfunction exitWithBrowserRemedy'))}
  process.exit(playwrightInstall(process.argv[1]) ? 0 : 1);
`;

for (const caller of ['capture', 'CI browser install']) {
  for (const scenario of ['project wins', 'PATH fallback', 'neither installed']) {
    test(`${caller}: ${scenario}`, { skip: process.platform === 'win32' }, () => {
      const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-resolution-')));
      try {
        fs.writeFileSync(path.join(cwd, 'spec.ts'), '');
        if (scenario === 'project wins') {
          const peer = path.join(cwd, 'node_modules/@playwright/test');
          fs.mkdirSync(peer, { recursive: true });
          fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
          fs.writeFileSync(
            path.join(peer, 'cli.cjs'),
            `console.log('PROJECT ' + JSON.stringify(process.argv.slice(2)));
             console.error('PROJECT stderr ' + process.env.STYLEPROOF_RESOLUTION_SENTINEL);
             process.exit(17);`,
          );
        }
        if (scenario !== 'neither installed') {
          fs.writeFileSync(
            path.join(cwd, 'playwright'),
            '#!/bin/sh\necho "PATH $*"\necho "PATH stderr $STYLEPROOF_RESOLUTION_SENTINEL" >&2\nexit 23\n',
            { mode: 0o755 },
          );
        }
        const args =
          caller === 'capture'
            ? [fileURLToPath(cli), '--spec', 'spec.ts']
            : ['--input-type=module', '-e', ciInstaller, cwd];
        const result = spawnSync(process.execPath, args, {
          // CI's explicit cwd must win over the helper's own process directory.
          cwd: caller === 'capture' ? cwd : repoRoot,
          env: { ...process.env, PATH: cwd, STYLEPROOF_RESOLUTION_SENTINEL: 'forwarded' },
          encoding: 'utf8',
          timeout: 15000,
        });
        assert.equal(result.error, undefined);
        if (scenario === 'neither installed') {
          assert.equal(result.status, caller === 'capture' ? 2 : 1, result.stderr);
          assert.match(result.stderr, /PATH Playwright failed:/);
          assert.ok(result.stderr.includes(`@playwright/test is not installed in ${cwd}`), result.stderr);
          assert.doesNotMatch(result.stderr, /Require stack:/);
        } else {
          const selected = scenario === 'project wins' ? 'PROJECT' : 'PATH';
          assert.match(result.stdout, new RegExp(`^${selected} `, 'm'));
          assert.match(result.stderr, new RegExp(`${selected} stderr forwarded`));
          assert.doesNotMatch(
            result.stdout + result.stderr,
            new RegExp(scenario === 'project wins' ? 'PATH ' : 'PROJECT '),
          );
          assert.equal(
            result.status,
            caller === 'capture' ? (scenario === 'project wins' ? 17 : 23) : 1,
            result.stderr,
          );
          assert.match(result.stdout, caller === 'capture' ? /test.*--grep/ : /install.*--with-deps.*chromium/);
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}
for (const installed of [true, false]) {
  test(`capture resolves project Playwright: installed=${installed}`, () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-playwright-'));
    try {
      fs.writeFileSync(path.join(cwd, 'spec.ts'), '');
      if (installed) {
        const peer = path.join(cwd, 'node_modules/@playwright/test');
        fs.mkdirSync(peer, { recursive: true });
        fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
        fs.writeFileSync(path.join(peer, 'cli.cjs'), "console.error('consumer Playwright reached'); process.exit(17);");
      }
      const result = spawnSync(process.execPath, [fileURLToPath(cli), '--spec', 'spec.ts'], {
        cwd,
        env: { ...process.env, PATH: '' },
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(result.status, installed ? 17 : 2, result.stderr);
      assert.match(result.stderr, installed ? /consumer Playwright reached/ : /@playwright\/test is not installed in/);
      if (!installed) assert.doesNotMatch(result.stderr, /Require stack:|\)\)/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const code of [undefined, 'EACCES', 'ENOENT', 'EINVAL']) {
  test(`Windows PATH fallback preserves results without a project CLI: ${code}`, (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-windows-'));
    t.mock.property(process, 'platform', 'win32');
    const calls = [];
    const result = { status: code ? null : 19, error: code ? { code, message: 'shim failed' } : undefined };
    t.mock.method(childProcess, 'spawnSync', (command) => {
      calls.push(command);
      return calls.length === 1 ? result : { status: 17 };
    });
    syncBuiltinESMExports();
    try {
      const actual = projectPlaywright(['--version'], { cwd });
      assert.equal(actual.status, result.status);
      assert.equal(calls.length, 1);
      assert.equal(calls[0], 'playwright.cmd');
      if (code === 'EACCES') assert.equal(actual, result);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('POSIX project CLI takes precedence over PATH executable', { skip: process.platform === 'win32' }, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-path-'));
  try {
    fs.writeFileSync(path.join(cwd, 'spec.ts'), '');
    fs.writeFileSync(path.join(cwd, 'playwright'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
    const peer = path.join(cwd, 'node_modules/@playwright/test');
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
    fs.writeFileSync(path.join(peer, 'cli.cjs'), 'process.exit(17)');
    const result = spawnSync(process.execPath, [fileURLToPath(cli), '--spec', 'spec.ts'], {
      cwd,
      env: { ...process.env, PATH: cwd },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 17, result.stderr);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('project spawn errors retain their original code and message without running PATH', (t) => {
  const spawn = t.mock.method(childProcess, 'spawnSync', (command) => ({
    error: Object.assign(new Error(command === process.execPath ? 'spawn denied cli-path' : 'shim invalid'), {
      code: command === process.execPath ? 'EACCES' : 'ENOENT',
    }),
  }));
  syncBuiltinESMExports();
  try {
    const result = projectPlaywright([], { cwd: repoRoot });
    assert.equal(result.error.code, 'EACCES');
    assert.match(result.error.message, /cli-path/);
    assert.equal(spawn.mock.callCount(), 1);
    assert.equal(spawn.mock.calls[0].arguments[0], process.execPath);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('Windows project CLI runs with Node and forwards spawn options unchanged', (t) => {
  t.mock.property(process, 'platform', 'win32');
  const result = { status: 19 };
  const options = { cwd: repoRoot, stdio: 'inherit', env: { SENTINEL: 'forwarded' } };
  const spawn = t.mock.method(childProcess, 'spawnSync', () => result);
  syncBuiltinESMExports();
  try {
    assert.equal(projectPlaywright(['install', 'chromium'], options), result);
    assert.equal(spawn.mock.callCount(), 1);
    const [command, args, actualOptions] = spawn.mock.calls[0].arguments;
    assert.equal(command, process.execPath);
    assert.equal(args[0], createRequire(path.join(repoRoot, 'package.json')).resolve('@playwright/test/cli'));
    assert.deepEqual(args.slice(1), ['install', 'chromium']);
    assert.equal(actualOptions, options);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
