import {
  classifyClassReach,
  combineClassReach,
  classJoinGap,
  type ClassUnit,
  type ClassJoinGap,
  type ClassMapPair,
} from '../class-join.js';
import { readScriptChanges, type ScriptChanges } from '../script-join-git.js';
import {
  classifyScriptReach,
  scriptJoinGap,
  compareSourceKeys,
  type ScriptJoinGap,
  type ScriptUnit,
} from '../script-join.js';
import { captureKeysIn, type StyleMap } from '../capture.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
import type { ChangeReachLevel } from '../config.js';
import { classifyRuleReach, type RuleReach, type RuleReachResult, type RuleReachStatus } from '../rule-reach.js';
import { createMapLoader, type RenderCtx } from './shared.js';

export type ReachGap =
  | ScriptJoinGap
  | ClassJoinGap
  | {
      join: 'J1' | 'J2' | 'J3';
      status: 'unknown' | 'unmeasured';
      side?: 'base' | 'head';
      /** Ledger gaps come from captures; not-built gaps name joins we do not record yet. */
      kind: 'ledger' | 'not-built';
      reason: string;
      remedy: string;
      paths?: string[];
      pathCount?: number;
    };

export type ReportReach = {
  level: ChangeReachLevel;
  /** Findings held by the opt-in gate; always zero at the default warn level. */
  blocking: number;
  complete: boolean;
  ledger: RuleReachResult['ledger'];
  counts: Record<RuleReachStatus, number>;
  /** Every changed rule, reached included, in classifier order. */
  rules: RuleReach[];
  unreadableSheets: number;
  /** J2 findings always stay warn-only, independently of J1 counts and blocking. */
  scripts: (ScriptUnit & { count?: number })[];
  scriptCounts: Record<ScriptUnit['status'], number>;
  /** Actual J2 evidence gaps before presentation truncation; notices never add to this count. */
  scriptGapCount?: number;
  /** J3 findings remain advisory at either level. No occurrence provenance is recorded. */
  classes?: ClassUnit[];
  classCounts?: Record<ClassUnit['status'], number>;
  classGapCount?: number;
  gaps: ReachGap[];
};

function ledgerGaps(maps: StyleMap[], side: 'base' | 'head'): ReachGap[] {
  const gaps: ReachGap[] = [];
  const add = (reason: string, remedy: string) =>
    gaps.push({ join: 'J1', status: 'unknown', side, kind: 'ledger', reason, remedy });
  if (maps.length === 0) {
    add(`no ${side} captures; changed rules cannot be listed`, 'capture both sides with `captureReach`');
  }
  const missing = maps.filter((m) => m.reach?.version !== 2 || m.reach.scope !== 'compared').length;
  if (missing) {
    add(
      `missing ${side} ledger on ${missing} capture(s); changed rules cannot be listed`,
      'recapture with `captureReach`',
    );
  }
  const reasons = [...new Set(maps.flatMap((map) => (map.reach?.unknown ? [map.reach.unknown] : [])))].sort(
    compareSourceKeys,
  );
  for (const reason of reasons) {
    const count = maps.filter((map) => map.reach?.unknown === reason).length;
    add(
      `served CSS reach is unknown on ${count} ${side} capture(s): ${reason}`,
      'simplify or remove the CSS shape named, then recapture',
    );
  }
  const unreadable = maps.reduce((sum, m) => sum + (m.reach?.unreadable ?? 0), 0);
  if (unreadable > 0) {
    add(
      `${unreadable} unreadable stylesheet(s) on ${side}; changed rules there cannot be listed`,
      'make the stylesheets readable (same-origin or CORS) and recapture',
    );
  }
  return gaps;
}

/** Opt-in reach evidence: incomplete joins can only add findings, never certify a run. */
export function assessReachMaps(
  base: StyleMap[],
  head: StyleMap[],
  level: ChangeReachLevel,
  sourceDiff?: ScriptChanges,
  pairs: readonly ClassMapPair[] = [],
): ReportReach | undefined {
  if (level === 'warn' && ![...base, ...head].some((map) => map.reach || map.scriptReach)) return undefined;
  const result = classifyRuleReach(base, head);
  const diff = sourceDiff ?? {
    changes: [],
    gaps: [...base, ...head].some((map) => map.scriptReach)
      ? [
          scriptJoinGap('base map SHA unavailable or dirty; changed source ranges cannot be listed', 'base'),
          scriptJoinGap('head map SHA unavailable or dirty; changed source ranges cannot be listed', 'head'),
        ]
      : [],
  };

  const classReach = classifyClassReach(base, head, diff.changes, pairs);
  if (!sourceDiff)
    classReach.gaps.push(
      classJoinGap(
        'changed source ranges unavailable; captureScriptReach and clean captured git revisions are required to list class occurrences',
      ),
    );
  diff.gaps
    .map((gap) => classJoinGap(`changed class occurrences unmeasured: ${gap.reason}`, gap.side))
    .forEach((appended) => classReach.gaps.push(appended));
  const script = classifyScriptReach(
    base,
    head,
    diff.changes,
    result.rules.flatMap((rule) =>
      rule.sourceRange ? [{ ...rule.sourceRange, join: 'J1' as const, status: rule.status }] : [],
    ),
  );

  script.units = combineClassReach(script.units, classReach.units);
  const gaps: ReachGap[] = [...ledgerGaps(base, 'base'), ...ledgerGaps(head, 'head'), ...script.gaps, ...diff.gaps];

  if (result.ledger !== 'complete' && !gaps.some((gap) => gap.kind === 'ledger')) {
    gaps.push({
      join: 'J1',
      status: 'unknown',
      kind: 'ledger',
      reason: 'reach ledger incomplete; changed rules cannot be listed',
      remedy: 'recapture with `captureReach`',
    });
  }
  gaps.push({
    join: 'J1',
    status: 'unknown',
    kind: 'not-built',
    reason:
      "changed stylesheets no capture served: StyleProof does not yet join the pull request's changed stylesheets with the sheets captures served, so a lazy route's or code-split chunk's changed CSS is not listed here",
    remedy: 'add a surface that loads each changed stylesheet; a later Change Reach phase (#934) adds the join',
  });
  classReach.gaps.forEach((appended) => gaps.push(appended));
  const counts: ReportReach['counts'] = { reached: 0, 'never-rendered': 0, unmeasured: 0, 'blind-channel': 0 };
  for (const rule of result.rules) counts[rule.status]++;
  const scriptCounts: ReportReach['scriptCounts'] = { reached: 0, 'never-rendered': 0, unmeasured: 0, unknown: 0 };

  for (const unit of script.units) scriptCounts[unit.status]++;

  const complete =
    gaps.length === 0 &&
    result.rules.every((rule) => rule.status === 'reached') &&
    script.units.every((unit) => unit.status === 'reached') &&
    classReach.units.every((unit) => unit.status === 'reached');

  const blocking =
    level === 'gate'
      ? counts['never-rendered'] +
        counts.unmeasured +
        counts['blind-channel'] +
        gaps.filter((gap) => gap.kind === 'ledger').length
      : 0;
  return {
    level,
    blocking,
    complete,
    ledger: result.ledger,
    counts,
    rules: result.rules,
    unreadableSheets: result.unreadableSheets,
    scripts: script.units,
    classes: classReach.units,
    classCounts: {
      reached: 0,
      'never-rendered': classReach.units.filter((unit) => unit.status === 'never-rendered').length,
      unknown: classReach.units.filter((unit) => unit.status === 'unknown').length,
      unmeasured: classReach.units.filter((unit) => unit.status === 'unmeasured').length,
    },
    classGapCount: gaps.filter((gap) => gap.join === 'J3').length,
    scriptCounts,
    scriptGapCount: gaps.filter((gap) => gap.join === 'J2').length,
    gaps,
  };
}

export function assessReach(
  ctx: Pick<RenderCtx, 'beforeDir' | 'afterDir' | 'load'>,
  level: ChangeReachLevel = 'warn',
): ReportReach | undefined {
  const mapsIn = (dir: string) => [...captureKeysIn(dir)].sort().map((key) => ctx.load(dir, key));

  const base = mapsIn(ctx.beforeDir),
    head = mapsIn(ctx.afterDir);

  if (level === 'warn' && ![...base, ...head].some((map) => map.reach || map.scriptReach)) return undefined;

  return assessReachMaps(
    base,
    head,
    level,
    [...base, ...head].some((map) => map.scriptReach)
      ? readScriptChanges(ctx.beforeDir, ctx.afterDir, { baseMaps: base, headMaps: head })
      : undefined,
    [...captureKeysIn(ctx.beforeDir)]
      .filter((key) => captureKeysIn(ctx.afterDir).includes(key))
      .sort(compareSourceKeys)
      .map((key) => ({ base: ctx.load(ctx.beforeDir, key), head: ctx.load(ctx.afterDir, key) })),
  );
}

export function assessReachDirs(beforeDir: string, afterDir: string, level: ChangeReachLevel): ReportReach | undefined {
  return assessReach({ beforeDir, afterDir, load: createMapLoader() }, level);
}

const gapReason = (gap: ReachGap): string => `${gap.side ? `${gap.side}: ` : ''}${gap.reason}`;

const MAX_NAMED_RULES = 5;

function namedRules(rules: RuleReach[]): string {
  const named = rules.slice(0, MAX_NAMED_RULES).map((rule) => codeValue(rule.key));
  return `${named.join(', ')}${rules.length > MAX_NAMED_RULES ? ` and ${rules.length - MAX_NAMED_RULES} more` : ''}`;
}

/**
 * What report.md says about Change Reach under the headline. When the opt-in gate holds
 * findings, nothing: the headline's "Reach gate" line already says so, and the findings are
 * listed under **Changed but never matched**. Otherwise only what a reviewer must act on, in
 * plain words: changed rules no captured page matched, and changed rules computed styles cannot
 * show. Join gaps, unmeasured rules and the warn-only J2/J3 detail stay in report.json (`reach`).
 */
export function reachHeadlineLines(reach: ReportReach): string[] {
  if (reach.blocking > 0) return [];
  const never = reach.rules.filter((rule) => rule.status === 'never-rendered');
  const blind = reach.rules.filter((rule) => rule.status === 'blind-channel');
  const lines: string[] = [];
  if (never.length) {
    const one = never.length === 1;
    lines.push(
      '',
      `⚠️ **${never.length} changed CSS rule${one ? '' : 's'} never matched on a captured page:** ${namedRules(never)}. ` +
        `Add a surface or state that shows ${one ? 'it' : 'them'}, or ${one ? 'it goes' : 'they go'} unreviewed.`,
    );
  }
  if (blind.length) {
    lines.push(
      '',
      `⚠️ **${blind.length} changed CSS rule${blind.length === 1 ? '' : 's'} computed styles cannot show:** ${namedRules(blind)}. Review ${blind.length === 1 ? 'it' : 'them'} in the diff.`,
    );
  }
  return lines;
}

function ruleTable(rules: RuleReach[]): string[] {
  return [
    '| Rule | Change | Gated by | Source | Why |',
    '| --- | --- | --- | --- | --- |',
    ...rules.map(
      (rule) =>
        `| ${codeValue(rule.key)} | ${rule.change} | ${rule.condition ? codeValue(rule.condition) : '—'} | ${rule.sheet ? codeValue(rule.sheet) : '—'} | ${escapeInlineMarkdown(rule.why)} |`,
    ),
  ];
}

export function reachSectionLines(reach: ReportReach): string[] {
  const never = reach.rules.filter((rule) => rule.status === 'never-rendered');
  const unmeasured = reach.rules.filter((rule) => rule.status === 'unmeasured');
  const blind = reach.rules.filter((rule) => rule.status === 'blind-channel');
  const ledger = reach.gaps.filter((gap) => gap.kind === 'ledger');
  // The warn-only J2/J3 detail never holds the gate, so it stays in report.json.
  if (never.length === 0 && unmeasured.length === 0 && blind.length === 0 && ledger.length === 0) return [];

  return [
    '',
    '## Changed but never matched',
    '',
    '_Changed CSS rules no captured state matched, so the diff above cannot show them. Add a surface or state that matches each one. Source is the served stylesheet; the ledger does not record source maps yet. ' +
      (reach.level === 'gate'
        ? "Under `changeReach: 'gate'` these findings hold the verdict: certify mode fails; review-gate mode needs approval._"
        : 'Reach findings do not change the verdict._'),
    '',
    ...ruleTable(never),
    ...(unmeasured.length
      ? [
          '',
          '**Changed but unmeasured** — matched only elements StyleProof does not compare (including required consumers or referrers); computed-style evidence does not cover these changes.',
          '',
          ...ruleTable(unmeasured),
        ]
      : []),
    ...(blind.length
      ? [
          '',
          '**Changed in a channel computed styles cannot hold** (`@keyframes`, `@font-face`, `@property`)',
          '',
          ...ruleTable(blind),
        ]
      : []),
    ...(ledger.length
      ? [
          '',
          '**Reach evidence gaps** — changed rules here cannot be listed',
          '',
          ...ledger.map((gap) => `- ${gapReason(gap)} — ${gap.remedy}`),
        ]
      : []),
    '',
    reach.level === 'gate' ? "**Not checked** (not held by `changeReach: 'gate'`)" : '**Not checked**',
    '',
    ...reach.gaps
      .filter((gap) => gap.kind === 'not-built' && gap.join === 'J1')
      .map((gap) => `- ${gap.reason} — ${gap.remedy}`),
  ];
}

export function reachSummaryLine(reach: ReportReach): string {
  const gaps = reach.gaps.filter((gap) => gap.kind === 'ledger').length;

  return `- Changed but never matched: ${reach.counts['never-rendered']} rule(s), ${reach.counts.unmeasured} unmeasured, ${reach.counts['blind-channel']} blind-channel, ${gaps} evidence gap(s); changed stylesheets no capture served are not checked${reach.level === 'gate' ? " (not held by `changeReach: 'gate'`)" : ''}; full list in report.json under \`reach\``;
}
