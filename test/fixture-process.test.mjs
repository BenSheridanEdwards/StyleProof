import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('fixture subprocess deadline names the command and deadline', () => {
  const source = `import { fixtureProcess } from './test/helpers/fixture-process.mjs';
    fixtureProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 150 });`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.ok(Date.now() - started < 2500, 'fixture exceeded outer guard');
  assert.match(result.stderr, /deadline 150 ms/);
  assert.ok(result.stderr.includes(process.execPath), result.stderr);
  assert.match(result.stderr, /local git install may have stalled/);
});
