import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
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
  test(`Windows PATH execution preserves results or resolves project CLI: ${code}`, (t) => {
    t.mock.property(process, 'platform', 'win32');
    const calls = [];
    const result = { status: code ? null : 19, error: code ? { code } : undefined };
    t.mock.method(childProcess, 'spawnSync', (command) => {
      calls.push(command);
      return calls.length === 1 ? result : { status: 17 };
    });
    syncBuiltinESMExports();
    try {
      const actual = projectPlaywright(['--version'], { cwd: repoRoot });
      assert.equal(actual.status, ['ENOENT', 'EINVAL'].includes(code) ? 17 : result.status);
      assert.equal(calls.length, ['ENOENT', 'EINVAL'].includes(code) ? 2 : 1);
      assert.equal(calls[0], 'playwright.cmd');
      if (code === 'EACCES') assert.equal(actual, result);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test('POSIX PATH executable takes precedence over project CLI', { skip: process.platform === 'win32' }, () => {
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
    assert.equal(result.status, 23, result.stderr);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('fallback spawn errors retain their original code and message', (t) => {
  t.mock.method(childProcess, 'spawnSync', (command) => ({
    error: Object.assign(new Error(command === process.execPath ? 'spawn denied cli-path' : 'shim invalid'), {
      code: command === process.execPath ? 'EACCES' : 'ENOENT',
    }),
  }));
  syncBuiltinESMExports();
  try {
    const result = projectPlaywright([], { cwd: repoRoot });
    assert.match(result.error.message, /EACCES/);
    assert.match(result.error.message, /cli-path/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
