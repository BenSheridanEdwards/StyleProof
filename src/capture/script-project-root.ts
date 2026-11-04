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
    timeout: 1000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return git.status === 0 && git.stdout.trim() ? path.resolve(git.stdout.trim()) : directory;
}
