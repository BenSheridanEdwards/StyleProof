/** One execution index per side/source, retaining script identity when captures are merged. */
import type { ScriptSourceReach, SourcePosition, SourceSpan } from './script-reach.js';
import type { ScriptExecution } from './script-join.js';
import { scriptTokens } from './script-join-tokens.js';

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

type RangeExecution = { execution: ScriptExecution; scope: 'range' | 'line' | 'preceding-anchor'; why?: string };

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

function firstStart(range: SourceSpan, index: ScriptExecutionIndex): SourcePosition | undefined {
  for (
    let cursor = firstAtOrAfter(index.lines, range.start.line, (value) => value);
    cursor < index.lines.length;
    cursor++
  ) {
    const line = index.lines[cursor];
    if (line > range.end.line) break;
    const row = index.rows.get(line)!;
    const anchor =
      row[firstAtOrAfter(row, line === range.start.line ? range.start.column : 0, (point) => point.column)];
    if (anchor && (line < range.end.line || anchor.column < range.end.column)) return { line, column: anchor.column };
  }
}

function leadingExecution(range: SourceSpan, index: ScriptExecutionIndex, text?: string): RangeExecution | undefined {
  if (text === undefined) return;
  const first = firstStart(range, index);
  if (!first) return;
  const stop = first.line - range.start.line;
  if (stop === 0 && first.column === range.start.column) return;
  const prefix = text
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .slice(0, stop + 1)
    .map((line, i) => line.slice(i === 0 ? range.start.column : 0, i === stop ? first.column : undefined))
    .join('\n');
  if (!scriptTokens(prefix).length) return;
  const preceding = rangeExecution(0, 'preceding-anchor', range, index);
  return {
    ...preceding,
    why: `leading text before the first in-range anchor; ${preceding.why ?? 'preceding-anchor evidence cannot be ignored'}`,
  };
}

function combinedExecution(bits: number, scope: RangeExecution['scope'], leading: RangeExecution): RangeExecution {
  const negative = leading.execution === 'partly-ran' ? 3 : leading.execution === 'never-ran' ? 2 : 0;
  bits |= negative;
  // An unmeasured prefix cannot be proved by a later start. Any known idle
  // portion still names the line as never-rendered rather than hiding it.
  const execution = bits & 2 ? (bits & 1 ? 'partly-ran' : 'never-ran') : 'unmeasured';
  return { execution, scope: scope === 'line' ? scope : 'preceding-anchor', why: leading.why };
}

export function executionIn(range: SourceSpan, index: ScriptExecutionIndex, text?: string): RangeExecution {
  let bits = 0;
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
    }
    bits |= rangeRowEvidence(row, line, range);
  }

  const leading = leadingExecution(range, index, text);
  return leading ? combinedExecution(bits, scope, leading) : rangeExecution(bits, scope, range, index);
}

function rangeExecution(
  bits: number,
  scope: RangeExecution['scope'],
  range: SourceSpan,
  index: ScriptExecutionIndex,
): RangeExecution {
  if (!bits) {
    bits = precedingEvidence(range, index);
    if (bits && scope !== 'line') scope = 'preceding-anchor';
    // A mapped start before this range can name an idle block, but cannot
    // prove execution of text that the bundler may have removed entirely.
    if (bits === 1)
      return {
        execution: 'unmeasured',
        scope,
        why: 'no mapped anchor inside the changed range; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler)',
      };
  }

  return { execution: bits === 3 ? 'partly-ran' : bits === 2 ? 'never-ran' : bits === 1 ? 'ran' : 'unmeasured', scope };
}
