/** Punctuation forest over the existing J2 lexemes; no framework parser or execution. */
import { commentEnd, literalAt, type ClassSource, type Literal, type Part } from './class-join-source.js';
export type RoleToken = Part & {
  text: string;
  kind: 'word' | 'literal' | 'group' | 'operator' | 'unknown';
  attribute?: true;
  children?: RoleToken[];
  literal?: Literal;
};
export type RoleTokens = { nodes: RoleToken[]; limit?: number; failed?: true };
export const ROLE_DEPTH = 128;
const OPERATOR =
  /^(?:===|!==|\*\*=|&&=|\|\|=|\?\?=|=>|\?\.|==|!=|<=|>=|&&|\|\||\?\?|\+\+|--|\+=|-=|\*=|\/=|%=|\*\*|<<|>>>?|\.\.\.)/;
function nextToken(source: ClassSource, start: number): RoleToken | undefined {
  const token = source.byStart.get(start);
  if (!token) return;
  const text = source.text.slice(start, token.end);
  if (token.negativeOnly) return { start, end: token.end, text, kind: 'unknown' };
  if ('\'"`'.includes(text[0])) {
    const literal = literalAt(source, token);
    return { start, end: literal.end, text: source.text[start], kind: 'literal', literal };
  }
  return { start, end: token.end, text, kind: /^[\p{ID_Start}_$]/u.test(text) ? 'word' : 'unknown' };
}
/** A tag may start a value; a generic following an identifier cannot. */
function markupStart(source: ClassSource, start: number, previous?: RoleToken): boolean {
  const prefix =
    !previous ||
    ['=', '(', '[', '{', ',', ':', '?', '=>', ';', '>', 'return', '&&', '||', '??'].includes(previous.text);
  return prefix && /^<[\w.-]+\s/.test(source.text.slice(start));
}
type TokenStack = { nodes: RoleToken[]; open: string; start: number }[];
type TokenCursor = { cursor: number; stack: TokenStack; markupDepth?: number; limit?: number; failed?: true };
function bracket(state: TokenCursor, text: string): boolean {
  if ('([{'.includes(text)) {
    if (state.stack.length >= ROLE_DEPTH) state.limit = state.stack[1]?.start ?? state.cursor;
    else state.stack.push({ nodes: [], open: text, start: state.cursor++ });
    return true;
  }
  if (!')]}'.includes(text)) return false;
  const part = state.stack.pop();
  if (!part || !state.stack.length || '([{'.indexOf(part.open) !== ')]}'.indexOf(text)) state.failed = true;
  else
    state.stack
      .at(-1)!
      .nodes.push({ start: part.start, end: ++state.cursor, text: part.open, kind: 'group', children: part.nodes });
  return true;
}
function punctuation(source: ClassSource, state: TokenCursor): void {
  const text = source.text[state.cursor];
  if (
    text === '<' &&
    state.markupDepth === undefined &&
    markupStart(source, state.cursor, state.stack.at(-1)!.nodes.at(-1))
  )
    state.markupDepth = state.stack.length;
  // A top-level comma is generic syntax, never a JSX attribute separator.
  if ((text === '>' || text === ',') && state.markupDepth === state.stack.length) state.markupDepth = undefined;
  if (bracket(state, text)) return;
  const operator = OPERATOR.exec(source.text.slice(state.cursor, state.cursor + 4))?.[0] ?? text;
  state.stack
    .at(-1)!
    .nodes.push({ start: state.cursor, end: state.cursor + operator.length, text: operator, kind: 'operator' });
  state.cursor += operator.length;
}
function tokenStep(source: ClassSource, state: TokenCursor): void {
  const skip = commentEnd(source.text, state.cursor);
  if (skip !== undefined) {
    state.cursor = skip;
    return;
  }
  if (/\s/.test(source.text[state.cursor])) {
    state.cursor++;
    return;
  }
  const token = nextToken(source, state.cursor);
  if (!token) {
    punctuation(source, state);
    return;
  }
  if (state.markupDepth === state.stack.length && /\s/.test(source.text[token.start - 1] ?? '')) token.attribute = true;
  state.stack.at(-1)!.nodes.push(token);
  state.cursor = token.end;
}
export function roleTokens(source: ClassSource, range: Part = { start: 0, end: source.text.length }): RoleTokens {
  const nodes: RoleToken[] = [],
    state: TokenCursor = { cursor: range.start, stack: [{ nodes, open: '', start: range.start }] };
  while (state.cursor < range.end && state.limit === undefined && !state.failed) tokenStep(source, state);
  if (state.limit !== undefined) return { nodes, limit: state.limit };
  return state.failed || state.stack.length !== 1 ? { nodes: [], failed: true } : { nodes };
}
export function splitTokens(nodes: RoleToken[], separator = ','): RoleToken[][] {
  const parts: RoleToken[][] = [[]];
  for (const node of nodes) {
    if (node.text === separator && node.kind === 'operator') parts.push([]);
    else parts.at(-1)!.push(node);
  }
  return parts;
}
export const tokenSpan = (nodes: RoleToken[]): Part => ({ start: nodes[0]?.start ?? 0, end: nodes.at(-1)?.end ?? 0 });
