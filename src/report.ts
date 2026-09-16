import fs from 'node:fs';
import path from 'node:path';
import { captureKeysIn, mergeSurfaceKeyLookup, surfaceElementPaths } from './capture.js';
import { readBaselineProvenance, type BaselineFailureReceipt } from './map-store.js';
import {
  diffStyleMapDirs,
  auditLiveTextDirs,
  presentationDiffStyleMaps,
  summarizeComparability,
  type ComparabilitySummary,
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
  type PreparedSurface,
  type RenderCtx,
  type ReportConsistency,
} from './report/shared.js';
import { contentSurfaces, renderContentSection } from './report/content-layer.js';
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
  liveTextFreezeLines,
} from './report/certification.js';
import { baselineFailureDetailLines, readBaselineInfo, reportHeadline } from './report/headline.js';
import { countShownChanges, groupBySignature } from './report/regions.js';
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
export { summarizeProps, prettyLabel, assessComparisonTruth } from './change-groups.js';
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
  /** Advisory content-layer changes rendered (0 unless includeContent + captured text). Never gates. */
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
  reportMdPath: string;
  reportJsonPath: string;
  /** Present only when `migration: true`. */
  migrationGallery?: MigrationGallery;
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
  return { legacyPairs, criticalStates, comparability };
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
  const blocked = (sd: SurfaceDiff): boolean => {
    const r = receipts.get(sd.surface);
    return r?.status === 'incomparable' || (r?.status === 'unproven' && (r.required || ctx.requireStateIdentity));
  };
  return surfaces
    .map((sd): PreparedSurface => {
      if (sd.missing) return { sd, findings: sd.findings };
      if (blocked(sd)) return { sd, findings: [] };
      const [before, after] = [ctx.load(ctx.beforeDir, sd.surface), ctx.load(ctx.afterDir, sd.surface)];
      const corresponded = presentationDiffStyleMaps(before, after, { includeStructure });
      const focused = ctx.includeNoise ? corresponded : cleanFindingsForDisplay(corresponded);
      return { sd, findings: dropDeclaredLiveTextGeometry(focused, ctx.liveText) };
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

function generateStyleMapReportInternal(opts: ReportOptions, includeStructure: boolean): ReportResult {
  const { beforeDir, afterDir, outDir, gateMode = 'certify' } = opts;
  const includeContent = opts.includeContent === true;
  const migration = opts.migration === true;
  // Base first, head second: current capture metadata wins when a surface's product key changed.
  const surfaceKeyOf = mergeSurfaceKeyLookup(beforeDir, afterDir);
  const diff = diffStyleMapDirs(beforeDir, afterDir, { includeStructure });
  const gates = auditGates(opts, diff.comparability);
  const liveText = auditLiveTextDirs(beforeDir, afterDir);
  const ctx = buildContext(opts, liveText);
  const { requireStateIdentity } = ctx;
  const rawComparison = assessComparisonTruth(diff.surfaces, diff.counts, gates.comparability, {
    requireStateIdentity,
    liveText,
  });
  const comparabilitySummary = summarizeComparability(gates.comparability, requireStateIdentity);
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });

  const prepared = prepareReportSurfaces(ctx, diff.surfaces, gates.comparability, includeStructure);
  const missing = prepared.filter((s) => s.sd.missing);
  const changeGroups = groupBySignature(
    ctx,
    prepared.filter((s) => !s.sd.missing),
  );
  // Shared-chrome tier (#193): purely presentational — only render order and one banner differ.
  const chrome = classifyChrome(changeGroups, surfaceElementPaths(beforeDir, afterDir), surfaceKeyOf);
  const shown = countShownChanges(changeGroups);
  const baseline = readBaselineInfo(beforeDir);
  const comparison: ReportComparison = {
    ...comparisonForReport(rawComparison, ctx.includeNoise, prepared.length - missing.length),
    ...comparabilitySummary,
  };
  const reportConsistency = assessReportConsistency(comparison, changeGroups.length > 0 || missing.length > 0);

  // Advisory content layer: computed first so its count can colour the headline; appended last; never gates.
  const withContent = includeContent || migration ? contentSurfaces(ctx) : [];
  const contentSection = includeContent ? renderContentSection(ctx, withContent) : { md: [], count: 0 };

  // Confidence is resolved once and shared with report.json so badge and JSON can never disagree.
  const confidenceLedger = resolveBundleConfidence(afterDir);
  const confidence = summarizeConfidence(confidenceLedger);
  const baselineProvenance = readBaselineProvenance(beforeDir);
  const provenanceLine = baselineProvenanceLine(baselineProvenance);
  const md = new ReportMarkdown(opts.maxReportBytes ?? 400_000);
  md.lines.push(
    '## 🗺️ StyleProof report',
    '',
    ...certificationLines(beforeDir, afterDir, { ledger: confidenceLedger, summary: confidence }),
    ...liveTextFreezeLines(liveText),
    ...(provenanceLine ? [provenanceLine, ''] : []),
    comparabilityLine(comparison, gates.legacyPairs),
    '',
    ...criticalObligationLines(gates.criticalStates, opts.criticalObligations),
    ...reportHeadline({
      changeGroups,
      missing,
      shown,
      changedScope: countChangedSurfaceScope(changeGroups, surfaceKeyOf),
      volatileCount: diff.volatile,
      liveCandidateLabels: diff.volatile === 0 ? [] : collectLiveCandidateLabels(beforeDir, afterDir),
      contentCount: contentSection.count,
      contentEvaluated: includeContent,
      reportConsistency,
      rawCounts: comparison.rawCounts,
      baseline,
      confidenceBlocked: confidence.counts.inaccessible > 0,
      comparisonBlocked: comparison.blocksCertification,
      liveTextFreezeViolated: comparison.liveTextFreezeViolated,
    }),
    ...stateCoverageLines(ctx),
  );
  md.trimToBudget();

  const out: SectionState = { md, json: [], seq: { crop: 0 } };
  if (baseline.failures.length > 0) {
    md.detail(
      baselineFailureDetailLines(baseline.failures),
      `- ${baseline.failures.length} baseline capture failure receipt(s) summarized here; full bounded identities are in report.json`,
    );
  }
  const oneSided = renderOneSidedSections(ctx, out, missing, baseline.surfaceFailures);
  const changed = renderChangedSections(
    ctx,
    out,
    chrome,
    countCapturedSurfaceBases(captureKeysIn(afterDir), surfaceKeyOf),
  );

  const migrationGallery = migration ? buildMigrationGallery(diff.surfaces, withContent) : undefined;
  if (migrationGallery) {
    const g = migrationGallery;
    md.detail(
      renderMigrationGallerySections(g),
      `- Migration gallery: ${g.changedStyles.length} changed styles, ${g.newSurfaces.length} new surfaces, ${g.newRemovedElements.length} surfaces with element changes`,
    );
  }
  if (contentSection.md.length > 0 && !migration) {
    md.detail(
      contentSection.md,
      `- ${contentSection.count} advisory content/structure change(s); full image evidence remains in the published report artifacts.`,
    );
  }

  const paths = writeReportArtifacts({
    outDir,
    md: md.lines,
    gateMode,
    counts: shown,
    comparison,
    comparability: gates.comparability,
    reportConsistency,
    baselineFailures: baseline.failures,
    content: { evaluated: includeContent, changes: contentSection.count, advisory: true },
    surfaces: out.json,
    confidence,
    baselineProvenance,
    liveTextFreeze: liveTextFreezeReceipt(liveText),
    legacyPairs: gates.legacyPairs,
    criticalStates: gates.criticalStates,
  });
  return {
    changedSurfaces: prepared.length - missing.length,
    newSurfaces: oneSided.greenfieldNewSurfaces,
    oneSidedSurfaces: missing.length,
    totalFindings: changed.totalFindings,
    contentChanges: contentSection.count,
    comparison,
    comparability: gates.comparability,
    ...(gates.legacyPairs ? { legacyPairs: gates.legacyPairs } : {}),
    ...(gates.criticalStates ? { criticalStates: gates.criticalStates } : {}),
    reportConsistency,
    baselineFailures: baseline.failures,
    partialBaseline: baseline.failures.length > 0,
    confidence,
    ...paths,
    ...(migrationGallery ? { migrationGallery } : {}),
  };
}

/** Generate the public report. DOM structure is never part of certification. */
export function generateStyleMapReport(opts: ReportOptions): ReportResult {
  return generateStyleMapReportInternal(opts, false);
}

/** @internal Retains direct coverage of the low-level structural renderer. */
export function generateStructuralStyleMapReportForTesting(opts: ReportOptions): ReportResult {
  return generateStyleMapReportInternal(opts, true);
}
