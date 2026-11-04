import { ScriptEvidenceError } from './script-reach-limits.js';
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

function checkPathDepth(pathname: string, depth: number, allowClipping: boolean): boolean {
  let clipped = false;
  for (const segment of decodeURIComponent(pathname).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (depth) depth--;
      else {
        if (!allowClipping) throw new ScriptEvidenceError('source path escapes URL root');
        clipped = true;
      }
    } else depth++;
  }
  return clipped;
}

/** Only content-backed relative sources may clip parent traversal at the URL root. */
export function resolveSourceUrl(
  reference: string,
  base: URL | string,
  allowClipping = false,
): { url: URL; clipped: boolean } {
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
  const clipped = checkPathDepth(path, Math.max(0, depth), allowClipping && !SCHEME.test(raw) && !raw.startsWith('/'));
  return { url: new URL(reference, base), clipped };
}
