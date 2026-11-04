/** One execution index per side/source; intervals never spread entry evidence to child expressions. */
import type { ScriptSourceReach, SourceSpan } from './script-reach.js';
import type { ScriptExecution } from './script-join.js';

type Anchor = { column: number; bits: number };

export type ScriptExecutionIndex = {
  hashes: Set<string | undefined>;
  rows: Map<number, Anchor[]>;
  lines: number[];
};

export function indexScriptSources(files: ScriptSourceReach[]): ScriptExecutionIndex {
  const rows = new Map<number, Map<number, number>>();
  const hashes = new Set<string | undefined>();

  for (const file of files) {
    hashes.add(file.contentHash);

    for (const [kind, bit] of [
      ['executed', 1],
      ['unexecuted', 2],
      ['mixed', 4],
    ] as const) {
      for (const [line, column] of file[kind]) {
        const row = rows.get(line) ?? new Map<number, number>();
        row.set(column, (row.get(column) ?? 0) | bit);
        rows.set(line, row);
      }
    }
  }

  return {
    hashes,
    rows: new Map(
      [...rows].map(([line, row]) => [
        line,
        [...row].map(([column, bits]) => ({ column, bits })).sort((a, b) => a.column - b.column),
      ]),
    ),
    lines: [...rows.keys()].sort((a, b) => a - b),
  };
}

function firstAtOrAfter<T>(items: T[], target: number, value: (item: T) => number): number {
  let low = 0,
    high = items.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (value(items[middle]) < target) low = middle + 1;
    else high = middle;
  }

  return low;
}

function rowEvidence(row: Anchor[], start: number, end: number): number {
  let bits = 0;

  for (
    let index = firstAtOrAfter(row, start, (anchor) => anchor.column);
    index < row.length && row[index].column < end;
    index++
  ) {
    const state = row[index].bits;
    // A different capture can witness the same original start that was idle before.
    bits |= state & 1 ? 1 : state & 4 ? 3 : 2;
  }

  return bits;
}

type RangeExecution = { execution: ScriptExecution; scope: 'range' | 'line' };

function lineOnly(row: Anchor[] | undefined): row is Anchor[] {
  return row?.length === 1 && row[0].column === 0;
}

function rangeRowEvidence(row: Anchor[], line: number, range: SourceSpan): number {
  return rowEvidence(
    row,
    line === range.start.line ? range.start.column : 0,
    line === range.end.line ? range.end.column : Infinity,
  );
}

export function executionIn(range: SourceSpan, index: ScriptExecutionIndex): RangeExecution {
  let bits = 0,
    lineBits = 0;
  let scope: 'range' | 'line' = 'range';

  for (
    let cursor = firstAtOrAfter(index.lines, range.start.line, (line) => line);
    cursor < index.lines.length && index.lines[cursor] <= range.end.line;
    cursor++
  ) {
    const line = index.lines[cursor];
    if (line === range.end.line && range.end.column === 0) break;
    const row = index.rows.get(line)!;
    if (lineOnly(row)) {
      scope = 'line';
      lineBits |= rowEvidence(row, 0, Infinity);
    }
    bits |= rangeRowEvidence(row, line, range);
  }

  if (!bits) bits = lineBits;

  return { execution: bits === 3 ? 'partly-ran' : bits === 2 ? 'never-ran' : bits === 1 ? 'ran' : 'unmeasured', scope };
}
