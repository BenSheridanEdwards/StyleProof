/** Summaries are bounded; exact unresolved ranges stay internal to classification. */
import type { ClassJoinGap } from './class-join.js';
import type { ScriptChange } from './script-join.js';
import type { SourceSpan } from './script-reach.js';

type Bucket = { sourceKey: string; side: 'base' | 'head'; ranges: SourceSpan[]; seen: Set<string> };
const compare = (a: SourceSpan, b: SourceSpan) =>
  a.start.line - b.start.line ||
  a.start.column - b.start.column ||
  a.end.line - b.end.line ||
  a.end.column - b.end.column;

export function unresolvedClassGaps(
  makeGap: (reason: string, side: 'base' | 'head', sourceKey: string) => ClassJoinGap,
) {
  const buckets = new Map<string, Bucket>();
  const add = (change: ScriptChange, range: SourceSpan): void => {
    const key = `${change.side}\u0000${change.sourceKey}`;
    const bucket = buckets.get(key) ?? { sourceKey: change.sourceKey, side: change.side, ranges: [], seen: new Set() };
    const position = `${range.start.line}:${range.start.column}:${range.end.line}:${range.end.column}`;
    if (!bucket.seen.has(position)) {
      bucket.seen.add(position);
      bucket.ranges.push(range);
    }
    buckets.set(key, bucket);
  };
  const summaries = (): ClassJoinGap[] =>
    [...buckets.values()].map((bucket) => {
      const sampleRanges = bucket.ranges.sort(compare).slice(0, 10);
      return {
        ...makeGap(
          `${bucket.sourceKey}: explicit class expression unresolved; no served class tokens (${bucket.ranges.length} occurrence(s); first ${sampleRanges.length} ranges sampled)`,
          bucket.side,
          bucket.sourceKey,
        ),
        occurrenceCount: bucket.ranges.length,
        sampleRanges,
      };
    });
  return { add, evidence: () => [...buckets.values()], summaries };
}
