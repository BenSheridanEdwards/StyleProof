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
      assert.match(
        result.stderr,
        installed
          ? /consumer Playwright reached/
          : /Playwright could not be found on PATH or in the project's node_modules/,
      );
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
      const actual = projectPlaywright(['--version']);
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
