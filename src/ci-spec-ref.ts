// `--spec-ref` overlay for `styleproof-ci`: pin the capture spec bytes from another
// commit while rendering the base checkout's app and lockfile.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitDetail } from './ci-worktree.js';
import { runGit } from './node-util.js';
import { isWithinDirectory } from './safe-filesystem.js';

export class CiSpecRefError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'CiSpecRefError';
    this.exitCode = exitCode;
  }
}

/** Run git, or throw a CiSpecRefError with `failure` and git's own detail. */
function specGit(cwd: string, args: string[], failure: string, exitCode: 1 | 2): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) throw new CiSpecRefError(`styleproof-ci: ${failure}\n${gitDetail(result)}`, exitCode);
  return result.stdout.trim();
}

/** Relative path only, resolved against the directory styleproof-ci runs in; rejects
 *  absolute paths and paths that escape upward. */
export function normalizeRepoRelativeSpec(spec: string, cwd: string): string {
  const trimmed = spec.trim();
  if (!trimmed) throw new CiSpecRefError('styleproof-ci: --spec must be a non-empty relative path', 2);
  if (path.isAbsolute(trimmed)) {
    throw new CiSpecRefError(`styleproof-ci: --spec must be a relative path, not absolute: ${spec}`, 2);
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.split('/').includes('..') || !isWithinDirectory(cwd, path.resolve(cwd, normalized))) {
    throw new CiSpecRefError(`styleproof-ci: --spec must stay inside the repository: ${spec}`, 2);
  }
  return normalized;
}

/** Resolve a possibly-symbolic `--spec-ref` to a SHA in the CONSUMER checkout: inside the
 *  detached base worktree `HEAD` is `--base` and `FETCH_HEAD`/`MERGE_HEAD` do not exist. */
export function resolveSpecRefToSha(specRef: string, cwd: string): string {
  return specGit(
    cwd,
    ['rev-parse', '--verify', `${specRef}^{commit}`],
    `could not resolve --spec-ref ${specRef} to a commit`,
    2,
  );
}

/** `<rev>:./<path>` resolves relative to the command's cwd; bare `<rev>:<path>` is repo-root-relative. */
const specRevPath = (specRef: string, spec: string): string => `${specRef}:./${spec}`;

export function assertSpecAtRef(spec: string, specRef: string, cwd: string): void {
  specGit(cwd, ['cat-file', '-e', specRevPath(specRef, spec)], `--spec ${spec} is missing at --spec-ref ${specRef}`, 2);
}

function readSpecBlobAtRef(spec: string, specRef: string, cwd: string): Buffer {
  const r = spawnSync('git', ['show', specRevPath(specRef, spec)], { cwd, encoding: 'buffer', maxBuffer: 1 << 28 });
  if (r.status !== 0 || !r.stdout?.length) {
    throw new CiSpecRefError(`styleproof-ci: could not read ${spec} at --spec-ref ${specRef}`, 1);
  }
  return r.stdout;
}

function pathExistsAtRef(relativePath: string, specRef: string, cwd: string): boolean {
  return runGit(cwd, ['cat-file', '-e', specRevPath(specRef, relativePath)]).status === 0;
}

export type SpecRefOverlay = {
  spec: string;
  paths: string[];
  dirtyAllow: string[];
  restore: () => void;
};

/** An explicit spec ref owns the capture harness, even when product commits do not track it. */
export function shouldApplySpecRefOverlay(_specExistsAtCheckout: boolean, specRef: string): boolean {
  return Boolean(specRef);
}

/** Harness files at `specRef` beside the spec, as cwd-relative paths. `--full-tree` pins
 *  ls-tree output to repo-root-relative paths so stripping the exact `--show-prefix` is
 *  always correct. */
function listHarnessPaths(spec: string, specRef: string, cwd: string, cwdPrefix: string): string[] {
  const harnessDirectory = path.posix.dirname(spec);
  if (harnessDirectory === '.') return [spec];
  const listed = runGit(cwd, [
    ...'ls-tree -r -z --name-only --full-tree'.split(' '),
    specRef,
    '--',
    `${cwdPrefix}${harnessDirectory}`,
  ]);
  return listed.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/'))
    .map((entry) => (cwdPrefix && entry.startsWith(cwdPrefix) ? entry.slice(cwdPrefix.length) : entry));
}

/** Overlay `spec` and its colocated harness with blobs from `specRef`, leaving application
 *  code and package metadata pinned to the base checkout. Tracked base files are marked
 *  assume-unchanged; head-only files are covered by `dirtyAllow`. Run `restore` before
 *  leaving the base checkout. */
export function applySpecRefOverlay(options: { spec: string; specRef: string; cwd: string }): SpecRefOverlay {
  const { specRef, cwd } = options;
  const spec = normalizeRepoRelativeSpec(options.spec, cwd);
  resolveSpecRefToSha(specRef, cwd);
  assertSpecAtRef(spec, specRef, cwd);
  const cwdPrefix = runGit(cwd, ['rev-parse', '--show-prefix']).stdout.trim().replace(/\\/g, '/');
  const playwrightConfig = 'playwright.styleproof.config.ts';
  const firstAdoptionConfig =
    !fs.existsSync(path.join(cwd, playwrightConfig)) && pathExistsAtRef(playwrightConfig, specRef, cwd)
      ? [playwrightConfig]
      : [];
  const paths = [...new Set([spec, ...listHarnessPaths(spec, specRef, cwd, cwdPrefix), ...firstAdoptionConfig])].sort();
  const trackedPaths: string[] = [];
  const headOnlyPaths: string[] = [];

  const restore = () => {
    for (const overlayPath of [...trackedPaths].reverse()) {
      specGit(
        cwd,
        ['update-index', '--no-assume-unchanged', '--', overlayPath],
        `could not clear assume-unchanged for ${overlayPath} after the spec-ref overlay`,
        1,
      );
      specGit(cwd, ['checkout', '--', overlayPath], `could not restore ${overlayPath} after the spec-ref overlay`, 1);
    }
    for (const overlayPath of [...headOnlyPaths].reverse()) fs.rmSync(path.join(cwd, overlayPath), { force: true });
  };

  try {
    for (const overlayPath of paths) {
      const bytes = readSpecBlobAtRef(overlayPath, specRef, cwd);
      const absoluteOverlayPath = path.join(cwd, overlayPath);
      const trackedAtBase = runGit(cwd, ['ls-files', '--error-unmatch', '--', overlayPath]).status === 0;
      (trackedAtBase ? trackedPaths : headOnlyPaths).push(overlayPath);
      fs.mkdirSync(path.dirname(absoluteOverlayPath), { recursive: true });
      fs.writeFileSync(absoluteOverlayPath, bytes);
      if (trackedAtBase) {
        specGit(
          cwd,
          ['update-index', '--assume-unchanged', '--', overlayPath],
          `could not mark ${overlayPath} assume-unchanged for the spec-ref overlay`,
          1,
        );
      }
    }
  } catch (error) {
    restore();
    throw error;
  }

  // `git status --porcelain` reports repo-root-relative paths, so the allowance lives in
  // that coordinate system and covers EXACTLY the overlaid files, never the whole directory.
  return { spec, paths, dirtyAllow: paths.map((overlayPath) => `${cwdPrefix}${overlayPath}`), restore };
}
