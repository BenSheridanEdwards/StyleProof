import { ScriptEvidenceError } from './script-reach-limits.js';
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

function checkPathDepth(pathname: string, depth: number): void {
  for (const segment of decodeURIComponent(pathname).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!depth) throw new ScriptEvidenceError('source path escapes URL root');
      depth--;
    } else depth++;
  }
}

/** Reject parent traversal that URL would silently clip before computing a source key. */
export function resolveSourceUrl(reference: string, base: URL | string): URL {
  const raw = reference.replaceAll('\\', '/');
  const path = raw
    .split(/[?#]/, 1)[0]
    .replace(SCHEME, '')
    .replace(/^\/\/[^/]*/, '');
  const url = new URL(base);
  const depth =
    SCHEME.test(raw) || raw.startsWith('/')
      ? 0
      : url.pathname.split('/').filter(Boolean).length - Number(!url.pathname.endsWith('/'));
  checkPathDepth(path, Math.max(0, depth));
  return new URL(reference, base);
}
