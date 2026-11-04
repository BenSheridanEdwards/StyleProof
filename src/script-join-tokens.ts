/** Conservative lexical ranges: ambiguous slash expressions remain ordinary code. */
export type ScriptToken = { index: number; end: number };

const TOKEN =
  /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|(?<regexp>\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[dgimsuvy]*)|0[xXoObB][\dA-Fa-f_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?n?|\.\d[\d_]*(?:[eE][+-]?\d[\d_]*)?|#?[\p{ID_Start}_$][\p{ID_Continue}$]*/uy;
const REGEX_PREFIX_WORDS = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'yield', 'await']);

function literalMayStart(line: string, offset: number): boolean {
  let index = offset - 1;
  while (index >= 0 && /\s/.test(line[index])) index--;
  if (index < 0 || '=(:,[!&|?{};><'.includes(line[index])) return true;
  const end = index + 1;
  while (index >= 0 && /[A-Za-z]/.test(line[index])) index--;
  return REGEX_PREFIX_WORDS.has(line.slice(index + 1, end));
}

/** Delimited text runs retain their text-node start; multiline gaps use preceding-anchor evidence. */
function jsxTextAfter(line: string, open: number, close: number): ScriptToken | undefined {
  if (!literalMayStart(line, open)) return;
  const tag = line.slice(open, close + 1);
  if (tag.endsWith('/>') || !/^<(?:[\p{ID_Start}_$][\p{ID_Continue}:.$-]*(?:\s[^<>]*)?)?>$/u.test(tag)) return;
  let end = close + 1;
  while (end < line.length && !'<{}\r\n'.includes(line[end])) end++;
  return line.slice(close + 1, end).trim() ? { index: close + 1, end } : undefined;
}

function jsxTextRanges(line: string): ScriptToken[] {
  const ranges: ScriptToken[] = [];
  let open = -1;
  for (let cursor = 0; cursor < line.length; cursor++) {
    if (line[cursor] === '<') open = cursor;
    else if (line[cursor] === '>' && open >= 0) {
      const text = jsxTextAfter(line, open, cursor);
      open = -1;
      if (text) {
        ranges.push(text);
        cursor = text.end - 1;
      }
    }
  }
  return ranges;
}

export function scriptTokens(line: string): ScriptToken[] {
  const tokens: ScriptToken[] = [],
    jsx = jsxTextRanges(line);
  const matcher = new RegExp(TOKEN);
  let cursor = 0,
    text = 0;
  while (cursor < line.length) {
    while (text < jsx.length && jsx[text].index < cursor) text++;
    if (jsx[text]?.index === cursor) {
      tokens.push(jsx[text]);
      cursor = jsx[text++].end;
      continue;
    }
    matcher.lastIndex = cursor;
    const match = matcher.exec(line);
    if (!match || (match.groups?.regexp && !literalMayStart(line, cursor))) {
      cursor++;
      continue;
    }
    const end = cursor + match[0].length;
    tokens.push({ index: cursor, end });
    cursor = end;
  }
  return tokens;
}
