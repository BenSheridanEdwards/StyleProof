/** J3 candidates are lexical; only approved syntax roles supply positive evidence. */
import type { SourcePosition, SourceSpan } from './script-reach.js';
import type { ScriptChange } from './script-join.js';
import {
  classSource,
  classWords,
  literalAt,
  sourceSpan,
  tokenIndex,
  type ClassSource,
  type Literal,
} from './class-join-source.js';
import { classRoles, scriptParts } from './class-join-context.js';
import { bindingLiteral, svelteDirectives } from './class-join-bindings.js';
import { containingPart, inMarkupTag, markupExpressions, mergeParts } from './class-join-markup.js';
import type { ClassRoles, RoleState } from './class-join-role-types.js';
export type ClassWord = { token: string; range: SourceSpan };
export type ClassLiteral = {
  range: SourceSpan;
  words: ClassWord[];
  explicit: boolean;
  classContext?: boolean;
  context?: boolean;
  residual?: string;
  /** Positive role and local slot, used only for replacement-hunk alignment. */
  role?: string;
  /** A truncated reader must name its gap even outside a positive class source. */
  extractionGap?: true;
};
const comparePosition = (a: SourcePosition, b: SourcePosition) => a.line - b.line || a.column - b.column;
export const spansOverlap = (a: SourceSpan, b: SourceSpan): boolean =>
  comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
type RawLiteral = { start: number; literal: Literal };
function sourceLiterals(source: ClassSource): RawLiteral[] {
  const found: RawLiteral[] = [],
    pending = [{ start: 0, end: source.text.length }];
  while (pending.length) {
    const part = pending.pop()!;
    let cursor = part.start;
    for (let i = tokenIndex(source, part.start); i < source.tokens.length && source.tokens[i].index < part.end; i++) {
      const token = source.tokens[i];
      if (token.index < cursor || token.negativeOnly || !'\'"`'.includes(source.text[token.index])) continue;
      const literal = literalAt(source, token);
      cursor = literal.end;
      found.push({ start: token.index, literal });
      if (!literal.limit) pending.push(...literal.substitutions.filter((p) => p.whole));
    }
  }
  return found;
}
type Reader = {
  source: ClassSource;
  key: string;
  roles: ClassRoles;
  scripts: ReturnType<typeof scriptParts>;
  markupParts: { start: number; end: number }[];
};
function candidate(source: ClassSource, entry: RawLiteral, state?: RoleState): ClassLiteral {
  const { start, literal } = entry,
    end = state?.end ?? literal.end;
  const range = sourceSpan(source, start, end),
    rawWords = classWords(source, literal.parts);
  const cooked = state?.cooked?.split(/\s+/).filter(Boolean);
  const words = cooked
    ? cooked.map((token, i) => ({ token, range: rawWords.length === cooked.length ? rawWords[i].range : range }))
    : rawWords;
  const escaped = !!state?.role && state.escapedTemplate;
  return {
    range,
    words,
    explicit: !!state?.role && !escaped,
    ...(state?.role ? { role: state.role } : {}),
    classContext: !!state?.context,
    ...(escaped
      ? { extractionGap: true as const, residual: 'escaped dynamic template class text unmeasured' }
      : literal.substitutions.some((p) => !p.whole)
        ? { residual: 'dynamic class template fragment excluded' }
        : {}),
  };
}
function qualify(reader: Reader, entry: RawLiteral): ClassLiteral[] {
  const { source, key, roles, scripts, markupParts } = reader,
    { start, literal } = entry;
  if (literal.limit)
    return [
      {
        range: sourceSpan(source, start, source.text.length),
        words: [],
        explicit: false,
        context: true,
        extractionGap: true,
        residual: 'template nesting depth limit (128) exceeded',
      },
    ];
  if (containingPart(markupParts, start)) return [];
  const binding =
    scripts !== undefined && !containingPart(scripts, start)
      ? bindingLiteral(source, start, literal.end, key, readExpression)
      : undefined;
  if (binding) return binding;
  const state = roles.states.get(start);
  return state?.excluded ? [] : [candidate(source, entry, state)];
}
function readLiterals(source: ClassSource, key: string, expression = false): ClassLiteral[] {
  const raw = sourceLiterals(source);
  const roles: ClassRoles = raw.some((r) => r.literal.limit)
    ? { states: new Map(), contexts: [] }
    : classRoles(source, key, expression);
  const scripts = scriptParts(source, key);
  const excluded = scripts ? mergeParts([...scripts, ...raw.map((r) => ({ start: r.start, end: r.literal.end }))]) : [];
  const markup = scripts ? markupExpressions(source, key, excluded, readExpression) : { literals: [], parts: [] };
  const literals: ClassLiteral[] = [
    ...markup.literals,
    ...svelteDirectives(source, key).filter((l) => {
      const offset = source.lines[l.range.start.line - 1] + l.range.start.column;
      return !containingPart(excluded, offset) && inMarkupTag(source, offset);
    }),
  ];
  const reader: Reader = { source, key, roles, scripts, markupParts: markup.parts };
  literals.push(...raw.flatMap((entry) => qualify(reader, entry)));
  appendRoles(literals, source, roles);
  return literals.sort(
    (a, b) => comparePosition(a.range.start, b.range.start) || comparePosition(a.range.end, b.range.end),
  );
}
function appendRoles(literals: ClassLiteral[], source: ClassSource, roles: ClassRoles): void {
  for (const [start, state] of roles.states)
    if (state.bareEnd !== undefined && !state.excluded && state.context)
      literals.push({
        range: sourceSpan(source, start, state.bareEnd),
        words: classWords(source, [{ start, end: state.bareEnd }]),
        explicit: !!state.role,
        classContext: true,
        ...(state.role ? { role: state.role } : {}),
      });
  for (const context of roles.contexts)
    literals.push({
      range: sourceSpan(source, context.start, context.end),
      words: [],
      explicit: !context.extractionGap,
      context: true,
      ...(context.residual ? { residual: context.residual } : {}),
      ...(context.extractionGap ? { extractionGap: true } : {}),
    });
  if ('failed' in roles && roles.failed)
    literals.push({
      range: sourceSpan(source, 0, source.text.length),
      words: [],
      explicit: false,
      context: true,
      extractionGap: true,
      residual: 'class role syntax unreadable; positive values unmeasured',
    });
}
export function classLiterals(text: string, sourceKey: string): ClassLiteral[] {
  return readLiterals(classSource(text, sourceKey), sourceKey);
}
function readExpression(source: ClassSource, start: number, end: number): ClassLiteral[] {
  const local = classSource(source.text.slice(start, end), 'binding.ts');
  const translate = (range: SourceSpan) =>
    sourceSpan(
      source,
      start + local.lines[range.start.line - 1] + range.start.column,
      start + local.lines[range.end.line - 1] + range.end.column,
    );
  return readLiterals(local, 'binding.ts', true).map((literal) => ({
    ...literal,
    range: translate(literal.range),
    words: literal.words.map((word) => ({ ...word, range: translate(word.range) })),
  }));
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
