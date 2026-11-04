import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceMap } from './script-reach.js';
import { ScriptEvidenceError } from './script-reach-limits.js';
const BUNDLER = /^(?:webpack(?:-internal)?|vite|rollup|parcel):/;
const WINDOWS_PATH = /^(?:[a-z]:[\\/]|\\)/i;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

function filesystemKey(filename: string, projectRoot: string): string {
  filename = filename.replace(/^\/@fs(?=\/)/, '');
  const paths = WINDOWS_PATH.test(filename) ? path.win32 : path;
  const relative = paths.relative(paths.resolve(projectRoot), filename).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || paths.isAbsolute(relative))
    throw new ScriptEvidenceError('source outside project root');
  return relative;
}

/** URL parsing erases /./ and /../, so classify empty-host bundler paths first. */
function absoluteBundlerPath(address: string): string | undefined {
  if (!BUNDLER.test(address)) return undefined;
  const raw = address.match(/^[a-z][a-z\d+.-]*:\/\/\/([^?#]*)/i)?.[1];
  if (!raw || raw.startsWith('./') || raw.startsWith('../')) return undefined;
  const filename = decodeURIComponent(raw).replaceAll('\\', '/');
  return WINDOWS_PATH.test(filename) ? filename : '/' + filename;
}

/** Only explicit filesystem server URLs qualify; relative app URL paths do not. */
function filesystemUrlPath(pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname).replaceAll('\\', '/');
  if (decoded.startsWith('/@fs/')) return decoded.slice(4);
  if (/^\/(?:Users|home|root|tmp)(?:\/|$)/.test(decoded) || /^\/?[a-z]:\//i.test(decoded))
    return decoded.replace(/^\/(?=[a-z]:\/)/i, '');
  return undefined;
}

function sourceDirectory(root: string | undefined, mapUrl: string): URL {
  if (!root) return new URL(mapUrl);
  let url = new URL(root, mapUrl);
  // Vite's opaque scheme becomes a hierarchical URL so relative sources resolve normally.
  if (!url.pathname.startsWith('/') && BUNDLER.test(url.href)) url = new URL(`${url.protocol}/${url.pathname}`);
  url.pathname = url.pathname.replace(/\/?$/, '/');
  url.search = '';
  url.hash = '';
  return url;
}

function filesystemReference(address: string): string | undefined {
  const absolute = absoluteBundlerPath(address);
  if (absolute) return absolute;
  return WINDOWS_PATH.test(address) || path.posix.isAbsolute(address) ? address : undefined;
}

function resolvedFilesystemPath(source: string, resolved: URL): string | undefined {
  if (resolved.protocol === 'file:') return fileURLToPath(resolved);
  const pathname = decodeURIComponent(resolved.pathname).replaceAll('\\', '/');
  if (pathname.startsWith('/@fs/')) return pathname.slice(4);
  return /^https?:/i.test(source) ? filesystemUrlPath(resolved.pathname) : undefined;
}

function sourceKey(source: string, root: string | undefined, mapUrl: string, projectRoot: string): string | undefined {
  const filename = filesystemReference(source);
  if (filename) return filesystemKey(filename, projectRoot);
  const rootPath = root && filesystemReference(root);
  if (rootPath && !SCHEME.test(source))
    return filesystemKey((WINDOWS_PATH.test(rootPath) ? path.win32 : path).resolve(rootPath, source), projectRoot);
  const resolved = SCHEME.test(source)
    ? new URL(source)
    : new URL(source.replaceAll('\\', '/'), sourceDirectory(root, mapUrl));
  const resolvedFile = resolvedFilesystemPath(source, resolved);
  if (resolvedFile) return filesystemKey(resolvedFile, projectRoot);
  if (BUNDLER.test(resolved.href) && !resolved.pathname.replaceAll('/', '')) return undefined;
  return projectKey(resolved.pathname.replace(/^\//, ''), projectRoot);
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
    if (!key || /(^|\/)node_modules\//.test(key)) return undefined;
    if (seen.has(key)) throw new ScriptEvidenceError('source key collision');
    seen.add(key);
    return key;
  });
}

function storedFilesystemKey(filename: string, projectRoot: string): string | undefined {
  try {
    return filesystemKey(filename, projectRoot);
  } catch {
    return undefined;
  }
}

function storedBundlerUrl(address: string, url: URL, projectRoot: string): string {
  const filename = absoluteBundlerPath(address);
  if (!filename) return url.protocol + url.pathname.replace(/^\/\.\//, '/');
  const key = storedFilesystemKey(filename, projectRoot);
  return key ? url.protocol + '/' + key : url.protocol + '<outside root>';
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
      const key = storedFilesystemKey(fileURLToPath(url), projectRoot);
      return key ? 'file:/' + key : 'file:';
    }
    if (BUNDLER.test(address)) return storedBundlerUrl(address, url, projectRoot);
    if (!/^https?:$/.test(url.protocol)) return url.protocol;
    const filename = filesystemUrlPath(url.pathname);
    if (filename) {
      const key = storedFilesystemKey(filename, projectRoot);
      if (!key) return url.origin + '/';
      url.pathname = '/' + key;
    }
    return url.href;
  } catch {
    return '<anonymous>';
  }
}
