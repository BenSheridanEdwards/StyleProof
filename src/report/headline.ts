import type { DiffCounts, HeadOnlyVolatile } from '../diff.js';
import {
  baselineFailureReceipts,
  honestBaselineCompareAttribution,
  readMapManifest,
  surfaceMissingMatchesBaselineFailure,
  type BaselineFailureReceipt,
  type SurfaceCaptureFailure,
} from '../map-store.js';
import { formatChangedSurfaceScope, formatSurfaceList, surfaceBase } from '../change-groups.js';
import type { ChangeGroup, PreparedSurface, ReportConsistency } from './shared.js';
import { escapeInlineMarkdown } from './markdown.js';

/** Everything the headline prose between the certification block and the detail needs. */
export type HeadlineInput = {
  changeGroups: ChangeGroup[];
  missing: PreparedSurface[];
  shown: DiffCounts;
  changedScope: { bases: number; variants: number };
  volatileCount: number;
  /** Subtrees volatile on the head only: excluded, never certified. */
  headOnlyVolatile?: HeadOnlyVolatile[];
  liveCandidateLabels: string[];
  contentCount: number;
  contentEvaluated: boolean;
  /** Any raw-vs-presentation contradiction: must not claim "identical". */
  reportConsistency: ReportConsistency;
  rawCounts?: DiffCounts;
  baseline: BaselineInfo;
  confidenceBlocked: boolean;
  comparisonBlocked: boolean;
  liveTextFreezeViolated?: boolean;
};

export type BaselineInfo = {
  surfaceFailures: SurfaceCaptureFailure[];
  failures: BaselineFailureReceipt[];
  sha?: string;
};

export function readBaselineInfo(beforeDir: string): BaselineInfo {
  const manifest = readMapManifest(beforeDir);
  const surfaceFailures = manifest?.surfaceCaptureFailures ?? [];
  return { surfaceFailures, failures: baselineFailureReceipts(surfaceFailures, manifest?.sha) };
}

/** Headline counts with the zeros dropped. */
function changeCountLabel(shown: DiffCounts): string {
  const parts: [number, string][] = [
    [shown.dom, 'DOM change(s)'],
    [shown.style, 'computed-style difference(s)'],
    [shown.state, 'state-delta difference(s)'],
  ];
  return parts
    .filter(([n]) => n)
    .map(([n, label]) => `${n} ${label}`)
    .join(' · ');
}

function newSurfaceSummary(missing: PreparedSurface[], maxNamed = 8): string {
  const bases = [...new Set(missing.map((p) => surfaceBase(p.sd.surface)))].sort();
  const shownBases = new Set(bases.slice(0, maxNamed));
  const shownSurfaces = missing.map((p) => p.sd.surface).filter((s) => shownBases.has(surfaceBase(s)));
  const more = bases.length > maxNamed ? `, +${bases.length - maxNamed} more` : '';
  return '`' + formatSurfaceList(shownSurfaces) + '`' + more;
}

const SURFACE_SCOPE_GLOSSARY =
  '_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._';

export function baselineFailureSummaryLines(failures: BaselineFailureReceipt[]): string[] {
  if (failures.length === 0) return [];
  const attribution = honestBaselineCompareAttribution({ baseCaptureFailed: false, receipts: failures });
  return [`⚠️ **${failures.length} baseline capture failure(s)**: ${attribution.summary}`];
}

export function baselineFailureDetailLines(failures: BaselineFailureReceipt[]): string[] {
  if (failures.length === 0) return [];
  return [
    '',
    '### Baseline capture failure receipt',
    '',
    ...failures.map((f) => `- \`${f.key}\` · \`${f.reason}\` · \`${f.sha}\``),
    '',
    '_Named surface+SHA above. This is not a base recapture failure (`base-capture-failed=false`)._',
    '',
  ];
}

export type OneSidedStatus = 'new' | 'capture-failed' | 'removed';

/** missing 'after' = captured only on base (a REMOVAL); missing 'before' = new, or
 *  baseline repair debt when a named baseline capture failed. */
export function oneSidedStatus(p: PreparedSurface, failures: SurfaceCaptureFailure[]): OneSidedStatus {
  if (p.sd.missing === 'after') return 'removed';
  return surfaceMissingMatchesBaselineFailure(p.sd.surface, failures) ? 'capture-failed' : 'new';
}

const MISSING_SUMMARY: [OneSidedStatus, (n: number, names: string) => string][] = [
  [
    'removed',
    (n, names) =>
      `🗑️ **${n} REMOVED surface(s)** — present in the baseline, not captured on head: ${names}. ` +
      `Review as removals; approving accepts the disappearance.`,
  ],
  [
    'capture-failed',
    (n, names) =>
      `⚠️ **${n} head surface(s)** have no base map because a named baseline surface capture failed (not first adoption, not a base recapture failure): ${names}.`,
  ],
  [
    'new',
    (n, names) =>
      `🆕 **${n} new surface(s)** captured with no baseline to compare: ${names}. ` +
      `These are reviewable first-adoption surfaces; approve them before they become the baseline.`,
  ],
];

function missingSurfaceSummaryLines(missing: PreparedSurface[], failures: SurfaceCaptureFailure[]): string[] {
  const md: string[] = [];
  for (const [status, text] of MISSING_SUMMARY) {
    const matching = missing.filter((p) => oneSidedStatus(p, failures) === status);
    if (matching.length === 0) continue;
    md.push(text(matching.length, newSurfaceSummary(matching)), ...(status === 'new' ? [] : ['']));
  }
  return md;
}

const CONSISTENCY_FAILURE = {
  raw_only_no_reviewable: {
    explanation:
      'every delta is a derived/reflow longhand the visual report strips — **no reviewable crops or change sections**.',
    remediation:
      '_This is **not** a clean no-change and **not** a visual-approval gate. Fail closed (`CERTIFICATION_FAILED`): fix the reflow source, or re-run with `--include-layout-noise` to inspect the raw longhands. This is **not** a base recapture failure (`base-capture-failed=false`)._',
  },
  presentation_collapsed_while_raw_reviewable: {
    explanation:
      'report-only path correspondence collapsed every presentation finding — **no reviewable crops or change sections remain**.',
    remediation:
      '_This is **not** a clean no-change and cannot be approved visually. Fail closed (`CERTIFICATION_FAILED`): inspect the raw path churn or tighten the correspondence signal before trusting this comparison. This is **not** a base recapture failure (`base-capture-failed=false`)._',
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
  if (input.baseline.failures.length > 0) md.push('', ...baselineFailureSummaryLines(input.baseline.failures));
  return md;
}

const NO_CHANGE = '✓ No reviewable computed-style changes among semantically matched elements.';

function noChangedSurfaceSummary(input: HeadlineInput): string[] | undefined {
  const failure = consistencyFailureLines(input);
  if (failure || input.baseline.surfaceFailures.length > 0) return failure;
  if (input.headOnlyVolatile?.length) {
    return [
      '✗ Not certified — a subtree became volatile on head and was excluded from the comparison (see below). Fail closed (`CERTIFICATION_FAILED`); not a clean no-change.',
    ];
  }
  if (input.liveTextFreezeViolated) {
    return [
      '✗ Live/age freeze violated — captured age/clock text drifted after a freeze was declared. Fail closed (`CERTIFICATION_FAILED`); not a style review.',
    ];
  }
  const scope = !input.contentEvaluated
    ? `${NO_CHANGE} Content/structure was not evaluated.`
    : input.contentCount > 0
      ? `${NO_CHANGE} See ${input.contentCount} advisory content/structure change(s) below.`
      : `${NO_CHANGE} No advisory content/structure changes detected.`;
  const blocked = input.confidenceBlocked || input.comparisonBlocked;
  return [blocked ? scope.replace(/^✓ /, 'Computed-style scope only: ') : scope];
}

function summaryLines(input: HeadlineInput): string[] {
  const { changeGroups, missing, shown, changedScope, baseline } = input;
  const noChange = changeGroups.length === 0 && missing.length === 0 ? noChangedSurfaceSummary(input) : undefined;
  if (noChange) return noChange;
  const md = [
    ...baselineFailureSummaryLines(baseline.failures),
    ...missingSurfaceSummaryLines(missing, baseline.surfaceFailures),
  ];
  if (changeGroups.length > 0) {
    md.push(
      ...(md.length > 0 ? [''] : []),
      `**${changeCountLabel(shown)}** across ${changeGroups.length} distinct change(s) in ${formatChangedSurfaceScope(changedScope.bases, changedScope.variants)} with an existing baseline.`,
      SURFACE_SCOPE_GLOSSARY,
    );
  }
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
      ...headOnly.slice(0, 20).map((v) => `- \`${v.surface}\` · \`${v.path}\``),
      ...(headOnly.length > 20 ? [`- … and ${headOnly.length - 20} more (full list in report.json)`] : []),
    );
  }
  if (input.contentCount > 0 && (input.changeGroups.length > 0 || input.missing.length > 0)) {
    md.push('', `📝 _${input.contentCount} advisory content change(s) below — they don't affect the check._`);
  }
  return md;
}
