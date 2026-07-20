/**
 * Ephemeral detached `git worktree` orchestration for `styleproof-ci`.
 *
 * Restore probes and cold base install/capture run in throwaway worktrees so the
 * consumer checkout never moves to `--base`. Head capture may still run in the
 * consumer at `--head`. Every path uses argv spawns (no shell) and scratch dirs
 * under `RUNNER_TEMP` or `os.tmpdir()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class CiWorktreeError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'CiWorktreeError';
    this.exitCode = exitCode;
  }
}

function runGit(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function removeDirRecursive(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Parent directory for ephemeral CI worktrees (`RUNNER_TEMP` in Actions, else OS tmp). */
export function ciWorktreeScratchParent(): string {
  return process.env.RUNNER_TEMP ?? os.tmpdir();
}

export function gitRepoRoot(cwd: string): string {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new CiWorktreeError(
      `styleproof-ci: could not resolve the git repository root\n${(result.stderr ?? result.stdout ?? '').trim()}`,
      2,
    );
  }
  return path.resolve(result.stdout.trim());
}

/** Consumer path relative to the repository root (`.` when already at root). */
export function consumerRelativeFromRepoRoot(repoRoot: string, consumerCwd: string): string {
  const resolvedConsumer = path.resolve(consumerCwd);
  const resolvedRoot = path.resolve(repoRoot);
  if (resolvedConsumer === resolvedRoot) return '.';
  if (!resolvedConsumer.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new CiWorktreeError('styleproof-ci: working directory is outside the git repository', 2);
  }
  return path.relative(resolvedRoot, resolvedConsumer) || '.';
}

export function worktreeRunCwd(worktreePath: string, consumerRel: string): string {
  return consumerRel === '.' ? worktreePath : path.join(worktreePath, consumerRel);
}

export function assertResolvableCommit(sha: string, cwd: string): void {
  const result = runGit(cwd, ['rev-parse', '--verify', `${sha}^{commit}`]);
  if (result.status !== 0) {
    throw new CiWorktreeError(
      `styleproof-ci: could not resolve ${sha} to a commit\n${(result.stderr ?? result.stdout ?? '').trim()}`,
      2,
    );
  }
}

/** Force the consumer checkout onto `--head` without ever checking out `--base`. */
export function ensureConsumerAtHead(repoRoot: string, head: string): void {
  const headResult = runGit(repoRoot, ['rev-parse', '--verify', `${head}^{commit}`]);
  if (headResult.status !== 0) {
    throw new CiWorktreeError(
      `styleproof-ci: could not resolve --head ${head} to a commit\n${(headResult.stderr ?? headResult.stdout ?? '').trim()}`,
      2,
    );
  }
  const current = runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (current.status === 0 && current.stdout.trim() === headResult.stdout.trim()) return;
  const checkout = runGit(repoRoot, ['checkout', '--force', head]);
  if (checkout.status !== 0) {
    throw new CiWorktreeError(
      `styleproof-ci: could not checkout --head ${head} in the consumer tree\n${(checkout.stderr ?? checkout.stdout ?? '').trim()}`,
      1,
    );
  }
}

export class CiProcessExit {
  readonly exitCode: number;
  constructor(exitCode: number) {
    this.exitCode = exitCode;
  }
}

export class CiWorktreeSession {
  private readonly repoRoot: string;
  private readonly scratchParent: string;
  private readonly worktrees = new Map<string, string>();
  private disposed = false;

  constructor(repoRoot: string, scratchParent?: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.scratchParent = scratchParent ?? fs.mkdtempSync(path.join(ciWorktreeScratchParent(), 'styleproof-ci-wt-'));
    // A hard kill (SIGKILL, runner teardown) skips dispose() and leaves stale
    // `git worktree` registrations pointing at deleted scratch dirs — on
    // persistent self-hosted workspaces they accumulate forever. Pruning at
    // session START makes each run clean up after any predecessor's crash;
    // a prune failure must never block the run itself.
    runGit(this.repoRoot, ['worktree', 'prune']);
  }

  scratchRoot(): string {
    return this.scratchParent;
  }

  /** Add (or return) a detached worktree at `sha` under the scratch parent. */
  addDetached(sha: string, label: string): string {
    const existing = this.worktrees.get(label);
    if (existing && fs.existsSync(existing)) return existing;

    assertResolvableCommit(sha, this.repoRoot);
    const dir = path.join(this.scratchParent, `${label}-${sha.slice(0, 12)}`);
    if (fs.existsSync(dir)) removeDirRecursive(dir);

    const add = runGit(this.repoRoot, ['worktree', 'add', '--detach', dir, sha]);
    if (add.status !== 0) {
      throw new CiWorktreeError(
        `styleproof-ci: could not create a detached worktree at ${sha}\n${(add.stderr ?? add.stdout ?? '').trim()}`,
        2,
      );
    }
    this.worktrees.set(label, dir);
    return dir;
  }

  remove(label: string): void {
    const dir = this.worktrees.get(label);
    if (!dir) return;
    this.worktrees.delete(label);
    const remove = runGit(this.repoRoot, ['worktree', 'remove', '--force', dir]);
    if (remove.status !== 0) {
      throw new CiWorktreeError(
        `styleproof-ci: could not remove worktree ${dir}\n${(remove.stderr ?? remove.stdout ?? '').trim()}`,
        1,
      );
    }
    removeDirRecursive(dir);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const label of [...this.worktrees.keys()]) {
      try {
        this.remove(label);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`styleproof-ci: worktree cleanup warning (${label}): ${message}\n`);
      }
    }
    try {
      removeDirRecursive(this.scratchParent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`styleproof-ci: scratch cleanup warning: ${message}\n`);
    }
  }
}
