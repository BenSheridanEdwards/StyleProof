/** Pure source-map v3 decoding and conservative projection of binary V8 block coverage. */
import { createHash } from 'node:crypto';

export type SourcePosition = { line: number; column: number };
/** Original lines are 1-based, UTF-16 columns 0-based, ends exclusive. Equal ends are mapping anchors. */
export type SourceSpan = { start: SourcePosition; end: SourcePosition };
export type ScriptSourceReach = {
  source: string;
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
  functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[];
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

function execution(entry: BinaryScriptCoverage, start: number, end: number): 'executed' | 'mixed' | 'unexecuted' {
  const ranges = entry.functions.flatMap((f) => f.ranges).filter((r) => r.startOffset < end && r.endOffset > start);
  const edges = [
    ...new Set([start, end, ...ranges.flatMap((r) => [Math.max(start, r.startOffset), Math.min(end, r.endOffset)])]),
  ].sort((a, b) => a - b);
  const states = edges.slice(0, -1).map((offset) => {
    const containing = ranges.filter((r) => r.startOffset <= offset && offset < r.endOffset);
    const size = Math.min(...containing.map((r) => r.endOffset - r.startOffset));
    // Conflicting equally-specific evidence cannot prove full execution.
    return (
      containing.filter((r) => r.endOffset - r.startOffset === size).every((r) => r.count > 0) && containing.length > 0
    );
  });
  return states.every(Boolean) ? 'executed' : states.some(Boolean) ? 'mixed' : 'unexecuted';
}

/** No dependency source, including webpack URLs, contributes app execution evidence. */
export function isAppScriptSource(source: string): boolean {
  return !/(^|[\\/])node_modules[\\/]/.test(source);
}

type ExecutionKind = 'executed' | 'mixed' | 'unexecuted';
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

type OriginalSource = { source: string; contentHash?: string; lines?: string[] };

function originalSource(map: SourceMap, index: number, mapUrl: string): OriginalSource | undefined {
  const source = new URL(
    map.sources[index],
    new URL(map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '.', mapUrl),
  ).href;
  if (!isAppScriptSource(source)) return undefined;
  const content = map.sourcesContent?.[index];
  return typeof content === 'string'
    ? { source, contentHash: createHash('sha256').update(content).digest('hex'), lines: content.split('\n') }
    : { source };
}

function originalSpan(segment: Segment, next: Segment | undefined, original: OriginalSource): SourceSpan {
  const line = segment.line + 1;
  const text = original.lines?.[segment.line];
  if (original.lines && (text === undefined || segment.column > text.length))
    throw new Error('original position outside sourcesContent');
  const column =
    next && next.source === segment.source && next.line === segment.line && next.column > segment.column
      ? next.column
      : (text?.length ?? segment.column);
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
 * A split segment is mixed. With no next same-line anchor or original content, keep a point anchor.
 */
export function mapScriptCoverage(
  entry: BinaryScriptCoverage,
  generated: string,
  map: SourceMap,
  mapUrl: string,
): ScriptSourceReach[] {
  const segments = mappedSegments(map, generated);
  const files = new Map<string, ScriptSourceReach>();
  const originals = map.sources.map((_, index) => originalSource(map, index, mapUrl));
  segments.forEach((segment, index) => {
    if (segment.source === undefined || segment.offset >= segment.end) return;
    const original = originals[segment.source];
    if (!original) return;
    const file = ensureSourceFile(files, original);
    file[execution(entry, segment.offset, segment.end)].push(originalSpan(segment, segments[index + 1], original));
  });
  for (const file of files.values()) normalizeSource(file);
  return [...files.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}
