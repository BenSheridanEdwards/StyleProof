import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceMap } from './script-reach.js';
import { ScriptEvidenceError } from './script-reach-limits.js';
const BUNDLER = /^(?:webpack(?:-internal)?|vite|rollup|parcel):/;
const WINDOWS_PATH = /^(?:[a-z]:[\\/]|\\\\)/i;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

function filesystemKey(filename: string, projectRoot: string): string {
  const paths = WINDOWS_PATH.test(filename) ? path.win32 : path;
  const relative = paths.relative(paths.resolve(projectRoot), filename).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || paths.isAbsolute(relative))
    throw new ScriptEvidenceError('source outside project root');
  return relative;
}

function bundlerPath(address: string): string {
  return address.replace(/^[a-z][a-z\d+.-]*:(?:\/\/[^/]*\/|\/)?/i, '');
}

function sourceKey(source: string, root: string | undefined, mapUrl: string, projectRoot: string): string {
  if (WINDOWS_PATH.test(source) || path.posix.isAbsolute(source)) return filesystemKey(source, projectRoot);
  if (BUNDLER.test(source)) return projectKey(bundlerPath(source), projectRoot);
  if (root && BUNDLER.test(root) && !SCHEME.test(source))
    return projectKey(path.posix.join(bundlerPath(root), source), projectRoot);
  if (root && (WINDOWS_PATH.test(root) || path.posix.isAbsolute(root)) && !SCHEME.test(source))
    return filesystemKey((WINDOWS_PATH.test(root) ? path.win32 : path).resolve(root, source), projectRoot);
  const base = root ? new URL(root.replace(/\/?$/, '/'), mapUrl) : new URL('.', mapUrl);
  const resolved = new URL(source.replaceAll('\\', '/'), base);
  if (resolved.protocol === 'file:') return filesystemKey(fileURLToPath(resolved), projectRoot);
  if (BUNDLER.test(resolved.href)) return projectKey(bundlerPath(resolved.href), projectRoot);
  return projectKey(decodeURIComponent(resolved.pathname).replace(/^\//, ''), projectRoot);
}

function projectKey(value: string, projectRoot: string): string {
  const decoded = decodeURIComponent(value).replaceAll('\\', '/');
  if (path.posix.isAbsolute(decoded) || WINDOWS_PATH.test(decoded)) return filesystemKey(decoded, projectRoot);
  const key = path.posix.normalize(decoded);
  if (key === '..' || key.startsWith('../') || key === '.')
    throw new ScriptEvidenceError('source outside project root');
  return key;
}

/** File paths are relative to a known project root; URL paths retain every project directory. */
export function sourceIdentities(map: SourceMap, mapUrl: string, projectRoot = process.cwd()): (string | undefined)[] {
  const seen = new Set<string>();
  return map.sources.map((source) => {
    if (source === null || /(^|[\\/])node_modules[\\/]/.test((map.sourceRoot ?? '') + '/' + source)) return undefined;
    const key = sourceKey(source, map.sourceRoot, mapUrl, projectRoot);
    if (/(^|\/)node_modules\//.test(key)) return undefined;
    if (seen.has(key)) throw new ScriptEvidenceError('source key collision');
    seen.add(key);
    return key;
  });
}

/** Preserve names without credentials, signed queries, code payloads or machine paths. */
export function storedScriptUrl(address: string, projectRoot = process.cwd()): string {
  if (!address) return '<anonymous>';
  if (address.startsWith('blob:')) return 'blob:';
  try {
    const url = new URL(address);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    if (url.protocol === 'file:') {
      try {
        return 'file:/' + filesystemKey(fileURLToPath(url), projectRoot);
      } catch {
        return 'file:';
      }
    }
    if (BUNDLER.test(address)) return url.protocol + '/' + bundlerPath(url.href).replace(/^\.\//, '');
    if (!/^https?:$/.test(url.protocol)) return url.protocol;
    const filename = decodeURIComponent(url.pathname).replace(/^\/@fs/, '');
    if (/^\/(?:Users|home)\//.test(filename)) {
      try {
        url.pathname = '/' + filesystemKey(filename, projectRoot);
      } catch {
        return url.origin + '/';
      }
    }
    return url.href;
  } catch {
    return '<anonymous>';
  }
}
