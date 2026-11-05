/** Replacement-line alignment never excludes occurrences on pure additions/deletions. */
import type { ScriptChange } from './script-join.js';
import { literalsInChange, type ClassLiteral, type ClassWord, type indexClassLiterals } from './class-join-literals.js';
type Index = ReturnType<typeof indexClassLiterals>;

function aligned(change: ScriptChange, index: Index, opposite?: Index): [ClassLiteral, ClassLiteral][] {
  if (!change.classCounterpart || !opposite) return [];
  const current = literalsInChange(
    { range: { start: change.classCounterpart.current, end: change.range.end } },
    index,
  ).filter((literal) => !literal.context);
  const other = literalsInChange({ range: change.classCounterpart.range }, opposite).filter(
    (literal) => !literal.context,
  );
  return current.flatMap((literal, i) => {
    const counterpart = other[i];
    return counterpart &&
      literal.explicit === counterpart.explicit &&
      (literal.explicit || !!literal.classContext === !!counterpart.classContext)
      ? [[literal, counterpart] as [ClassLiteral, ClassLiteral]]
      : [];
  });
}
export function unchangedLiterals(change: ScriptChange, index: Index, opposite?: Index): Set<ClassLiteral> {
  return new Set(
    aligned(change, index, opposite)
      .filter(
        ([a, b]) =>
          a.words.length > 0 &&
          JSON.stringify(a.words.map((w) => w.token)) === JSON.stringify(b.words.map((w) => w.token)),
      )
      .map(([literal]) => literal),
  );
}
/** Match token occurrences within the aligned literal, allowing unchanged neighbours to shift columns. */
export function unchangedWords(change: ScriptChange, index: Index, opposite?: Index): Set<ClassWord> {
  const unchanged = new Set<ClassWord>();
  for (const [literal, counterpart] of aligned(change, index, opposite)) {
    const positions = new Map<string, { indices: number[]; next: number }>();
    counterpart.words.forEach((word, i) => {
      const entry = positions.get(word.token) ?? { indices: [], next: 0 };
      entry.indices.push(i);
      positions.set(word.token, entry);
    });
    let minimum = 0;
    for (const word of literal.words) {
      const entry = positions.get(word.token);
      if (!entry) continue;
      while (entry.next < entry.indices.length && entry.indices[entry.next] < minimum) entry.next++;
      if (entry.next < entry.indices.length) {
        unchanged.add(word);
        minimum = entry.indices[entry.next++] + 1;
      }
    }
  }
  return unchanged;
}
