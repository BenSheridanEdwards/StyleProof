import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveSpawnCommand, resolveSpawnPlan } from '../bin/platform-command.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

test('setup maps package-manager names to their Windows executables', () => {
  assert.equal(resolveSpawnCommand('npm', 'win32'), 'npm.cmd');
  assert.equal(resolveSpawnCommand('pnpm', 'win32'), 'pnpm.cmd');
  assert.equal(resolveSpawnCommand('yarn', 'win32'), 'yarn.cmd');
  assert.equal(resolveSpawnCommand('bun', 'win32'), 'bun.exe');
  assert.equal(resolveSpawnCommand('bunx', 'win32'), 'bunx.exe');
  assert.equal(resolveSpawnCommand('npm', 'darwin'), 'npm');
  assert.equal(resolveSpawnCommand('/absolute/bin/tool', 'win32'), '/absolute/bin/tool');
});

test('Windows package-manager plans quote install arguments through cmd.exe', () => {
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    const plan = resolveSpawnPlan(
      manager,
      ['install', '--save-dev', 'styleproof@9.0.0', '@playwright/test@>=1.45'],
      'win32',
      { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    );
    assert.deepEqual(plan, {
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `"${manager}.cmd ^"install^" ^"--save-dev^" ^"styleproof@9.0.0^" ^"@playwright/test@^>=1.45^""`,
      ],
      options: { windowsVerbatimArguments: true },
    });
    assert.equal(plan.args[3].split('@playwright/test@^>=1.45').length - 1, 1);
    assert.equal('shell' in plan.options, false);
  }
  assert.deepEqual(resolveSpawnPlan('npm', ['exec', 'playwright', 'install', 'chromium'], 'win32', {}), {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', '"npm.cmd ^"exec^" ^"playwright^" ^"install^" ^"chromium^""'],
    options: { windowsVerbatimArguments: true },
  });
});

test('non-shim executables and non-Windows plans spawn directly without a shell', () => {
  const args = ['a b', '@playwright/test@>=1.45'];
  for (const [command, platform, file] of [
    ['bun', 'win32', 'bun.exe'],
    ['bunx', 'win32', 'bunx.exe'],
    ['npm', 'darwin', 'npm'],
    ['npm', 'linux', 'npm'],
    ['/absolute/bin/tool', 'win32', '/absolute/bin/tool'],
    ['C:\\nodejs\\node.exe', 'win32', 'C:\\nodejs\\node.exe'],
  ]) {
    const plan = resolveSpawnPlan(command, args, platform, {});
    assert.deepEqual(plan, { file, args, options: {} });
    assert.equal('shell' in plan.options, false);
  }
});

test('absolute cmd and bat paths also route through cmd.exe', () => {
  for (const extension of ['CMD', 'bat']) {
    const plan = resolveSpawnPlan(`C:\\tools\\x.${extension}`, ['a b'], 'win32', {});
    assert.equal(plan.file, 'cmd.exe');
    assert.equal(plan.args[3], `"C:\\tools\\x.${extension} ^"a^ b^""`);
  }
});

test('Windows shim plans refuse unsafe arguments and command paths', () => {
  for (const unsafe of ['a"b', '50%', 'x!y', 'a\nb', 'a\rb']) {
    assert.throws(() => resolveSpawnPlan('npm', [unsafe], 'win32', {}), /cmd\.exe/);
    assert.throws(() => resolveSpawnPlan(`C:\\${unsafe}\\npm.cmd`, [], 'win32', {}), /cmd\.exe/);
    assert.doesNotThrow(() => resolveSpawnPlan('npm', [unsafe], 'darwin', {}));
  }
});

test('setup completes install and browser steps with the Windows direct-shim guard', async (t) => {
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    for (const skipInstall of [false, true]) {
      await t.test(`${manager}${skipInstall ? ' --skip-install' : ''}`, () => {
        const project = mkTmp('styleproof-setup-windows-');
        try {
          fs.writeFileSync(
            path.join(project, 'package.json'),
            JSON.stringify({ name: 'consumer', private: true, packageManager: `${manager}@1.0.0` }),
          );
          // Model Node's Windows EINVAL guard on every host; real cmd.exe parsing
          // is separately exercised by package-smoke on the Windows CI runner.
          const preload = `
            import childProcess from 'node:child_process';
            import { syncBuiltinESMExports } from 'node:module';
            const spawnSync = childProcess.spawnSync;
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.ComSpec = 'cmd.exe';
            childProcess.spawnSync = (file, args, options) => {
              if (file === process.execPath) return spawnSync(file, args, options);
              if (file === 'cmd.exe' && options.windowsVerbatimArguments && !options.shell) {
                process.stdout.write('Simulated package-manager step\\n');
                return { status: 0 };
              }
              return { status: null, error: new Error('spawnSync ' + file + ' EINVAL') };
            };
            syncBuiltinESMExports();
            const [setup, ...flags] = process.argv.slice(1);
            process.argv = [process.execPath, setup, ...flags];
            await import(setup);
          `;
          const result = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '--eval',
              preload,
              new URL('../bin/styleproof-setup.mjs', import.meta.url).href,
              '--external-server',
              ...(skipInstall ? ['--skip-install'] : []),
            ],
            { cwd: project, encoding: 'utf8', timeout: 60_000 },
          );
          assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
          assert.match(result.stdout, /StyleProof setup complete/);
          assert.equal(result.stdout.split('Simulated package-manager step').length - 1, skipInstall ? 1 : 2);
          assert.ok(fs.existsSync(path.join(project, '.github/workflows/styleproof.yml')));
        } finally {
          rmTmp(project);
        }
      });
    }
  }
});
