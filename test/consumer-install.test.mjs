import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('prepare builds the package without requiring consumer-side Husky', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.prepare, 'npm run build && node .husky/install.mjs');

  const scratch = mkdtempSync(path.join(tmpdir(), 'styleproof-consumer-install-'));
  const installer = path.join(scratch, 'install.mjs');
  writeFileSync(installer, readFileSync(new URL('../.husky/install.mjs', import.meta.url)));
  try {
    const run = spawnSync(process.execPath, [installer], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /package build completed without installing repository hooks/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
