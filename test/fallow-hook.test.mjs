import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const hook = readFileSync(new URL('../.husky/pre-commit', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('pre-commit runs the same audit and production complexity gates as CI', () => {
  const syntax = spawnSync('sh', ['-n', '.husky/pre-commit'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  assert.match(hook, /git diff --cached --unified=0/);
  assert.match(hook, /npx --no-install fallow audit --base HEAD --health-baseline/);
  assert.match(hook, /npx --no-install fallow health/);
  assert.match(hook, /--production/);
  assert.match(hook, /--baseline \.fallow\/health-baseline\.json/);
  assert.match(hook, /--changed-since HEAD/);
  assert.match(hook, /--diff-file "\$FALLOW_STAGED_DIFF"/);
  assert.match(hook, /--fail-on-issues/);
});

test('local Fallow is exactly pinned so pre-commit and the Action resolve the same release', () => {
  assert.equal(pkg.devDependencies.fallow, '3.14.0');
  assert.equal(lock.packages[''].devDependencies.fallow, '3.14.0');
  assert.equal(lock.packages['node_modules/fallow'].version, '3.14.0');
});
