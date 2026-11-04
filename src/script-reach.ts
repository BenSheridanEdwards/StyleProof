/** Pure source-map v3 decoding and conservative projection of binary V8 block coverage. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sourceIdentities } from './script-reach-identity.js';
import {
  ScriptEvidenceError,
  MAX_GENERATED_LENGTH,
  MAX_MAPPING_LENGTH,
  MAX_APP_SEGMENTS,
  MAX_COVERAGE_RANGES,
} from './script-reach-limits.js';
export { ScriptEvidenceError } from './script-reach-limits.js';

export type SourcePosition = { line: number; column: number };
/** Original lines are 1-based, UTF-16 columns 0-based, ends exclusive. Equal ends are mapping anchors. */
export type SourceSpan = { start: SourcePosition; end: SourcePosition };
export type CompactSourceSpan = [line: number, startColumn: number, endColumn: number];
export type ScriptSourceReach<Span = CompactSourceSpan> = {
  source: string;
  /** Origin-independent identity for joins across capture hosts. */
  sourceKey?: string;
  contentHash?: string;
  encoding?: 'line-column-tuples';
  executed: Span[];
  mixed: Span[];
  unexecuted: Span[];
};
export type ScriptReachEntry<Span = CompactSourceSpan> = {
  url: string;
  status: 'mapped' | 'unknown' | 'unmeasured';
  reason?: string;
  files?: ScriptSourceReach<Span>[];
};
export type ScriptReach = {
  version: 1;
  window: 'navigation';
  /** Config/project root relative to git top level; empty means repository root. Never an absolute path. */
  projectRootPrefix?: string;
  /** Missing git provenance remains named even when coverage itself was measured. */
  projectRootIssue?: string;
  status: 'measured' | 'unknown' | 'unmeasured';
  reason?: string;
  /** V8 block-coverage residuals; consumers must retain these limits. */
  notes?: string[];
  scripts: ScriptReachEntry[];
};
export type BinaryScriptCoverage = {
  functions: { isBlockCoverage?: boolean; ranges: { startOffset: number; endOffset: number; count: number }[] }[];
};
export type SourceMap = {
  version: number;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
  mappings: string;
};
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGITS = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) DIGITS[BASE64.charCodeAt(i)] = i;
type MappingBudget = { generatedBytes: number; mappingsLength: number; deadline: number };
function checkMappingBudget(budget: MappingBudget): void {
  if (budget.generatedBytes > MAX_GENERATED_LENGTH || budget.mappingsLength > MAX_MAPPING_LENGTH)
    throw new ScriptEvidenceError('source mapping size limit exceeded');
  if (performance.now() >= budget.deadline) throw new ScriptEvidenceError('source mapping CPU budget exhausted');
}

/** Decode signed base64 VLQ values without 32-bit bitwise overflow. */
export function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let factor = 1;
  for (const character of segment) {
    const digit = DIGITS[character.charCodeAt(0)] ?? -1;
    if (digit < 0) throw new Error('invalid source-map VLQ digit');
    value += (digit % 32) * factor;
    if (!Number.isSafeInteger(value) || factor > 2 ** 50) throw new Error('source-map VLQ overflow');
    if (digit >= 32) factor *= 32;
    else {
      values.push((value % 2 ? -1 : 1) * Math.floor(value / 2));
      value = 0;
      factor = 1;
    }
  }
  if (factor !== 1) throw new Error('unterminated source-map VLQ');
  return values;
}

type Segment = { offset: number; end: number; source?: number; line: number; column: number };

function validateMap(map: SourceMap): void {
  if (
    map.version !== 3 ||
    !Array.isArray(map.sources) ||
    !map.sources.every((s) => s === null || typeof s === 'string') ||
    typeof map.mappings !== 'string'
  )
    throw new Error('unsupported source map');
}

function generatedOffset(lines: string[], starts: number[], line: number, column: number, delta: number): number {
  if (lines[line] === undefined || delta < 0 || column < 0 || column > lines[line].length)
    throw new Error('invalid generated position');
  return starts[line] + column;
}

type OriginalCursor = { source: number; line: number; column: number };
function originalPosition(
  fields: number[],
  cursor: OriginalCursor,
  map: SourceMap,
  appSources: boolean[],
  originalLines: (string[] | undefined)[] | undefined,
): OriginalCursor | undefined {
  if (fields.length === 1) return undefined;
  cursor.source += fields[1];
  cursor.line += fields[2];
  cursor.column += fields[3];
  if (cursor.source < 0 || cursor.source >= map.sources.length || cursor.line < 0 || cursor.column < 0)
    throw new Error('invalid original position');
  if (!appSources[cursor.source]) return undefined;
  const text = originalLines?.[cursor.source];
  if (text && (text[cursor.line] === undefined || cursor.column > text[cursor.line].length))
    throw new Error('original position outside sourcesContent');
  return cursor;
}

function generatedLines(text: string): { lines: string[]; starts: number[] } {
  const lines: string[] = [],
    starts = [0];
  let previous = 0;
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    lines.push(text.slice(previous, match.index));
    previous = match.index + match[0].length;
    starts.push(previous);
  }
  lines.push(text.slice(previous));
  return { lines, starts };
}

function pushAppSegment(segments: Segment[], segment: Segment | undefined): void {
  if (!segment) return;
  if (segments.length >= MAX_APP_SEGMENTS) throw new ScriptEvidenceError('source mapping app segment limit exceeded');
  segments.push(segment);
}

function mappedSegments(
  map: SourceMap,
  generated: string,
  identities: (string | undefined)[],
  budget: MappingBudget,
): Segment[] {
  validateMap(map);
  checkMappingBudget(budget);
  const { lines, starts } = generatedLines(generated);
  const appSources = identities.map((identity) => identity !== undefined);
  const originalLines = map.sourcesContent?.map((content, index) =>
    appSources[index] && typeof content === 'string' ? generatedLines(content).lines : undefined,
  );
  const segments: Segment[] = [];
  const cursor = { source: 0, line: 0, column: 0 };
  let generatedLine = 0,
    generatedColumn = 0,
    count = 0;
  let previous: Segment | undefined;
  // Scan once, without materialising millions of split strings or vendor segments.
  for (const match of map.mappings.matchAll(/[^,;]+|;/g)) {
    if (match[0] === ';') {
      generatedLine++;
      generatedColumn = 0;
      previous = undefined;
      continue;
    }
    if (++count % 8192 === 0) checkMappingBudget(budget);
    const fields = decodeVlq(match[0]);
    if (![1, 4, 5].includes(fields.length)) throw new Error('invalid source-map segment');
    generatedColumn += fields[0];
    const offset = generatedOffset(lines, starts, generatedLine, generatedColumn, fields[0]);
    if (previous) previous.end = offset;
    const original = originalPosition(fields, cursor, map, appSources, originalLines);
    const segment = original
      ? { offset, end: starts[generatedLine] + lines[generatedLine].length, ...original }
      : undefined;
    pushAppSegment(segments, segment);
    previous = segment;
  }
  return segments;
}

type ExecutionKind = 'executed' | 'mixed' | 'unexecuted';
type CoverageRange = BinaryScriptCoverage['functions'][number]['ranges'][number];
type ExecutionRun = { start: number; end: number; kind: ExecutionKind };

/** Sort V8 boundaries once, keeping the innermost active range at the head of a heap. */
function executionRuns(entry: BinaryScriptCoverage): ExecutionRun[] {
  const ranges: CoverageRange[] = entry.functions.flatMap((f) => f.ranges);
  const events = ranges
    .flatMap((range, id) => [
      { offset: range.startOffset, id, start: true },
      { offset: range.endOffset, id, start: false },
    ])
    .sort((a, b) => a.offset - b.offset);
  const active = new Set<number>();
  const heap: number[] = [];
  const less = (a: number, b: number): boolean => {
    const x = ranges[a],
      y = ranges[b];
    return (
      x.endOffset - x.startOffset < y.endOffset - y.startOffset ||
      (x.endOffset - x.startOffset === y.endOffset - y.startOffset && x.count < y.count)
    );
  };
  const runs: ExecutionRun[] = [];
  let previous = 0;
  for (let i = 0; i < events.length;) {
    const offset = events[i].offset;
    while (heap.length && !active.has(heap[0])) popRange(heap, less);
    if (offset > previous)
      runs.push({
        start: previous,
        end: offset,
        kind: heap.length && ranges[heap[0]].count > 0 ? 'executed' : 'unexecuted',
      });
    i = advanceRanges(events, i, active, heap, less);
    previous = offset;
  }
  return runs;
}

function advanceRanges(
  events: { offset: number; id: number; start: boolean }[],
  index: number,
  active: Set<number>,
  heap: number[],
  less: (a: number, b: number) => boolean,
): number {
  const offset = events[index].offset;
  while (index < events.length && events[index].offset === offset) {
    const event = events[index++];
    if (event.start) {
      active.add(event.id);
      pushRange(heap, event.id, less);
    } else active.delete(event.id);
  }
  return index;
}

function pushRange(heap: number[], value: number, less: (a: number, b: number) => boolean): void {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!less(value, heap[parent])) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function popRange(heap: number[], less: (a: number, b: number) => boolean): void {
  const value = heap.pop()!;
  if (!heap.length) return;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
    if (!less(heap[child], value)) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = value;
}

function segmentExecutions(
  segments: Segment[],
  runs: ExecutionRun[],
  identities: (string | undefined)[],
): ExecutionKind[] {
  const anchored = new Map<number, Set<string>>();
  const originalLine = (segment: Segment): string => `${identities[segment.source ?? -1]}:${segment.line}`;
  let index = 0;
  for (const segment of segments) {
    while (index < runs.length && runs[index].end <= segment.offset) index++;
    if (index < runs.length && runs[index].start <= segment.offset) {
      const lines = anchored.get(index) ?? new Set<string>();
      lines.add(originalLine(segment));
      anchored.set(index, lines);
    }
  }
  index = 0;
  return segments.map((segment) => {
    while (index < runs.length && runs[index].end <= segment.offset) index++;
    const run = runs[index];
    const kind = run && run.start <= segment.offset ? run.kind : 'unexecuted';
    // Only a start on this source and original line represents the other run
    // (a ?? b). A later body's line cannot clear a coarse arrow header.
    for (let cursor = index; cursor < runs.length && runs[cursor].start < segment.end; cursor++)
      if (runs[cursor].kind !== kind && !anchored.get(cursor)?.has(originalLine(segment))) return 'mixed';
    return kind;
  });
}

type AnchorStates = Map<number, Map<number, number>>;
const EXECUTION_KINDS = ['executed', 'mixed', 'unexecuted'] as const;

function addAnchor(states: AnchorStates, segment: Segment, kind: ExecutionKind): void {
  const line = states.get(segment.line + 1) ?? new Map<number, number>();
  const bit = kind === 'executed' ? 1 : kind === 'unexecuted' ? 2 : 4;
  line.set(segment.column, (line.get(segment.column) ?? 0) | bit);
  states.set(segment.line + 1, line);
}

function writeAnchors(file: ScriptSourceReach<SourceSpan>, states: AnchorStates): void {
  for (const [line, columns] of [...states].sort((a, b) => a[0] - b[0]))
    for (const [column, bits] of [...columns].sort((a, b) => a[0] - b[0])) {
      const kind = bits === 1 ? 'executed' : bits === 2 ? 'unexecuted' : 'mixed';
      file[kind].push({ start: { line, column }, end: { line, column } });
    }
}

type OriginalSource = { source: string; sourceKey: string; contentHash?: string };

function originalSource(map: SourceMap, index: number, identities: (string | undefined)[]): OriginalSource | undefined {
  const source = identities[index];
  if (!source) return undefined;
  const content = map.sourcesContent?.[index];
  return typeof content === 'string'
    ? {
        source,
        sourceKey: source,
        contentHash: createHash('sha256').update(content).digest('hex'),
      }
    : { source, sourceKey: source };
}

function ensureSourceFile(
  files: Map<string, ScriptSourceReach<SourceSpan>>,
  original: OriginalSource,
): ScriptSourceReach<SourceSpan> {
  const previous = files.get(original.source);
  if (previous) {
    if (previous.contentHash !== original.contentHash) throw new Error('conflicting original source content');
    return previous;
  }
  const file = {
    source: original.source,
    sourceKey: original.sourceKey,
    ...(original.contentHash ? { contentHash: original.contentHash } : {}),
    executed: [],
    mixed: [],
    unexecuted: [],
  };
  files.set(original.source, file);
  return file;
}

/**
 * Each generated segment contributes one original start anchor. No original extent is inferred.
 * Unanchored state changes inside a generated extent, or conflicting states at repeated original starts, are mixed.
 */
export function mapScriptCoverage(
  entry: BinaryScriptCoverage,
  generated: string,
  map: SourceMap,
  mapUrl: string,
  options: { deadline?: number; projectRoot?: string } = {},
): ScriptSourceReach<SourceSpan>[] {
  validateMap(map);
  const budget = {
    generatedBytes: Buffer.byteLength(generated, 'utf8'),
    mappingsLength: map.mappings.length,
    deadline: options.deadline ?? Infinity,
  };
  checkMappingBudget(budget);
  const identities = sourceIdentities(map, mapUrl, options.projectRoot);
  const segments = mappedSegments(map, generated, identities, budget);
  checkMappingBudget(budget);
  if (entry.functions.reduce((sum, f) => sum + f.ranges.length, 0) > MAX_COVERAGE_RANGES)
    throw new ScriptEvidenceError('source mapping coverage range limit exceeded');
  const files = new Map<string, ScriptSourceReach<SourceSpan>>();
  const executions = segmentExecutions(segments, executionRuns(entry), identities);
  const states = new Map<string, AnchorStates>();
  const originals = map.sources.map((_, index) => originalSource(map, index, identities));
  segments.forEach((segment, index) => {
    if (segment.source === undefined || segment.offset >= segment.end) return;
    const original = originals[segment.source];
    if (!original) return;
    const file = ensureSourceFile(files, original);
    const anchors = states.get(file.sourceKey!) ?? new Map<number, Map<number, number>>();
    addAnchor(anchors, segment, executions[index]);
    states.set(file.sourceKey!, anchors);
  });
  for (const file of files.values()) {
    checkMappingBudget(budget);
    writeAnchors(file, states.get(file.sourceKey!)!);
    checkMappingBudget(budget);
  }
  return [...files.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** Mapped app-file execution only, independent of generated URLs and capture origins. */
export function scriptExecutionProjection(evidence: ScriptReach): Omit<ScriptSourceReach<SourceSpan>, 'source'>[] {
  const files = evidence.scripts.filter((script) => script.status === 'mapped').flatMap((script) => script.files ?? []);
  const canonical = files.map(({ source, sourceKey, ...file }) =>
    JSON.stringify({
      sourceKey: sourceKey ?? source,
      ...file,
      encoding: undefined,
      ...Object.fromEntries(
        EXECUTION_KINDS.map((kind) => [
          kind,
          file[kind].map((span) => {
            const [line, start, end] = span as CompactSourceSpan;
            return { start: { line, column: start }, end: { line, column: end } };
          }),
        ]),
      ),
    }),
  );
  return [...new Set(canonical)]
    .sort()
    .map((file: string) => JSON.parse(file) as Omit<ScriptSourceReach<SourceSpan>, 'source'>);
}
