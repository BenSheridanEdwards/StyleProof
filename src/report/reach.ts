import { auditReach, readReachAckFile, ruleReachKey } from '../reach-ledger.js';
import {
  classifyClassReach,
  combineClassReach,
  classJoinGap,
  type ClassUnit,
  type ClassJoinGap,
  type ClassMapPair,
} from '../class-join.js';
import { classSectionLines, classSummary } from './class-units.js';
import { scriptUnitRanges } from './script-units.js';
import { scriptGapLines } from './script-gap-details.js';
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
  audit?: ReturnType<typeof auditReach>;
  acknowledged?: Record<string, string>;
  staleAcknowledgements?: string[];
  acknowledgementReasons?: Record<string, string>;
  complete: boolean;
  ledger: RuleReachResult['ledger'];
  counts: Record<RuleReachStatus, number>;
  /** Every changed rule, reached included, in classifier order. */
  rules: (RuleReach & { acknowledged?: boolean })[];
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

const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

type Side = 'base' | 'head';
/** One J1 gap, parsed from the exact record `ledgerGaps` writes: its kind, side, count and detail. */
type LedgerPart = { kind: string; side: Side; n: number; detail: string };

function ledgerPart(gap: ReachGap): LedgerPart | null {
  const r = gap.reason;
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^no (base|head) captures;/))) return { kind: 'none', side: m[1] as Side, n: 0, detail: '' };
  if ((m = r.match(/^missing (base|head) ledger on (\d+) capture\(s\);/)))
    return { kind: 'missing', side: m[1] as Side, n: Number(m[2]), detail: '' };
  if ((m = r.match(/^served CSS reach is unknown on (\d+) (base|head) capture\(s\): (.*)$/)))
    return { kind: 'unknown', side: m[2] as Side, n: Number(m[1]), detail: m[3] };
  if ((m = r.match(/^(\d+) unreadable stylesheet\(s\) on (base|head);/)))
    return { kind: 'unreadable', side: m[2] as Side, n: Number(m[1]), detail: '' };
  return null;
}

/** "1 base capture", "1 capture on each side", "1 base capture and 2 head captures". */
function onSides(parts: LedgerPart[], one: string): { text: string; single: boolean } {
  if (parts.length === 1) return { text: many(parts[0].n, `${parts[0].side} ${one}`), single: parts[0].n === 1 };
  const [base, head] = parts;
  if (base.n === head.n) return { text: `${many(base.n, one)} on each side`, single: base.n === 1 };
  return { text: `${many(base.n, `base ${one}`)} and ${many(head.n, `head ${one}`)}`, single: false };
}

/** "2 stylesheets on head", "1 stylesheet on each side", "2 stylesheets on base and 1 on head". */
function sheetsOnSides([first, second]: LedgerPart[]): { text: string; single: boolean } {
  if (!second) return { text: `${many(first.n, 'stylesheet')} on ${first.side}`, single: first.n === 1 };
  if (first.n === second.n) return { text: `${many(first.n, 'stylesheet')} on each side`, single: false };
  return { text: `${many(first.n, 'stylesheet')} on base and ${second.n} on head`, single: false };
}

/** Captures whose served CSS could not be read, each with its reason unless they share one. */
function unknownWhere(parts: LedgerPart[]): string {
  if (parts.every((p) => p.detail === parts[0].detail)) return `${onSides(parts, 'capture').text} (${parts[0].detail})`;
  return parts.map((p) => `${many(p.n, `${p.side} capture`)} (${p.detail})`).join(' and ');
}

/** One kind of served-CSS gap on one or both sides, said once with one remedy. */
const LEDGER_PHRASES: Record<string, (parts: LedgerPart[]) => string> = {
  none: (parts) =>
    `there are no ${parts.length > 1 ? 'base or head' : parts[0].side} captures — capture both sides with \`captureReach\``,
  missing: (parts) => {
    const { text, single } = onSides(parts, 'capture');
    const has = single
      ? 'has a missing or out-of-date record of the CSS it'
      : 'have missing or out-of-date records of the CSS they';
    return `${text} ${has} served — recapture ${parts.length > 1 ? 'both sides ' : ''}with \`captureReach\``;
  },
  unknown: (parts) =>
    `StyleProof could not read the CSS served on ${unknownWhere(parts)} — simplify or remove that CSS, then recapture`,
  unreadable: (parts) => {
    const { text, single } = sheetsOnSides(parts);
    return `${text} could not be read — make ${single ? 'it' : 'them'} readable (same-origin or CORS), then recapture`;
  },
};

/**
 * The J1 served-CSS gaps (`ledgerGaps`, or the incomplete-ledger gap) in reviewer words: no "(s)", no
 * "ledger", and a gap both sides share said once with one remedy (RV22-03). The warn line and the
 * gate section both use these; report.json keeps the exact per-side records.
 */
function ledgerGapPhrases(gaps: ReachGap[]): string[] {
  const groups = new Map<string, LedgerPart[]>();
  const out: Array<string | [string, LedgerPart[]]> = [];
  for (const gap of gaps) {
    const part = ledgerPart(gap);
    if (!part) {
      out.push(
        gap.reason.startsWith('reach ledger incomplete;')
          ? 'the record of served CSS is incomplete — recapture with `captureReach`'
          : `${gap.side ? `${gap.side}: ` : ''}${gap.reason} — ${gap.remedy}`,
      );
      continue;
    }
    // Every gap of one kind shares its remedy, so it is said once for both sides (and every reason).
    const key = part.kind;
    const group = groups.get(key);
    if (group) group.push(part);
    else {
      const parts = [part];
      groups.set(key, parts);
      out.push([part.kind, parts]);
    }
  }
  return out.map((entry) => (typeof entry === 'string' ? entry : LEDGER_PHRASES[entry[0]](entry[1])));
}

/** Reach as report.json and the report API publish it. */
export type PublishedReach = Omit<ReportReach, 'counts' | 'rules'> & Partial<Pick<ReportReach, 'counts' | 'rules'>>;

/**
 * When a served-CSS record is missing, old or unreadable on a side, changed rules cannot be
 * listed, so zero counts or an empty rule list would read as "no changed CSS". Publish the gap
 * (`ledger`, `complete: false`, `gaps`) without that zero claim; listed rules stay. The diff's
 * gate receipt keeps its counts (a verdict input).
 */
export function publishedReach(reach: PublishedReach): PublishedReach {
  if (!reach.gaps.some((gap) => gap.kind === 'ledger')) return reach;
  const published: PublishedReach = { ...reach };
  delete published.counts;
  if (!reach.rules?.length) delete published.rules;
  return published;
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

  const acknowledged = readReachAckFile();
  const units = result.rules.filter((rule) => rule.status !== 'reached');
  const audit = auditReach(
    units.flatMap((rule) => {
      const key = ruleReachKey(rule);
      return key ? [key] : [];
    }),
    acknowledged,
  );
  const held = units.filter((rule) => {
    const key = ruleReachKey(rule);
    return !key || !acknowledged[key];
  }).length;
  const blocking =
    level === 'gate'
      ? held + audit.staleAcknowledgements.length + gaps.filter((gap) => gap.kind === 'ledger').length
      : 0;
  return {
    level,
    blocking,
    audit,
    acknowledged: Object.fromEntries(audit.acknowledged.map((key) => [key, acknowledged[key]!])),
    staleAcknowledgements: audit.staleAcknowledgements,
    acknowledgementReasons: acknowledged,
    complete,
    ledger: result.ledger,
    counts,
    rules: result.rules.map((rule) => ({
      ...rule,
      acknowledged: rule.status !== 'reached' && Boolean(acknowledged[ruleReachKey(rule) ?? '']),
    })),
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

/** Fixed copy and counts only; CSS evidence is escaped in the detail tables below. */
export function reachStripLines(reach: ReportReach): string[] {
  if (
    reach.complete &&
    reach.ledger === 'complete' &&
    reach.gaps.length === 0 &&
    reach.rules.every((rule) => rule.status === 'reached') &&
    (reach.scripts ?? []).every((unit) => unit.status === 'reached') &&
    (reach.classes ?? []).every((unit) => unit.status === 'reached')
  ) {
    return ['', '**Reach complete** — every changed rule matched a captured element in a captured state.'];
  }

  const scriptStrip = [
    ...scriptStripLines(reach),
    '',
    `**J3 class reach (warn-only)**${classSummary(reach).replace('; J3:', ' —')}. No per-occurrence render provenance is recorded.`,
  ];

  const unchecked =
    "Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS)." +
    (reach.gaps.some((gap) => gap.join === 'J3')
      ? ' Class-list deltas are not checked where J3 source, vocabulary or pairing evidence is unavailable; see J3 gaps.'
      : '') +
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
  ledger.map(gapReason).forEach((appended) => parts.push(appended));
  ledger.map((gap) => gap.remedy).forEach((appended) => remedies.push(appended));
  return [
    '',
    `**Reach incomplete** — ${parts.join('; ')}. Fix: ${[...new Set(remedies)].join('; ')}. ${reach.blocking > 0 ? unchecked.replace(" These are not held by `changeReach: 'gate'`.", " The findings above are held by `changeReach: 'gate'`; the unchecked items are not.") : unchecked}`,
    ...scriptStrip,
  ];
}

const MAX_NAMED_RULES = 5;

function namedRules(rules: RuleReach[]): string {
  const named = rules.slice(0, MAX_NAMED_RULES).map((rule) => codeValue(rule.key));
  return `${named.join(', ')}${rules.length > MAX_NAMED_RULES ? ` and ${rules.length - MAX_NAMED_RULES} more` : ''}`;
}

/** Plain non-blocking Change Reach warnings for the visual-first layout. */
export function reachHeadlineLines(reach: ReportReach): string[] {
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
  const unchecked = uncheckedLine(reach);
  if (unchecked) lines.push('', unchecked);
  return lines;
}

/**
 * The CSS reach could not check at warn level, so it is never silent (ADR 0009): changed rules
 * that matched only elements StyleProof does not compare, and ledger gaps (missing or old
 * ledgers, unreadable sheets, a side with no captures). One line; detail stays in report.json.
 */
function uncheckedLine(reach: ReportReach): string | null {
  const unmeasured = reach.rules.filter((rule) => rule.status === 'unmeasured');
  const parts = [
    ...(unmeasured.length
      ? [
          `${unmeasured.length} changed CSS rule${unmeasured.length === 1 ? '' : 's'} matched only elements StyleProof does not compare (${namedRules(unmeasured)})`,
        ]
      : []),
    ...ledgerGapPhrases(reach.gaps.filter((gap) => gap.kind === 'ledger')),
  ];
  return parts.length ? `⚠️ **Change Reach could not check every changed CSS rule:** ${parts.join('; ')}.` : null;
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
  const acknowledgementLines = [
    ...Object.entries(reach.acknowledged ?? {}).flatMap(([key, reason], index) => [
      ...(index === 0 ? ['', '## Acknowledged reach items', ''] : []),
      `- ${codeValue(key)} — ${escapeInlineMarkdown(reason)}`,
    ]),
    ...(reach.staleAcknowledgements?.length
      ? [
          '',
          '## Stale reach acknowledgements',
          '',
          'Prune these keys from `styleproof.reach.json`. If the range is still unreached, add a new entry keyed by file/sheet plus the hash of the current changed range, mapped to a reason.',
          '',
          ...reach.staleAcknowledgements.map(
            (key) =>
              `- ${codeValue(key)}${reach.acknowledgementReasons?.[key] ? ` — ${escapeInlineMarkdown(reach.acknowledgementReasons[key])}` : ''}`,
          ),
        ]
      : []),
  ];
  const scriptLines = [...acknowledgementLines, ...scriptSectionLines(reach), ...classSectionLines(reach)];

  if (never.length === 0 && unmeasured.length === 0 && blind.length === 0 && ledger.length === 0) return scriptLines;

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
          ...(blind.some((rule) => /^@font-face\b/i.test(rule.key))
            ? ['', 'Run with `--pixels` on the affected surface to review the rendered font change.']
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

  const counted = gaps
    ? 'not every changed rule could be listed'
    : `${reach.counts['never-rendered']} rule(s), ${reach.counts.unmeasured} unmeasured, ${reach.counts['blind-channel']} blind-channel`;
  return `- Changed but never matched: ${counted}, ${gaps} evidence gap(s); changed stylesheets no capture served are not checked${reach.level === 'gate' ? " (not held by `changeReach: 'gate'`)" : ''}; full list in report.json under \`reach\`${scriptSummary(reach)}${classSummary(reach)}`;
}

function scriptSummary(reach: ReportReach): string {
  const scripts = reach.scripts ?? [];
  const gaps =
    reach.scriptGapCount ??
    reach.gaps.reduce((count, gap) => {
      if (gap.join !== 'J2') return count;
      const omitted = gap.reason.match(/^J2 gaps truncated: (\d+)\b/);
      if (omitted) return count + Number(omitted[1]);
      return count + (/^J2 (?:gap paths|gaps|units) truncated:/.test(gap.reason) ? 0 : 1);
    }, 0);
  const statuses = ['reached', 'never-rendered', 'unmeasured', 'unknown'] as const;

  return `; J2: ${statuses.map((status) => `${reach.scriptCounts?.[status] ?? scripts.filter((unit) => unit.status === status).reduce((sum, unit) => sum + (unit.count ?? 1), 0)} ${status}`).join(', ')}, ${gaps} run-level gap(s) (warn-only)`;
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

  let budget = 100;
  for (const status of ['never-rendered', 'unmeasured', 'unknown', 'reached'] as const) {
    const ranges = scriptUnitRanges(units.filter((unit) => unit.status === status));
    const group = ranges.slice(0, budget);
    budget -= group.length;
    const hidden = ranges.slice(group.length);

    if (!ranges.length) continue;
    lines.push('', `**${status}**`, '', '| Source | Side | Execution | Why |', '| --- | --- | --- | --- |');
    group
      .map(
        (unit) =>
          `| ${codeValue(`${unit.sourceKey}:${unit.range.start.line}:${unit.range.start.column}-${unit.range.end.line}:${unit.range.end.column}${unit.count > 1 ? ` (${unit.count} units)` : ''}`)} | ${unit.side} | ${unit.execution} | ${escapeInlineMarkdown(unit.why)} |`,
      )
      .forEach((appended) => lines.push(appended));
    if (hidden.length)
      lines.push(
        '',
        `+${hidden.length} more changed range(s), ${hidden.reduce((sum, range) => sum + range.count, 0)} unit(s); report.json retains bounded J2 detail and full status counts.`,
      );
  }

  if (gaps.length) {
    lines.push('', '**J2 run-level gaps (unmeasured)**', '');
    scriptGapLines(gaps).forEach((appended) => lines.push(appended));
  }

  return lines;
}
