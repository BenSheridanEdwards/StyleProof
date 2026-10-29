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
  consumerRelativeFromRepoRoot,
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

test('consumerRelativeFromRepoRoot: a repository at the filesystem root keeps its subdirectory', () => {
  const root = path.parse(process.cwd()).root;
  assert.equal(consumerRelativeFromRepoRoot(root, root), '.');
  assert.equal(consumerRelativeFromRepoRoot(root, path.join(root, 'app')), 'app');
  const repo = path.join(root, 'repo');
  assert.throws(() => consumerRelativeFromRepoRoot(repo, path.join(root, 'repo-other')), CiWorktreeError);
});

test('CiWorktreeSession sweeps dead owners and writes its own owner pid', () => {
  const parent = mkTmp('styleproof-ci-owners-');
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = parent;
  let session;

  try {
    const dead = spawnSync(process.execPath, ['-e', '']);
    const stale = path.join(parent, 'styleproof-ci-wt-dead');
    const fresh = path.join(parent, 'styleproof-ci-wt-fresh');
    const live = path.join(parent, 'styleproof-ci-wt-live');
    const unowned = path.join(parent, 'styleproof-ci-wt-unowned');

    for (const dir of [stale, fresh, live, unowned]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(stale, 'owner.pid'), String(dead.pid));
    fs.writeFileSync(path.join(fresh, 'owner.pid'), String(dead.pid));
    const old = new Date(Date.now() - 61 * 60_000);
    fs.writeFileSync(path.join(live, 'owner.pid'), String(process.ppid));

    for (const dir of [stale, live, unowned]) fs.utimesSync(dir, old, old);
    git(parent, ['init', '-q']);
    session = new CiWorktreeSession(parent);
    assert.equal(fs.existsSync(stale), false);
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(live));
    assert.ok(fs.existsSync(unowned));
    assert.equal(fs.readFileSync(path.join(session.scratchRoot(), 'owner.pid'), 'utf8'), String(process.pid));
  } finally {
    session?.dispose();

    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
    rmTmp(parent);
  }
});

test(
  'CiWorktreeSession skips unreadable owner files',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  (t) => {
    const parent = mkTmp('styleproof-ci-unreadable-');
    const previous = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = parent;
    const dir = path.join(parent, 'styleproof-ci-wt-locked');
    fs.mkdirSync(dir);
    const owner = path.join(dir, 'owner.pid');
    fs.writeFileSync(owner, '123');
    const old = new Date(Date.now() - 61 * 60_000);
    fs.utimesSync(dir, old, old);
    t.after(() => {
      fs.chmodSync(owner, 0o600);

      if (previous === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previous;
      rmTmp(parent);
    });
    fs.chmodSync(owner, 0);
    let session;
    assert.doesNotThrow(() => {
      session = new CiWorktreeSession(parent);
    });
    session.dispose();
    assert.ok(fs.existsSync(dir));
  },
);
