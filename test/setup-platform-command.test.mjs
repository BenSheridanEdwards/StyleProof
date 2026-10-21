import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSpawn } from '../bin/platform-command.mjs';

const args = ['install', '--save-dev', 'styleproof@1.2.3', '@playwright/test@>=1.45'];

test('setup runs Windows package-manager .cmd shims through cmd.exe with every argument quoted', () => {
  // Node on Windows rejects a direct .cmd spawn with EINVAL (#970); an unquoted `>` would be a redirect.
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    assert.deepEqual(resolveSpawn(manager, args, 'win32'), {
      file: process.env.ComSpec || 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `""${manager}.cmd" "install" "--save-dev" "styleproof@1.2.3" "@playwright/test@>=1.45""`,
      ],
      options: { windowsVerbatimArguments: true },
    });
  }
});

test('setup spawns Bun, non-Windows commands, and absolute paths directly without a shell', () => {
  const direct = (file) => ({ file, args, options: {} });
  assert.deepEqual(resolveSpawn('bun', args, 'win32'), direct('bun.exe'));
  assert.deepEqual(resolveSpawn('bunx', args, 'win32'), direct('bunx.exe'));
  assert.deepEqual(resolveSpawn('npm', args, 'darwin'), direct('npm'));
  assert.deepEqual(resolveSpawn('yarn', args, 'linux'), direct('yarn'));
  assert.deepEqual(resolveSpawn('/absolute/bin/tool', args, 'win32'), direct('/absolute/bin/tool'));
});
