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

/** Pin to `--head` without visiting `--base`; return whether a checkout was needed. */
export function ensureConsumerAtHead(repoRoot: string, head: string): boolean {
  const headSha = resolveCommit(repoRoot, head, `--head ${head}`);
  const current = runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (current.status === 0 && current.stdout.trim() === headSha) return false;
  ciGit(repoRoot, ['checkout', '--force', head], `could not checkout --head ${head} in the consumer tree`, 1);
  return true;
}

export class CiProcessExit {
  readonly exitCode: number;
  constructor(exitCode: number) {
    this.exitCode = exitCode;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** Pid recorded in a scratch dir's owner.pid, or undefined when absent or malformed. */
function scratchOwnerPid(dir: string): number | undefined {
  let owner: string;
  try {
    owner = fs.readFileSync(path.join(dir, 'owner.pid'), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const pid = Number(owner);
  return /^[1-9]\d*$/.test(owner) && Number.isSafeInteger(pid) ? pid : undefined;
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}

/** Remove styleproof-ci-wt-* dirs whose recorded owner process has exited (a killed job skips dispose()). */
function sweepDeadScratch(parent: string): void {
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^styleproof-ci-wt-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const dir = path.join(parent, entry.name);
    const pid = scratchOwnerPid(dir);
    if (pid !== undefined && pid !== process.pid && processIsGone(pid)) removeDirRecursive(dir);
  }
}

function createScratchParent(): string {
  const parent = ciWorktreeScratchParent();
  sweepDeadScratch(parent);
  const dir = fs.mkdtempSync(path.join(parent, 'styleproof-ci-wt-'));
  fs.writeFileSync(path.join(dir, 'owner.pid'), String(process.pid));
  return dir;
}

export class CiWorktreeSession {
  private readonly repoRoot: string;
  private readonly scratchParent: string;
  private readonly worktrees = new Map<string, string>();
  private disposed = false;

  constructor(repoRoot: string, scratchParent?: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.scratchParent = scratchParent ?? createScratchParent();
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
