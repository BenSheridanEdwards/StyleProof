import fs from 'node:fs';
import type { BaseOnlyVolatile, DiffCounts, HeadOnlyVolatile } from '../diff.js';
import {
  baselineFailureReceipts,
  honestBaselineCompareAttribution,
  isMapFile,
  readBaselineFailureLedger,
  surfaceMissingMatchesBaselineFailure,
  type BaselineFailureReceipt,
  type SurfaceCaptureFailure,
} from '../map-store.js';
import { formatSurfaceList, safeKey, surfaceBase } from '../change-groups.js';
import { sizeLimitName } from './crop-budget.js';
import type { ChangeGroup, CropGap, PartialPage, PreparedSurface, ReportConsistency } from './shared.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';

/** Everything the headline prose between the certification block and the detail needs. */
export type HeadlineInput = {
  changeGroups: ChangeGroup[];
  missing: PreparedSurface[];
  /** Change sections the report shows; each is one change to review. */
  sectionCount: number;
  /** " on `index` at 1280px wide: 9 elements, 4 changed CSS rules." (empty without style changes). */
  scope: string;
  volatileCount: number;
  /** Subtrees volatile on the head only: excluded, never certified. */
  headOnlyVolatile?: HeadOnlyVolatile[];
  /** Subtrees volatile on the base only: excluded, held for review (approvable). */
  baseOnlyVolatile?: BaseOnlyVolatile[];
  liveCandidateLabels: string[];
  contentCount: number;
  /** One-sided element changes shared by every surface base that renders their container (#754). */
  globalChromeCount?: number;
  /** #766: Global chrome navigable additions elevated to reviewable. */
  elevatedNavigableChromeAdds?: number;
  /** Visible paired-surface element add/remove elevated to reviewable. */
  elevatedVisibleStructure?: number;
  /** Both elevations de-duplicated — the count that gates (`reviewableCounts.dom`). */
  elevatedStructureDom: number;
  contentEvaluated: boolean;
  /** Any raw-vs-presentation contradiction: must not claim "identical". */
  reportConsistency: ReportConsistency;
  rawCounts?: DiffCounts;
  baseline: BaselineInfo;
  confidenceBlocked: boolean;
  comparisonBlocked: boolean;
  reachBlocking: number;
  liveTextFreezeViolated?: boolean;
};

export type BaselineInfo = {
  surfaceFailures: SurfaceCaptureFailure[];
  failures: BaselineFailureReceipt[];
  /** Base capture failures set aside because git proves the base never declared the surface. */
  undeclaredOnBase: string[];
  sha?: string;
};

export function readBaselineInfo(beforeDir: string, afterDir: string): BaselineInfo {
  const headKeys = new Set(
    fs
      .readdirSync(afterDir)
      .filter(isMapFile)
      .map((f) => f.replace(/\.json(\.gz)?$/, '')),
  );
  const ledger = readBaselineFailureLedger(beforeDir, afterDir, headKeys);
  return {
    surfaceFailures: ledger.failures,
    failures: baselineFailureReceipts(ledger.failures, ledger.sha),
    undeclaredOnBase: ledger.undeclaredOnBase,
    sha: ledger.sha,
  };
}

function newSurfaceSummary(missing: PreparedSurface[], maxNamed = 8): string {
  const bases = [...new Set(missing.map((p) => surfaceBase(p.sd.surface)))].sort();
  const shownBases = new Set(bases.slice(0, maxNamed));
  const shownSurfaces = missing.map((p) => p.sd.surface).filter((s) => shownBases.has(surfaceBase(s)));
  const more = bases.length > maxNamed ? `, +${bases.length - maxNamed} more` : '';
  return '`' + formatSurfaceList(shownSurfaces) + '`' + more;
}

const MAX_NAMED_FAILURES = 10;

export function baselineFailureSummaryLines(failures: BaselineFailureReceipt[]): string[] {
  if (failures.length === 0) return [];
  const shown = failures.slice(0, MAX_NAMED_FAILURES);
  const { named } = honestBaselineCompareAttribution({ baseCaptureFailed: false, receipts: shown });
  const more = failures.length - shown.length;
  const list = more ? `${named} and ${more} more, all listed in report.json` : named;
  const one = failures.length === 1;
  return [
    `⚠️ **${one ? '1 surface' : `${failures.length} surfaces`} failed to capture on the base:** ${list}. ` +
      `The rest of the base was captured; repair ${one ? 'that surface' : 'those surfaces'} on that commit and capture ${one ? 'it' : 'them'} again.`,
  ];
}

/** Disclose base capture attempts that were not counted as baseline failures. */
export function undeclaredOnBaseLines(keys: readonly string[], sha?: string): string[] {
  if (keys.length === 0) return [];
  const at = sha ? ` \`${sha.slice(0, 12)}\`` : '';
  // Named here too (RV11-06): the new-surface line names every new surface, and this says which of
  // them were never declared on the base, a different fact about some of them.
  const n = keys.length;
  const names = keys.map((key) => `\`${formatSurfaceList([key])}\``).join(', ');
  return [
    `ℹ️ ${names} ${n === 1 ? 'was' : 'were'} never declared on the base commit${at} ` +
      `(the head capture spec ran against the base), so ${n === 1 ? 'its base capture attempt is' : 'their base capture attempts are'} not counted as a baseline failure.`,
  ];
}

export type OneSidedStatus = 'new' | 'capture-failed' | 'removed';

/** missing 'after' = captured only on base (a REMOVAL); missing 'before' = new, or
 *  baseline repair debt when a named baseline capture failed. */
export function oneSidedStatus(p: PreparedSurface, failures: SurfaceCaptureFailure[]): OneSidedStatus {
  if (p.sd.missing === 'after') return 'removed';
  return surfaceMissingMatchesBaselineFailure(p.sd.surface, failures) ? 'capture-failed' : 'new';
}

// One line per kind; a surface whose base capture failed is already named by the failure line.
const MISSING_SUMMARY: [OneSidedStatus, (n: number, names: string) => string][] = [
  [
    'removed',
    (n, names) =>
      `🗑️ **${n === 1 ? '1 removed surface' : `${n} removed surfaces`}** — in the baseline, not captured on head: ${names}. ` +
      `Review ${n === 1 ? 'it' : 'them'} as ${n === 1 ? 'a removal' : 'removals'}.`,
  ],
  [
    'new',
    (n, names) =>
      `🆕 **${n === 1 ? '1 new surface' : `${n} new surfaces`}** with no baseline to compare: ${names}. ` +
      `Review ${n === 1 ? 'it before it becomes' : 'them before they become'} part of the baseline.`,
  ],
];

function missingSurfaceSummaryLines(missing: PreparedSurface[], failures: SurfaceCaptureFailure[]): string[] {
  const md: string[] = [];
  for (const [status, text] of MISSING_SUMMARY) {
    const matching = missing.filter((p) => oneSidedStatus(p, failures) === status);
    if (matching.length === 0) continue;
    md.push(text(matching.length, newSurfaceSummary(matching)));
    (status === 'new' ? [] : ['']).forEach((appended) => md.push(appended));
  }
  return md;
}

const CONSISTENCY_FAILURE = {
  raw_only_no_reviewable: {
    explanation:
      'every delta is a derived/reflow longhand the visual report strips — **no reviewable crops or change sections**.',
    remediation:
      '_This is not a clean no-change, so StyleProof cannot certify it: fix the reflow source, or re-run with `--include-layout-noise` to inspect the raw longhands._',
  },
  presentation_collapsed_while_raw_reviewable: {
    explanation:
      'report-only path correspondence collapsed every presentation finding — **no reviewable crops or change sections remain**.',
    remediation:
      '_This is not a clean no-change, so StyleProof cannot certify it: inspect the raw path churn or tighten the correspondence signal before trusting this comparison._',
  },
} as const;

function consistencyFailureLines(input: HeadlineInput): string[] | undefined {
  const { reportConsistency, rawCounts } = input;
  if (reportConsistency.ok || !rawCounts) return undefined;
  const { explanation, remediation } = CONSISTENCY_FAILURE[reportConsistency.reason];
  const md = [
    `⚠ **Report consistency failure:** the certification differ found **${rawCounts.dom} DOM**, **${rawCounts.style} computed-style**, and **${rawCounts.state} state** difference(s), but ${explanation}`,
    '',
    remediation,
  ];
  if (input.baseline.failures.length > 0) {
    md.push('');
    baselineFailureSummaryLines(input.baseline.failures).forEach((appended) => md.push(appended));
  }
  return md;
}

const NO_CHANGE = '✓ No reviewable computed-style changes among semantically matched elements.';

function noChangedSurfaceSummary(input: HeadlineInput): string[] | undefined {
  const failure = consistencyFailureLines(input);
  if (failure) return failure;
  // Baseline capture failures are reviewable evidence even with zero restyles — surface them
  // here (not as "0 changes need review") so the receipt stays above the fold.
  if (input.baseline.surfaceFailures.length > 0) {
    return [...baselineFailureSummaryLines(input.baseline.failures)];
  }
  // A volatile subtree's own block (below the summary) says what happened and what to do: once.
  if (input.headOnlyVolatile?.length || input.baseOnlyVolatile?.length) return [];
  if (input.liveTextFreezeViolated) {
    return [
      '✗ Live/age freeze violated — captured age/clock text drifted after a freeze was declared, so StyleProof cannot certify this compare; not a style review.',
    ];
  }
  if (input.reachBlocking > 0) return [reachGateLine(input.reachBlocking, false)];
  const elevated = elevatedStructureSummary(input);
  if (elevated) return elevated;
  return cleanScopeSummary(input);
}

/** The one line that says `changeReach: 'gate'` holds the check, with or without style changes. */
export function reachGateLine(blocking: number, hasChanges: boolean): string {
  return (
    `✗ **Reach gate** — ${blocking} changed CSS rule(s) or reach evidence gap(s) were never matched in a captured state (see **Changed but never matched**). ` +
    (hasChanges ? 'They hold the check.' : 'Not a clean no-change: they hold the check.')
  );
}

/** The one sentence for visible additions/removals that gate the check: said once per report. */
export function visibleStructureLine(n: number): string {
  return n === 1
    ? '🧱 **1 visible element was added or removed** — it needs review.'
    : `🧱 **${n} visible elements were added or removed** — they need review.`;
}

function elevatedStructureSummary(input: HeadlineInput): string[] | undefined {
  const n = input.elevatedStructureDom;
  return n > 0 ? [visibleStructureLine(n)] : undefined;
}

function cleanScopeSummary(input: HeadlineInput): string[] {
  const scope = !input.contentEvaluated
    ? `${NO_CHANGE} Content/structure was not evaluated.`
    : input.contentCount > 0
      ? `${NO_CHANGE} See ${input.contentCount} advisory content/structure change(s) below.`
      : `${NO_CHANGE} No advisory content/structure changes detected.`;
  const blocked = input.confidenceBlocked || input.comparisonBlocked;
  return [blocked ? scope.replace(/^✓ /, 'Computed-style scope only: ') : scope];
}

/** "**3 changes to review** on `index` at 1280px wide: 9 elements, 4 changed CSS rules." */
function verdictToReview(n: number, scope: string): string {
  return `**${n} ${n === 1 ? 'change' : 'changes'} to review**${scope}`;
}

function summaryLines(input: HeadlineInput): string[] {
  const { changeGroups, missing, baseline } = input;
  const noChange = changeGroups.length === 0 && missing.length === 0 ? noChangedSurfaceSummary(input) : undefined;
  if (noChange) return noChange;
  const md = [
    verdictToReview(input.sectionCount + missing.length, changeGroups.length ? input.scope : ''),
    '',
    // Each statement its own paragraph, so report.html never runs two together.
    ...[
      baselineFailureSummaryLines(baseline.failures),
      missingSurfaceSummaryLines(missing, baseline.surfaceFailures),
      undeclaredOnBaseLines(baseline.undeclaredOnBase ?? [], baseline.sha),
    ].flatMap((lines) => (lines.length ? [...lines.filter((l, i) => l || i < lines.length - 1), ''] : [])),
  ];
  while (md[md.length - 1] === '') md.pop();
  return md;
}

/** One block per side of one-sided volatility: the lead line, then up to 20 regions, then the overflow count. */
function oneSidedVolatileLines(regions: NonNullable<HeadlineInput['headOnlyVolatile']>, lead: string): string[] {
  if (regions.length === 0) return [];
  return [
    '',
    lead,
    ...regions.slice(0, 20).map((v) => `- \`${safeKey(v.surface)}\` · ${codeValue(v.path)}`),
    ...(regions.length > 20 ? [`- … and ${regions.length - 20} more (full list in report.json)`] : []),
  ];
}

const where = (key: string): string => (key === 'Global chrome' ? key : `\`${formatSurfaceList([key])}\``);

/** "2 on `home @ 1280`, 1 on Global chrome", in first-seen order. */
function countsByPlace(gaps: CropGap[]): string {
  const counts = new Map<string, number>();
  for (const gap of gaps) counts.set(gap.where, (counts.get(gap.where) ?? 0) + 1);
  return [...counts].map(([key, n]) => `${n} on ${where(key)}`).join(', ');
}

/**
 * Every change missing some or all of its crops, said once for the whole report: the true total of
 * changes (one per section or entry, however many image pairs it lost, so it agrees with the
 * summary's count), each cause with the places it hit, and the option that shows them. Sections and
 * entries carry no note of their own.
 */
export function cropGapLines(
  gaps: CropGap[],
  limits: { maxCrops: number; maxFiles: number; maxBytes: number },
): string[] {
  if (gaps.length === 0) return [];
  const of = (reason: CropGap['reason']) => gaps.filter((gap) => gap.reason === reason);
  const causes = [
    [of('max-crops'), `past the \`--max-crops\` limit of ${limits.maxCrops} per surface`],
    [of('budget'), `past the report's crop budget (${limits.maxFiles} files / ${limits.maxBytes / 1_000_000} MB)`],
    [of('size'), `too large to fit the ${sizeLimitName(limits.maxBytes)} after downscaling`],
  ] as const;
  const hits = causes.filter(([hit]) => hit.length > 0);
  // One cause: the total already counts it. Several: each says how many it left out.
  const parts = hits.map(([hit, why]) => `${hits.length > 1 ? `${hit.length} ` : ''}${why} (${countsByPlace(hit)})`);
  const options = [
    of('max-crops').length ? 'raise `--max-crops`' : '',
    of('budget').length ? 'raise `--max-crop-files` or `--max-crop-bytes`' : '',
    of('size').length && !of('budget').length && sizeLimitName(limits.maxBytes) === 'report byte limit'
      ? 'raise `--max-crop-bytes`'
      : '',
  ].filter(Boolean);
  const n = gaps.length;
  return [
    '',
    `✂️ **${n === 1 ? '1 change is' : `${n} changes are`} missing crops**${hits.length > 1 ? ':' : ','} ${parts.join('; ')}. ` +
      `${n === 1 ? 'It is' : 'Each is'} still listed and counted` +
      (options.length ? `; ${options.join(', or ')} to show the crops.` : '.'),
  ];
}

/**
 * One-sided pages shown only in part, said once for the report: each page by name with how much is
 * shown, why, and what to do. It names nothing the PR comment lacks (no tiles or captions).
 */
export function partialPageLines(pages: PartialPage[], maxTiles = 8, { budgetAdviceElsewhere = false } = {}): string[] {
  if (pages.length === 0) return [];
  const list = pages
    .map(
      (p) =>
        `${where(p.surface)} (${p.shown} of ${p.captured}px, full screenshot \`${safeKey(p.surface)}.png\` in the ${p.side} capture)`,
    )
    .join(', ');
  const budget = pages.some((p) => p.budget);
  const capped = pages.some((p) => !p.budget);
  const why = [
    capped ? `a new or removed page shows at most ${maxTiles} screen heights` : '',
    budget ? `the report's crop budget ran out` : '',
  ].filter(Boolean);
  const todo = [
    capped ? 'open the full screenshot to review the rest' : '',
    // When the ✂️ line also counts crop-budget gaps, it gives that option once for both (QA12-03).
    budget && !budgetAdviceElsewhere ? 'raise `--max-crop-files` or `--max-crop-bytes` to show more of it' : '',
  ].filter(Boolean);
  return [
    '',
    `📏 **Only part of ${pages.length === 1 ? '1 page' : `${pages.length} pages`} is shown:** ${list}. ` +
      `${why.join(', and ').replace(/^./, (c) => c.toUpperCase())}${todo.length ? `; ${todo.join(', or ')}` : ''}.`,
  ];
}

/** The headline lines between the certification block and the per-surface detail. */
export function reportHeadline(input: HeadlineInput): string[] {
  const md = summaryLines(input);
  // Regions volatile on one side only are named in their own block below; count only the others.
  const live = input.volatileCount - (input.headOnlyVolatile?.length ?? 0) - (input.baseOnlyVolatile?.length ?? 0);
  const candidates = input.liveCandidateLabels.length
    ? `Auto-detected live-state candidate(s): ${input.liveCandidateLabels.slice(0, 5).map(escapeInlineMarkdown).join('; ')}.`
    : '';
  if (live > 0) {
    md.push(
      '',
      `_${live} live region(s) auto-excluded as nondeterministic (a stream, ticker, or late-loading content) — changes inside them are NOT certified by this check.${candidates ? ` ${candidates}` : ''}_`,
    );
  } else if (candidates && input.volatileCount > 0) md.push('', `_${candidates}_`);
  const headOnly = input.headOnlyVolatile ?? [];
  oneSidedVolatileLines(
    headOnly,
    `✗ **${headOnly.length} subtree(s) newly volatile on head** — still mutating at capture settle on the head but settled and compared on the base, so they were excluded and whatever changed inside them is **not certified**. Stop the head-side churn (a timer, stream, or animation), fixture it, or \`ignore\` the region on both sides.`,
  ).forEach((appended) => md.push(appended));
  const baseOnly = input.baseOnlyVolatile ?? [];
  oneSidedVolatileLines(
    baseOnly,
    `⚠ **${baseOnly.length} subtree(s) volatile on the base only** — still mutating at capture settle on the base but settled on the head, so they were excluded and whatever the head renders inside them is **not checked**. Review the head rendering there, or fixture the base-side churn so the next baseline compares it.`,
  ).forEach((appended) => md.push(appended));
  // A structure-only report leads with the visible-structure line; the notes below never repeat it.
  const lines = [...md, ...contentNoteLines(input, md.includes(visibleStructureLine(input.elevatedStructureDom)))];
  // With no summary paragraph (a volatile-only report), the first block opens without a blank line.
  const first = lines.findIndex((line) => line !== '');
  return first < 0 ? [] : lines.slice(first);
}

/** The shared-chrome note (#754); its verdict clause is left out when the headline already said it. */
function chromeNoteLines(input: HeadlineInput, structureSaid: boolean): string[] {
  const chrome = input.globalChromeCount ?? 0;
  // The headline already said the visible change; the Global chrome section lists it.
  if (chrome <= 0 || structureSaid) return [];
  const gating = (input.elevatedNavigableChromeAdds ?? 0) > 0 || (input.elevatedVisibleStructure ?? 0) > 0;
  const verdictNote = !gating
    ? " DOM structure does not change this check's verdict."
    : ' Visible additions/removals need review.';
  return [
    '',
    `🧱 **${chrome === 1 ? '1 global chrome element' : `${chrome} global chrome elements`}** added or removed on every surface base that renders its container, listed once under Global chrome below.${verdictNote}`,
  ];
}

/** The advisory content count; visible additions/removals were already named above. */
function contentCountLines(input: HeadlineInput): string[] {
  if (input.contentCount <= 0 || (input.changeGroups.length === 0 && input.missing.length === 0)) return [];
  // The Content and structure section says what is advisory; this only points there.
  const kind = (input.elevatedVisibleStructure ?? 0) > 0 ? 'content/structure' : 'advisory content';
  return ['', `📝 _${input.contentCount} ${kind} change(s) below._`];
}

/** Content-layer pointers: shared chrome, visible structure elevation (said once), then the advisory count. */
function contentNoteLines(input: HeadlineInput, structureSaid: boolean): string[] {
  // The gating total (visible + navigable chrome, de-duplicated), so the 🧱 note agrees with the headline.
  const structureElevated = input.elevatedStructureDom;
  const chrome = input.globalChromeCount ?? 0;
  const structure =
    structureElevated > 0 && chrome === 0 && !structureSaid ? ['', visibleStructureLine(structureElevated)] : [];
  return [...chromeNoteLines(input, structureSaid), ...structure, ...contentCountLines(input)];
}
