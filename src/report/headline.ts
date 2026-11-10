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
import type { ChangeGroup, PreparedSurface, ReportConsistency } from './shared.js';
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
      `The rest of the base was captured; repair ${one ? 'that surface' : 'those surfaces'} on that commit and recapture.`,
  ];
}

/** Disclose base capture attempts that were not counted as baseline failures. */
export function undeclaredOnBaseLines(keys: readonly string[], sha?: string): string[] {
  if (keys.length === 0) return [];
  const at = sha ? ` \`${sha.slice(0, 12)}\`` : '';
  return [
    `ℹ️ **${keys.length} base capture attempt(s) not counted as baseline failures**: \`${formatSurfaceList([...keys])}\`. ` +
      `The base commit${at} never declared these surface(s) (the head capture spec ran against base), so they are reviewed as new surfaces.`,
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
      '_This is **not** a clean no-change and **not** a visual-approval gate, so StyleProof cannot certify it: fix the reflow source, or re-run with `--include-layout-noise` to inspect the raw longhands. The base capture itself ran._',
  },
  presentation_collapsed_while_raw_reviewable: {
    explanation:
      'report-only path correspondence collapsed every presentation finding — **no reviewable crops or change sections remain**.',
    remediation:
      '_This is **not** a clean no-change and cannot be approved visually, so StyleProof cannot certify it: inspect the raw path churn or tighten the correspondence signal before trusting this comparison. The base capture itself ran._',
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
  if (input.headOnlyVolatile?.length) {
    return [
      '✗ Not certified — a subtree became volatile on head and was excluded from the comparison (see below), so StyleProof cannot certify this compare; not a clean no-change.',
    ];
  }
  if (input.baseOnlyVolatile?.length) {
    return [
      '⚠ Review required — a subtree volatile on the base settled on head and was excluded from the comparison (see below). Not a clean no-change; approve once the head rendering there is reviewed.',
    ];
  }
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
    (hasChanges
      ? 'They hold the check: certify mode fails; review-gate mode needs approval.'
      : 'Not a clean no-change: certify mode fails; review-gate mode needs approval.')
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
    ...baselineFailureSummaryLines(baseline.failures),
    ...missingSurfaceSummaryLines(missing, baseline.surfaceFailures),
    ...undeclaredOnBaseLines(baseline.undeclaredOnBase ?? [], baseline.sha),
  ];
  while (md[md.length - 1] === '') md.pop();
  return md;
}

/** The headline lines between the certification block and the per-surface detail. */
export function reportHeadline(input: HeadlineInput): string[] {
  const md = summaryLines(input);
  if (input.volatileCount > 0) {
    const candidates = input.liveCandidateLabels.length
      ? ` Auto-detected live-state candidate(s): ${input.liveCandidateLabels.slice(0, 5).map(escapeInlineMarkdown).join('; ')}.`
      : '';
    md.push(
      '',
      `_${input.volatileCount} live region(s) auto-excluded as nondeterministic (a stream, ticker, or late-loading content) — changes inside them are NOT certified by this check.${candidates}_`,
    );
  }
  const headOnly = input.headOnlyVolatile ?? [];
  if (headOnly.length > 0) {
    md.push(
      '',
      `✗ **${headOnly.length} subtree(s) newly volatile on head** — still mutating at capture settle on the head but settled and compared on the base, so they were excluded and whatever changed inside them is **not certified**. Stop the head-side churn (a timer, stream, or animation), fixture it, or \`ignore\` the region on both sides.`,
    );
    headOnly
      .slice(0, 20)
      .map((v) => `- \`${safeKey(v.surface)}\` · ${codeValue(v.path)}`)
      .forEach((appended) => md.push(appended));
    (headOnly.length > 20 ? [`- … and ${headOnly.length - 20} more (full list in report.json)`] : []).forEach(
      (appended) => md.push(appended),
    );
  }
  const baseOnly = input.baseOnlyVolatile ?? [];
  if (baseOnly.length > 0) {
    md.push(
      '',
      `⚠ **${baseOnly.length} subtree(s) volatile on the base only** — still mutating at capture settle on the base but settled on the head, so they were excluded and whatever the head renders inside them is **not checked**. Review the head rendering there and approve, or fixture the base-side churn so the next baseline compares it.`,
    );
    baseOnly
      .slice(0, 20)
      .map((v) => `- \`${safeKey(v.surface)}\` · ${codeValue(v.path)}`)
      .forEach((appended) => md.push(appended));
    (baseOnly.length > 20 ? [`- … and ${baseOnly.length - 20} more (full list in report.json)`] : []).forEach(
      (appended) => md.push(appended),
    );
  }
  // A structure-only report leads with the visible-structure line; the notes below never repeat it.
  return [...md, ...contentNoteLines(input, md.includes(visibleStructureLine(input.elevatedStructureDom)))];
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
  const note =
    (input.elevatedVisibleStructure ?? 0) > 0
      ? `📝 _${input.contentCount} content/structure change(s) below; text and invisible DOM churn stay advisory._`
      : `📝 _${input.contentCount} advisory content change(s) below — they don't affect the check._`;
  return ['', note];
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
