// Node-runtime helpers shared across the library: the git spawn, hashing, and
// retried directory removal.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

export function runGit(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: options.maxBuffer ?? 1 << 28, env: options.env });
}

/** Trimmed stdout of a successful `git` call, else ''. */
export function gitOutput(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = runGit(cwd, args, { env });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Recursive removal that retries the transient ENOTEMPTY/EBUSY races a bare rmSync does not. */
export function removeDirRecursive(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
