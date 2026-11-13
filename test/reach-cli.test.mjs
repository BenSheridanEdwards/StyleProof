import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('reach JSON reports source guards, enclosing surfaces and acknowledgements', () => {
  const result = spawnSync(process.execPath, ['bin/styleproof.mjs', 'reach', '--json'], {
    encoding: 'utf8',
    input: JSON.stringify({
      units: [
        {
          file: 'app.js',
          text: 'if (fault) show();',
          guardingCondition: 'fault',
          enclosingSurfaces: ['home'],
          status: 'never-rendered',
        },
      ],
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.units[0].guardingCondition, 'fault');
  assert.deepEqual(output.units[0].enclosingSurfaces, ['home']);
  assert.equal(output.units[0].acknowledged, false);
  assert.equal(output.audit.passed, false);
});
