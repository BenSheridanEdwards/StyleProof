/** J3 presentation shares the after-findings detail budget with J2. */
import { classJoinGap, type ClassUnit } from '../class-join.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
import { jsonBytes, takeScriptDetail, type ScriptDetailBudget } from './script-gap-details.js';
import type { ReportReach, ReachGap } from './reach.js';

const notice = (units: number, gaps: number) => ({
  ...classJoinGap(`J3 detail truncated: ${units} unit(s), ${gaps} gap(s) omitted; full counts retained`),
  remedy:
    'review remaining changed class occurrences and evidence gaps; J2/J3 detail shares 64 KB after style findings',
});
export function reserveClassNotice(reach: ReportReach): ReportReach {
  const classes = reach.classes ?? [],
    gaps = reach.gaps.filter((gap) => gap.join !== 'J3');
  const count = reach.gaps.length - gaps.length;
  if (classes.length || count) gaps.push(notice(classes.length, count));
  return { ...reach, classes: [], gaps };
}

export function budgetClassReach(original: ReportReach, reserved: ReportReach, budget: ScriptDetailBudget) {
  const classes: ClassUnit[] = [],
    gaps: ReachGap[] = [];
  for (const unit of original.classes ?? []) {
    const cost = jsonBytes({ reach: { classes: [unit] } }) - jsonBytes({ reach: { classes: [] } });
    if (!takeScriptDetail(budget, cost)) break;
    classes.push(unit);
  }
  for (const gap of original.gaps.filter((entry) => entry.join === 'J3')) {
    const cost = jsonBytes({ reach: { gaps: [gap] } }) - jsonBytes({ reach: { gaps: [] } });
    if (!takeScriptDetail(budget, cost)) break;
    gaps.push(gap);
  }
  const unitsOmitted = (original.classes?.length ?? 0) - classes.length;
  const gapsOmitted = original.gaps.filter((gap) => gap.join === 'J3').length - gaps.length;
  if (unitsOmitted || gapsOmitted) gaps.push(notice(unitsOmitted, gapsOmitted));
  return {
    reach: { ...reserved, classes, gaps: [...reserved.gaps.filter((gap) => gap.join !== 'J3'), ...gaps] },
    omitted: unitsOmitted + gapsOmitted,
  };
}

export function classSummary(reach: ReportReach): string {
  const counts = reach.classCounts ?? { reached: 0, 'never-rendered': 0, unknown: 0, unmeasured: 0 };
  return `; J3: ${Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(
      ', ',
    )}, ${reach.classGapCount ?? reach.gaps.filter((gap) => gap.join === 'J3').length} run-level gap(s) (warn-only)`;
}
export function classSectionLines(reach: ReportReach): string[] {
  const units = reach.classes ?? [],
    gaps = reach.gaps.filter((gap) => gap.join === 'J3');
  if (!units.length && !gaps.length) return [];
  return [
    '',
    '## Class change reach (J3)',
    '',
    '_Warn-only under both changeReach levels. No per-occurrence render provenance is recorded. Token-name deltas never prove reach; J3 never upgrades J2._',
    '',
    '| Source | Side | Token | Status | Why |',
    '| --- | --- | --- | --- | --- |',
    ...units
      .slice(0, 100)
      .map(
        (unit) =>
          `| ${codeValue(`${unit.sourceKey}:${unit.range.start.line}:${unit.range.start.column}-${unit.range.end.line}:${unit.range.end.column}`)} | ${unit.side} | ${codeValue(unit.token)} | ${unit.status} | ${escapeInlineMarkdown(unit.why)} |`,
      ),
    ...(units.length > 100
      ? [`+${units.length - 100} more class unit(s); report.json retains bounded detail and full counts.`]
      : []),
    ...gaps
      .slice(0, 100)
      .map(
        (gap) =>
          `- ${escapeInlineMarkdown(`${gap.side ? `${gap.side}: ` : ''}${gap.reason.slice(0, 1000)}`)} — ${escapeInlineMarkdown(gap.remedy.slice(0, 400))}`,
      ),
    ...(gaps.length > 100 ? [`- J3 gaps truncated: ${gaps.length - 100} more; full count retained.`] : []),
  ];
}
