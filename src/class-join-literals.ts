/** J3 lexical class sources. Full source is transient and never enters a report. */
import type { SourcePosition, SourceSpan } from './script-reach.js';
import type { ScriptToken } from './script-join-tokens.js';
import type { ScriptChange } from './script-join.js';
import { classSource, classWords, commentEnd, literalAt, sourceSpan, type ClassSource } from './class-join-source.js';
import { bindingLiteral, svelteDirectives } from './class-join-bindings.js';

export type ClassWord = { token: string; range: SourceSpan };
export type ClassLiteral = {
  range: SourceSpan;
  words: ClassWord[];
  explicit: boolean;
  /** Lexical class-helper candidates can be listed without supplying positive value evidence. */
  classContext?: boolean;
  context?: boolean;
  residual?: string;
};
const helper = /\b(?:clsx|cx|classnames|classNames|cva|twMerge|twJoin|cn)\s*$/;
const attribute = /(?<![\w-])class(?:Name|List)?\s*[:=]\s*$/;
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
  residual?: string;
  cva?: 'call' | 'options' | 'variants' | 'values' | 'excluded';
  bracket?: string;
  classContext?: boolean;
  blocked?: boolean;
  method?: string;
  argument?: number;
};
type Scan = { source: ClassSource; key: string; frames: Frame[]; prefix: string; literals: ClassLiteral[] };
const explicit = (scan: Scan) => {
  const frame = scan.frames.at(-1)!;
  if (frame.blocked) return false;
  if (frame.method) return frame.method === 'add' || (frame.method === 'replace' && frame.argument === 1);
  if (frame.cva) return frame.value || frame.cva === 'call' || frame.cva === 'values';
  return frame.inherited || frame.value;
};

function cvaContext(scan: Scan, char: string): Frame['cva'] {
  if (/\bcva\s*$/.test(scan.prefix)) return 'call';
  const frame = scan.frames.at(-1)!,
    parent = frame.cva;
  if (parent && char === '[' && frame.bracket === '{' && !scan.prefix.trim()) return 'excluded';
  if (parent === 'call') return char === '{' ? 'options' : 'values';
  if (parent === 'options')
    return /(?:\bvariants|['"]variants['"])\s*:\s*$/.test(scan.prefix) ? 'variants' : 'excluded';
  if (parent === 'variants') return 'values';
  return parent;
}

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
  const isClass = !scan.frames.at(-1)!.blocked && (inherited || attribute.test(scan.prefix));
  const cva = scan.frames.at(-1)!.cva;
  const cvaKey = cva && !scan.prefix.trim() && /^\s*:/.test(text.slice(literal.end, literal.end + 128));
  if (cva && (!isClass || cvaKey)) {
    scan.prefix += text.slice(token.index, literal.end);
    return literal.end;
  }
  pushLiteral(scan, token, literal, isClass);
  scan.prefix += ' value ';
  return literal.end;
}
function pushLiteral(scan: Scan, token: ScriptToken, literal: ReturnType<typeof literalAt>, isClass: boolean): void {
  const { source } = scan,
    { text } = source;
  const concatenated = /\+\s*$/.test(scan.prefix) || /^\s*\+/.test(text.slice(literal.end, literal.end + 128));
  const residual = concatenated
    ? 'dynamic class concatenation fragment excluded'
    : literal.substitutions.some((part) => !part.whole)
      ? 'dynamic class template fragment excluded'
      : undefined;
  if (isClass && residual) for (const frame of scan.frames) if (frame.own || frame.value) frame.residual = residual;
  scan.literals.push({
    range: sourceSpan(source, token.index, literal.end),
    words: classWords(source, literal.parts),
    explicit: isClass,
    classContext: isClass || !!scan.frames.at(-1)!.classContext,
    ...(residual ? { residual } : {}),
  });
  addSubstitutionLiterals(scan, literal.substitutions, isClass);
}
function addSubstitutionLiterals(
  scan: Scan,
  substitutions: ReturnType<typeof literalAt>['substitutions'],
  isClass: boolean,
): void {
  for (const part of substitutions) {
    if (!part.whole) continue;
    const nested: Scan = {
      ...scan,
      prefix: '',
      frames: [
        {
          inherited: isClass,
          value: false,
          own: false,
          start: part.start,
          classContext: isClass || !!scan.frames.at(-1)!.classContext,
          blocked: scan.frames.at(-1)!.blocked,
        },
      ],
    };
    scanRange(nested, part.start, part.end);
  }
}
function flushValue(scan: Scan, cursor: number): void {
  const frame = scan.frames.at(-1)!;
  if (frame.valueStart !== undefined && (!frame.measured || frame.residual))
    scan.literals.push({
      range: sourceSpan(scan.source, frame.valueStart, cursor),
      words: [],
      explicit: !frame.blocked,
      context: true,
      ...(frame.residual ? { residual: frame.residual } : {}),
    });
  frame.valueStart = undefined;
  frame.measured = false;
  if (!frame.own) frame.residual = undefined;
}
function closeFrame(scan: Scan, cursor: number): void {
  if (scan.frames.length <= 1) return;
  flushValue(scan, cursor);
  const frame = scan.frames.pop()!;
  if (frame.own && !frame.blocked)
    scan.literals.push({
      range: sourceSpan(scan.source, frame.start, cursor + 1),
      words: [],
      explicit: true,
      context: true,
      ...(frame.residual ? { residual: frame.residual } : {}),
    });
}
function openFrame(char: string, cursor: number, scan: Scan): void {
  const parent = scan.frames.at(-1)!;
  const method = char === '(' ? /\bclassList\s*\.\s*(\w+)\s*$/.exec(scan.prefix)?.[1] : undefined;
  const own = helper.test(scan.prefix) || attribute.test(scan.prefix) || method === 'add' || method === 'replace';
  const call = char === '(' && !own && !method && /[\w$)\]]\s*$/.test(scan.prefix);
  const blocked =
    !!parent.blocked || (!!parent.method && !explicit(scan)) || (call && (!!parent.classContext || explicit(scan)));
  const cva = cvaContext(scan, char);
  if (own) parent.measured = true;
  scan.frames.push({
    inherited: explicit(scan) || own,
    value: false,
    own,
    start: cursor,
    cva,
    bracket: char,
    classContext: !!parent.classContext || explicit(scan) || own || !!method,
    blocked,
    method,
    argument: 0,
  });
  scan.prefix = '';
}
function delimiter(char: string, cursor: number, scan: Scan): void {
  if ('([{'.includes(char)) {
    openFrame(char, cursor, scan);
  } else if (')]}'.includes(char)) {
    closeFrame(scan, cursor);
    scan.prefix = '';
  } else if (',;>'.includes(char)) {
    flushValue(scan, cursor);
    scan.prefix = '';
    scan.frames.at(-1)!.value = false;
    if (char === ',' && scan.frames.at(-1)!.method) scan.frames.at(-1)!.argument!++;
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
    !scan.frames.at(-1)!.cva &&
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
  scanRange(scan, 0, text.length);
  flushValue(scan, text.length);
  return scan.literals.sort(
    (a, b) => comparePosition(a.range.start, b.range.start) || comparePosition(a.range.end, b.range.end),
  );
}
function scanRange(scan: Scan, start: number, end: number): void {
  const { source } = scan,
    { text } = source;
  for (let cursor = start; cursor < end; cursor++) {
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
