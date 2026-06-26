import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A readable failure materialising a base from git — CLIs map this to exit 2. */
export class GitRefError extends Error {}

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
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', maxBuffer: 1 << 28 });
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
