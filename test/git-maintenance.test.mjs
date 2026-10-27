import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeTestEnv } from '../scripts/run-node-test.mjs';
import { createContentFixture } from './helpers/browser-lanes-fixtures.mjs';

test('test preload prevents commit auto-maintenance and preserves inherited git config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-git-maintenance-'));
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'test.inherited',
    GIT_CONFIG_VALUE_0: 'preserved',
    GIT_CONFIG_KEY_1: 'maintenance.auto',
    GIT_CONFIG_VALUE_1: 'true',
    GIT_CONFIG_KEY_2: 'gc.auto',
    GIT_CONFIG_VALUE_2: '256',
  };
  // A Node child models a CLI spawned by a test worker; its git subprocesses
  // must inherit the preload's settings without any per-command options.
  const script = `
    const { execFileSync, spawnSync } = require('node:child_process');
    execFileSync('git', ['init', '-q']);
    const config = execFileSync('git', ['config', '--get', 'test.inherited'], { encoding: 'utf8' });
    const maintenance = execFileSync('git', ['config', '--get', 'maintenance.auto'], { encoding: 'utf8' });
    const gc = execFileSync('git', ['config', '--get', 'gc.auto'], { encoding: 'utf8' });
    const commit = spawnSync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'
    ], { encoding: 'utf8', env: { ...process.env, GIT_TRACE: '1' } });
    process.stdout.write(JSON.stringify({ config, maintenance, gc, status: commit.status, trace: commit.stderr }));
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: dir,
      env: nodeTestEnv(env),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const { config, maintenance, gc, status, trace } = JSON.parse(result.stdout);
    assert.equal(status, 0, trace);
    assert.equal(config.trim(), 'preserved');
    assert.doesNotMatch(trace, /maintenance run/);
    assert.equal(maintenance.trim(), 'false');
    assert.equal(gc.trim(), '0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser lane fixture repositories disable maintenance despite filtering Git environment config', (t) => {
  const fixture = createContentFixture(t, { id: 'maintenance', gitlink: 'update' });
  assert.equal(
    Object.keys(fixture.env).some((key) => key.startsWith('GIT_')),
    false,
  );
  for (const cwd of [fixture.directory, path.join(fixture.workspace, 'child')]) {
    const git = (args) => spawnSync('git', args, { cwd, env: fixture.env, encoding: 'utf8' });
    for (const [key, value] of Object.entries({ 'maintenance.auto': 'false', 'gc.auto': '0' })) {
      const config = git(['config', '--get', key]);
      assert.equal(config.status, 0, config.stderr);
      assert.equal(config.stdout.trim(), value);
    }
    const commit = spawnSync('git', ['commit', '--allow-empty', '-qm', 'maintenance regression'], {
      cwd,
      env: { ...fixture.env, GIT_TRACE: '1' },
      encoding: 'utf8',
    });
    assert.equal(commit.status, 0, commit.stderr);
    assert.doesNotMatch(commit.stderr, /maintenance run/);
  }
});
