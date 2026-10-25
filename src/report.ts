import fs from 'node:fs';
import path from 'node:path';
import type { ChangeReachLevel } from './config.js';
import { captureKeysIn, mergeSurfaceKeyLookup, surfaceElementPaths } from './capture.js';
import { collectStructureElevation, elevateReviewable, type StructureElevation } from './structure-elevation.js';
import { readBaselineProvenance, type BaselineFailureReceipt } from './map-store.js';
import {
  diffStyleMapDirs,
  auditLiveTextDirs,
  presentationDiffStyleMaps,
  summarizeComparability,
  type ComparabilitySummary,
  type BaseOnlyVolatile,
  type DiffCounts,
  type HeadOnlyVolatile,
  type SurfaceComparability,
  type SurfaceDiff,
} from './diff.js';
import { liveTextFreezeError, type LiveTextAudit } from './live-text.js';
import {
  applyLegacyPairReceipts,
  auditLegacyPairs,
  type DeclaredLegacyPairs,
  type LegacyPairAudit,
} from './legacy-pairs.js';
import {
  applyCriticalObligationReceipts,
  auditCriticalObligations,
  type CriticalObligationAudit,
  type DeclaredCriticalObligations,
} from './critical-obligations.js';
import { resolveBundleConfidence, summarizeConfidence, type ConfidenceSummary } from './confidence-ledger.js';
import {
  assessComparisonTruth,
  classifyChrome,
  cleanFindingsForDisplay,
  countCapturedSurfaceBases,
  countChangedSurfaceScope,
  type ComparisonTruth,
} from './change-groups.js';
import { dropDeclaredLiveTextGeometry } from './findings-clean.js';
import {
  collectLiveCandidateLabels,
  createMapLoader,
  type ChangeGroup,
  type PreparedSurface,
  type RenderCtx,
  type ReportConsistency,
} from './report/shared.js';
import {
  contentHostingSurfacePaths,
  contentSurfaces,
  renderChromeStructureSection,
  renderContentSection,
  splitChromeStructure,
} from './report/content-layer.js';
import {
  buildMigrationGallery,
  renderMigrationGallerySections,
  type MigrationGallery,
} from './report/migration-gallery.js';
import {
  baselineProvenanceLine,
  certificationLines,
  comparabilityLine,
  criticalObligationLines,
  evidenceSection,
  liveTextFreezeLines,
  productStateWarningLines,
} from './report/certification.js';
import { buildDigest, digestLines } from './report/digest.js';
import {
  baselineFailureDetailLines,
  oneSidedStatus,
  readBaselineInfo,
  reportHeadline,
  type BaselineInfo,
} from './report/headline.js';
import { countShownChanges, groupBySignature } from './report/regions.js';
import { assessReach, reachSectionLines, reachStripLines, reachSummaryLine, type ReportReach } from './report/reach.js';
import {
  ReportMarkdown,
  renderChangedSections,
  renderOneSidedSections,
  stateCoverageLines,
  writeReportArtifacts,
  type SectionState,
} from './report/sections.js';

// Re-exported so consumers (and tests) reach the summariser and grouping
// primitives through the package's report module rather than deep paths.
export { describeChange, colorName, tokenIndex, toHex } from './describe.js';
export {
  summarizeProps,
  summarizePropsWithFollowOns,
  prettyLabel,
  humanLabel,
  assessComparisonTruth,
} from './change-groups.js';
export type { SummarizedProp } from './change-groups.js';
export type { ComparisonTruth } from './change-groups.js';
export { propertyGlanceLine } from './report/markdown.js';
export { MIGRATION_GALLERY_LABELS, type MigrationGallery } from './report/migration-gallery.js';

/**
 * Visual diff report: for every surface with findings, crop the before/after
 * screenshots around the changed elements (both sides at the SAME page rectangle)
 * and write report.md with side-by-side images plus the exact property changes.
 */

export type ReportOptions = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  /** Prefix for image URLs in report.md (default: relative paths). */
  imageBaseUrl?: string;
  /** Padding around the union of changed rects (default 12px). */
  pad?: number;
  /** Minimum crop size, for context around tiny changes (default 320×180). */
  minWidth?: number;
  minHeight?: number;
  /** Crops taller than this are clamped (default 1600px). */
  maxHeight?: number;
  /** Changed-element footprint (px) at or below which a magnified zoom crop is added (default 64; 0 disables). */
  zoomBelow?: number;
  /** Max crop regions per surface before collapsing into one union crop (default 8). */
  maxCrops?: number;
  /** Row count at which a crop's property tables fold under `<details>` (default 0 = always; Infinity = never). */
  foldDetailsAt?: number;
  /** Include size/position-derived longhands. Off by default: on a reflow they would anchor crops to the whole page. */
  includeLayoutNoise?: boolean;
  /** Render the opt-in ADVISORY content layer (needs captures taken with `captureText: true`). Never gates. */
  includeContent?: boolean;
  /** Require explicit matching productState identity on every paired capture. */
  requireStateIdentity?: boolean;
  /** Unbound compare (no trusted SHAs): undeclared legacy pairs render as advisory, like declared ones. Gates unchanged. */
  diagnostic?: boolean;
  /** Declare gates: a precomputed audit wins; otherwise the declarations are audited when armed. */
  legacyPairs?: LegacyPairAudit;
  legacyPairDeclarations?: DeclaredLegacyPairs;
  legacyPairsArmed?: boolean;
  criticalStates?: CriticalObligationAudit;
  criticalObligations?: DeclaredCriticalObligations;
  criticalStatesArmed?: boolean;
  /** Coverage-ledger exclusion keys — a declared obligation that is also excluded fails closed. */
  coverageExclusions?: Iterable<string>;
  /** Byte ceiling for report.md (GitHub stops rendering past ~512 KB); past it, surfaces become one-liners
   *  while report.json keeps every row. Default 400_000; Infinity never caps. */
  maxReportBytes?: number;
  /** Migration mode (#566): add the Changed styles / New surfaces / New-removed elements gallery. Gates unchanged. */
  migration?: boolean;
  /** Operational mode recorded in report.json (#580). Defaults to 'certify'. */
  gateMode?: 'certify' | 'review-gate' | 'migration' | 'advisory';
  /** Change Reach is advisory by default; gate holds never-rendered rules and J1 ledger gaps. */
  changeReach?: ChangeReachLevel;
};

export type ReportComparison = ComparisonTruth & ComparabilitySummary;

export type ReportResult = {
  /** Surfaces carrying a reviewable change (excludes new, one-sided surfaces). */
  changedSurfaces: number;
  /** Genuinely new head surfaces with no baseline to compare. */
  newSurfaces: number;
  /** Every one-sided surface: new, removed, or baseline repair debt. */
  oneSidedSurfaces: number;
  totalFindings: number;
  /** Content-layer changes rendered — advisory entries plus Global chrome entries (0 unless includeContent). Never gates. */
  contentChanges: number;
  /** Canonical comparison truth vs the certification differ. `rawOnlyNoReviewable` must fail closed. */
  comparison: ReportComparison;
  /** Bounded per-capture receipts; identity values and page observations are never included. */
  comparability: SurfaceComparability[];
  legacyPairs?: LegacyPairAudit;
  criticalStates?: CriticalObligationAudit;
  /** Presentation-vs-certification coherence. Any false value must fail closed. */
  reportConsistency: ReportConsistency;
  /** Public baseline capture failures; raw exception details are deliberately excluded. */
  baselineFailures: BaselineFailureReceipt[];
  partialBaseline: boolean;
  /** The head bundle's confidence badge (#399), separate from the visual verdict. */
  confidence: ConfidenceSummary;
  /** Subtrees volatile on the head but compared on the base: excluded, so the report can never certify. */
  headOnlyVolatile: HeadOnlyVolatile[];
  /** Subtrees volatile on the base but settled on the head: excluded, so the report holds them for review. */
  baseOnlyVolatile: BaseOnlyVolatile[];
  reportMdPath: string;
  reportJsonPath: string;
  /** Present only when `migration: true`. */
  migrationGallery?: MigrationGallery;
  /** Change Reach J1 (#996); only when a capture carries a reach ledger. */
  reach?: ReportReach;
};

function buildContext(opts: ReportOptions, liveText: LiveTextAudit): RenderCtx {
  const { beforeDir, afterDir, outDir, imageBaseUrl = '' } = opts;
  return {
    beforeDir,
    afterDir,
    outDir,
    img: (rel) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, '')}/${rel}` : rel),
    load: createMapLoader(),
    liveText,
    padBy: opts.pad ?? 12,
    minWidth: opts.minWidth ?? 320,
    minHeight: opts.minHeight ?? 180,
    maxHeight: opts.maxHeight ?? 1600,
    zoomBelow: opts.zoomBelow ?? 64,
    maxCrops: opts.maxCrops ?? 8,
    foldDetailsAt: opts.foldDetailsAt ?? 0,
    includeNoise: opts.includeLayoutNoise === true,
    requireStateIdentity: opts.requireStateIdentity === true,
  };
}

type Gates = {
  legacyPairs?: LegacyPairAudit;
  criticalStates?: CriticalObligationAudit;
  comparability: SurfaceComparability[];
  /** What the presentation may render; certification always reads `comparability`. */
  displayComparability: SurfaceComparability[];
};

/** The declare gates: precomputed audits win; otherwise audit when armed. Receipts tighten comparability. */
function auditGates(opts: ReportOptions, raw: SurfaceComparability[]): Gates {
  const legacyPairs =
    opts.legacyPairs ??
    (opts.legacyPairsArmed ? auditLegacyPairs(raw, opts.legacyPairDeclarations ?? {}, true) : undefined);
  const criticalStates =
    opts.criticalStates ??
    (opts.criticalStatesArmed
      ? auditCriticalObligations(raw, opts.criticalObligations ?? {}, opts.coverageExclusions ?? [], true)
      : undefined);
  const comparability = applyCriticalObligationReceipts(applyLegacyPairReceipts(raw, legacyPairs), criticalStates);
  const displayComparability = opts.diagnostic ? applyCriticalObligationReceipts(raw, criticalStates) : comparability;
  return { legacyPairs, criticalStates, comparability, displayComparability };
}

function nonCertifying(receipt: SurfaceComparability | undefined, requireStateIdentity: boolean): boolean {
  return (
    receipt?.status === 'incomparable' || (receipt?.status === 'unproven' && (receipt.required || requireStateIdentity))
  );
}

/**
 * Focus each surface on styling intent: presentation findings run through
 * report-only path correspondence, then (unless layout noise is requested) the
 * reflow-casualty strip. Raw `sd.findings`, counts and gates stay on the
 * certification differ. Incomparable / required-unproven pairs render nothing.
 */
function prepareReportSurfaces(
  ctx: RenderCtx,
  surfaces: SurfaceDiff[],
  comparability: SurfaceComparability[],
  includeStructure: boolean,
): PreparedSurface[] {
  const receipts = new Map(comparability.map((entry) => [entry.surface, entry]));
  const blocked = (sd: SurfaceDiff): boolean => nonCertifying(receipts.get(sd.surface), ctx.requireStateIdentity);
  return surfaces
    .map((sd): PreparedSurface => {
      if (sd.missing) return { sd, findings: sd.findings };
      if (blocked(sd)) return { sd, findings: [] };
      const [before, after] = [ctx.load(ctx.beforeDir, sd.surface), ctx.load(ctx.afterDir, sd.surface)];
      const corresponded = presentationDiffStyleMaps(before, after, { includeStructure });
      const focused = ctx.includeNoise ? corresponded : cleanFindingsForDisplay(corresponded);
      return { sd, findings: dropDeclaredLiveTextGeometry(focused, ctx.liveText, sd.surface) };
    })
    .filter((s) => s.sd.missing || s.findings.length > 0);
}

/** With layout noise included, raw-only is not a consistency failure; otherwise keep the fail-closed truth. */
function comparisonForReport(
  comparison: ComparisonTruth,
  includeNoise: boolean,
  reviewableChangedSurfaces: number,
): ComparisonTruth {
  return {
    ...comparison,
    rawOnlyNoReviewable: !includeNoise && comparison.rawOnlyNoReviewable,
    hasReviewableEvidence: comparison.hasReviewableEvidence || (includeNoise && reviewableChangedSurfaces > 0),
  };
}

/** The presentation may simplify raw evidence but never erase every reviewable finding and claim "identical". */
function assessReportConsistency(comparison: ComparisonTruth, hasPresentationEvidence: boolean): ReportConsistency {
  if (comparison.rawOnlyNoReviewable) return { ok: false, reason: 'raw_only_no_reviewable' };
  if (comparison.hasReviewableEvidence && !hasPresentationEvidence) {
    return { ok: false, reason: 'presentation_collapsed_while_raw_reviewable' };
  }
  return { ok: true, reason: 'aligned' };
}

function liveTextFreezeReceipt(liveText: LiveTextAudit): { violated: boolean; reason?: string } | null {
  if (liveText.freeze && liveText.violations.length > 0)
    return { violated: true, reason: liveTextFreezeError(liveText) };
  return liveText.declared ? { violated: false } : null;
}

/**
 * The opt-in content layer: advisory per-surface entries, with one-sided element changes
 * shared by every surface base that renders their container split out into ONE Global
 * chrome entry each (#754). Migration mode keeps its gallery and the unsplit list.
 */
function renderContentLayer(
  ctx: RenderCtx,
  mode: { includeContent: boolean; migration: boolean },
  surfacePaths: Map<string, Set<string>>,
  surfaceKeyOf: (captureKey: string) => string | undefined,
  elevatedNavigableChromeAdds = 0,
  elevatedVisibleStructure = 0,
) {
  const withContent = mode.includeContent || mode.migration ? contentSurfaces(ctx) : [];
  if (!mode.includeContent) {
    return { withContent, contentSection: { md: [], count: 0 }, chromeMd: [], globalChrome: 0, total: 0 };
  }
  // Content chrome hosts only over paired surfaces — unpaired co-hosts must not
  // expand the must-hit set (#767 / #754 residual). Style classifyChrome keeps full surfacePaths.
  const split = mode.migration
    ? { chrome: [], rest: withContent }
    : splitChromeStructure(
        withContent,
        contentHostingSurfacePaths(ctx.beforeDir, ctx.afterDir, surfacePaths),
        surfaceKeyOf,
      );
  const contentSection = renderContentSection(ctx, split.rest, {
    elevatedVisibleStructure,
  });
  const globalChrome = split.chrome.length;
  const chromeMd = renderChromeStructureSection(ctx, split.chrome, {
    elevatedNavigableAdds: elevatedNavigableChromeAdds,
    elevatedVisibleStructure,
  });
  return { withContent, contentSection, chromeMd, globalChrome, total: contentSection.count + globalChrome };
}

type SurfaceKeyOf = (captureKey: string) => string | undefined;

type Presentation = {
  prepared: PreparedSurface[];
  /** One-sided surfaces: new, removed, or baseline repair debt. */
  missing: PreparedSurface[];
  /** Paired surfaces shown that also certify; advisory-only (diagnostic display) surfaces are not
   *  presentation evidence for the consistency receipt. */
  certifyingShown: number;
  changeGroups: ChangeGroup[];
  /** Shared-chrome tier (#193): purely presentational — only render order and one banner differ. */
  chrome: { chrome: ChangeGroup[]; rest: ChangeGroup[] };
  shown: DiffCounts;
};

/** What the report shows: prepared surfaces, grouped by change signature and split into the chrome tier. */
function presentSurfaces(
  ctx: RenderCtx,
  surfaces: SurfaceDiff[],
  gates: Gates,
  includeStructure: boolean,
  surfacePaths: Map<string, Set<string>>,
  surfaceKeyOf: SurfaceKeyOf,
): Presentation {
  const prepared = prepareReportSurfaces(ctx, surfaces, gates.displayComparability, includeStructure);
  const missing = prepared.filter((s) => s.sd.missing);
  const paired = prepared.filter((s) => !s.sd.missing);
  const certifyingReceipts = new Map(gates.comparability.map((entry) => [entry.surface, entry]));
  const certifyingShown = paired.filter(
    (s) => !nonCertifying(certifyingReceipts.get(s.sd.surface), ctx.requireStateIdentity),
  ).length;
  const changeGroups = groupBySignature(ctx, paired);
  const chrome = classifyChrome(changeGroups, surfacePaths, surfaceKeyOf);
  return { prepared, missing, certifyingShown, changeGroups, chrome, shown: countShownChanges(changeGroups) };
}

/** The certification differ's truth, adjusted for the presentation, with elevated structure counted as reviewable. */
function reportComparison(
  raw: ComparisonTruth,
  summary: ComparabilitySummary,
  includeNoise: boolean,
  certifyingShown: number,
  elevation: StructureElevation,
): ReportComparison {
  const base: ReportComparison = { ...comparisonForReport(raw, includeNoise, certifyingShown), ...summary };
  return { ...base, ...elevateReviewable(base, elevation) };
}

/**
 * Everything below the headline, in render order: baseline failure receipts, one-sided and
 * changed surfaces, Global chrome, the migration gallery, and advisory content. Budget-aware:
 * past the display budget, each block collapses to its one-line notice (report.json keeps it all).
 */
function renderReportBody(
  ctx: RenderCtx,
  out: SectionState,
  input: {
    view: Presentation;
    baseline: BaselineInfo;
    content: ReturnType<typeof renderContentLayer>;
    migrationGallery: MigrationGallery | undefined;
    reach: ReportReach | undefined;
    surfaceKeyOf: SurfaceKeyOf;
  },
) {
  const { view, baseline, content, migrationGallery, reach, surfaceKeyOf } = input;
  const { md } = out;
  if (baseline.failures.length > 0) {
    md.detail(
      baselineFailureDetailLines(baseline.failures),
      `- ${baseline.failures.length} baseline capture failure receipt(s) summarized here; full bounded identities are in report.json`,
    );
  }
  const oneSided = renderOneSidedSections(ctx, out, view.missing, baseline.surfaceFailures);
  const changed = renderChangedSections(
    ctx,
    out,
    view.chrome,
    countChangedSurfaceScope(view.chrome.chrome, surfaceKeyOf).bases,
    countCapturedSurfaceBases(captureKeysIn(ctx.afterDir), surfaceKeyOf),
  );
  if (reach) md.detail(reachSectionLines(reach), reachSummaryLine(reach));
  md.detail(
    content.chromeMd,
    `- ${content.globalChrome} global chrome element change(s) on every surface base that renders its container`,
  );
  if (migrationGallery) {
    const g = migrationGallery;
    md.detail(
      renderMigrationGallerySections(g),
      `- Migration gallery: ${g.changedStyles.length} changed styles, ${g.newSurfaces.length} new surfaces, ${g.newRemovedElements.length} surfaces with element changes`,
    );
  }
  if (content.contentSection.md.length > 0 && !migrationGallery) {
    md.detail(
      content.contentSection.md,
      `- ${content.contentSection.count} advisory content/structure change(s); full image evidence remains in the published report artifacts.`,
    );
  }
  return { oneSided, changed };
}

/** Evidence lists failures and warnings only; passing checks stay out. */
function evidenceLines(input: {
  certIssues: string[];
  liveText: LiveTextAudit;
  provenanceLine: string;
  comparison: ReportComparison;
  gates: Gates;
  criticalObligations: DeclaredCriticalObligations | undefined;
}): string[] {
  const { certIssues, liveText, provenanceLine, comparison, gates } = input;
  const comparabilityText = comparabilityLine(comparison, gates.legacyPairs);
  // Proven / not-required stay out of Evidence; the above-the-fold warning covers unproven cases.
  const comparabilityEvidence = /✓ comparable|not required/.test(comparabilityText) ? [] : [comparabilityText, ''];
  return [
    ...certIssues,
    ...liveTextFreezeLines(liveText),
    ...(provenanceLine && !/✓/.test(provenanceLine) ? [provenanceLine, ''] : []),
    ...comparabilityEvidence,
    ...criticalObligationLines(gates.criticalStates, input.criticalObligations),
  ];
}

function generateStyleMapReportInternal(opts: ReportOptions, includeStructure: boolean): ReportResult {
  const { beforeDir, afterDir, outDir, gateMode = 'certify' } = opts;
  const includeContent = opts.includeContent === true;
  const migration = opts.migration === true;

  // 1. Compare the maps and audit the declare gates.
  // Base first, head second: current capture metadata wins when a surface's product key changed.
  const surfaceKeyOf = mergeSurfaceKeyLookup(beforeDir, afterDir);
  const diff = diffStyleMapDirs(beforeDir, afterDir, { includeStructure });
  const gates = auditGates(opts, diff.comparability);
  const liveText = auditLiveTextDirs(beforeDir, afterDir);
  const ctx = buildContext(opts, liveText);
  const rawComparison = assessComparisonTruth(diff.surfaces, diff.counts, gates.comparability, {
    requireStateIdentity: ctx.requireStateIdentity,
    liveText,
  });
  const comparabilitySummary = summarizeComparability(gates.comparability, ctx.requireStateIdentity);
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });

  // 2. Decide what the report shows, and what it may claim about it.
  const surfacePaths = surfaceElementPaths(beforeDir, afterDir);
  const view = presentSurfaces(ctx, diff.surfaces, gates, includeStructure, surfacePaths, surfaceKeyOf);
  const reach = assessReach(ctx, opts.changeReach ?? 'warn');
  const baseline = readBaselineInfo(beforeDir, afterDir);
  const elevation = collectStructureElevation({ beforeDir, afterDir, migration, surfacePaths, surfaceKeyOf });
  const comparison = reportComparison(
    rawComparison,
    comparabilitySummary,
    ctx.includeNoise,
    view.certifyingShown,
    elevation,
  );
  // Elevated visible structure / navigable chrome is reviewable presentation evidence even
  // when matched-element style changeGroups are empty (no restyle sections to crop).
  const reportConsistency = assessReportConsistency(
    comparison,
    view.certifyingShown > 0 || view.missing.length > 0 || elevation.dom > 0,
  );
  // Content layer: advisory per-surface + Global chrome display; elevated count colours copy.
  const content = renderContentLayer(
    ctx,
    { includeContent, migration },
    surfacePaths,
    surfaceKeyOf,
    elevation.chrome.count,
    elevation.visible.count,
  );
  // Confidence is resolved once and shared with report.json so badge and JSON can never disagree.
  const confidenceLedger = resolveBundleConfidence(afterDir);
  const confidence = summarizeConfidence(confidenceLedger);
  const baselineProvenance = readBaselineProvenance(beforeDir);
  const digest = buildDigest(
    ctx,
    view.missing.map((p) => ({ surface: p.sd.surface, status: oneSidedStatus(p, baseline.surfaceFailures) })),
    view.chrome,
  );

  // 3. Render report.md: verdict first (above the fold), then the product-state warning when it
  // fires — never the certification checklist first, and never a green product-state peer card.
  const md = new ReportMarkdown(opts.maxReportBytes ?? 400_000);
  const headline = reportHeadline({
    changeGroups: view.changeGroups,
    missing: view.missing,
    shown: view.shown,
    changedScope: countChangedSurfaceScope(view.changeGroups, surfaceKeyOf),
    whatChanged: digestLines(digest),
    volatileCount: diff.volatile,
    headOnlyVolatile: diff.headOnlyVolatile,
    baseOnlyVolatile: diff.baseOnlyVolatile,
    liveCandidateLabels: diff.volatile === 0 ? [] : collectLiveCandidateLabels(beforeDir, afterDir),
    contentCount: content.contentSection.count,
    globalChromeCount: content.globalChrome,
    elevatedNavigableChromeAdds: elevation.chrome.count,
    elevatedVisibleStructure: elevation.visible.count,
    elevatedStructureDom: elevation.dom,
    contentEvaluated: includeContent,
    reportConsistency,
    rawCounts: comparison.rawCounts,
    baseline,
    confidenceBlocked: confidence.counts.inaccessible > 0,
    comparisonBlocked: comparison.blocksCertification,
    reachBlocking: reach?.blocking ?? 0,
    liveTextFreezeViolated: comparison.liveTextFreezeViolated,
  });
  const reachStrip = reach ? reachStripLines(reach) : [];
  md.lines.push(
    '## 🗺️ StyleProof report',
    '',
    ...productStateWarningLines(comparison, gates.legacyPairs),
    ...headline,
    ...reachStrip,
    ...stateCoverageLines(ctx),
  );
  md.trimToBudget();
  // A byte cap must never leave the verdict visible while silently dropping reach evidence.
  if (reach && !md.lines.includes(reachStrip[1])) {
    throw new Error('report byte budget cannot show reach status; increase maxReportBytes');
  }

  const out: SectionState = { md, json: [], seq: { crop: 0 } };
  const migrationGallery = migration ? buildMigrationGallery(diff.surfaces, content.withContent) : undefined;
  const { oneSided, changed } = renderReportBody(ctx, out, {
    view,
    baseline,
    content,
    migrationGallery,
    reach,
    surfaceKeyOf,
  });

  // Evidence (failures/warnings only) collapses by default under the fold.
  const certIssues = certificationLines(
    beforeDir,
    afterDir,
    { ledger: confidenceLedger, summary: confidence },
    elevation.chrome.count,
  );
  // "Nothing else" when restyles exist but no advisory content / inventory issues.
  const inventoryTouched = certIssues.some((l) => /Inventory/.test(l));
  if (
    view.changeGroups.length > 0 &&
    view.missing.length === 0 &&
    content.total === 0 &&
    !migrationGallery &&
    !inventoryTouched &&
    !(reach && reachSectionLines(reach).length > 0)
  ) {
    md.append(['', '_Nothing else — no other element or inventory changes in this compare._']);
  }
  md.finish(
    evidenceSection(
      evidenceLines({
        certIssues,
        liveText,
        provenanceLine: baselineProvenanceLine(baselineProvenance),
        comparison,
        gates,
        criticalObligations: opts.criticalObligations,
      }),
    ),
  );

  // 4. Write report.md and report.json, and return the result.
  const paths = writeReportArtifacts({
    outDir,
    md: md.lines,
    gateMode,
    counts: view.shown,
    comparison,
    comparability: gates.comparability,
    reportConsistency,
    baselineFailures: baseline.failures,
    undeclaredOnBase: baseline.undeclaredOnBase,
    content: {
      evaluated: includeContent,
      changes: content.total,
      advisory: true,
      ...(content.globalChrome ? { globalChrome: content.globalChrome } : {}),
      ...(elevation.chrome.count ? { elevatedNavigableChromeAdds: elevation.chrome.count } : {}),
      ...(elevation.visible.count ? { elevatedVisibleStructure: elevation.visible.count } : {}),
    },
    surfaces: out.json,
    confidence,
    baselineProvenance,
    liveTextFreeze: liveTextFreezeReceipt(liveText),
    headOnlyVolatile: diff.headOnlyVolatile,
    baseOnlyVolatile: diff.baseOnlyVolatile,
    legacyPairs: gates.legacyPairs,
    criticalStates: gates.criticalStates,
    digest,
    reach,
  });
  return {
    changedSurfaces: view.prepared.length - view.missing.length,
    newSurfaces: oneSided.greenfieldNewSurfaces,
    oneSidedSurfaces: view.missing.length,
    totalFindings: changed.totalFindings,
    contentChanges: content.total,
    comparison,
    comparability: gates.comparability,
    ...(gates.legacyPairs ? { legacyPairs: gates.legacyPairs } : {}),
    ...(gates.criticalStates ? { criticalStates: gates.criticalStates } : {}),
    reportConsistency,
    baselineFailures: baseline.failures,
    partialBaseline: baseline.failures.length > 0,
    confidence,
    headOnlyVolatile: diff.headOnlyVolatile,
    baseOnlyVolatile: diff.baseOnlyVolatile,
    ...paths,
    ...(migrationGallery ? { migrationGallery } : {}),
    ...(reach ? { reach } : {}),
  };
}

/** Generate the public report. Navigable Global chrome (#766) and visible paired-surface add/remove elevate; invisible structure and pure text stay advisory. */
export function generateStyleMapReport(opts: ReportOptions): ReportResult {
  return generateStyleMapReportInternal(opts, false);
}

/** @internal Retains direct coverage of the low-level structural renderer. */
export function generateStructuralStyleMapReportForTesting(opts: ReportOptions): ReportResult {
  return generateStyleMapReportInternal(opts, true);
}
