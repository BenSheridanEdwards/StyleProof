import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkTmp, rmTmp } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// These are documented copyable workflows, not historical snippets. Keep both
// halves on the same manifest-producing, server-managed path as new installs.
test('split workflow examples match the supported review-gate scaffold', () => {
  const cwd = mkTmp('styleproof-example-scaffold-');
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'bin/styleproof-init.mjs'),
        '--workflow',
        'split',
        '--storage',
        'artifact',
        '--mode',
        'review-gate',
        '--server-command',
        'npm run build && npm run serve',
      ],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const [name, generatedName] of [
      ['styleproof-capture.yml', 'styleproof.yml'],
      ['styleproof-report.yml', 'styleproof-report.yml'],
    ]) {
      const actual = fs.readFileSync(path.join(root, 'example', name), 'utf8');
      const expected = fs.readFileSync(path.join(cwd, '.github/workflows', generatedName), 'utf8');
      assert.equal(actual, expected, `${name} must not bypass the supported capture/report orchestration`);
    }
  } finally {
    rmTmp(cwd);
  }
});
