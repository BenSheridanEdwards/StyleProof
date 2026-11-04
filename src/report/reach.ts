import { readScriptChanges, type ScriptChanges } from '../script-join-git.js';
import { classifyScriptReach, scriptJoinGap, type ScriptJoinGap, type ScriptUnit } from '../script-join.js';
import { captureKeysIn, type StyleMap } from '../capture.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
import type { ChangeReachLevel } from '../config.js';
import { classifyRuleReach, type RuleReach, type RuleReachResult, type RuleReachStatus } from '../rule-reach.js';
import { createMapLoader, type RenderCtx } from './shared.js';

export type ReachGap =
  | ScriptJoinGap
  | {
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
  /** J2 findings always stay warn-only, independently of J1 counts and blocking. */
  scripts: ScriptUnit[];
  scriptCounts: Record<ScriptUnit['status'], number>;
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

  const reasons = [...new Set(maps.flatMap((map) => (map.reach?.unknown ? [map.reach.unknown] : [])))].sort();

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
  sourceDiff: ScriptChanges = {
    changes: [],
    gaps: [
      scriptJoinGap('base map SHA unavailable or dirty; changed source ranges cannot be listed', 'base'),
      scriptJoinGap('head map SHA unavailable or dirty; changed source ranges cannot be listed', 'head'),
    ],
  },
): ReportReach | undefined {
  if (level === 'warn' && ![...base, ...head].some((map) => map.reach || map.scriptReach)) return undefined;
  const result = classifyRuleReach(base, head);

  const script = classifyScriptReach(
    base,
    head,
    sourceDiff.changes,
    result.rules.flatMap((rule) =>
      rule.sourceRange ? [{ ...rule.sourceRange, join: 'J1' as const, status: rule.status }] : [],
    ),
  );

  const gaps: ReachGap[] = [
    ...ledgerGaps(base, 'base'),
    ...ledgerGaps(head, 'head'),
    ...script.gaps,
    ...sourceDiff.gaps,
  ];

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
        "changed stylesheets no capture served: StyleProof does not yet join the pull request's changed stylesheets with the sheets captures served, so a lazy route's or code-split chunk's changed CSS is not listed here",
      remedy: 'add a surface that loads each changed stylesheet; a later Change Reach phase (#934) adds the join',
    },
    { join: 'J3', status: 'unmeasured', kind: 'not-built', reason: 'class-list deltas are not recorded yet', remedy },
  );
  const counts: ReportReach['counts'] = { reached: 0, 'never-rendered': 0, unmeasured: 0, 'blind-channel': 0 };

  for (const rule of result.rules) counts[rule.status]++;
  const scriptCounts: ReportReach['scriptCounts'] = { reached: 0, 'never-rendered': 0, unmeasured: 0, unknown: 0 };

  for (const unit of script.units) scriptCounts[unit.status]++;

  const complete =
    gaps.length === 0 &&
    result.rules.every((rule) => rule.status === 'reached') &&
    script.units.every((unit) => unit.status === 'reached');

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
    scriptCounts,
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

  const sourceKeys = [
    ...new Set(
      [...base, ...head].flatMap(
        (map) =>
          map.scriptReach?.scripts.flatMap(
            (script) => script.files?.flatMap((file) => (file.sourceKey ? [file.sourceKey] : [])) ?? [],
          ) ?? [],
      ),
    ),
  ].sort();

  return assessReachMaps(base, head, level, readScriptChanges(ctx.beforeDir, ctx.afterDir, { sourceKeys }));
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
    reach.rules.every((rule) => rule.status === 'reached') &&
    (reach.scripts ?? []).every((unit) => unit.status === 'reached')
  ) {
    return ['', '**Reach complete** — every changed rule matched a captured element in a captured state.'];
  }

  const scriptStrip = scriptStripLines(reach);

  const unchecked =
    "Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS) and class-list deltas." +
    (reach.level === 'gate' ? " These are not held by `changeReach: 'gate'`." : '');

  const never = reach.counts['never-rendered'];
  const unmeasured = reach.counts.unmeasured;
  const blind = reach.counts['blind-channel'];
  const ledger = reach.gaps.filter((gap) => gap.kind === 'ledger');

  if (!never && !unmeasured && !blind && ledger.length === 0) {
    return [
      '',
      `**Reach incomplete** — ${reach.rules.length ? `${reach.rules.length} changed CSS rule(s) in served stylesheets matched a captured element` : 'no changed CSS rule in any served stylesheet'}. ${unchecked}`,
      ...scriptStrip,
    ];
  }

  const parts: string[] = [];
  const remedies: string[] = [];

  if (never) {
    parts.push(`${never} changed CSS rule(s) never matched`);
    remedies.push('add a surface or state that matches each rule under **Changed but never matched**');
  }

  if (unmeasured) {
    parts.push(`${unmeasured} changed CSS rule(s) unmeasured`);
    remedies.push(
      'review the changes under **Changed but unmeasured** and capture them on compared elements where possible',
    );
  }

  if (blind) {
    parts.push(`${blind} changed in a channel computed styles cannot hold`);
    remedies.push('review the changes under **Changed in a channel computed styles cannot hold**');
  }

  parts.push(...ledger.map(gapReason));
  remedies.push(...ledger.map((gap) => gap.remedy));

  return [
    '',
    `**Reach incomplete** — ${parts.join('; ')}. Fix: ${[...new Set(remedies)].join('; ')}. ${reach.blocking > 0 ? unchecked.replace(" These are not held by `changeReach: 'gate'`.", " The findings above are held by `changeReach: 'gate'`; the unchecked items are not.") : unchecked}`,
    ...scriptStrip,
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
  const unmeasured = reach.rules.filter((rule) => rule.status === 'unmeasured');
  const blind = reach.rules.filter((rule) => rule.status === 'blind-channel');
  const ledger = reach.gaps.filter((gap) => gap.kind === 'ledger');
  const scriptLines = scriptSectionLines(reach);

  if (never.length === 0 && unmeasured.length === 0 && blind.length === 0 && ledger.length === 0) return scriptLines;

  return [
    '',
    '## Changed but never matched',
    '',
    '_Changed CSS rules no captured state matched, so the diff above cannot show them. Add a surface or state that matches each one. Source is the served stylesheet; the ledger does not record source maps yet. ' +
      (reach.level === 'gate'
        ? "Under `changeReach: 'gate'` these findings hold the verdict: certify mode fails (`CERTIFICATION_FAILED`); review-gate mode needs approval._"
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
    ...scriptLines,
  ];
}

export function reachSummaryLine(reach: ReportReach): string {
  const gaps = reach.gaps.filter((gap) => gap.kind === 'ledger').length;

  return `- Changed but never matched: ${reach.counts['never-rendered']} rule(s), ${reach.counts.unmeasured} unmeasured, ${reach.counts['blind-channel']} blind-channel, ${gaps} evidence gap(s); changed stylesheets no capture served are not checked${reach.level === 'gate' ? " (not held by `changeReach: 'gate'`)" : ''}; full list in report.json under \`reach\`${scriptSummary(reach)}`;
}

function scriptSummary(reach: ReportReach): string {
  const scripts = reach.scripts ?? [];
  const gaps = reach.gaps.filter((gap) => gap.join === 'J2').length;
  const statuses = ['reached', 'never-rendered', 'unmeasured', 'unknown'] as const;

  return `; J2: ${statuses.map((status) => `${scripts.filter((unit) => unit.status === status).length} ${status}`).join(', ')}, ${gaps} run-level gap(s) (warn-only)`;
}

function scriptStripLines(reach: ReportReach): string[] {
  return [
    '',
    `**J2 script reach (warn-only)**${scriptSummary(reach).replace('; J2:', ' —')}. Navigation-window execution includes transient loading code; running a value does not prove rendering.`,
  ];
}

function scriptSectionLines(reach: ReportReach): string[] {
  const units = reach.scripts ?? [];
  const gaps = reach.gaps.filter((gap) => gap.join === 'J2');

  if (!units.length && !gaps.length) return [];

  const lines = [
    '',
    '## Script change reach (J2)',
    '',
    '_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._',
  ];

  for (const status of ['never-rendered', 'unmeasured', 'unknown', 'reached'] as const) {
    const group = units.filter((unit) => unit.status === status);

    if (!group.length) continue;
    lines.push(
      '',
      `**${status}**`,
      '',
      '| Source | Side | Execution | Why |',
      '| --- | --- | --- | --- |',
      ...group.map(
        (unit) =>
          `| ${codeValue(`${unit.sourceKey}:${unit.range.start.line}:${unit.range.start.column}-${unit.range.end.line}:${unit.range.end.column}`)} | ${unit.side} | ${unit.execution} | ${escapeInlineMarkdown(unit.why)} |`,
      ),
    );
  }

  if (gaps.length)
    lines.push(
      '',
      '**J2 run-level gaps (unmeasured)**',
      '',
      ...gaps.map((gap) => `- ${escapeInlineMarkdown(gapReason(gap))} — ${gap.remedy}`),
    );

  return lines;
}
