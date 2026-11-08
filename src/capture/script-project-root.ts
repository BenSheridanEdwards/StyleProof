import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverStyleProofConfig } from '../config/load.js';

/** Resolve once at runner setup; never serialize the filesystem root into evidence. */
export function resolveScriptProjectRoot(startDir = process.cwd()): string {
  const directory = path.resolve(startDir);
  const config = discoverStyleProofConfig(directory).location;
  if (config) return config.dir;
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return git.status === 0 && git.stdout.trim() ? path.resolve(git.stdout.trim()) : directory;
}

/** Capture provenance for sourceKey joins. Absence is explicit when the project is not in git. */
export function scriptProjectRootPrefix(projectRoot: string): string | undefined {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (git.status !== 0 || !git.stdout.trim()) return undefined;
  try {
    const prefix = path
      .relative(fs.realpathSync(git.stdout.trim()), fs.realpathSync(projectRoot))
      .replaceAll('\\', '/');
    return prefix === '..' || prefix.startsWith('../') || path.isAbsolute(prefix) ? undefined : prefix;
  } catch {
    return undefined;
  }
}
