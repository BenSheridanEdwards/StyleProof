/** Raw over-approximation: contents in strings, comments and templates are included. */
const YIELD_WORD = /\byield\b/u;
const IDENTIFIER = /#?(?:[\p{ID_Continue}$\\]|\{[\dA-Fa-f]+\})+/uy;
const NUMERIC =
  /(?:0[xXoObB][\dA-Fa-f_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?n?|\.\d[\d_]*(?:[eE][+-]?\d[\d_]*)?)/uy;
const QUOTED = /'(?:\\[^]|[^'\\])*'|"(?:\\[^]|[^"\\])*"/uy;
const BOUND = 512;

type RawScan = {
  text: string;
  trivia: Uint32Array;
  keys: Map<number, boolean>;
  suffixes: Map<number, boolean>;
  identifier: RegExp;
  numeric: RegExp;
  quoted: RegExp;
};

/** Raw gap ends, not lexical exclusion: every star in the original file is still tried. */
function triviaEnds(text: string): Uint32Array {
  const ends = new Uint32Array(text.length + 1);
  ends[text.length] = text.length;
  let nextClosing = -1,
    afterNextClosing = -1,
    nextLine = text.length;
  for (let cursor = text.length - 1; cursor >= 0; cursor--) {
    if ('\r\n\u2028\u2029'.includes(text[cursor])) nextLine = cursor;
    const closing = text[cursor] === '*' && text[cursor + 1] === '/' ? cursor : nextClosing;
    let end = cursor;
    if (/\s/u.test(text[cursor])) end = ends[cursor + 1];
    else if (text.startsWith('/*', cursor) && afterNextClosing >= 0) end = ends[afterNextClosing + 2];
    else if (text.startsWith('//', cursor)) end = ends[nextLine];
    ends[cursor] = end;
    afterNextClosing = nextClosing;
    nextClosing = closing;
  }
  return ends;
}

function boundedClose(text: string, start: number, delimiter: string, accept: (end: number) => boolean): boolean {
  let cursor = start + 1;
  for (let count = 0; count <= BOUND && cursor < text.length; count++) {
    if (text[cursor] === delimiter && accept(cursor + 1)) return true;
    cursor += text.codePointAt(cursor)! > 0xffff ? 2 : 1;
  }
  return false;
}

function afterKey(scan: RawScan, end: number): boolean {
  let start = scan.trivia[end];
  if (scan.text[start] === '?') start = scan.trivia[start + 1];
  const cached = scan.suffixes.get(start);
  if (cached !== undefined) return cached;
  const result =
    scan.text[start] === '(' ||
    (scan.text[start] === '<' && boundedClose(scan.text, start, '>', (next) => scan.text[scan.trivia[next]] === '('));
  scan.suffixes.set(start, result);
  return result;
}

function nameEnd(scan: RawScan, start: number): number {
  const first = scan.text[start] ?? '';
  const pattern = /['"]/.test(first) ? scan.quoted : /[\d.]/.test(first) ? scan.numeric : scan.identifier;
  pattern.lastIndex = start;
  return pattern.exec(scan.text) ? pattern.lastIndex : -1;
}

function methodAt(scan: RawScan, star: number): boolean {
  const start = scan.trivia[star + 1];
  const cached = scan.keys.get(start);
  if (cached !== undefined) return cached;
  const end = scan.text[start] === '[' ? -1 : nameEnd(scan, start);
  const result =
    scan.text[start] === '['
      ? boundedClose(scan.text, start, ']', (next) => afterKey(scan, next))
      : end >= 0 && afterKey(scan, end);
  scan.keys.set(start, result);
  return result;
}

export function sourceContainsGenerator(text: string): boolean {
  if (YIELD_WORD.test(text)) return true;
  if (!text.includes('*')) return false;
  const scan: RawScan = {
    text,
    trivia: triviaEnds(text),
    keys: new Map(),
    suffixes: new Map(),
    identifier: new RegExp(IDENTIFIER),
    numeric: new RegExp(NUMERIC),
    quoted: new RegExp(QUOTED),
  };
  for (const match of text.matchAll(/function/g))
    if (text[scan.trivia[match.index + match[0].length]] === '*') return true;
  for (let star = text.indexOf('*'); star >= 0; star = text.indexOf('*', star + 1))
    if (methodAt(scan, star)) return true;
  return false;
}
