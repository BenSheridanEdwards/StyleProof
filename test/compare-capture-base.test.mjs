import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('bin/styleproof-diff.mjs');

for (const mode of ['manual', 'install-failure', 'config-install-failure', 'capture-failure', 'success']) {
  const captureBase = mode !== 'manual';
  test(`missing base with ${mode} preserves checkout and cleans worktrees`, () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-compare-'));

    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);

      return result.stdout;
    };

    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.com');
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { preinstall: 'exit 1' } }));
      fs.writeFileSync(
        path.join(repo, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
      );
      fs.mkdirSync(path.join(repo, 'e2e'));
      fs.writeFileSync(path.join(repo, 'e2e/styleproof.spec.ts'), '// fixture');
      fs.writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\nstyleproof-audit.json\n');

      if (mode === 'config-install-failure')
        fs.writeFileSync(path.join(repo, 'styleproof.config.json'), JSON.stringify({ captureBase: true }));

      git('add', '.');
      git('commit', '-m', 'base');
      const baseSha = git('rev-parse', 'HEAD').trim();
      git('switch', '-c', 'feature');
      fs.writeFileSync(path.join(repo, 'feature'), 'head commit');
      git('add', '.');
      git('commit', '-m', 'head');
      fs.writeFileSync(
        path.join(repo, 'package.json'),
        fs.readFileSync(path.join(repo, 'package.json'), 'utf8') + '\n',
      );
      fs.writeFileSync(path.join(repo, 'dirty'), 'uncommitted');
      const executables = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-capture-bin-'));

      try {
        const log = path.join(executables, 'calls.jsonl');

        for (const command of ['npm', 'playwright']) {
          const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const cwd = process.cwd();
const side = process.env.STYLEMAP_DIR;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: '${command}', cwd, side,
sha: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
dirty: fs.existsSync('dirty') }) + '\\n');
if ('${command}' === 'npm') process.exit(${mode.endsWith('install-failure') ? 1 : 0});
if (${mode === 'capture-failure'} && side === 'base') process.exit(1);
const out = path.join(process.env.STYLEPROOF_BASEDIR, side);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'home@1280.json'), JSON.stringify({ defaults: {}, states: {},
elements: { body: { tag: 'body', cls: '', style: { color: side === 'base' ? 'red' : 'blue' } } } }));
`;

          fs.writeFileSync(path.join(executables, command), script);
          fs.chmodSync(path.join(executables, command), 0o755);
        }

        const before = git('status', '--porcelain');
        const head = git('rev-parse', 'HEAD');

        const result = spawnSync(
          process.execPath,
          [cli, 'main', ...(captureBase && mode !== 'config-install-failure' ? ['--capture-base'] : [])],
          {
            cwd: repo,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${executables}${path.delimiter}${process.env.PATH}` },
          },
        );

        assert.equal(result.status, mode === 'success' ? 1 : 2, result.stderr);

        if (captureBase) {
          if (mode !== 'success')
            assert.match(
              result.stderr,
              new RegExp(`base ${mode.endsWith('install-failure') ? 'install' : 'capture'} failed.*\\.worktrees/`, 's'),
            );
          else {
            assert.match(result.stdout, /red/);
            assert.match(result.stdout, /blue/);
            const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
            const base = calls.find((call) => call.command === 'playwright' && call.side === 'base');
            assert.ok(base.cwd.startsWith(path.join(fs.realpathSync(repo), '.worktrees') + path.sep));
            assert.equal(base.sha, baseSha);
            assert.equal(calls.find((call) => call.command === 'npm').cwd, base.cwd);
            assert.equal(base.dirty, false);
            assert.equal(calls.find((call) => call.side === 'head').cwd, fs.realpathSync(repo));
            assert.equal(calls.find((call) => call.side === 'head').dirty, true);
          }

          assert.deepEqual(fs.readdirSync(path.join(repo, '.worktrees')), []);
        } else {
          assert.match(result.stderr, /cached maps are not available/);
          assert.match(result.stderr, /or rerun with --capture-base to capture the base in a temporary worktree/);
        }

        assert.equal(git('status', '--porcelain'), before);
        assert.equal(git('rev-parse', 'HEAD'), head);
        assert.equal(git('branch', '--show-current').trim(), 'feature');
        assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
      } finally {
        fs.rmSync(executables, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}
