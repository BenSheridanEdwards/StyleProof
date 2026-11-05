/** J3 lexical class sources. Full source is transient and never enters a report. */
import type { SourcePosition, SourceSpan } from './script-reach.js';
import type { ScriptToken } from './script-join-tokens.js';
import type { ScriptChange } from './script-join.js';
import {
  classSource,
  classWords,
  commentEnd,
  literalAt,
  sourceSpan,
  tokenIndex,
  type ClassSource,
} from './class-join-source.js';
import { bindingLiteral, svelteDirectives } from './class-join-bindings.js';

export type ClassWord = { token: string; range: SourceSpan };
export type ClassLiteral = {
  range: SourceSpan;
  words: ClassWord[];
  explicit: boolean;
  context?: boolean;
  residual?: string;
};
const helper = /(?:\b(?:clsx|cx|classnames|classNames|cva|twMerge|twJoin|cn)|\bclassList\s*\.\s*\w+)\s*$/;
const attribute = /\bclass(?:Name)?\s*[:=]\s*$/;
const comparePosition = (a: SourcePosition, b: SourcePosition) => a.line - b.line || a.column - b.column;
export const spansOverlap = (a: SourceSpan, b: SourceSpan): boolean =>
  comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;

type Frame = {
  inherited: boolean;
  value: boolean;
  start: number;
  own: boolean;
  valueStart?: number;
  measured?: boolean;
};
type Scan = { source: ClassSource; key: string; frames: Frame[]; prefix: string; literals: ClassLiteral[] };
const explicit = (scan: Scan) => scan.frames.some((frame) => frame.inherited || frame.value);

function addLiteral(scan: Scan, token: ScriptToken, inherited = explicit(scan)): number {
  const { source } = scan,
    { text } = source;
  const literal = literalAt(source, token);
  if (inherited) scan.frames.at(-1)!.measured = true;
  if (text[literal.end - 1] !== text[token.index]) return literal.end;
  const binding = bindingLiteral(source, token.index, literal.end, scan.key);
  if (binding) {
    scan.literals.push(...binding);
    return literal.end;
  }
  const isClass = inherited || attribute.test(scan.prefix);
  scan.literals.push({
    range: sourceSpan(source, token.index, literal.end),
    words: classWords(source, literal.parts),
    explicit: isClass,
    ...(literal.substitutions.some((part) => !part.whole)
      ? { residual: 'dynamic class template fragment excluded' }
      : {}),
  });
  addSubstitutionLiterals(scan, literal.substitutions, isClass);
  scan.prefix += ' value ';
  return literal.end;
}
function addSubstitutionLiterals(
  scan: Scan,
  substitutions: ReturnType<typeof literalAt>['substitutions'],
  isClass: boolean,
): void {
  for (const part of substitutions) {
    if (!part.whole) continue;
    let index = tokenIndex(scan.source, part.start);
    while (index < scan.source.tokens.length && scan.source.tokens[index].index < part.end) {
      const token = scan.source.tokens[index];
      if (!token.negativeOnly && '\'"`'.includes(scan.source.text[token.index])) {
        const end = addLiteral(scan, token, isClass);
        index = tokenIndex(scan.source, end);
      } else index++;
    }
  }
}
function flushValue(scan: Scan, cursor: number): void {
  const frame = scan.frames.at(-1)!;
  if (frame.valueStart !== undefined && !frame.measured)
    scan.literals.push({
      range: sourceSpan(scan.source, frame.valueStart, cursor),
      words: [],
      explicit: true,
      context: true,
    });
  frame.valueStart = undefined;
  frame.measured = false;
}
function closeFrame(scan: Scan, cursor: number): void {
  if (scan.frames.length <= 1) return;
  flushValue(scan, cursor);
  const frame = scan.frames.pop()!;
  if (frame.own)
    scan.literals.push({
      range: sourceSpan(scan.source, frame.start, cursor + 1),
      words: [],
      explicit: true,
      context: true,
    });
}
function delimiter(char: string, cursor: number, scan: Scan): void {
  if ('([{'.includes(char)) {
    const own = helper.test(scan.prefix) || attribute.test(scan.prefix);
    if (own) scan.frames.at(-1)!.measured = true;
    scan.frames.push({ inherited: explicit(scan) || own, value: false, own, start: cursor });
    scan.prefix = '';
  } else if (')]}'.includes(char)) {
    closeFrame(scan, cursor);
    scan.prefix = '';
  } else if (',;>'.includes(char)) {
    flushValue(scan, cursor);
    scan.prefix = '';
    scan.frames.at(-1)!.value = false;
  } else {
    if ((char === ':' || char === '=') && /^[\s\w.$-]+$/.test(scan.prefix)) {
      flushValue(scan, cursor);
      const frame = scan.frames.at(-1)!;
      frame.value = attribute.test(scan.prefix + char);
      if (frame.value) frame.valueStart = cursor + 1;
    }
    scan.prefix = (scan.prefix + char).slice(-256);
  }
}
function ordinaryToken(scan: Scan, token: ScriptToken): void {
  const raw = scan.source.text.slice(token.index, token.end);
  if (
    explicit(scan) &&
    !scan.prefix.trim() &&
    /^[\w$-]+$/.test(raw) &&
    /^\s*:/.test(scan.source.text.slice(token.end, token.end + 128))
  )
    scan.literals.push({
      range: sourceSpan(scan.source, token.index, token.end),
      words: classWords(scan.source, [{ start: token.index, end: token.end }]),
      explicit: true,
    });
  scan.prefix += raw;
}
/** Literal positions and template-token walks are indexed once per blob. */
export function classLiterals(text: string, sourceKey: string): ClassLiteral[] {
  const source = classSource(text, sourceKey);
  const scan: Scan = {
    source,
    key: sourceKey,
    frames: [{ inherited: false, value: false, own: false, start: 0 }],
    prefix: '',
    literals: svelteDirectives(source, sourceKey),
  };
  for (let cursor = 0; cursor < text.length; cursor++) {
    const comment = commentEnd(text, cursor);
    if (comment !== undefined) {
      cursor = comment - 1;
      scan.prefix += ' ';
      continue;
    }
    const token = source.byStart.get(cursor);
    if (!token) {
      delimiter(text[cursor], cursor, scan);
      continue;
    }
    if (!token.negativeOnly && '\'"`'.includes(text[cursor])) cursor = addLiteral(scan, token) - 1;
    else {
      ordinaryToken(scan, token);
      cursor = token.end - 1;
    }
  }
  flushValue(scan, text.length);
  return scan.literals.sort(
    (a, b) => comparePosition(a.range.start, b.range.start) || comparePosition(a.range.end, b.range.end),
  );
}

/** Binary lookup through monotonic prefix ends avoids a full literal scan per changed line. */
export function indexClassLiterals(literals: ClassLiteral[]): { literals: ClassLiteral[]; ends: SourcePosition[] } {
  const ends: SourcePosition[] = [];
  for (const literal of literals) {
    const previous = ends.at(-1);
    ends.push(previous && comparePosition(previous, literal.range.end) > 0 ? previous : literal.range.end);
  }
  return { literals, ends };
}
export function literalsInChange(
  change: Pick<ScriptChange, 'range'>,
  index: ReturnType<typeof indexClassLiterals>,
): ClassLiteral[] {
  let low = 0,
    high = index.ends.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (comparePosition(index.ends[mid], change.range.start) <= 0) low = mid + 1;
    else high = mid;
  }
  const found: ClassLiteral[] = [];
  while (low < index.literals.length && comparePosition(index.literals[low].range.start, change.range.end) < 0) {
    const literal = index.literals[low++];
    if (spansOverlap(literal.range, change.range)) found.push(literal);
  }
  return found;
}
