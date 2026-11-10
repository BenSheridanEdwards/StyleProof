/** J2 gap detail shares the after-findings byte budget; reserved notices stay small. */
import { scriptJoinGap, type ScriptJoinGap } from '../script-join.js';
import type { ReachGap } from './reach.js';

export type ScriptDetailBudget = { remaining: number };
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, null, 2));

export function takeScriptDetail(budget: ScriptDetailBudget, cost: number): boolean {
  if (cost > budget.remaining) return false;
  budget.remaining -= cost;
  return true;
}

export function scriptGapPathCount(gaps: readonly ReachGap[]): number {
  return gaps.reduce((sum, gap) => sum + (gap.join === 'J2' ? (gap.pathCount ?? gap.paths?.length ?? 0) : 0), 0);
}

const preview = (value: string, length: number): string =>
  value.length > length ? Array.from(value).slice(0, length).join('') + '…' : value;

export function gapRecordNotice(gaps: readonly ReachGap[], omitted: number): ScriptJoinGap {
  const first = gaps
    .filter((gap) => gap.join === 'J2')
    .slice(0, 2)
    .map((gap) => preview(gap.reason, 120))
    .join('; ');
  return {
    ...scriptJoinGap(`J2 gaps truncated: ${omitted} more omitted from report.json; first: ${first}`),
    remedy: 'review the remaining J2 evidence gaps; report.json shares a 64 KB J2 detail budget after style findings',
  };
}

export function gapPathNotice(omitted: number): ScriptJoinGap {
  return {
    ...scriptJoinGap(`J2 gap paths truncated: ${omitted} more omitted from report.json; full path counts retained`),
    remedy: 'review the remaining changed paths; report.json shares a 64 KB J2 detail budget after style findings',
  };
}

/** Full gap records and paths are both allocated only after diff findings. */
export function budgetScriptGaps(original: readonly ReachGap[], budget: ScriptDetailBudget) {
  const gaps: ReachGap[] = [];
  const paths: { original: string[]; stored: string[] }[] = [];
  const omitted: ReachGap[] = [];
  // The first omitted previews may be longer than the reserved first-record previews.
  // Keep their worst-case JSON growth inside J2's budget, after findings allocation.
  const noticeReserve = original.filter((gap) => gap.join === 'J2').length > 1 ? Math.min(2048, budget.remaining) : 0;
  budget.remaining -= noticeReserve;
  let listedPaths = 0;
  for (const gap of original) {
    if (gap.join !== 'J2') {
      gaps.push(gap);
      continue;
    }
    const entry: ReachGap = {
      ...gap,
      ...(gap.paths ? { paths: [], pathCount: gap.pathCount ?? gap.paths.length } : {}),
    };
    const cost = jsonBytes({ reach: { gaps: [entry] } }) - jsonBytes({ reach: { gaps: [] } });
    if (!takeScriptDetail(budget, cost)) {
      omitted.push(gap);
      continue;
    }
    gaps.push(entry);
    if (gap.paths) paths.push({ original: gap.paths, stored: entry.paths! });
  }
  if (!omitted.length) budget.remaining += noticeReserve;
  for (const entry of paths) listedPaths += storeGapPaths(entry.original, entry.stored, budget);
  const pathsOmitted = scriptGapPathCount(original) - listedPaths;
  if (omitted.length) gaps.push(gapRecordNotice(omitted, omitted.length));
  if (pathsOmitted) gaps.push(gapPathNotice(pathsOmitted));
  return { gaps, omitted: omitted.length, pathsOmitted };
}

function storeGapPaths(original: readonly string[], stored: string[], budget: ScriptDetailBudget): number {
  for (const file of original) {
    // Charge the first-item indentation each time: conservative even for escaped Unicode paths.
    const cost = jsonBytes({ reach: { gaps: [{ paths: [file] }] } }) - jsonBytes({ reach: { gaps: [{ paths: [] }] } });
    if (!takeScriptDetail(budget, cost)) break;
    stored.push(file);
  }
  return stored.length;
}
