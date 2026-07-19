/**
 * `--spec-ref` overlay for `styleproof-ci`: pin the capture spec bytes from another
 * commit while rendering the base checkout's app and lockfile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class CiSpecRefError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'CiSpecRefError';
    this.exitCode = exitCode;
  }
}

function runGit(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** Relative path only — resolved against the directory styleproof-ci runs in, like
 *  every other `--spec` in the toolchain (a workflow may run the CLI from a
 *  subdirectory, e.g. `working-directory: hud`). Rejects absolute paths and paths
 *  that escape upward. */
export function normalizeRepoRelativeSpec(spec: string, cwd: string): string {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new CiSpecRefError('styleproof-ci: --spec must be a non-empty relative path', 2);
  }
  if (path.isAbsolute(trimmed)) {
    throw new CiSpecRefError(`styleproof-ci: --spec must be a relative path, not absolute: ${spec}`, 2);
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new CiSpecRefError(`styleproof-ci: --spec must stay inside the repository: ${spec}`, 2);
  }
  const resolved = path.resolve(cwd, normalized);
  const repoRoot = path.resolve(cwd);
  if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${path.sep}`)) {
    throw new CiSpecRefError(`styleproof-ci: --spec must stay inside the repository: ${spec}`, 2);
  }
  return normalized;
}

/** Resolve a possibly-symbolic `--spec-ref` to a commit SHA in the CONSUMER
 *  checkout. Inside the detached base worktree `HEAD` IS `--base` (so
 *  `--spec-ref HEAD` silently overlays the base's own spec — a no-op defeating
 *  the flag) and `FETCH_HEAD`/`MERGE_HEAD` are per-worktree pseudo-refs that
 *  don't exist there at all. Resolving to a SHA before entering the worktree
 *  makes the ref mean what it meant where the user typed it; the SHA itself
 *  resolves everywhere since worktrees share one object store. */
export function resolveSpecRefToSha(specRef: string, cwd: string): string {
  const r = runGit(cwd, ['rev-parse', '--verify', `${specRef}^{commit}`]);
  if (r.status !== 0) {
    throw new CiSpecRefError(
      `styleproof-ci: could not resolve --spec-ref ${specRef} to a commit\n${(r.stderr ?? r.stdout ?? '').trim()}`,
      2,
    );
  }
  return r.stdout.trim();
}

export function assertResolvableSpecRef(specRef: string, cwd: string): void {
  const r = runGit(cwd, ['rev-parse', '--verify', `${specRef}^{commit}`]);
  if (r.status !== 0) {
    throw new CiSpecRefError(
      `styleproof-ci: could not resolve --spec-ref ${specRef} to a commit\n${(r.stderr ?? r.stdout ?? '').trim()}`,
      2,
    );
  }
}

/** The `<rev>:<path>` form for a CWD-RELATIVE spec. Bare `<rev>:<path>` resolves
 *  the path from the REPO ROOT, so from a subdirectory (`working-directory: hud`,
 *  spec `tests/e2e/styleproof.spec.ts`) the lookup missed a file that exists and
 *  the overlay failed with a false "missing at --spec-ref". Git's `<rev>:./<path>`
 *  syntax resolves relative to the command's cwd — matching how the same `spec`
 *  string is used by every pathspec call and filesystem write in this module. */
function specRevPath(specRef: string, spec: string): string {
  return `${specRef}:./${spec}`;
}

export function assertSpecAtRef(spec: string, specRef: string, cwd: string): void {
  const r = runGit(cwd, ['cat-file', '-e', specRevPath(specRef, spec)]);
  if (r.status !== 0) {
    throw new CiSpecRefError(
      `styleproof-ci: --spec ${spec} is missing at --spec-ref ${specRef}\n${(r.stderr ?? r.stdout ?? '').trim()}`,
      2,
    );
  }
}

function readSpecBlobAtRef(spec: string, specRef: string, cwd: string): Buffer {
  const r = spawnSync('git', ['show', specRevPath(specRef, spec)], { cwd, encoding: 'buffer', maxBuffer: 1 << 28 });
  if (r.status !== 0 || !r.stdout?.length) {
    throw new CiSpecRefError(`styleproof-ci: could not read ${spec} at --spec-ref ${specRef}`, 1);
  }
  return r.stdout;
}

export type SpecRefOverlay = {
  spec: string;
  paths: string[];
  dirtyAllow: string[];
  restore: () => void;
};

/** Cold base capture only overlays when the base tree already contains the spec path. */
export function shouldApplySpecRefOverlay(specExistsAtBase: boolean, specRef: string): boolean {
  return Boolean(specRef && specExistsAtBase);
}

/**
 * Overlay `spec` and its colocated test harness with blobs from `specRef`, while
 * leaving application code and package metadata pinned to the base checkout.
 * Tracked base files are marked assume-unchanged; head-only harness files are
 * covered by `dirtyAllow`. The returned restore handle must run before leaving
 * the base checkout.
 */
export function applySpecRefOverlay(options: { spec: string; specRef: string; cwd: string }): SpecRefOverlay {
  const spec = normalizeRepoRelativeSpec(options.spec, options.cwd);
  assertResolvableSpecRef(options.specRef, options.cwd);
  assertSpecAtRef(spec, options.specRef, options.cwd);
  const harnessDirectory = path.posix.dirname(spec);
  const listed =
    harnessDirectory === '.'
      ? [spec]
      : runGit(options.cwd, ['ls-tree', '-r', '-z', '--name-only', options.specRef, '--', `./${harnessDirectory}`])
          .stdout.split('\0')
          .filter(Boolean)
          .map((entry) => entry.replace(/\\/g, '/'));
  const paths = [...new Set([spec, ...listed])].sort();
  const trackedPaths: string[] = [];
  const headOnlyPaths: string[] = [];

  const restore = () => {
    for (const overlayPath of [...trackedPaths].reverse()) {
      const noAssume = runGit(options.cwd, ['update-index', '--no-assume-unchanged', '--', overlayPath]);
      if (noAssume.status !== 0) {
        throw new CiSpecRefError(
          `styleproof-ci: could not clear assume-unchanged for ${overlayPath} after the spec-ref overlay\n${(noAssume.stderr ?? noAssume.stdout ?? '').trim()}`,
          1,
        );
      }
      const checkout = runGit(options.cwd, ['checkout', '--', overlayPath]);
      if (checkout.status !== 0) {
        throw new CiSpecRefError(
          `styleproof-ci: could not restore ${overlayPath} after the spec-ref overlay\n${(checkout.stderr ?? checkout.stdout ?? '').trim()}`,
          1,
        );
      }
    }
    for (const overlayPath of [...headOnlyPaths].reverse()) {
      fs.rmSync(path.join(options.cwd, overlayPath), { force: true });
    }
  };

  try {
    for (const overlayPath of paths) {
      const bytes = readSpecBlobAtRef(overlayPath, options.specRef, options.cwd);
      const absoluteOverlayPath = path.join(options.cwd, overlayPath);
      const trackedAtBase = runGit(options.cwd, ['ls-files', '--error-unmatch', '--', overlayPath]).status === 0;
      (trackedAtBase ? trackedPaths : headOnlyPaths).push(overlayPath);
      fs.mkdirSync(path.dirname(absoluteOverlayPath), { recursive: true });
      fs.writeFileSync(absoluteOverlayPath, bytes);
      if (!trackedAtBase) continue;
      const assume = runGit(options.cwd, ['update-index', '--assume-unchanged', '--', overlayPath]);
      if (assume.status !== 0) {
        throw new CiSpecRefError(
          `styleproof-ci: could not mark ${overlayPath} assume-unchanged for the spec-ref overlay\n${(assume.stderr ?? assume.stdout ?? '').trim()}`,
          1,
        );
      }
    }
  } catch (error) {
    restore();
    throw error;
  }

  return {
    spec,
    paths,
    dirtyAllow: harnessDirectory === '.' ? [spec] : [harnessDirectory],
    restore,
  };
}
