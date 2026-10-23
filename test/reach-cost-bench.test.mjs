import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = path.join(repoRoot, 'bench/reach-cost.results.json');

test('reach-cost rejects invalid run counts without changing the receipt', async (t) => {
  for (const value of [['0'], ['-1'], ['1.5'], ['abc'], []]) {
    await t.test(`--runs ${value[0] ?? '(missing)'}`, () => {
      const receipt = fs.readFileSync(receiptPath);
      const result = spawnSync(process.execPath, ['bench/reach-cost.mjs', '--runs', ...value], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--runs must be a positive integer/);
      assert.deepEqual(fs.readFileSync(receiptPath), receipt);
    });
  }
});
