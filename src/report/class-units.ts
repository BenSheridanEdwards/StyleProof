/** J3 presentation shares the after-findings detail budget with J2. */
import { classJoinGap, type ClassUnit } from '../class-join.js';
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
    reach: {
      ...reserved,
      complete: reserved.complete && unitsOmitted === 0 && gapsOmitted === 0,
      classes,
      gaps: [...reserved.gaps.filter((gap) => gap.join !== 'J3'), ...gaps],
    },
    omitted: unitsOmitted + gapsOmitted,
  };
}
