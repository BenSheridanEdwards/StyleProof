/** Ordered value/role/slot matching is cached once for each replacement hunk. */
import type { SourceSpan } from './script-reach.js';
import type { ScriptChange } from './script-join.js';
import {
  literalsInChange,
  spansOverlap,
  type ClassLiteral,
  type ClassWord,
  type indexClassLiterals,
} from './class-join-literals.js';
type Index = ReturnType<typeof indexClassLiterals>;
type Alignment = { literals: Set<ClassLiteral>; words: Set<ClassWord> };
const cache = new WeakMap<Index, WeakMap<Index, Map<string, Alignment>>>();
function wordSequence(literals: ClassLiteral[], range: SourceSpan) {
  return literals
    .flatMap((literal) =>
      literal.context
        ? []
        : literal.words
            .filter((word) => spansOverlap(word.range, range))
            .map((word) => ({
              literal,
              word,
              key: JSON.stringify([literal.explicit, !!literal.classContext, literal.role, word.token]),
            })),
    )
    .sort(
      (a, b) =>
        a.word.range.start.line - b.word.range.start.line || a.word.range.start.column - b.word.range.start.column,
    );
}
function match(
  current: ClassLiteral[],
  other: ClassLiteral[],
  ranges: { current: SourceSpan; other: SourceSpan },
): Alignment {
  const before = wordSequence(other, ranges.other),
    after = wordSequence(current, ranges.current);
  const positions = new Map<string, { indices: number[]; next: number }>();
  before.forEach((entry, i) => {
    const queue = positions.get(entry.key) ?? { indices: [], next: 0 };
    queue.indices.push(i);
    positions.set(entry.key, queue);
  });
  const words = new Set<ClassWord>();
  let minimum = 0;
  for (const entry of after) {
    const queue = positions.get(entry.key);
    if (!queue) continue;
    while (queue.next < queue.indices.length && queue.indices[queue.next] < minimum) queue.next++;
    if (queue.next < queue.indices.length) {
      words.add(entry.word);
      minimum = queue.indices[queue.next++] + 1;
    }
  }
  return { words, literals: new Set(current.filter((l) => l.words.length > 0 && l.words.every((w) => words.has(w)))) };
}
function aligned(change: ScriptChange, index: Index, opposite?: Index): Alignment {
  const counterpart = change.classCounterpart;
  if (!counterpart || !opposite) return { literals: new Set(), words: new Set() };
  let byOther = cache.get(index);
  if (!byOther) {
    byOther = new WeakMap();
    cache.set(index, byOther);
  }
  let hunks = byOther.get(opposite);
  if (!hunks) {
    hunks = new Map();
    byOther.set(opposite, hunks);
  }
  const range = { start: counterpart.current, end: counterpart.end ?? change.range.end };
  const key = JSON.stringify([range, counterpart.range]);
  let result = hunks.get(key);
  if (!result) {
    result = match(literalsInChange({ range }, index), literalsInChange({ range: counterpart.range }, opposite), {
      current: range,
      other: counterpart.range,
    });
    hunks.set(key, result);
  }
  return result;
}
export function unchangedLiterals(change: ScriptChange, index: Index, opposite?: Index): Set<ClassLiteral> {
  return aligned(change, index, opposite).literals;
}
export function unchangedWords(change: ScriptChange, index: Index, opposite?: Index): Set<ClassWord> {
  return aligned(change, index, opposite).words;
}
