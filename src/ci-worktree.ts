// Ephemeral detached `git worktree` orchestration for `styleproof-ci`: restore probes and
// cold base capture run in throwaway worktrees so the consumer checkout never moves to
// `--base`. Argv spawns only; scratch dirs under `RUNNER_TEMP` or `os.tmpdir()`.
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeDirRecursive, runGit } from './node-util.js';
import { isWithinDirectory } from './safe-filesystem.js';
import { errorMessage } from './util.js';

export class CiWorktreeError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'CiWorktreeError';
    this.exitCode = exitCode;
  }
}

/** Trimmed stderr (else stdout) of a failed git call, for error messages. */
export function gitDetail(result: SpawnSyncReturns<string>): string {
  return (result.stderr ?? result.stdout ?? '').trim();
}

/** Run git, or throw a CiWorktreeError with `failure` and git's own detail. */
function ciGit(cwd: string, args: string[], failure: string, exitCode: 1 | 2, requireOutput = false): string {
  const result = runGit(cwd, args);
  const output = result.stdout?.trim() ?? '';
  if (result.status !== 0 || (requireOutput && !output)) {
    throw new CiWorktreeError(`styleproof-ci: ${failure}\n${gitDetail(result)}`, exitCode);
  }
  return output;
}

/** Parent directory for ephemeral CI worktrees (`RUNNER_TEMP` in Actions, else OS tmp). */
export function ciWorktreeScratchParent(): string {
  return process.env.RUNNER_TEMP ?? os.tmpdir();
}

export function gitRepoRoot(cwd: string): string {
  return path.resolve(
    ciGit(cwd, ['rev-parse', '--show-toplevel'], 'could not resolve the git repository root', 2, true),
  );
}

/** Consumer path relative to the repository root (`.` when already at root). */
export function consumerRelativeFromRepoRoot(repoRoot: string, consumerCwd: string): string {
  if (!isWithinDirectory(repoRoot, consumerCwd)) {
    throw new CiWorktreeError('styleproof-ci: working directory is outside the git repository', 2);
  }
  return path.relative(path.resolve(repoRoot), path.resolve(consumerCwd)) || '.';
}

export function worktreeRunCwd(worktreePath: string, consumerRel: string): string {
  return consumerRel === '.' ? worktreePath : path.join(worktreePath, consumerRel);
}

function resolveCommit(cwd: string, ref: string, label: string): string {
  return ciGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], `could not resolve ${label} to a commit`, 2);
}

export function assertResolvableCommit(sha: string, cwd: string): void {
  resolveCommit(cwd, sha, sha);
}

/** Force the consumer checkout onto `--head` without ever checking out `--base`. */
export function ensureConsumerAtHead(repoRoot: string, head: string): void {
  const headSha = resolveCommit(repoRoot, head, `--head ${head}`);
  const current = runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (current.status === 0 && current.stdout.trim() === headSha) return;
  ciGit(repoRoot, ['checkout', '--force', head], `could not checkout --head ${head} in the consumer tree`, 1);
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
    // A hard kill skips dispose() and leaves stale registrations that accumulate on
    // persistent runners; pruning at START cleans up after any predecessor's crash.
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
    ciGit(
      this.repoRoot,
      ['worktree', 'add', '--detach', dir, sha],
      `could not create a detached worktree at ${sha}`,
      2,
    );
    this.worktrees.set(label, dir);
    return dir;
  }

  remove(label: string): void {
    const dir = this.worktrees.get(label);
    if (!dir) return;
    this.worktrees.delete(label);
    ciGit(this.repoRoot, ['worktree', 'remove', '--force', dir], `could not remove worktree ${dir}`, 1);
    removeDirRecursive(dir);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const warn = (what: string, cleanup: () => void) => {
      try {
        cleanup();
      } catch (error) {
        process.stderr.write(`styleproof-ci: ${what} cleanup warning: ${errorMessage(error)}\n`);
      }
    };
    for (const label of [...this.worktrees.keys()]) warn(`worktree (${label})`, () => this.remove(label));
    warn('scratch', () => removeDirRecursive(this.scratchParent));
  }
}
