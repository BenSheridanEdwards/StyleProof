/** J2 gap detail shares the after-findings byte budget; reserved notices stay small. */
import { scriptJoinGap, type ScriptJoinGap } from '../script-join.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
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
    ...scriptJoinGap(`J2 gaps truncated: ${omitted} more in report.json; first: ${first}`),
    remedy: 'review the remaining J2 evidence gaps; report.json shares a 64 KB J2 detail budget after style findings',
  };
}

export function gapPathNotice(omitted: number): ScriptJoinGap {
  return {
    ...scriptJoinGap(`J2 gap paths truncated: ${omitted} more in report.json; full path counts retained`),
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

/** Human detail has its own fixed cap and always names omitted records and paths. */
export function scriptGapLines(gaps: readonly ReachGap[]): string[] {
  const notice = (gap: ReachGap): boolean => /^J2 (?:gap paths|gaps|units) truncated:/.test(gap.reason);
  const records = gaps.filter((gap) => !notice(gap));
  const lines = gaps.filter(notice).map(gapLine);
  let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0),
    shownGaps = 0,
    shownPaths = 0;
  const append = (line: string): boolean => {
    const cost = Buffer.byteLength(line) + 1;
    if (bytes + cost > 63_000) return false;
    lines.push(line);
    bytes += cost;
    return true;
  };
  for (const gap of records.slice(0, 100)) {
    if (!append(gapLine(gap))) break;
    shownGaps++;
    for (const file of gap.paths ?? []) {
      if (shownPaths === 100 || !append(`- ${codeValue(file)}`)) break;
      shownPaths++;
    }
  }
  if (shownGaps < records.length) lines.push(`- J2 gaps truncated: ${records.length - shownGaps} more in this report.`);
  const hiddenPaths = scriptGapPathCount(gaps) - shownPaths;
  if (hiddenPaths)
    lines.push(`- J2 gap paths truncated: ${hiddenPaths} more in this report; full path counts retained.`);
  return lines;
}

function gapLine(gap: ReachGap): string {
  const reason = `${gap.side ? `${gap.side}: ` : ''}${preview(gap.reason, 1000)}`;
  return `- ${escapeInlineMarkdown(reason)} — ${escapeInlineMarkdown(preview(gap.remedy, 400))}`;
}
