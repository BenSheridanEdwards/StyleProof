/** Boolean range evidence, grouped by side/file and merged for logarithmic overlap lookup. */
import type { SourcePosition, SourceSpan } from './script-reach.js';

type Evidence = {
  sourceKey?: string;
  paths?: string[];
  side?: 'base' | 'head';
  range?: SourceSpan;
  ranges?: readonly SourceSpan[];
};
type Bucket = { all: boolean; ranges: SourceSpan[] };
const compare = (a: SourcePosition, b: SourcePosition) => a.line - b.line || a.column - b.column;
const key = (file: string, side: string) => `${side}\u0000${file}`;

function merge(ranges: SourceSpan[]): SourceSpan[] {
  ranges.sort((a, b) => compare(a.start, b.start) || compare(a.end, b.end));
  const merged: SourceSpan[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (!last || compare(last.end, range.start) < 0) merged.push({ ...range });
    else if (compare(last.end, range.end) < 0) last.end = range.end;
  }
  return merged;
}
function overlaps(bucket: Bucket | undefined, range: SourceSpan): boolean {
  if (!bucket) return false;
  if (bucket.all) return true;
  let low = 0,
    high = bucket.ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(bucket.ranges[mid].end, range.start) <= 0) low = mid + 1;
    else high = mid;
  }
  return low < bucket.ranges.length && compare(bucket.ranges[low].start, range.end) < 0;
}
export function scopedRangeLookup(
  entries: readonly Evidence[],
): (query: Required<Pick<Evidence, 'sourceKey' | 'side' | 'range'>>) => boolean {
  const buckets = new Map<string, Bucket>();
  for (const entry of entries) {
    for (const file of entry.paths ?? [entry.sourceKey ?? '*']) {
      const name = key(file, entry.side ?? '*');
      const bucket = buckets.get(name) ?? { all: false, ranges: [] };
      if (entry.ranges) entry.ranges.forEach((range) => bucket.ranges.push(range));
      else if (entry.range) bucket.ranges.push(entry.range);
      else bucket.all = true;
      buckets.set(name, bucket);
    }
  }
  for (const bucket of buckets.values()) bucket.ranges = bucket.all ? [] : merge(bucket.ranges);
  return ({ sourceKey, side, range }) =>
    [key(sourceKey, side), key(sourceKey, '*'), key('*', side), key('*', '*')].some((name) =>
      overlaps(buckets.get(name), range),
    );
}
