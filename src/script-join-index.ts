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
    // Punctuation and other starts can still supply negative/mixed evidence.
    if (row[index].bits & 2) bits |= row[index].bits;
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

type TokenEvidence = { bits: number; missing: boolean; preceding: boolean; count: number; why?: string };

function exactAnchor(point: SourcePosition, index: ScriptExecutionIndex): number | undefined {
  const row = index.rows.get(point.line) ?? [];
  const position = firstAtOrAfter(row, point.column, (anchor) => anchor.column);
  return row[position]?.column === point.column ? row[position].bits : undefined;
}

function tokenEvidence(point: SourcePosition, index: ScriptExecutionIndex, startsInRange: boolean): TokenEvidence {
  const own = startsInRange ? exactAnchor(point, index) : undefined;
  if (own !== undefined) return { bits: own, missing: false, preceding: false, count: 1 };
  const before = precedingEvidence({ start: point, end: point }, index);
  return {
    bits: before & 2 ? before : 0,
    missing: !(before & 2),
    preceding: true,
    count: 1,
    why:
      before === 1
        ? 'changed script token has no mapped anchor at its start; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler)'
        : 'script token without an execution start, including leading text, retains negative or missing preceding-anchor evidence',
  };
}

function rangeTokens(range: SourceSpan, index: ScriptExecutionIndex, text: string): TokenEvidence {
  const result: TokenEvidence = { bits: 0, missing: false, preceding: false, count: 0 };
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  for (const [offset, line] of lines.entries()) {
    const number = range.start.line + offset;
    if (number > range.end.line) break;
    const from = offset === 0 ? range.start.column : 0;
    const to = number === range.end.line ? range.end.column : Infinity;
    for (const token of scriptTokens(line)) {
      if (token.index >= to || token.end <= from) continue;
      const evidence = tokenEvidence({ line: number, column: Math.max(from, token.index) }, index, token.index >= from);
      result.bits |= evidence.bits;
      result.missing ||= evidence.missing;
      result.preceding ||= evidence.preceding;
      result.count++;
      result.why ??= evidence.why;
    }
  }
  return result;
}

function tokenExecution(bits: number, scope: RangeExecution['scope'], evidence: TokenEvidence): RangeExecution {
  bits |= evidence.bits;
  const execution =
    bits & 2 ? (bits & 1 ? 'partly-ran' : 'never-ran') : !evidence.missing && bits === 1 ? 'ran' : 'unmeasured';
  return {
    execution,
    scope: evidence.preceding && scope !== 'line' ? 'preceding-anchor' : scope,
    ...(evidence.why ? { why: evidence.why } : {}),
  };
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
    if (lineOnly(row)) scope = 'line';
    bits |= rangeRowEvidence(row, line, range);
  }
  const tokens = text === undefined ? undefined : rangeTokens(range, index, text);
  if (tokens?.count) return tokenExecution(bits, scope, tokens);
  const fallback = tokenEvidence(range.start, index, false);
  fallback.missing = true;
  fallback.why =
    text === undefined
      ? 'changed source text unavailable; no token-start execution proof'
      : 'no script token-start execution proof; punctuation anchors supply negative evidence only';
  return tokenExecution(bits, scope, fallback);
}
