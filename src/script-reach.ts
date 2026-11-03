/** Pure source-map v3 decoding and conservative projection of binary V8 block coverage. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sourceIdentities } from './script-reach-identity.js';

export type SourcePosition = { line: number; column: number };
/** Original lines are 1-based, UTF-16 columns 0-based, ends exclusive. Equal ends are mapping anchors. */
export type SourceSpan = { start: SourcePosition; end: SourcePosition };
export type CompactSourceSpan = [line: number, startColumn: number, endColumn: number];
export type ScriptSourceReach<Span = SourceSpan | CompactSourceSpan> = {
  source: string;
  /** Origin-independent identity for joins across capture hosts. */
  sourceKey?: string;
  contentHash?: string;
  encoding?: 'line-column-tuples';
  executed: Span[];
  mixed: Span[];
  unexecuted: Span[];
};
export type ScriptReachEntry = {
  url: string;
  status: 'mapped' | 'unknown' | 'unmeasured';
  reason?: string;
  files?: ScriptSourceReach[];
};
export type ScriptReach = {
  version: 1;
  window: 'navigation';
  status: 'measured' | 'unknown' | 'unmeasured';
  reason?: string;
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
export class ScriptEvidenceError extends Error {}
const MAX_SEGMENTS = 100_000;
function checkMappingBudget(generated: string, mappings: string, deadline = Infinity): void {
  if (generated.length > 4 * 1024 * 1024 || mappings.length > 2 * 1024 * 1024)
    throw new ScriptEvidenceError('source mapping size limit exceeded');
  if (performance.now() >= deadline) throw new ScriptEvidenceError('source mapping CPU budget exhausted');
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

type Segment = { offset: number; end: number; source?: number; line: number; column: number; adjacent?: boolean };

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

function connectSegments(previous: Segment | undefined, next: Segment | undefined): void {
  if (!previous || !next) return;
  previous.adjacent = previous.source === next.source && previous.line === next.line && next.column > previous.column;
}

function checkSegmentBudget(count: number, generated: string, mappings: string, deadline: number): void {
  if (count > MAX_SEGMENTS) throw new ScriptEvidenceError('source mapping segment limit exceeded');
  if (count % 1024 === 0) checkMappingBudget(generated, mappings, deadline);
}

function mappedSegments(map: SourceMap, generated: string, deadline: number): Segment[] {
  validateMap(map);
  checkMappingBudget(generated, map.mappings, deadline);
  const lines = generated.split('\n');
  const originalLines = map.sourcesContent?.map((content) =>
    typeof content === 'string' ? content.split('\n') : undefined,
  );
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1);
  const appSources = map.sources.map(
    (source) => source !== null && isAppScriptSource((map.sourceRoot ?? '') + '/' + source),
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
    checkSegmentBudget(++count, generated, map.mappings, deadline);
    const fields = decodeVlq(match[0]);
    if (![1, 4, 5].includes(fields.length)) throw new Error('invalid source-map segment');
    generatedColumn += fields[0];
    const offset = generatedOffset(lines, starts, generatedLine, generatedColumn, fields[0]);
    if (previous) previous.end = offset;
    const original = originalPosition(fields, cursor, map, appSources, originalLines);
    const segment = original
      ? { offset, end: starts[generatedLine] + lines[generatedLine].length, ...original }
      : undefined;
    connectSegments(previous, segment);
    if (segment) segments.push(segment);
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

function segmentExecutions(segments: Segment[], runs: ExecutionRun[]): ExecutionKind[] {
  let index = 0;
  return segments.map((segment) => {
    while (index < runs.length && runs[index].end <= segment.offset) index++;
    let any = false,
      all = true,
      covered = segment.offset;
    for (let i = index; i < runs.length && runs[i].start < segment.end; i++) {
      const run = runs[i];
      if (run.start > covered) all = false;
      any ||= run.kind === 'executed';
      all &&= run.kind === 'executed';
      covered = Math.max(covered, run.end);
    }
    all &&= covered >= segment.end;
    return all ? 'executed' : any ? 'mixed' : 'unexecuted';
  });
}

/** No dependency source, including webpack URLs, contributes app execution evidence. */
export function isAppScriptSource(source: string): boolean {
  return !/(^|[\\/])node_modules[\\/]/.test(source);
}

type SpanEvent = { column: number; kind: ExecutionKind; delta: number };
const EXECUTION_KINDS = ['executed', 'mixed', 'unexecuted'] as const;

function combinedKind(counts: Record<ExecutionKind, number>): ExecutionKind {
  return counts.mixed || (counts.executed && counts.unexecuted) ? 'mixed' : counts.executed ? 'executed' : 'unexecuted';
}

/** Sweep overlapping original spans; conflicting generated occurrences cannot prove full execution. */
function normalizeSource(file: ScriptSourceReach<SourceSpan>): void {
  const lines = new Map<number, SpanEvent[]>();
  const points = new Map<number, Map<number, { span: SourceSpan; counts: Record<ExecutionKind, number> }>>();
  for (const kind of EXECUTION_KINDS) {
    for (const span of file[kind]) {
      if (span.start.column === span.end.column) {
        const row = points.get(span.start.line) ?? new Map();
        const point = row.get(span.start.column) ?? { span, counts: { executed: 0, mixed: 0, unexecuted: 0 } };
        point.counts[kind]++;
        row.set(span.start.column, point);
        points.set(span.start.line, row);
      } else {
        const events = lines.get(span.start.line) ?? [];
        events.push({ column: span.start.column, kind, delta: 1 }, { column: span.end.column, kind, delta: -1 });
        lines.set(span.start.line, events);
      }
    }
    file[kind] = [];
  }
  for (const [line, events] of lines) sweepLine(file, line, events);
  for (const row of points.values()) for (const { span, counts } of row.values()) file[combinedKind(counts)].push(span);
  for (const kind of EXECUTION_KINDS)
    file[kind].sort((a, b) => a.start.line - b.start.line || a.start.column - b.start.column);
}

function sweepLine(file: ScriptSourceReach<SourceSpan>, line: number, events: SpanEvent[]): void {
  events.sort((a, b) => a.column - b.column);
  const counts = { executed: 0, mixed: 0, unexecuted: 0 };
  let previous = events[0].column;
  for (const event of events) {
    if (event.column > previous && Object.values(counts).some((n) => n > 0)) {
      const spans = file[combinedKind(counts)];
      const last = spans.at(-1);
      if (last?.end.line === line && last.end.column === previous) last.end.column = event.column;
      else spans.push({ start: { line, column: previous }, end: { line, column: event.column } });
    }
    counts[event.kind] += event.delta;
    previous = event.column;
  }
}

type OriginalSource = { source: string; sourceKey: string; contentHash?: string; lines?: string[] };

function originalSource(map: SourceMap, index: number, identities: (string | undefined)[]): OriginalSource | undefined {
  const source = identities[index];
  if (!source) return undefined;
  const content = map.sourcesContent?.[index];
  return typeof content === 'string'
    ? {
        source,
        sourceKey: source,
        contentHash: createHash('sha256').update(content).digest('hex'),
        lines: content.split('\n'),
      }
    : { source, sourceKey: source };
}

/** Next greater original column, independent of generated order, never the line length. */
function originalEnds(segments: Segment[]): Map<Segment, number> {
  const sources = new Map<number, Map<number, Segment[]>>();
  for (const segment of segments) {
    if (segment.source === undefined) continue;
    const lines = sources.get(segment.source) ?? new Map<number, Segment[]>();
    const points = lines.get(segment.line) ?? [];
    points.push(segment);
    lines.set(segment.line, points);
    sources.set(segment.source, lines);
  }
  const ends = new Map<Segment, number>();
  for (const lines of sources.values()) for (const points of lines.values()) indexOriginalLine(points, ends);
  return ends;
}

function indexOriginalLine(points: Segment[], ends: Map<Segment, number>): void {
  points.sort((a, b) => a.column - b.column);
  let next = points.at(-1)!.column;
  for (let i = points.length - 1; i >= 0; i--) {
    if (i + 1 < points.length && points[i].column < points[i + 1].column) next = points[i + 1].column;
    ends.set(points[i], points[i].adjacent ? next : points[i].column);
  }
}

function originalSpan(segment: Segment, ends: Map<Segment, number>, original: OriginalSource): SourceSpan {
  const line = segment.line + 1;
  const column = Math.min(ends.get(segment) ?? segment.column, original.lines?.[segment.line]?.length ?? Infinity);
  return { start: { line, column: segment.column }, end: { line, column } };
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
 * Project mapped generated segments, never interpolate an original position across a V8 boundary.
 * A split segment is mixed. Without a later original anchor on the same source line, keep a point anchor.
 */
export function mapScriptCoverage(
  entry: BinaryScriptCoverage,
  generated: string,
  map: SourceMap,
  mapUrl: string,
  options: { deadline?: number } = {},
): ScriptSourceReach<SourceSpan>[] {
  const deadline = options.deadline ?? Infinity;
  const segments = mappedSegments(map, generated, deadline);
  checkMappingBudget(generated, map.mappings, deadline);
  if (entry.functions.reduce((sum, f) => sum + f.ranges.length, 0) > 200_000)
    throw new ScriptEvidenceError('source mapping coverage range limit exceeded');
  const files = new Map<string, ScriptSourceReach<SourceSpan>>();
  const executions = segmentExecutions(segments, executionRuns(entry));
  const ends = originalEnds(segments);
  const identities = sourceIdentities(map, mapUrl);
  const originals = map.sources.map((_, index) => originalSource(map, index, identities));
  segments.forEach((segment, index) => {
    if (segment.source === undefined || segment.offset >= segment.end) return;
    const original = originals[segment.source];
    if (!original) return;
    const file = ensureSourceFile(files, original);
    file[executions[index]].push(originalSpan(segment, ends, original));
  });
  for (const file of files.values()) {
    checkMappingBudget(generated, map.mappings, deadline);
    normalizeSource(file);
    checkMappingBudget(generated, map.mappings, deadline);
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
          file[kind].map((span) =>
            Array.isArray(span)
              ? { start: { line: span[0], column: span[1] }, end: { line: span[0], column: span[2] } }
              : span,
          ),
        ]),
      ),
    }),
  );
  return [...new Set(canonical)]
    .sort()
    .map((file: string) => JSON.parse(file) as Omit<ScriptSourceReach<SourceSpan>, 'source'>);
}
