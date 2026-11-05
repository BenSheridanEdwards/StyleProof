/** Indexed transient source positions and bounded template substitution walks for J3. */
import { scriptTokens, type ScriptToken } from './script-join-tokens.js';
import type { SourcePosition, SourceSpan } from './script-reach.js';
export type Part = { start: number; end: number };
export type Literal = { end: number; parts: Part[]; substitutions: (Part & { whole: boolean })[] };
export type ClassSource = {
  text: string;
  tokens: ScriptToken[];
  byStart: Map<number, ScriptToken>;
  lines: number[];
  literals: Map<number, Literal>;
};
export function classSource(text: string, key: string): ClassSource {
  const tokens = scriptTokens(text, key),
    lines = [0];
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) lines.push(match.index + match[0].length);
  return { text, tokens, byStart: new Map(tokens.map((t) => [t.index, t])), lines, literals: new Map() };
}
export function tokenIndex(source: ClassSource, offset: number): number {
  let low = 0,
    high = source.tokens.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (source.tokens[mid].index < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}
function position(source: ClassSource, offset: number): SourcePosition {
  let low = 0,
    high = source.lines.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (source.lines[mid] <= offset) low = mid;
    else high = mid;
  }
  return { line: low + 1, column: offset - source.lines[low] };
}
export const sourceSpan = (source: ClassSource, start: number, end: number): SourceSpan => ({
  start: position(source, start),
  end: position(source, end),
});
export function commentEnd(text: string, cursor: number): number | undefined {
  if (text.startsWith('/*', cursor)) {
    const end = text.indexOf('*/', cursor + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (!text.startsWith('//', cursor)) return;
  const end = text.slice(cursor).search(/[\r\n\u2028\u2029]/);
  return end < 0 ? text.length : cursor + end + 1;
}
function substitutionEnd(source: ClassSource, start: number): number {
  const { text } = source;
  let depth = 1;
  for (let cursor = start; cursor < text.length; cursor++) {
    const token = source.byStart.get(cursor);
    const skip = token ? literalAt(source, token).end : commentEnd(text, cursor);
    if (skip !== undefined) {
      cursor = skip - 1;
      continue;
    }
    if (text[cursor] === '{') depth++;
    if (text[cursor] === '}' && --depth === 0) return cursor;
  }
  return text.length;
}
function staticPart(text: string, start: number, end: number): Part {
  return { start, end: end - (text.slice(start, end).match(/\S+$/)?.[0].length ?? 0) };
}
function afterSubstitution(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && !/[\s`]/.test(text[cursor]) && !text.startsWith('${', cursor)) cursor++;
  return cursor;
}
function templateLiteral(source: ClassSource, start: number): Literal {
  const { text } = source,
    parts: Part[] = [],
    substitutions: Literal['substitutions'] = [];
  let from = start + 1;
  for (let cursor = from; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') {
      cursor++;
      continue;
    }
    if (text[cursor] === '`')
      return { end: cursor + 1, parts: [...parts, { start: from, end: cursor }], substitutions };
    if (!text.startsWith('${', cursor)) continue;
    const end = substitutionEnd(source, cursor + 2);
    const whole =
      (cursor === start + 1 || /\s/.test(text[cursor - 1])) &&
      (text[end + 1] === '`' || /\s/.test(text[end + 1] ?? ''));
    substitutions.push({ start: cursor + 2, end, whole });
    parts.push(staticPart(text, from, cursor));
    from = afterSubstitution(text, end + 1);
    cursor = from - 1;
  }
  return { end: text.length, parts: [], substitutions: [] };
}
export function literalAt(source: ClassSource, token: ScriptToken): Literal {
  const saved = source.literals.get(token.index);
  if (saved) return saved;
  const literal =
    source.text[token.index] === '`'
      ? templateLiteral(source, token.index)
      : { end: token.end, parts: [{ start: token.index + 1, end: token.end - 1 }], substitutions: [] };
  source.literals.set(token.index, literal);
  return literal;
}
export function classWords(source: ClassSource, parts: Part[]): { token: string; range: SourceSpan }[] {
  return parts.flatMap((part) =>
    [...source.text.slice(part.start, part.end).matchAll(/\S+/g)].flatMap((match) =>
      unescapeWord(match[0])
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => ({
          token,
          range: sourceSpan(source, part.start + match.index, part.start + match.index + match[0].length),
        })),
    ),
  );
}
function unescapeWord(word: string): string {
  return word.replace(
    /\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|([\s\S]))/g,
    (_raw, point: string, unicode: string, hex: string, char: string) => {
      const digits = point || unicode || hex;
      if (!digits) return ({ n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' } as Record<string, string>)[char] ?? char;
      const value = parseInt(digits, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : '\uFFFD';
    },
  );
}
