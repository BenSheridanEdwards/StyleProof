// Playwright-style URL globs (the `page.route` / `replayUrl` micro-syntax), replicated
// because Playwright exposes no public matcher: `**` spans `/`, `*` stays within a
// segment, `?` is literal, `{a,b}` alternates, and every glob is anchored. A glob not
// starting with `*` is first resolved against the context's baseURL, as Playwright does.

const REGEX_CHARS = new Set('$^+.*()|\\?{}[]');
const literal = (char: string): string => (REGEX_CHARS.has(char) ? `\\${char}` : char);

function invalid(glob: string, reason: string): never {
  throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: ${reason}`);
}

function starToken(glob: string, index: number): { token: string; endIndex: number } {
  let endIndex = index;
  while (glob[endIndex + 1] === '*') endIndex++;
  if (endIndex === index) return { token: '([^/]*)', endIndex };
  if (glob[endIndex + 1] !== '/') return { token: '(.*)', endIndex };
  return { token: glob[index - 1] === '/' ? '((.+/)|)' : '(.*/)', endIndex: endIndex + 1 };
}

function escapedToken(glob: string, index: number): { token: string; endIndex: number } {
  const next = glob[index + 1];
  return { token: literal(next ?? glob[index]), endIndex: next === undefined ? index : index + 1 };
}

function groupToken(glob: string, char: string, inGroup: boolean): string {
  const opening = char === '{';
  if (opening === inGroup) invalid(glob, opening ? "nested '{' is not supported" : "unmatched '}'");
  return opening ? '(' : ')';
}

function compileUrlGlob(glob: string): RegExp {
  const tokens = ['^'];
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' || c === '*') {
      const { token, endIndex } = c === '*' ? starToken(glob, i) : escapedToken(glob, i);
      tokens.push(token);
      i = endIndex;
    } else if (c === '{' || c === '}') {
      tokens.push(groupToken(glob, c, inGroup));
      inGroup = c === '{';
    } else {
      tokens.push(c === ',' && inGroup ? '|' : literal(c));
    }
  }
  if (inGroup) invalid(glob, "unmatched '{'");
  return new RegExp(tokens.join('') + '$');
}

const PASSTHROUGH_SCHEMES = ['about:', 'data:', 'chrome:', 'edge:', 'file:'];

// Port of Playwright 1.61 `resolveGlobBase`: each path token is swapped for a placeholder,
// the path is resolved with `new URL`, then the originals are restored (host lowercased).
function resolveGlobBase(glob: string, baseURL: string | undefined): string {
  if (glob.startsWith('*')) return glob;
  const match = glob.replaceAll(/\\\\\?/g, '?');
  if (PASSTHROUGH_SCHEMES.some((scheme) => match.startsWith(scheme))) return match;
  const tokenMap = new Map<string, string>();
  const mapToken = (original: string, replacement: string): string => {
    if (original.length === 0) return '';
    tokenMap.set(replacement, original);
    return replacement;
  };
  const relativePath = match
    .split('/')
    .map((token, index) => {
      if (token === '.' || token === '..' || token === '') return token;
      if (index === 0 && token.endsWith(':')) {
        if (token.includes('*') || token.includes('{')) return mapToken(token, 'http:');
        return token;
      }
      const questionIndex = token.indexOf('?');
      if (questionIndex === -1) return mapToken(token, `$_${index}_$`);
      return (
        mapToken(token.substring(0, questionIndex), `$_${index}_$`) +
        mapToken(token.substring(questionIndex), `?$_${index}_$`)
      );
    })
    .join('/');
  let url: URL;
  try {
    url = new URL(relativePath, baseURL);
  } catch {
    if (baseURL === undefined) {
      throw new Error(
        `URL glob ${JSON.stringify(glob)} is relative but no baseURL is set, so it matches no request ` +
          `(Playwright's routes resolve it the same way). Set \`use.baseURL\` in the Playwright config, ` +
          `or start the glob with \`**\` (e.g. "**/api/**") or an absolute origin.`,
      );
    }
    return match;
  }
  let resolved = url.toString();
  for (const [token, original] of tokenMap) {
    resolved = resolved.replace(token, url.origin.includes(token) ? original.toLowerCase() : original);
  }
  return resolved;
}

/**
 * Match URLs exactly as Playwright's `page.route` / `routeFromHAR` match `glob` in a context
 * with this `baseURL`. Throws when the glob is relative and there is no `baseURL`.
 */
export function urlMatcher(glob: string, baseURL?: string): (url: string) => boolean {
  const compiled = compileUrlGlob(resolveGlobBase(glob, baseURL));
  return (url) => compiled.test(url);
}
