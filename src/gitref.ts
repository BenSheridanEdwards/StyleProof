import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A readable failure materialising a base from git — CLIs map this to exit 2. */
export class GitRefError extends Error {}

function git(args: string[]) {
  return spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function gitOutput(args: string[]): string {
  const r = git(args);
  return r.status === 0 ? r.stdout.trim() : '';
}

function refExists(ref: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

function firstExistingRef(refs: string[]): string | undefined {
  return refs.find(refExists);
}

/** Infer the committed-map base ref for local and GitHub Actions CLI runs. */
export function inferBaseRef(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_BASE_REF) {
    const fromEnv = firstExistingRef([`origin/${env.GITHUB_BASE_REF}`, env.GITHUB_BASE_REF]);
    if (fromEnv) return fromEnv;
    return `origin/${env.GITHUB_BASE_REF}`;
  }

  const branch = gitOutput(['branch', '--show-current']);
  if (branch) {
    const configured = gitOutput(['config', `branch.${branch}.gh-merge-base`]);
    if (configured) {
      const fromConfig = firstExistingRef([`origin/${configured}`, configured]);
      if (fromConfig) return fromConfig;
      return `origin/${configured}`;
    }
  }

  const fallback = firstExistingRef(['origin/main', 'origin/master', 'main', 'master']);
  if (fallback) return fallback;

  throw new GitRefError(
    'could not infer a base branch (tried GITHUB_BASE_REF, branch.<name>.gh-merge-base, origin/main, origin/master, main, master); pass a base ref, e.g. styleproof-diff main',
  );
}

/**
 * Materialise the captures committed at `dir` as of `ref` into a fresh temp dir,
 * so a diff/report can use e.g. `main`'s committed map as the base with no checkout
 * and no recapture — the "base map lives on main, CI just diffs" model.
 *
 * Reads purely through git (`ls-tree`/`show`, no `tar`/deps); binary `.json.gz`
 * bytes come straight from `git show`. The caller owns cleanup of the returned dir.
 * Throws {@link GitRefError} (never exits) so it's reusable from any entry point.
 */
export function materializeRef(ref: string, dir: string): string {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new GitRefError('must run inside a git repository');
  const toplevel = top.stdout.trim();

  // -z: NUL-separated, unquoted paths (handles spaces/unicode).
  const ls = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', ref, '--', dir], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (ls.status !== 0) throw new GitRefError(`cannot read ${dir} at ${ref}: ${(ls.stderr || '').trim()}`);
  const files = ls.stdout.split('\0').filter(Boolean);
  if (files.length === 0) {
    throw new GitRefError(`no committed captures at ${dir} in ${ref} — commit the maps so the base lives in git`);
  }

  const dirRepoRel = path.relative(toplevel, path.resolve(dir));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-baseref-'));
  for (const f of files) {
    const show = spawnSync('git', ['show', `${ref}:${f}`], { maxBuffer: 1 << 28 }); // buffer — preserves .json.gz
    if (show.status !== 0) throw new GitRefError(`cannot read ${f} at ${ref}`);
    const out = path.join(dest, path.relative(dirRepoRel, f));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, show.stdout);
  }
  return dest;
}
