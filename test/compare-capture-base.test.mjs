import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { writeMapManifest, publishMapBundle } from '../dist/map-store.js';

const cli = path.resolve('bin/styleproof-diff.mjs');

for (const mode of 'manual install-failure install-status-SIGINT install-status-SIGTERM leftovers config-only capture-failure install-SIGINT install-SIGTERM SIGINT SIGTERM group-install-SIGINT group-install-SIGTERM group-capture-SIGINT group-capture-SIGTERM stored-head success'.split(
  ' ',
)) {
  const captureBase = !['manual', 'config-only'].includes(mode);
  test(`missing base with ${mode} preserves checkout and cleans worktrees`, async () => {
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
      fs.writeFileSync(path.join(repo, '.gitignore'), 'styleproof-audit.json\n');

      if (mode === 'config-only')
        fs.writeFileSync(path.join(repo, 'styleproof.config.json'), JSON.stringify({ captureBase: true }));

      git('add', '.');
      git('commit', '-m', 'base');
      const baseSha = git('rev-parse', 'HEAD').trim();
      git('switch', '-c', 'feature');
      fs.writeFileSync(path.join(repo, 'feature'), 'head commit');
      git('add', '.');
      git('commit', '-m', 'head');
      fs.appendFileSync(path.join(repo, 'package.json'), '\n');
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
worktrees: fs.existsSync('.worktrees') ? fs.readdirSync('.worktrees') : [], dirty: fs.existsSync('dirty') }) + '\\n');
if (${mode.startsWith('group-')} && ('${command}' === 'npm' ? ${mode.startsWith('group-install-')} : side === 'base')) process.kill(0, '${mode.split('-').at(-1)}');
if ('${command}' === 'npm' && ${mode.startsWith('install-SIG')}) process.kill(process.pid, '${mode.replace('install-', '')}');
if ('${command}' === 'npm' && ${mode.startsWith('install-status-')}) process.exit(${mode.endsWith('SIGINT') ? 130 : 143});
if ('${command}' === 'npm') { console.error('fixture install diagnostic'); process.exit(${mode.endsWith('install-failure') ? 1 : 0}); }
if (${mode === 'capture-failure'} && side === 'base') process.exit(1);
if (${mode.startsWith('SIG')} && side === 'base') { process.kill(process.ppid, '${mode}'); process.exit(0); }
const out = path.join(process.env.STYLEPROOF_BASEDIR, side);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'home@1280.json'), JSON.stringify({ defaults: {}, states: {},
elements: { body: { tag: 'body', cls: '', style: { color: side === 'base' ? 'red' : 'blue' } } } }));
`;

          fs.writeFileSync(path.join(executables, command), script);
          fs.chmodSync(path.join(executables, command), 0o755);
        }

        if (mode === 'stored-head') {
          const remote = path.join(executables, 'remote.git');
          git('init', '--bare', remote);
          git('remote', 'add', 'origin', remote);
          const dir = path.join(executables, 'stored');
          fs.mkdirSync(dir);
          fs.writeFileSync(
            path.join(dir, 'home@1280.json'),
            '{"defaults":{},"states":{},"elements":{"body":{"tag":"body","cls":"","style":{"color":"green"}}}}',
          );
          writeMapManifest({ cwd: repo, dir, spec: 'e2e/styleproof.spec.ts', screenshots: false, dirty: false });
          await publishMapBundle({ cwd: repo, dir });
        }

        const parent = path.join(repo, '.worktrees');

        if (mode === 'leftovers') {
          for (const name of ['dead', 'live', 'ownerless']) {
            const dir = path.join(parent, `styleproof-base-${name}`);
            fs.mkdirSync(dir, { recursive: true });
            git('worktree', 'add', '--detach', path.join(dir, `cache-base-${baseSha.slice(0, 12)}`), baseSha);

            if (name !== 'ownerless')
              fs.writeFileSync(path.join(dir, 'owner.pid'), String(name === 'live' ? process.pid : 2147483647));
          }

          fs.mkdirSync(path.join(parent, 'unrelated'));
          fs.writeFileSync(path.join(repo, '.git/info/exclude'), '.worktrees/\n');
        }

        const before = git('status', '--porcelain');
        const head = git('rev-parse', 'HEAD');

        const result = spawnSync(process.execPath, [cli, 'main', ...(captureBase ? ['--capture-base'] : [])], {
          cwd: repo,
          detached: true,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${executables}${path.delimiter}${process.env.PATH}` },
        });

        assert.equal(
          result.status,
          mode.endsWith('SIGINT')
            ? 130
            : mode.endsWith('SIGTERM')
              ? 143
              : ['success', 'stored-head', 'leftovers'].includes(mode)
                ? 1
                : 2,
          result.stderr,
        );

        if (captureBase) {
          assert.match(result.stderr, /base restore failed:.*capturing/s);

          if (mode === 'install-failure') {
            assert.match(result.stderr, /fixture install diagnostic/);
            assert.match(result.stderr, /npm ci.*exit 1/);
          }

          assert.doesNotMatch(result.stderr, /Or rerun with --capture-base/);

          if (mode.includes('SIG')) {
            assert.match(result.stderr, /(?:capture|install) interrupted by SIG/);
            assert.equal(fs.readFileSync(log, 'utf8').includes('"side":"head"'), false);
          } else if (!['success', 'stored-head', 'leftovers'].includes(mode))
            assert.match(
              result.stderr,
              new RegExp(`base ${mode.endsWith('install-failure') ? 'install' : 'capture'} failed.*\\.worktrees/`, 's'),
            );
          else {
            assert.match(result.stdout, /red/);
            assert.match(result.stdout, mode === 'stored-head' ? /green/ : /blue/);
            const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
            const base = calls.find((call) => call.command === 'playwright' && call.side === 'base');
            assert.ok(base.cwd.startsWith(path.join(fs.realpathSync(repo), '.worktrees') + path.sep));
            assert.equal(base.sha, baseSha);
            assert.equal(calls.find((call) => call.command === 'npm').cwd, base.cwd);
            assert.equal(base.dirty, false);

            if (mode === 'stored-head') {
              assert.ok(!calls.some((call) => call.side === 'head'));
            } else {
              assert.equal(calls.find((call) => call.side === 'head').cwd, fs.realpathSync(repo));
              assert.equal(calls.find((call) => call.side === 'head').dirty, true);
              assert.deepEqual(
                calls.find((call) => call.side === 'head').worktrees.sort(),
                mode === 'leftovers' ? ['styleproof-base-live', 'unrelated'] : [],
              );
            }
          }

          assert.equal(fs.existsSync(parent), mode === 'leftovers');
        } else {
          assert.match(result.stderr, /cached maps are not available/);
          assert.equal(fs.existsSync(log), false);

          if (mode === 'config-only') assert.match(result.stderr, /unknown key\(s\) ignored: captureBase/);
          assert.match(result.stderr, /Or rerun with --capture-base to capture the base in a temporary worktree/);
        }

        assert.equal(git('status', '--porcelain'), before);
        assert.equal(git('rev-parse', 'HEAD'), head);
        assert.equal(git('branch', '--show-current').trim(), 'feature');
        assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, mode === 'leftovers' ? 2 : 1);
      } finally {
        fs.rmSync(executables, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}

for (const command of ['diff', 'report']) {
  test(`${command} rejects --capture-base with explicit directories`, () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(`bin/styleproof-${command}.mjs`), '.', '.', '--capture-base'],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--capture-base.*(?:baseRef|cached)/);
  });
}
