// Playwright-style URL globs (the `page.route` / `replayUrl` micro-syntax), replicated
// because Playwright exposes no public matcher: `**` spans `/`, `*` stays within a
// segment, `?` is literal, `{a,b}` alternates, and a glob-char-free string is a substring match.

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

export function urlMatcher(glob: string): (url: string) => boolean {
  if (!/[*?{}[\]\\]/.test(glob)) return (url) => url.includes(glob);
  const compiled = compileUrlGlob(glob);
  return (url) => compiled.test(url);
}
