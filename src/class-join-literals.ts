/** J3 lexical class sources. Full source is transient and never enters a report. */
import { scriptTokens, type ScriptToken } from './script-join-tokens.js';
import type { SourcePosition, SourceSpan } from './script-reach.js';
import type { ScriptChange } from './script-join.js';

export type ClassWord = { token: string; range: SourceSpan };
export type ClassLiteral = { range: SourceSpan; words: ClassWord[]; explicit: boolean };
type Part = { start: number; end: number };
type Literal = { end: number; parts: Part[] };
const helper = /(?:\b(?:clsx|cx|classnames|classNames|cva|twMerge|twJoin|cn)|\bclassList\s*\.\s*\w+)\s*$/;
const attribute = /\bclass(?:Name)?\s*[:=]\s*$/;

function commentEnd(text: string, cursor: number): number | undefined {
  if (text.startsWith('/*', cursor)) {
    const end = text.indexOf('*/', cursor + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (!text.startsWith('//', cursor)) return;
  const end = text.slice(cursor).search(/[\r\n\u2028\u2029]/);
  return end < 0 ? text.length : cursor + end + 1;
}

function substitutionEnd(text: string, start: number, tokens: Map<number, ScriptToken>): number {
  let depth = 1;
  for (let cursor = start; cursor < text.length; cursor++) {
    const token = tokens.get(cursor);
    const skip = token ? literalAt(text, token, tokens).end : commentEnd(text, cursor);
    if (skip !== undefined) {
      cursor = skip - 1;
      continue;
    }
    if (text[cursor] === '{') depth++;
    if (text[cursor] === '}' && --depth === 0) return cursor;
  }
  return text.length;
}

function staticPart(text: string, start: number, end: number, beforeSubstitution: boolean): Part {
  const content = text.slice(start, end);
  return { start, end: beforeSubstitution ? end - (content.match(/\S+$/)?.[0].length ?? 0) : end };
}

function afterSubstitution(text: string, start: number): number {
  const word = /^[^\s`]+/.exec(text.slice(start));
  return start + (word?.[0].length ?? 0);
}

function templateLiteral(text: string, start: number, tokens: Map<number, ScriptToken>): Literal {
  const parts: Part[] = [];
  let from = start + 1;
  for (let cursor = from; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') {
      cursor++;
      continue;
    }
    if (text[cursor] === '`') return { end: cursor + 1, parts: [...parts, staticPart(text, from, cursor, false)] };
    if (!text.startsWith('${', cursor)) continue;
    parts.push(staticPart(text, from, cursor, true));
    from = afterSubstitution(text, substitutionEnd(text, cursor + 2, tokens) + 1);
    cursor = from - 1;
  }
  return { end: text.length, parts: [] };
}

function literalAt(text: string, token: ScriptToken, tokens: Map<number, ScriptToken>): Literal {
  if (text[token.index] === '`') return templateLiteral(text, token.index, tokens);
  return { end: token.end, parts: [{ start: token.index + 1, end: token.end - 1 }] };
}

function position(text: string, offset: number): SourcePosition {
  const lines = text.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/);
  return { line: lines.length, column: lines.at(-1)!.length };
}
const span = (text: string, start: number, end: number): SourceSpan => ({
  start: position(text, start),
  end: position(text, end),
});
const comparePosition = (a: SourcePosition, b: SourcePosition) => a.line - b.line || a.column - b.column;
export const spansOverlap = (a: SourceSpan, b: SourceSpan): boolean =>
  comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;

function unescapeWord(word: string): string {
  return word.replace(
    /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([\s\S]))/gi,
    (_raw, point: string, unicode: string, hex: string, char: string) => {
      const digits = point || unicode || hex;
      if (!digits) return ({ n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' } as Record<string, string>)[char] ?? char;
      const value = parseInt(digits, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : '\uFFFD';
    },
  );
}

function wordsOf(text: string, parts: Part[]): ClassWord[] {
  return parts.flatMap((part) =>
    [...text.slice(part.start, part.end).matchAll(/\S+/g)].flatMap((match) =>
      unescapeWord(match[0])
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => ({
          token,
          range: span(text, part.start + match.index, part.start + match.index + match[0].length),
        })),
    ),
  );
}

type Scan = { contexts: boolean[]; values: boolean[]; prefix: string; literals: ClassLiteral[] };
function addLiteral(text: string, token: ScriptToken, tokens: Map<number, ScriptToken>, scan: Scan): number {
  const literal = literalAt(text, token, tokens);
  if (text[literal.end - 1] !== text[token.index]) return literal.end;
  const explicit = scan.contexts.some(Boolean) || scan.values.some(Boolean) || attribute.test(scan.prefix);
  scan.literals.push({ range: span(text, token.index, literal.end), words: wordsOf(text, literal.parts), explicit });
  if (text[token.index] === '`') addSubstitutionLiterals(text, token.index, literal.end, tokens, scan, explicit);
  scan.prefix += ' value ';
  return literal.end;
}

function addSubstitutionLiterals(
  text: string,
  start: number,
  end: number,
  tokens: Map<number, ScriptToken>,
  scan: Scan,
  explicit: boolean,
): void {
  for (const token of tokens.values()) {
    if (token.index <= start || token.end >= end || !'\'"'.includes(text[token.index])) continue;
    scan.literals.push({
      range: span(text, token.index, token.end),
      words: wordsOf(text, [{ start: token.index + 1, end: token.end - 1 }]),
      explicit,
    });
  }
}

function delimiter(char: string, scan: Scan): void {
  if ('([{'.includes(char)) {
    scan.contexts.push(
      scan.contexts.some(Boolean) ||
        scan.values.some(Boolean) ||
        helper.test(scan.prefix) ||
        attribute.test(scan.prefix),
    );
    scan.values.push(false);
    scan.prefix = '';
  } else if (')]}'.includes(char)) {
    if (scan.contexts.length > 1) {
      scan.contexts.pop();
      scan.values.pop();
    }
    scan.prefix = '';
  } else if (',;>'.includes(char)) {
    scan.prefix = '';
    scan.values[scan.values.length - 1] = false;
  } else {
    if ((char === ':' || char === '=') && /^[\s\w.$-]+$/.test(scan.prefix))
      scan.values[scan.values.length - 1] = attribute.test(scan.prefix + char);
    scan.prefix = (scan.prefix + char).slice(-256);
  }
}

/** The existing J2 lexer supplies literal starts; its execution semantics stay unchanged. */
export function classLiterals(text: string, sourceKey: string): ClassLiteral[] {
  const tokens = new Map(scriptTokens(text, sourceKey).map((token) => [token.index, token]));
  const scan: Scan = { contexts: [false], values: [false], prefix: '', literals: [] };
  for (let cursor = 0; cursor < text.length; cursor++) {
    const comment = commentEnd(text, cursor);
    if (comment !== undefined) {
      cursor = comment - 1;
      scan.prefix += ' ';
      continue;
    }
    const token = tokens.get(cursor);
    if (!token) {
      delimiter(text[cursor], scan);
      continue;
    }
    if (!token.negativeOnly && '\'"`'.includes(text[cursor])) cursor = addLiteral(text, token, tokens, scan) - 1;
    else {
      scan.prefix += text.slice(cursor, token.end);
      cursor = token.end - 1;
    }
  }
  return scan.literals;
}

export function literalsInChange(change: ScriptChange, literals: ClassLiteral[]): ClassLiteral[] {
  return literals.filter(({ range }) => spansOverlap(range, change.range));
}
