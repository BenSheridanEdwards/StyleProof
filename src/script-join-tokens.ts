/** Conservative lexical ranges: ambiguous slash expressions remain ordinary code. */
export type ScriptToken = { index: number; end: number; negativeOnly?: true };

const TOKEN =
  /'(?:\\.|[^'\\\r\n\u2028\u2029])*'|"(?:\\.|[^"\\\r\n\u2028\u2029])*"|['"]|(?<regexp>\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[dgimsuvy]*)|0[xXoObB][\dA-Fa-f_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?n?|\.\d[\d_]*(?:[eE][+-]?\d[\d_]*)?|#?[\p{ID_Start}_$][\p{ID_Continue}$]*/uy;
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
  // A TS generic header can resemble an opening tag in JSX-capable input.
  if (/^<[\w$]+(?:\s+extends\b[^]*|\s*,[^]*)>$/.test(tag)) return { index: open, end: close + 1, negativeOnly: true };
  if (tag.endsWith('/>') || !/^<(?:[\p{ID_Start}_$][\p{ID_Continue}:.$-]*(?:\s[^]*)?)?>$/u.test(tag)) return;
  let end = close + 1;
  while (end < line.length && !'<{}\r\n'.includes(line[end])) end++;
  return line.slice(close + 1, end).trim() ? { index: close + 1, end } : undefined;
}

function negativeTail(text: string, index: number): ScriptToken {
  let end = index;
  while (end < text.length && !'\r\n\u2028\u2029'.includes(text[end])) end++;
  return { index, end, negativeOnly: true };
}

function jsxBoundaryTail(text: string, start: number): ScriptToken | undefined {
  const prefix = /^[ \t]*(?=[`'"/])/.exec(text.slice(start));
  if (!prefix) return;
  return negativeTail(text, start + prefix[0].length);
}

function jsxBoundary(text: string, start: number, seen: boolean): { end: number; tokens: ScriptToken[] } | undefined {
  const closing = /^<\/(?:[\p{ID_Start}_$][\p{ID_Continue}:.$-]*)?\s*>/u.exec(text.slice(start));
  if (!closing && !(seen && text[start] === '}')) return;
  const end = closing ? start + closing[0].length : start + 1;
  const tail = jsxBoundaryTail(text, end);
  return { end: tail ? tail.end - 1 : end - 1, tokens: tail ? [tail] : [] };
}

function jsxTextRanges(line: string): ScriptToken[] {
  const ranges: ScriptToken[] = [];
  let seen = false;
  for (let cursor = 0; cursor < line.length; cursor++) {
    const boundary = jsxBoundary(line, cursor, seen);
    if (boundary) {
      ranges.push(...boundary.tokens);
      cursor = boundary.end;
      seen = true;
      continue;
    }
    if (line[cursor] !== '<' || !literalMayStart(line, cursor)) continue;
    if (!/^<(?:[\p{ID_Start}_$][\p{ID_Continue}:.$-]*(?=[\s,/>])|>)/u.test(line.slice(cursor))) continue;
    const close = jsxTagEnd(line, cursor);
    if (close < 0) {
      ranges.push({ index: cursor, end: line.length, negativeOnly: true });
      break;
    }
    const text = jsxTextAfter(line, cursor, close);
    seen = true;
    cursor = text ? text.end - 1 : close;
    if (text) ranges.push(text);
  }
  return ranges;
}

function quotedEnd(text: string, start: number): number {
  if (text[start] === '`') return templateEnd(text, start);
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') cursor++;
    else if (text[cursor] === text[start]) return cursor + 1;
  }
  return text.length;
}

function tagLiteralEnd(text: string, cursor: number, braces: number, matcher: RegExp): number | undefined {
  if ('\'"`'.includes(text[cursor])) return quotedEnd(text, cursor);
  if (!braces) return;
  const comment = commentEnd(text, cursor);
  if (comment !== undefined) return comment;
  if (text[cursor] !== '/') return;
  matcher.lastIndex = cursor;
  const match = matcher.exec(text);
  if (match?.groups?.regexp) return literalMayStart(text, cursor) ? cursor + match[0].length : -1;
}

function jsxTagEnd(text: string, start: number): number {
  let braces = 0;
  const matcher = new RegExp(TOKEN);
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const literal = tagLiteralEnd(text, cursor, braces, matcher);
    if (literal === -1) return -1;
    if (literal !== undefined) {
      cursor = literal - 1;
      continue;
    }
    if (text[cursor] === '{') braces++;
    else if (text[cursor] === '}') braces--;
    else if (text[cursor] === '>' && braces === 0) return cursor;
  }
  return -1;
}

/** Backticks start a value; subsequent template chunks only delimit substitutions. */
function templateChunk(text: string, start: number): { end: number; substitution: boolean } {
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') cursor++;
    else if (text[cursor] === '`') return { end: cursor + 1, substitution: false };
    else if (text[cursor] === '$' && text[cursor + 1] === '{') return { end: cursor + 2, substitution: true };
  }
  return { end: text.length, substitution: false };
}

function commentEnd(text: string, start: number): number | undefined {
  if (text.startsWith('/*', start)) {
    const end = text.indexOf('*/', start + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (!text.startsWith('//', start)) return;
  let end = start + 2;
  while (end < text.length && !'\r\n\u2028\u2029'.includes(text[end])) end++;
  return end;
}

function commentPiece(text: string, start: number, end: number): { end: number; tokens: ScriptToken[] } {
  if (text[start - 1] !== '\\') return { end, tokens: [] };
  // A comment after an escaped slash was reached through an unrecognised regex.
  // It cannot consume the remaining code as positive execution evidence.
  const tail = negativeTail(text, start - 1);
  return { end: tail.end, tokens: [tail] };
}

function templatePiece(
  text: string,
  start: number,
  substitutions: number[],
): { end: number; tokens: ScriptToken[] } | undefined {
  const comment = commentEnd(text, start);
  if (comment !== undefined) return commentPiece(text, start, comment);
  const head = text[start] === '`';
  if (head || (text[start] === '}' && substitutions.at(-1) === 0)) {
    const chunk = templateChunk(text, start);
    if (head && chunk.substitution) substitutions.push(0);
    else if (!head && !chunk.substitution) substitutions.pop();
    return { end: chunk.end, tokens: head ? [{ index: start, end: chunk.end }] : [] };
  }
  if (substitutions.length && '{}'.includes(text[start]))
    substitutions[substitutions.length - 1] += text[start] === '{' ? 1 : -1;
  return;
}

function templateEnd(text: string, start: number): number {
  const substitutions: number[] = [],
    matcher = new RegExp(TOKEN);
  let cursor = start;
  while (cursor < text.length) {
    const piece = templatePiece(text, cursor, substitutions);
    if (piece) {
      cursor = piece.end;
      if (!substitutions.length) return cursor;
      continue;
    }
    matcher.lastIndex = cursor;
    const match = matcher.exec(text);
    cursor += match?.[0].length ?? 1;
  }
  return cursor;
}

function ordinaryToken(text: string, start: number, matcher: RegExp): ScriptToken | undefined {
  matcher.lastIndex = start;
  const match = matcher.exec(text);
  if (!match) return;
  if (match.groups?.regexp && !literalMayStart(text, start)) {
    // Re-lexing a possible regex body must not invent a comment that hides code.
    const candidate = text.slice(start, start + match[0].length + 1);
    return /\/\/|\/\*|\\\//.test(candidate) ? negativeTail(text, start) : undefined;
  }
  return { index: start, end: start + match[0].length };
}

export function scriptTokens(line: string, sourceKey = '', language?: 'ts'): ScriptToken[] {
  const tokens: ScriptToken[] = [],
    jsx = language === 'ts' || /\.(?:ts|mts|cts)$/i.test(sourceKey) ? [] : jsxTextRanges(line);
  const matcher = new RegExp(TOKEN);
  const closingTag = /<\/(?:[\p{ID_Start}_$][\p{ID_Continue}:.$-]*)?\s*>/uy;
  const substitutions: number[] = [];
  let cursor = 0,
    text = 0;
  while (cursor < line.length) {
    while (text < jsx.length && jsx[text].index < cursor) text++;
    if (jsx[text]?.index === cursor) {
      tokens.push(jsx[text]);
      cursor = jsx[text++].end;
      continue;
    }
    const piece = templatePiece(line, cursor, substitutions);
    if (piece) {
      tokens.push(...piece.tokens);
      cursor = piece.end;
      continue;
    }
    // A closing JSX tag is delimiter syntax, not another evaluation of its name.
    // Execution joining still retains any negative anchors inside that delimiter.
    closingTag.lastIndex = cursor;
    if (line[cursor] === '<' && closingTag.test(line)) {
      cursor = closingTag.lastIndex;
      continue;
    }
    const token = ordinaryToken(line, cursor, matcher);
    if (!token) {
      cursor++;
      continue;
    }
    tokens.push(token);
    cursor = token.end;
  }
  return tokens;
}
