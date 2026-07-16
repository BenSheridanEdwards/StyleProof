import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CiWorktreeError,
  CiWorktreeSession,
  assertResolvableCommit,
  ciWorktreeScratchParent,
  ensureConsumerAtHead,
  gitRepoRoot,
  worktreeRunCwd,
} from '../dist/ci-worktree.js';
import { mkTmp, rmTmp } from './helpers.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('gitRepoRoot: resolves from a repo subdirectory', () => {
  const root = mkTmp('styleproof-ci-wt-root-');
  try {
    git(root, ['init', '-q', '-b', 'main']);
    const sub = path.join(root, 'hud');
    fs.mkdirSync(sub);
    assert.equal(gitRepoRoot(sub), gitRepoRoot(root));
  } finally {
    rmTmp(root);
  }
});

test('assertResolvableCommit: invalid SHA is a usage error', () => {
  const root = mkTmp('styleproof-ci-wt-bad-sha-');
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'styleproof@example.test']);
    git(root, ['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'init']);
    assert.throws(
      () => assertResolvableCommit('not-a-real-ref', root),
      (error) => {
        assert.ok(error instanceof CiWorktreeError);
        assert.equal(error.exitCode, 2);
        assert.match(error.message, /could not resolve/);
        return true;
      },
    );
  } finally {
    rmTmp(root);
  }
});

test('worktreeRunCwd: nests consumer-relative paths inside the worktree', () => {
  const wt = path.join(os.tmpdir(), 'styleproof-ci-wt-demo');
  assert.equal(worktreeRunCwd(wt, '.'), wt);
  assert.equal(worktreeRunCwd(wt, 'hud'), path.join(wt, 'hud'));
});

test('ciWorktreeScratchParent: prefers RUNNER_TEMP when set', () => {
  const custom = path.join(os.tmpdir(), `styleproof-runner-temp-${process.pid}`);
  fs.mkdirSync(custom, { recursive: true });
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = custom;
  try {
    assert.equal(ciWorktreeScratchParent(), custom);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
    fs.rmSync(custom, { recursive: true, force: true });
  }
});

test('CiWorktreeSession: detached worktrees are removed after success and failure', () => {
  const root = mkTmp('styleproof-ci-wt-session-');
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'styleproof@example.test']);
    git(root, ['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'base']);
    const base = git(root, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(root, 'README.md'), 'head\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'head']);
    const head = git(root, ['rev-parse', 'HEAD']);

    const scratch = path.join(root, 'scratch');
    fs.mkdirSync(scratch);

    const session = new CiWorktreeSession(root, scratch);
    const baseWt = session.addDetached(base, 'base');
    assert.equal(git(baseWt, ['rev-parse', 'HEAD']), base);
    const headWt = session.addDetached(head, 'head');
    assert.equal(git(headWt, ['rev-parse', 'HEAD']), head);
    assert.ok(fs.existsSync(baseWt));
    assert.ok(fs.existsSync(headWt));
    session.dispose();
    assert.equal(fs.existsSync(baseWt), false);
    assert.equal(fs.existsSync(headWt), false);
    assert.equal(
      git(root, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length,
      1,
      'only the consumer worktree remains',
    );

    const failing = new CiWorktreeSession(root, path.join(root, 'scratch-2'));
    try {
      assert.throws(
        () => failing.addDetached('deadbeef', 'missing'),
        (error) => {
          assert.ok(error instanceof CiWorktreeError);
          assert.equal(error.exitCode, 2);
          return true;
        },
      );
    } finally {
      failing.dispose();
    }
    assert.equal(
      git(root, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length,
      1,
    );
  } finally {
    rmTmp(root);
  }
});

test('ensureConsumerAtHead: checkout failure is operational error (exit 1)', () => {
  const root = mkTmp('styleproof-ci-wt-checkout-');
  const previousPath = process.env.PATH;
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'styleproof@example.test']);
    git(root, ['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'base']);
    const base = git(root, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(root, 'README.md'), 'head\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'head']);
    const head = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', base]);

    const which = spawnSync('which', ['git'], { encoding: 'utf8' });
    assert.equal(which.status, 0, which.stderr);
    const realGit = which.stdout.trim();
    const bin = path.join(root, 'git-bin');
    fs.mkdirSync(bin, { recursive: true });
    const wrapper = path.join(bin, 'git');
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh
case "$*" in
  *checkout\\ --force*)
    echo "deliberate checkout failure" >&2
    exit 1
    ;;
esac
exec "${realGit}" "$@"
`,
    );
    fs.chmodSync(wrapper, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;

    assert.throws(
      () => ensureConsumerAtHead(root, head),
      (error) => {
        assert.ok(error instanceof CiWorktreeError);
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /could not checkout --head/);
        return true;
      },
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmTmp(root);
  }
});
