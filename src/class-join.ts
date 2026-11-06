import { selectorClasses } from './class-join-selectors.js';
/** J3: changed class-token occurrences × paired class-list deltas. Warn-only. */
import type { StyleMap } from './capture.js';
import { compareScriptRanges, compareSourceKeys, type ScriptChange, type ScriptUnit } from './script-join.js';
import type { SourceSpan } from './script-reach.js';
import { classLiterals, literalsInChange, type ClassLiteral, indexClassLiterals } from './class-join-literals.js';
import { correspondBeforeMap } from './path-correspondence.js';
import { isUnder } from './capture/shared.js';
import { scopedRangeLookup } from './class-join-index.js';
import { unchangedLiterals, unchangedWords } from './class-join-alignment.js';
import { unresolvedClassGaps } from './class-join-gaps.js';

export type ClassUnit = {
  sourceKey: string;
  side: 'base' | 'head';
  range: SourceSpan;
  token: string;
  /** Only explicit class contexts may supply negative evidence to J2. Missing on legacy units. */
  explicit?: boolean;
  /** Token-name movement only; never occurrence provenance. */
  delta?: 'gained' | 'lost';
  status: 'reached' | 'never-rendered' | 'unknown' | 'unmeasured';
  why: string;
  level: 'warn';
  /** Future proof hook. No capture records per-occurrence render provenance today. */
  provenance?: { kind: 'source-mapped-render'; surface: string; elementPath: string; range: SourceSpan };
};
export type ClassJoinGap = {
  range?: SourceSpan;
  /** Unresolved expressions are summarized once per source file and side. */
  occurrenceCount?: number;
  /** First ten ranges in source order; detail remains subject to the report budget. */
  sampleRanges?: SourceSpan[];
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
export const classJoinGap = (reason: string, side?: 'base' | 'head', sourceKey?: string): ClassJoinGap => ({
  join: 'J3',
  status: 'unmeasured',
  kind: 'class-list',
  ...(side ? { side } : {}),
  ...(sourceKey ? { paths: [sourceKey] } : {}),
  reason,
  remedy:
    'capture both revisions with captureReach and retain paired maps, served CSS class vocabulary and changed source ranges',
});

export function classVocabulary(keys: readonly string[]): Set<string> {
  return new Set(
    keys.flatMap((key) =>
      selectorClasses(
        key
          .split(' > ')
          .filter((part) => !part.startsWith('@'))
          .join(' > '),
      ),
    ),
  );
}

function vocabularyGaps(maps: readonly StyleMap[], side: 'base' | 'head'): ClassJoinGap[] {
  const reasons = new Set<string>();
  if (!maps.length) reasons.add(`missing ${side} captures; class-list delta unavailable`);
  for (const map of maps) {
    const ledger = map.reach;
    if (!map.elements) reasons.add(`missing ${side} element class lists`);
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
function elementDeltas(before: Set<string>, after: Set<string>, deltas: Deltas): void {
  for (const token of before) if (!after.has(token)) deltas.base.add(token);
  for (const token of after) if (!before.has(token)) deltas.head.add(token);
}
function pairDeltas(pair: ClassMapPair, deltas: Deltas): void {
  const base = correspondBeforeMap(pair.base, pair.head),
    head = pair.head;
  const volatile = [...(base.volatile ?? []), ...(head.volatile ?? [])];
  const paths = new Set([...Object.keys(base.elements), ...Object.keys(head.elements)]);
  for (const path of paths) {
    if (isUnder(path, volatile)) continue;
    const was = base.elements[path],
      now = head.elements[path];
    const before = classes(was?.cls ?? ''),
      after = classes(now?.cls ?? '');
    if (was && now && was.tag !== now.tag) {
      elementDeltas(before, new Set(), deltas);
      elementDeltas(new Set(), after, deltas);
    } else elementDeltas(before, after, deltas);
  }
}
function presentTokens(maps: readonly StyleMap[]): Set<string> {
  return new Set(
    maps.flatMap((map) => Object.values(map.elements ?? {}).flatMap((element) => [...classes(element.cls ?? '')])),
  );
}
type LiteralIndex = ReturnType<typeof indexClassLiterals>;
type JoinContext = {
  vocabulary: Set<string>;
  deltas: Deltas;
  present: Deltas;
  complete: Record<'base' | 'head', boolean>;
  gap: ReturnType<typeof scopedRangeLookup>;
};
function presenceComplete(maps: readonly StyleMap[]): boolean {
  return (
    maps.length > 0 &&
    maps.every((map) => {
      const facts = map.classPresence;
      return (
        !!map.elements &&
        !map.volatile?.length &&
        facts?.version === 2 &&
        facts.shadowRootsVerified === true &&
        facts.documentBoundsVerified === true &&
        facts.outsideBody === 0 &&
        !facts.unstable &&
        facts.ignored === false &&
        facts.shadowHosts === 0 &&
        facts.frames === 0
      );
    })
  );
}
/** Every captured surface must occur exactly once in the explicit filename-paired set. */
function fullyPaired(base: readonly StyleMap[], head: readonly StyleMap[], pairs: readonly ClassMapPair[]): boolean {
  if (!pairs.length || base.length !== pairs.length || head.length !== pairs.length) return false;
  const before = new Set(pairs.map((pair) => pair.base)),
    after = new Set(pairs.map((pair) => pair.head));
  return (
    before.size === base.length &&
    after.size === head.length &&
    base.every((map) => before.has(map)) &&
    head.every((map) => after.has(map))
  );
}
function classUnit(change: ScriptChange, literal: ClassLiteral, token: string, context: JoinContext): ClassUnit {
  const unmeasured = !!change.unmeasuredReason || context.gap({ ...change, range: literal.range });
  const present = context.present[change.side].has(token);
  const absent = !present && context.complete[change.side];
  return {
    sourceKey: change.sourceKey,
    side: change.side,
    range: literal.range,
    token,
    explicit: literal.explicit,
    ...(context.deltas[change.side].has(token)
      ? { delta: change.side === 'head' ? ('gained' as const) : ('lost' as const) }
      : {}),
    status: unmeasured ? 'unmeasured' : absent ? 'never-rendered' : 'unknown',
    why: unmeasured
      ? 'class-list or source evidence unavailable; see J3 run-level gaps'
      : present
        ? 'token present on a captured element; not tied to this occurrence'
        : absent
          ? 'class token never landed on a captured element'
          : 'token absence unproven; omitted elements, unstable/legacy facts or unpaired captures',
    level: 'warn',
  };
}
function unitsForChange(
  change: ScriptChange,
  index: LiteralIndex,
  opposite: LiteralIndex | undefined,
  context: JoinContext,
): ClassUnit[] {
  const stable = unchangedLiterals(change, index, opposite);
  const sources = literalsInChange(change, index).filter(
    (literal) =>
      !stable.has(literal) &&
      (literal.explicit || literal.classContext || literal.words.every((word) => context.vocabulary.has(word.token))),
  );
  const unchanged = unchangedWords(change, index, opposite);
  return sources.flatMap((literal) => {
    const words = literal.words.filter(
      (word) =>
        context.vocabulary.has(word.token) &&
        !unchanged.has(word) &&
        touches(word.range, change.classRange ?? change.range),
    );
    return [...new Set(words.map((word) => word.token))].map((token) => classUnit(change, literal, token, context));
  });
}
/** A deletion/insertion can leave a zero-width column range at the word's edge. */
function touches(a: SourceSpan, b: SourceSpan): boolean {
  const compare = (x: SourceSpan['start'], y: SourceSpan['start']) => x.line - y.line || x.column - y.column;
  return compare(a.start, b.end) <= 0 && compare(b.start, a.end) <= 0;
}
function extractionGaps(
  change: ScriptChange,
  index: LiteralIndex,
  vocabulary: Set<string>,
  opposite: LiteralIndex | undefined,
  unresolved: (change: ScriptChange, range: SourceSpan) => void,
): ClassJoinGap[] {
  const stable = unchangedLiterals(change, index, opposite);
  return literalsInChange(change, index)
    .filter((literal) => literal.extractionGap || (literal.explicit && (!stable.has(literal) || literal.residual)))
    .flatMap((literal) => {
      const known = literalsInChange({ range: literal.range }, index).some(
        (entry) => entry.explicit && entry.words.some((word) => vocabulary.has(word.token)),
      );
      if (known && !literal.residual) return [];
      if (!literal.residual) {
        unresolved(change, literal.range);
        return [];
      }
      return [
        {
          ...classJoinGap(
            `${change.sourceKey}:${literal.range.start.line}:${literal.range.start.column}: ${literal.residual ?? 'explicit class expression unresolved; no served class tokens'}`,
            change.side,
            change.sourceKey,
          ),
          range: literal.range,
        },
      ];
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
  if (!pairs.length) gaps.push(classJoinGap('no paired captures; class-list delta unavailable'));
  const vocabulary = classVocabulary(
    [...base, ...head].flatMap((map) => map.reach?.rules.map((rule) => rule.key) ?? []),
  );
  const deltas: Deltas = { base: new Set(), head: new Set() };
  for (const pair of pairs) pairDeltas(pair, deltas);
  const cache = new Map<string, LiteralIndex>();
  const unresolved = unresolvedClassGaps(classJoinGap);
  const indexed = (change: ScriptChange, opposite = false): LiteralIndex => {
    const key = `${change.sourceKey}\u0000${change.side}\u0000${opposite ? 'opposite' : change.contentHash}`;
    if (!cache.has(key))
      cache.set(
        key,
        indexClassLiterals(
          classLiterals(
            opposite
              ? (change.classOtherSource ?? '')
              : (change.classSource ?? '\n'.repeat(change.range.start.line - 1) + change.text),
            change.sourceKey,
          ),
        ),
      );
    return cache.get(key)!;
  };
  for (const change of changes) {
    if (change.unmeasuredReason) gaps.push(classJoinGap(change.unmeasuredReason, change.side, change.sourceKey));
    extractionGaps(
      change,
      indexed(change),
      vocabulary,
      change.classCounterpart ? indexed(change, true) : undefined,
      unresolved.add,
    ).forEach((gap) => gaps.push(gap));
  }
  const uniqueGaps = [...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values()].sort((a, b) =>
    compareSourceKeys(JSON.stringify(a), JSON.stringify(b)),
  );
  const paired = fullyPaired(base, head, pairs);
  const context: JoinContext = {
    vocabulary,
    deltas,
    present: { base: presentTokens(base), head: presentTokens(head) },
    complete: { base: paired && presenceComplete(base), head: paired && presenceComplete(head) },
    gap: scopedRangeLookup([...uniqueGaps, ...unresolved.evidence()]),
  };
  const units = changes.flatMap((change) =>
    unitsForChange(change, indexed(change), change.classCounterpart ? indexed(change, true) : undefined, context),
  );
  return {
    units: [
      ...new Map(
        units.map((unit) => [JSON.stringify([unit.sourceKey, unit.side, unit.range, unit.token]), unit]),
      ).values(),
    ].sort((a, b) => compareScriptRanges(a, b) || compareSourceKeys(a.token, b.token)),
    gaps: [...uniqueGaps, ...unresolved.summaries()].sort((a, b) =>
      compareSourceKeys(JSON.stringify(a), JSON.stringify(b)),
    ),
  };
}

/** Negative evidence can lower J2; neither execution nor an unresolved delta supplies rendering proof. */
export function combineClassReach(scripts: readonly ScriptUnit[], classes: readonly ClassUnit[]): ScriptUnit[] {
  const negative = scopedRangeLookup(
    classes.filter((entry) => entry.status === 'never-rendered' && entry.explicit === true),
  );
  return scripts.map((unit) => {
    return negative(unit) && unit.status !== 'never-rendered'
      ? { ...unit, status: 'never-rendered', why: `${unit.why}; J3: class token never landed on a captured element` }
      : unit;
  });
}
