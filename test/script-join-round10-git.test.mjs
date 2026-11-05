import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readScriptGitDiff, readScriptGitBlobs } from '../dist/script-join-git-read.js';
import { readScriptChanges } from '../dist/script-join-git.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

const timeout = (stdout = Buffer.alloc(0)) => ({
  status: null,
  signal: 'SIGTERM',
  stdout,
  stderr: Buffer.alloc(0),
  error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
});

function mockSpawn(t, run) {
  t.mock.method(childProcess, 'spawnSync', run);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('git diff has sixty seconds and names a timeout', (t) => {
  mockSpawn(t, (_command, _args, options) => {
    assert.equal(options.timeout, 60_000);
    return timeout();
  });
  assert.throws(() => readScriptGitDiff('.', 'base', 'head'), /timed out/);
});

test('a timed-out blob batch retains parsed blobs and names unread consumers', (t) => {
  mockSpawn(t, (_command, _args, options) => {
    assert.equal(options.timeout, 60_000);
    return timeout(Buffer.from('aaaa blob 1\nx\n'));
  });
  const blobs = readScriptGitBlobs('.', ['aaaa', 'bbbb']);
  assert.equal(blobs.get('aaaa').content.toString(), 'x');
  assert.match(blobs.get('bbbb').reason, /timed out/);
});

for (const phase of ['root', 'diff']) {
  test(`a ${phase} timeout is named in the run-level J2 gap`, (t) => {
    const cwd = mkTmp();
    t.after(() => rmTmp(cwd));
    const git = (...args) => childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'const x = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'const x = 2;\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    const head = git('rev-parse', 'HEAD');
    const dirs = [path.join(cwd, 'base'), path.join(cwd, 'head')];
    dirs.forEach((dir, i) => {
      fs.mkdirSync(dir);
      stampCertifyingFixture(dir, i ? head : base);
    });
    const original = childProcess.spawnSync;
    mockSpawn(t, (command, args, options) => {
      if (args.includes(phase === 'root' ? '--show-toplevel' : '--raw')) {
        assert.equal(options.timeout, 60_000);
        return timeout();
      }
      return Reflect.apply(original, childProcess, [command, args, options]);
    });
    const map = {
      scriptReach: { version: 1, status: 'measured', window: 'navigation', projectRootPrefix: '', scripts: [] },
    };
    const result = readScriptChanges(dirs[0], dirs[1], { cwd, baseMaps: [map], headMaps: [map] });
    assert.equal(result.changes.length, 0);
    assert.ok(result.gaps.some((gap) => /timed out/.test(gap.reason)));
  });
}
