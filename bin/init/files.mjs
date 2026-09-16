// Safe writes into a consumer repository: never follow symlinked parents, never
// overwrite unless told to, never touch non-regular files.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function pathState(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { kind: 'symlink' };
    if (stat.isFile()) return { kind: 'file' };
    if (stat.isDirectory()) return { kind: 'directory' };
    return { kind: 'other' };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable' };
  }
}

export function pathStateWithin(file, trustedRoot) {
  const root = path.resolve(trustedRoot);
  const absolute = path.resolve(file);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { kind: 'outside' };
  }
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return { kind: 'symlink-parent' };
      if (!stat.isDirectory()) return { kind: 'non-directory-parent' };
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      return { kind: 'unreadable-parent' };
    }
  }
  return pathState(absolute);
}

/** Classify a repository-generated destination relative to the current directory. */
export const generatedPathState = (file) => pathStateWithin(file, '.');

/** Classify a path under git's common dir (where default hooks live). */
export function defaultHookPathState(file) {
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  const commonPath = common.status === 0 ? common.stdout.trim() : '';
  if (!commonPath || /[\r\n]/.test(commonPath)) return { kind: 'unreadable-parent' };
  return pathStateWithin(file, commonPath);
}

export function isExecutableFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

export function readRegularTextFile(file) {
  try {
    return generatedPathState(file).kind === 'file' ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

const accessible = (file, mode) => {
  try {
    fs.accessSync(file, mode);
    return true;
  } catch {
    return false;
  }
};

function writableDestination(file, state) {
  try {
    if (state.kind === 'file') return accessible(file, fs.constants.R_OK | fs.constants.W_OK);
    if (state.kind !== 'missing') return false;
    for (let parent = path.dirname(path.resolve(file)); ; parent = path.dirname(parent)) {
      const parentState = pathState(parent);
      if (parentState.kind === 'directory') {
        fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
        return true;
      }
      if (parentState.kind !== 'missing' || path.dirname(parent) === parent) return false;
    }
  } catch {
    return false;
  }
}

/** Write `contents` to `file` → `{ wrote, exists, unmanaged? }`. Existing files need `force`. */
export function writeFileSafe(file, contents, { force = false } = {}) {
  const state = generatedPathState(file);
  const exists = state.kind !== 'missing';
  if (exists && (state.kind !== 'file' || !accessible(file, fs.constants.R_OK)))
    return { wrote: false, exists: true, unmanaged: true };
  if (exists && !force) return { wrote: false, exists: true };
  if (!writableDestination(file, state)) return { wrote: false, exists, unmanaged: true };
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, contents);
  } catch {
    return { wrote: false, exists, unmanaged: true };
  }
  return { wrote: true, exists };
}

/** Append the missing `lines` to .gitignore → `{ added, unmanaged }`. */
export function ensureGitignoreLines(lines) {
  const file = '.gitignore';
  const state = generatedPathState(file);
  if (state.kind !== 'missing' && state.kind !== 'file') return { added: [], unmanaged: true };
  let existing = '';
  if (state.kind === 'file') {
    try {
      fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
      const bytes = fs.readFileSync(file);
      existing = bytes.toString('utf8');
      if (!Buffer.from(existing, 'utf8').equals(bytes)) return { added: [], unmanaged: true };
    } catch {
      return { added: [], unmanaged: true };
    }
  }
  const present = new Set(existing.split(/\r?\n/));
  const added = lines.filter((line) => !present.has(line));
  if (!added.length) return { added, unmanaged: false };
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const result = writeFileSafe(file, `${existing}${prefix}${added.join('\n')}\n`, { force: true });
  return result.unmanaged ? { added: [], unmanaged: true } : { added, unmanaged: false };
}
