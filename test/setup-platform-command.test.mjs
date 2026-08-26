import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSpawnCommand } from '../bin/platform-command.mjs';

test('setup resolves package-manager executables without a shell on Windows', () => {
  assert.equal(resolveSpawnCommand('npm', 'win32'), 'npm.cmd');
  assert.equal(resolveSpawnCommand('pnpm', 'win32'), 'pnpm.cmd');
  assert.equal(resolveSpawnCommand('yarn', 'win32'), 'yarn.cmd');
  assert.equal(resolveSpawnCommand('bun', 'win32'), 'bun.exe');
  assert.equal(resolveSpawnCommand('bunx', 'win32'), 'bunx.exe');
  assert.equal(resolveSpawnCommand('npm', 'darwin'), 'npm');
  assert.equal(resolveSpawnCommand('/absolute/bin/tool', 'win32'), '/absolute/bin/tool');
});
