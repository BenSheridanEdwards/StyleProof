/** Bounded J2 presentation. Full classifier units and counts remain in the assessment. */
import { compareScriptRanges, scriptJoinGap, type ScriptUnit } from '../script-join.js';
import type { ReportReach } from './reach.js';

export type ScriptUnitRange = ScriptUnit & { count: number };
const MAX_SCRIPT_JSON_BYTES = 64_000;
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, null, 2));

function adjacent(previous: ScriptUnitRange, next: ScriptUnit): boolean {
  return (
    previous.changeScope === 'line' &&
    next.changeScope === 'line' &&
    previous.sourceKey === next.sourceKey &&
    previous.side === next.side &&
    previous.status === next.status &&
    previous.why === next.why &&
    previous.execution === next.execution &&
    previous.executionScope === next.executionScope &&
    previous.range.end.line + 1 === next.range.start.line
  );
}

/** Token ranges never grow into unrelated columns on neighboring lines. */
export function scriptUnitRanges(units: (ScriptUnit & { count?: number })[]): ScriptUnitRange[] {
  const ranges: ScriptUnitRange[] = [];
  for (const unit of [...units].sort(compareScriptRanges)) {
    const previous = ranges.at(-1);
    if (previous && adjacent(previous, unit)) {
      previous.range.end = { ...unit.range.end };
      previous.count += unit.count ?? 1;
    } else
      ranges.push({
        ...unit,
        range: { start: { ...unit.range.start }, end: { ...unit.range.end } },
        count: unit.count ?? 1,
      });
  }
  return ranges;
}

const unitCount = (units: (ScriptUnit & { count?: number })[]): number =>
  units.reduce((sum, unit) => sum + (unit.count ?? 1), 0);

function truncationGap(omitted: number) {
  return {
    ...scriptJoinGap(`J2 units truncated: ${omitted} more in report.json; full status counts retained`),
    remedy: 'review the remaining changed source ranges; J2 JSON detail is capped at 64 KB after style findings',
  };
}

/** Reserve only the mandatory notice before allocating space to diff findings. */
export function reserveScriptNotice(reach: ReportReach | undefined): ReportReach | undefined {
  if (!reach?.scripts.length) return reach;
  return { ...reach, scripts: [], gaps: [...reach.gaps, truncationGap(unitCount(reach.scripts))] };
}

/** Pretty-printed cost at the actual reach.scripts nesting depth, including array indentation. */
function unitBytes(unit: ScriptUnit & { count?: number }): number {
  return jsonBytes({ reach: { scripts: [unit] } }) - jsonBytes({ reach: { scripts: [] } });
}

/** Diff findings have already been allocated; J2 can consume only leftover bytes. */
export function budgetScriptReach(
  original: ReportReach | undefined,
  reserved: ReportReach | undefined,
  available: number,
) {
  if (!original?.scripts.length || !reserved) return { reach: reserved, omitted: 0 };
  const scripts: (ScriptUnit & { count?: number })[] = [];
  let bytes = 0,
    listed = 0;
  for (const { count, ...unit } of scriptUnitRanges(original.scripts)) {
    const entry = count > 1 ? { ...unit, count } : unit;
    const cost = unitBytes(entry) - (scripts.length ? 4 : 0);
    if (bytes + cost > Math.min(MAX_SCRIPT_JSON_BYTES, Math.max(0, available))) break;
    scripts.push(entry);
    listed += count;
    bytes += cost;
  }
  const omitted = unitCount(original.scripts) - listed;
  return {
    reach: {
      ...reserved,
      scripts,
      complete: original.complete && omitted === 0,
      gaps: [...original.gaps, ...(omitted ? [truncationGap(omitted)] : [])],
    },
    omitted,
  };
}
