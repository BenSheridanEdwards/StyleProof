/** J3: changed class-token occurrences × paired class-list deltas. Warn-only. */
import type { StyleMap } from './capture.js';
import { compareScriptRanges, compareSourceKeys, type ScriptChange, type ScriptUnit } from './script-join.js';
import type { SourceSpan } from './script-reach.js';
import { classLiterals, literalsInChange, type ClassLiteral, spansOverlap } from './class-join-literals.js';
import { correspondBeforeMap } from './path-correspondence.js';
import { isUnder } from './capture/shared.js';

export type ClassUnit = {
  sourceKey: string;
  side: 'base' | 'head';
  range: SourceSpan;
  token: string;
  status: 'reached' | 'never-rendered' | 'unknown' | 'unmeasured';
  why: string;
  level: 'warn';
  /** Future proof hook. No capture records per-occurrence render provenance today. */
  provenance?: { kind: 'source-mapped-render'; surface: string; elementPath: string; range: SourceSpan };
};
export type ClassJoinGap = {
  paths?: string[];
  pathCount?: number;
  join: 'J3';
  status: 'unmeasured';
  kind: 'class-list';
  side?: 'base' | 'head';
  reason: string;
  remedy: string;
};
export type ClassMapPair = { base: StyleMap; head: StyleMap };
export type ClassJoinResult = { units: ClassUnit[]; gaps: ClassJoinGap[] };
export const classJoinGap = (reason: string, side?: 'base' | 'head'): ClassJoinGap => ({
  join: 'J3',
  status: 'unmeasured',
  kind: 'class-list',
  ...(side ? { side } : {}),
  reason,
  remedy:
    'capture both revisions with captureReach and retain paired maps, served CSS class vocabulary and changed source ranges',
});

/** Read selector class identifiers, excluding quoted attribute values and at-rule strings. */
export function classVocabulary(keys: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const key of keys) {
    const selector = key
      .split(' > ')
      .filter((part) => !part.startsWith('@'))
      .join(' > ');
    const clean = selector.replace(/\/\*[^]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\]]*\]/g, '');
    for (const match of clean.matchAll(/\.((?:\\(?:[\da-f]{1,6}\s?|[^\r\n\f])|[\w\u0080-\uFFFF-])+)/gi)) {
      names.add(
        match[1].replace(/\\([\da-f]{1,6})\s?|\\(.)/gi, (_all, hex: string, char: string) =>
          hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char,
        ),
      );
    }
  }
  return names;
}

function vocabularyGaps(maps: readonly StyleMap[], side: 'base' | 'head'): ClassJoinGap[] {
  const reasons = new Set<string>();
  if (!maps.length) reasons.add(`missing ${side} captures; class-list delta unavailable`);
  for (const map of maps) {
    const ledger = map.reach;
    if (!ledger || ledger.version !== 2 || ledger.scope !== 'compared')
      reasons.add(`missing ${side} served-rule ledger; class vocabulary unavailable`);
    else if (ledger.unknown || ledger.unreadable)
      reasons.add(
        `${side} served-rule ledger incomplete; class vocabulary unavailable${ledger.unknown ? `: ${ledger.unknown}` : ''}`,
      );
    else if (!classVocabulary(ledger.rules.map((rule) => rule.key)).size)
      reasons.add(`missing ${side} served CSS class vocabulary`);
  }
  return [...reasons].sort(compareSourceKeys).map((reason) => classJoinGap(reason, side));
}

const classes = (cls: string) => new Set(cls.split(/\s+/).filter(Boolean));
type Deltas = Record<'base' | 'head', Set<string>>;
function pairDeltas(pair: ClassMapPair, deltas: Deltas): void {
  const base = correspondBeforeMap(pair.base, pair.head),
    head = pair.head;
  const volatile = [...(base.volatile ?? []), ...(head.volatile ?? [])];
  const paired = Object.entries(head.elements).filter(
    ([path, now]) => base.elements[path]?.tag === now.tag && !isUnder(path, volatile),
  );
  for (const [path, now] of paired) {
    const before = classes(base.elements[path].cls ?? ''),
      after = classes(now.cls ?? '');
    for (const token of before) if (!after.has(token)) deltas.base.add(token);
    for (const token of after) if (!before.has(token)) deltas.head.add(token);
  }
}

type JoinContext = { vocabulary: Set<string>; deltas: Deltas; unmeasured: boolean; unchanged: Set<string> };
function classUnit(change: ScriptChange, literal: ClassLiteral, token: string, context: JoinContext): ClassUnit {
  const unmeasured = context.unmeasured || !!change.unmeasuredReason;
  const moved = context.deltas[change.side].has(token);
  return {
    sourceKey: change.sourceKey,
    side: change.side,
    range: literal.range,
    token,
    status: unmeasured ? 'unmeasured' : moved ? 'unknown' : 'never-rendered',
    why: unmeasured
      ? 'class-list delta or source evidence unavailable; see J3 run-level gaps'
      : moved
        ? 'class token; delta not tied to this occurrence'
        : 'class token never landed on a captured element',
    level: 'warn',
  };
}

function unitsForChange(change: ScriptChange, literals: ClassLiteral[], context: JoinContext): ClassUnit[] {
  const sources = literalsInChange(change, literals).filter(
    (literal) => literal.explicit || literal.words.every((word) => context.vocabulary.has(word.token)),
  );
  return sources.flatMap((literal) => {
    const words = literal.words.filter(
      (word) =>
        context.vocabulary.has(word.token) &&
        !context.unchanged.has(JSON.stringify(word)) &&
        spansOverlap(word.range, change.classRange ?? change.range),
    );
    return [...new Set(words.map((word) => word.token))].map((token) => classUnit(change, literal, token, context));
  });
}

/** Pairing is explicit: map array positions or token names never establish identity. */
export function classifyClassReach(
  base: readonly StyleMap[],
  head: readonly StyleMap[],
  changes: readonly ScriptChange[],
  pairs: readonly ClassMapPair[] = [],
): ClassJoinResult {
  const gaps = [...vocabularyGaps(base, 'base'), ...vocabularyGaps(head, 'head')];
  for (const reason of [
    ...new Set(changes.flatMap((change) => (change.unmeasuredReason ? [change.unmeasuredReason] : []))),
  ].sort(compareSourceKeys))
    gaps.push(classJoinGap(reason));
  if (!pairs.length) gaps.push(classJoinGap('no paired captures; class-list delta unavailable'));
  const vocabulary = classVocabulary(
    [...base, ...head].flatMap((map) => map.reach?.rules.map((rule) => rule.key) ?? []),
  );
  const deltas: Deltas = { base: new Set(), head: new Set() };
  for (const pair of pairs) pairDeltas(pair, deltas);
  const cache = new Map<string, ClassLiteral[]>(),
    units = new Map<string, ClassUnit>();
  const unchanged = new Map<string, Set<string>>();
  const context: JoinContext = { vocabulary, deltas, unmeasured: gaps.length > 0, unchanged: new Set() };
  for (const change of changes) {
    const source = change.classSource ?? '\n'.repeat(change.range.start.line - 1) + change.text;
    const key = `${change.sourceKey}\u0000${change.side}\u0000${change.contentHash}`;
    if (!cache.has(key)) cache.set(key, classLiterals(source, change.sourceKey));
    const otherKey = `${change.sourceKey}\u0000${change.side}\u0000opposite`;
    if (!cache.has(otherKey)) cache.set(otherKey, classLiterals(change.classOtherSource ?? '', change.sourceKey));
    if (!unchanged.has(otherKey))
      unchanged.set(
        otherKey,
        new Set(cache.get(otherKey)!.flatMap((literal) => literal.words.map((word) => JSON.stringify(word)))),
      );
    context.unchanged = unchanged.get(otherKey)!;
    for (const unit of unitsForChange(change, cache.get(key)!, context))
      units.set(JSON.stringify([unit.sourceKey, unit.side, unit.range, unit.token]), unit);
  }
  return {
    units: [...units.values()].sort((a, b) => compareScriptRanges(a, b) || compareSourceKeys(a.token, b.token)),
    gaps,
  };
}

/** Negative evidence can lower J2; neither execution nor an unresolved delta supplies rendering proof. */
export function combineClassReach(scripts: readonly ScriptUnit[], classes: readonly ClassUnit[]): ScriptUnit[] {
  return scripts.map((unit) => {
    const negative = classes.some(
      (entry) =>
        entry.status === 'never-rendered' &&
        entry.sourceKey === unit.sourceKey &&
        entry.side === unit.side &&
        spansOverlap(entry.range, unit.range),
    );
    return negative && unit.status !== 'never-rendered'
      ? { ...unit, status: 'never-rendered', why: `${unit.why}; J3: class token never landed on a captured element` }
      : unit;
  });
}
