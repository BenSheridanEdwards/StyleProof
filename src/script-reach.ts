/** Pure source-map v3 decoding and conservative projection of binary V8 block coverage. */
import { createHash } from 'node:crypto';

export type SourcePosition = { line: number; column: number };
/** Original lines are 1-based, UTF-16 columns 0-based, ends exclusive. Equal ends are mapping anchors. */
export type SourceSpan = { start: SourcePosition; end: SourcePosition };
export type ScriptSourceReach = {
  source: string;
  /** Origin-independent identity for joins across capture hosts. */
  sourceKey?: string;
  contentHash?: string;
  executed: SourceSpan[];
  mixed: SourceSpan[];
  unexecuted: SourceSpan[];
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
  sources: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
  mappings: string;
};
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode signed base64 VLQ values without 32-bit bitwise overflow. */
export function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let factor = 1;
  for (const character of segment) {
    const digit = BASE64.indexOf(character);
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

function mappedSegments(map: SourceMap, generated: string): Segment[] {
  if (
    map.version !== 3 ||
    !Array.isArray(map.sources) ||
    !map.sources.every((s) => typeof s === 'string') ||
    typeof map.mappings !== 'string'
  ) {
    throw new Error('unsupported source map');
  }
  const lines = generated.split('\n');
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1);
  const segments: Segment[] = [];
  let source = 0;
  let line = 0;
  let column = 0;
  map.mappings.split(';').forEach((row, generatedLine) => {
    let generatedColumn = 0;
    let previous: Segment | undefined;
    for (const raw of row.split(',').filter(Boolean)) {
      const fields = decodeVlq(raw);
      if (![1, 4, 5].includes(fields.length)) throw new Error('invalid source-map segment');
      generatedColumn += fields[0];
      if (
        lines[generatedLine] === undefined ||
        generatedColumn < 0 ||
        generatedColumn > lines[generatedLine].length ||
        fields[0] < 0
      )
        throw new Error('invalid generated position');
      const offset = starts[generatedLine] + generatedColumn;
      if (previous) previous.end = offset;
      const segment: Segment = { offset, end: starts[generatedLine] + lines[generatedLine].length, line: 0, column: 0 };
      if (fields.length > 1) {
        source += fields[1];
        line += fields[2];
        column += fields[3];
        if (source < 0 || source >= map.sources.length || line < 0 || column < 0)
          throw new Error('invalid original position');
        Object.assign(segment, { source, line, column });
      }
      segments.push(segment);
      previous = segment;
    }
  });
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
function normalizeSource(file: ScriptSourceReach): void {
  const lines = new Map<number, SpanEvent[]>();
  const points = new Map<string, { span: SourceSpan; counts: Record<ExecutionKind, number> }>();
  for (const kind of EXECUTION_KINDS) {
    for (const span of file[kind]) {
      if (span.start.column === span.end.column) {
        const key = JSON.stringify(span);
        const point = points.get(key) ?? { span, counts: { executed: 0, mixed: 0, unexecuted: 0 } };
        point.counts[kind]++;
        points.set(key, point);
      } else {
        const events = lines.get(span.start.line) ?? [];
        events.push({ column: span.start.column, kind, delta: 1 }, { column: span.end.column, kind, delta: -1 });
        lines.set(span.start.line, events);
      }
    }
    file[kind] = [];
  }
  for (const [line, events] of lines) sweepLine(file, line, events);
  for (const { span, counts } of points.values()) file[combinedKind(counts)].push(span);
  for (const kind of EXECUTION_KINDS)
    file[kind].sort((a, b) => a.start.line - b.start.line || a.start.column - b.start.column);
}

function sweepLine(file: ScriptSourceReach, line: number, events: SpanEvent[]): void {
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

function originalSource(map: SourceMap, index: number, mapUrl: string): OriginalSource | undefined {
  const source = new URL(
    map.sources[index],
    new URL(map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '.', mapUrl),
  ).href;
  if (!isAppScriptSource(source)) return undefined;
  const parsed = new URL(source);
  const sourceKey = /^(https?|file):$/.test(parsed.protocol) ? parsed.pathname : source;
  const content = map.sourcesContent?.[index];
  return typeof content === 'string'
    ? { source, sourceKey, contentHash: createHash('sha256').update(content).digest('hex'), lines: content.split('\n') }
    : { source, sourceKey };
}

/** Next greater original column, independent of generated order, never the line length. */
function originalEnds(segments: Segment[]): Map<string, number> {
  const positions = new Map<string, Set<number>>();
  for (const segment of segments) {
    if (segment.source === undefined) continue;
    const key = `${segment.source}:${segment.line}`;
    const columns = positions.get(key) ?? new Set<number>();
    columns.add(segment.column);
    positions.set(key, columns);
  }
  const ends = new Map<string, number>();
  for (const [key, columns] of positions) {
    const sorted = [...columns].sort((a, b) => a - b);
    sorted.forEach((column, i) => ends.set(`${key}:${column}`, sorted[i + 1] ?? column));
  }
  return ends;
}

function originalSpan(segment: Segment, ends: Map<string, number>, original: OriginalSource): SourceSpan {
  const line = segment.line + 1;
  const text = original.lines?.[segment.line];
  if (original.lines && (text === undefined || segment.column > text.length))
    throw new Error('original position outside sourcesContent');
  const column = ends.get(`${segment.source}:${segment.line}:${segment.column}`) ?? segment.column;
  return { start: { line, column: segment.column }, end: { line, column } };
}

function ensureSourceFile(files: Map<string, ScriptSourceReach>, original: OriginalSource): ScriptSourceReach {
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
): ScriptSourceReach[] {
  const segments = mappedSegments(map, generated);
  const files = new Map<string, ScriptSourceReach>();
  const executions = segmentExecutions(segments, executionRuns(entry));
  const ends = originalEnds(segments);
  const originals = map.sources.map((_, index) => originalSource(map, index, mapUrl));
  segments.forEach((segment, index) => {
    if (segment.source === undefined || segment.offset >= segment.end) return;
    const original = originals[segment.source];
    if (!original) return;
    const file = ensureSourceFile(files, original);
    file[executions[index]].push(originalSpan(segment, ends, original));
  });
  for (const file of files.values()) normalizeSource(file);
  return [...files.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** Mapped app-file execution only, independent of generated URLs and capture origins. */
export function scriptExecutionProjection(evidence: ScriptReach): Omit<ScriptSourceReach, 'source'>[] {
  const files = evidence.scripts.filter((script) => script.status === 'mapped').flatMap((script) => script.files ?? []);
  const canonical = files.map(({ source, sourceKey, ...file }) =>
    JSON.stringify({ sourceKey: sourceKey ?? source, ...file }),
  );
  return [...new Set(canonical)].sort().map((file: string) => JSON.parse(file) as Omit<ScriptSourceReach, 'source'>);
}
