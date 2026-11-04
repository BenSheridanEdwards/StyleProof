/** One execution index per side/source, retaining script identity when captures are merged. */
import type { ScriptSourceReach, SourceSpan } from './script-reach.js';
import type { ScriptExecution } from './script-join.js';

type Anchor = { column: number; bits: number };
export type ScriptSourceEvidence = ScriptSourceReach & { scriptUrl?: string };

export type ScriptExecutionIndex = {
  hashes: Set<string | undefined>;
  rows: Map<number, Anchor[]>;
  lines: number[];
};

export function indexScriptSources(files: ScriptSourceEvidence[]): ScriptExecutionIndex {
  const rows = new Map<number, Map<number, Map<string, number>>>();
  const hashes = new Set<string | undefined>();

  for (const file of files) {
    hashes.add(file.contentHash);

    for (const [kind, bit] of [
      ['executed', 1],
      ['unexecuted', 2],
      ['mixed', 4],
    ] as const) {
      for (const [line, column] of file[kind]) {
        const row = rows.get(line) ?? new Map<number, Map<string, number>>();
        const scripts = row.get(column) ?? new Map<string, number>();
        const url = file.scriptUrl ?? '';
        scripts.set(url, (scripts.get(url) ?? 0) | bit);
        row.set(column, scripts);
        rows.set(line, row);
      }
    }
  }

  return {
    hashes,
    rows: new Map(
      [...rows].map(([line, row]) => [
        line,
        [...row]
          .map(([column, scripts]) => ({ column, bits: anchorBits(scripts) }))
          .sort((a, b) => a.column - b.column),
      ]),
    ),
    lines: [...rows.keys()].sort((a, b) => a - b),
  };
}

function anchorBits(scripts: Map<string, number>): number {
  const states = [...scripts.values()];
  // A full run can clear mixed evidence only from the same generated script URL.
  if (states.some((state) => state & 4 && !(state & 1))) return 3;
  return states.some((state) => state & 1) ? 1 : 2;
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
    bits |= row[index].bits;
  }

  return bits;
}

type RangeExecution = { execution: ScriptExecution; scope: 'range' | 'line' | 'preceding-anchor' };

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

function precedingEvidence(range: SourceSpan, index: ScriptExecutionIndex): number {
  let cursor = firstAtOrAfter(index.lines, range.start.line, (line) => line);
  if (index.lines[cursor] !== range.start.line) cursor--;
  if (cursor < 0) return 0;
  const row = index.rows.get(index.lines[cursor])!;
  if (index.lines[cursor] < range.start.line) return row.at(-1)!.bits;
  const position = firstAtOrAfter(row, range.start.column, (anchor) => anchor.column);
  if (row[position]?.column === range.start.column) return row[position].bits;
  if (position > 0) return row[position - 1].bits;
  return cursor > 0 ? index.rows.get(index.lines[cursor - 1])!.at(-1)!.bits : 0;
}

export function executionIn(range: SourceSpan, index: ScriptExecutionIndex): RangeExecution {
  let bits = 0,
    lineBits = 0;
  let scope: RangeExecution['scope'] = 'range';

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

  return rangeExecution(bits || lineBits, scope, range, index);
}

function rangeExecution(
  bits: number,
  scope: RangeExecution['scope'],
  range: SourceSpan,
  index: ScriptExecutionIndex,
): RangeExecution {
  if (!bits) {
    bits = precedingEvidence(range, index);
    if (bits) scope = 'preceding-anchor';
  }

  return { execution: bits === 3 ? 'partly-ran' : bits === 2 ? 'never-ran' : bits === 1 ? 'ran' : 'unmeasured', scope };
}
