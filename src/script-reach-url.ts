import { ScriptEvidenceError } from './script-reach-limits.js';
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

function checkPathDepth(pathname: string, depth: number, allowClipping: boolean): void {
  for (const segment of decodeURIComponent(pathname).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (depth) depth--;
      else if (!allowClipping) throw new ScriptEvidenceError('source path escapes URL root');
    } else depth++;
  }
}

/** Only content-backed relative sources may clip parent traversal at the URL root. */
export function resolveSourceUrl(reference: string, base: URL | string, hasSourceContent = false): URL {
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
  checkPathDepth(path, Math.max(0, depth), hasSourceContent && !SCHEME.test(raw) && !raw.startsWith('/'));
  return new URL(reference, base);
}
