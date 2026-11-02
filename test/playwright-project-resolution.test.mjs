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
      const result = spawnSync(process.execPath, [cli.pathname, '--spec', 'spec.ts'], {
        cwd,
        env: { ...process.env, PATH: '' },
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(result.status, installed ? 17 : 2, result.stderr);
      assert.match(
        result.stderr,
        installed ? /consumer Playwright reached/ : /could not resolve @playwright\/test\/cli from/,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
