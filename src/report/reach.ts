import { captureKeysIn, type StyleMap } from '../capture.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
import type { ChangeReachLevel } from '../config.js';
import { classifyRuleReach, type RuleReach, type RuleReachResult, type RuleReachStatus } from '../rule-reach.js';
import { createMapLoader, type RenderCtx } from './shared.js';

export type ReachGap = {
  join: 'J1' | 'J2' | 'J3';
  status: 'unknown' | 'unmeasured';
  side?: 'base' | 'head';
  /** Ledger gaps come from captures; not-built gaps name joins we do not record yet. */
  kind: 'ledger' | 'not-built';
  reason: string;
  remedy: string;
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
  gaps: ReachGap[];
};

function ledgerGaps(maps: StyleMap[], side: 'base' | 'head'): ReachGap[] {
  const gaps: ReachGap[] = [];
  const add = (reason: string, remedy: string) =>
    gaps.push({ join: 'J1', status: 'unknown', side, kind: 'ledger', reason, remedy });
  if (maps.length === 0) {
    add(`no ${side} captures; changed rules cannot be listed`, 'capture both sides with `captureReach`');
  }
  const missing = maps.filter((m) => m.reach?.version !== 2).length;
  if (missing) {
    add(
      `missing ${side} ledger on ${missing} capture(s); changed rules cannot be listed`,
      'recapture with `captureReach`',
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
  keys?: { base: readonly string[]; head: readonly string[] },
): ReportReach | undefined {
  if (level === 'warn' && ![...base, ...head].some((map) => map.reach)) return undefined;
  const result = classifyRuleReach(base, head, keys);
  const gaps = [...ledgerGaps(base, 'base'), ...ledgerGaps(head, 'head')];
  if (result.ledger !== 'complete' && gaps.length === 0) {
    gaps.push({
      join: 'J1',
      status: 'unknown',
      kind: 'ledger',
      reason: 'reach ledger incomplete; changed rules cannot be listed',
      remedy: 'recapture with `captureReach`',
    });
  }
  const remedy = 'none yet: a later Change Reach phase (#934) adds it';
  gaps.push(
    {
      join: 'J1',
      status: 'unknown',
      kind: 'not-built',
      reason:
        'changed stylesheets in the pull request are not yet joined with the sheets captures served; a changed sheet no capture served cannot be listed',
      remedy,
    },
    { join: 'J2', status: 'unmeasured', kind: 'not-built', reason: 'render-code coverage is not recorded yet', remedy },
    { join: 'J3', status: 'unmeasured', kind: 'not-built', reason: 'class-list deltas are not recorded yet', remedy },
  );
  const counts: ReportReach['counts'] = { reached: 0, 'never-rendered': 0, 'blind-channel': 0 };
  for (const rule of result.rules) counts[rule.status]++;
  const complete = gaps.length === 0 && result.rules.every((rule) => rule.status === 'reached');
  const blocking =
    level === 'gate'
      ? counts['never-rendered'] + counts['blind-channel'] + gaps.filter((gap) => gap.kind === 'ledger').length
      : 0;
  return {
    level,
    blocking,
    complete,
    ledger: result.ledger,
    counts,
    rules: result.rules,
    unreadableSheets: result.unreadableSheets,
    gaps,
  };
}

export function assessReach(
  ctx: Pick<RenderCtx, 'beforeDir' | 'afterDir' | 'load'>,
  level: ChangeReachLevel = 'warn',
): ReportReach | undefined {
  const keysIn = (dir: string) => [...captureKeysIn(dir)].sort();
  const baseKeys = keysIn(ctx.beforeDir);
  const headKeys = keysIn(ctx.afterDir);
  return assessReachMaps(
    baseKeys.map((key) => ctx.load(ctx.beforeDir, key)),
    headKeys.map((key) => ctx.load(ctx.afterDir, key)),
    level,
    { base: baseKeys, head: headKeys },
  );
}

export function assessReachDirs(beforeDir: string, afterDir: string, level: ChangeReachLevel): ReportReach | undefined {
  return assessReach({ beforeDir, afterDir, load: createMapLoader() }, level);
}

const gapReason = (gap: ReachGap): string => `${gap.side ? `${gap.side}: ` : ''}${gap.reason}`;

/** Fixed copy and counts only; CSS evidence is escaped in the detail tables below. */
export function reachStripLines(reach: ReportReach): string[] {
  if (
    reach.complete &&
    reach.ledger === 'complete' &&
    reach.gaps.length === 0 &&
    reach.rules.every((rule) => rule.status === 'reached')
  ) {
    return ['', '**Reach complete** — every changed rule rendered in a captured state.'];
  }
  const never = reach.counts['never-rendered'];
  const blind = reach.counts['blind-channel'];
  const ledger = reach.gaps.filter((gap) => gap.kind === 'ledger');
  if (!never && !blind && ledger.length === 0) {
    return [
      '',
      `**Reach incomplete** — every changed served CSS rule rendered (${reach.rules.length}); render-code reach and the changed-stylesheet join are not measured yet.`,
    ];
  }
  const parts: string[] = [];
  const remedies: string[] = [];
  if (never) {
    parts.push(`${never} changed CSS rule(s) never rendered`);
    remedies.push('add a surface or state that renders each rule under **Changed but never rendered**');
  }
  if (blind) {
    parts.push(`${blind} changed in a channel computed styles cannot hold`);
    remedies.push('review the changes under **Changed in a channel computed styles cannot hold**');
    if (reach.rules.some((rule) => rule.status === 'blind-channel' && rule.pixels?.length)) {
      remedies.push('compare the screenshots of each changed `@font-face` with `styleproof-diff --pixels`');
    }
  }
  parts.push(...ledger.map(gapReason));
  remedies.push(...ledger.map((gap) => gap.remedy));
  return [
    '',
    `**Reach incomplete** — ${parts.join('; ')}. Fix: ${[...new Set(remedies)].join('; ')}. Render-code reach is not measured yet.${reach.blocking > 0 ? " Held by `changeReach: 'gate'`." : ''}`,
  ];
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
  const blind = reach.rules.filter((rule) => rule.status === 'blind-channel');
  const ledger = reach.gaps.filter((gap) => gap.kind === 'ledger');
  if (never.length === 0 && blind.length === 0 && ledger.length === 0) return [];
  return [
    '',
    '## Changed but never rendered',
    '',
    '_Changed CSS rules no captured state rendered, so the diff above cannot show them. Add a surface or state that renders each one. Source is the served stylesheet; the ledger does not record source maps yet. ' +
      (reach.level === 'gate'
        ? "Under `changeReach: 'gate'` these findings hold the verdict: certify mode fails (`CERTIFICATION_FAILED`); review-gate mode needs approval._"
        : 'Reach findings do not change the verdict._'),
    '',
    ...ruleTable(never),
    ...(blind.length
      ? [
          '',
          '**Changed in a channel computed styles cannot hold** (`@keyframes`, `@font-face`, `@property`)',
          '',
          ...ruleTable(blind),
          ...(blind.some((rule) => rule.pixels?.length)
            ? [
                '',
                'Computed styles cannot show a font change. Compare these captures with `styleproof-diff <base> <head> --pixels`:',
                '',
                ...blind
                  .filter((rule) => rule.pixels?.length)
                  .map((rule) => `- ${codeValue(rule.key)}: ${rule.pixels!.map(codeValue).join(', ')}`),
              ]
            : []),
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
  ];
}

export function reachSummaryLine(reach: ReportReach): string {
  const gaps = reach.gaps.filter((gap) => gap.kind === 'ledger').length;
  return `- Changed but never rendered: ${reach.counts['never-rendered']} rule(s), ${reach.counts['blind-channel']} blind-channel, ${gaps} evidence gap(s); full list in report.json under \`reach\``;
}
