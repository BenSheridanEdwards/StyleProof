/**
 * Phase 1 foundation harness helpers (#668 / #669).
 *
 * Shared fail-closed assertions for proving a known CSS delta on the StyleProof
 * demo maps through capture → diff → report. Soft-pass: HOLD — callers must not
 * treat incomplete mapping as success.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StyleMap } from '../src/capture.js';
import type { ContentChange, Finding } from '../src/diff.js';
import { MIGRATION_GALLERY_LABELS } from '../src/report.js';
import { classifyStyleProofVerdict, type StyleProofTrustState } from '../src/verdict.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export type Phase1CssDeltaOracle = {
  description: string;
  softPass: string;
  surfaceKey: string;
  width: number;
  element: { tag: string; cls: string; label: string };
  queryParams: { base: string; head: string };
  expectedFinding: {
    kind: 'style';
    prop: string;
    before: string;
    after: string;
  };
  report: {
    surfaceCaption: string;
    elementHeading: string;
    propLine: string;
    beforeHex: string;
    afterHex: string;
    trustGlanceContains: string;
  };
};

export const PHASE1_ORACLE_PATH = path.join(here, '..', 'example', 'demo', 'phase1-css-delta.json');
export const PHASE1_NOOP_ORACLE_PATH = path.join(here, '..', 'example', 'demo', 'phase1-noop-equivalent.json');

export function loadPhase1CssDeltaOracle(oraclePath = PHASE1_ORACLE_PATH): Phase1CssDeltaOracle {
  return JSON.parse(fs.readFileSync(oraclePath, 'utf8')) as Phase1CssDeltaOracle;
}

export function phase1DemoUrl(demoFileUrl: string, query: string): string {
  const joiner = demoFileUrl.includes('?') ? '&' : '?';
  return `${demoFileUrl}${joiner}${query}`;
}

export type Phase1ElementOracle = { element: { tag: string; cls: string; label: string } };

export type Phase1StructureDeltaOracle = {
  description: string;
  softPass: string;
  surfaceKey: string;
  width: number;
  element: Phase1ElementOracle['element'];
  queryParams: { base: string; head: string };
  expectedFinding: {
    kind: 'structure';
    change: 'added' | 'removed' | 'retagged';
  };
  report: {
    migrationHeader: string;
    galleryLabel: string;
    gallerySurfaceLine: string;
    galleryAddedCount: string;
    trustGlanceContains: string;
  };
};

export const PHASE1_STRUCTURE_ORACLE_PATH = path.join(here, '..', 'example', 'demo', 'phase1-structure-delta.json');

export function loadPhase1StructureDeltaOracle(oraclePath = PHASE1_STRUCTURE_ORACLE_PATH): Phase1StructureDeltaOracle {
  return JSON.parse(fs.readFileSync(oraclePath, 'utf8')) as Phase1StructureDeltaOracle;
}

export function findDemoElementPath(map: StyleMap, oracle: Phase1ElementOracle): string | undefined {
  return Object.entries(map.elements).find(
    ([, entry]) => entry.tag === oracle.element.tag && entry.cls === oracle.element.cls,
  )?.[0];
}

export function assertPhase1CssDiffFinding(
  findings: Finding[],
  beforePath: string,
  afterPath: string,
  oracle: Phase1CssDeltaOracle,
): Extract<Finding, { kind: 'style' }> {
  const expected = oracle.expectedFinding;
  const actual = findings.find(
    (finding): finding is Extract<Finding, { kind: 'style' }> =>
      finding.kind === expected.kind &&
      finding.path === afterPath &&
      finding.pseudo === null &&
      finding.props.some((prop) => prop.prop === expected.prop),
  );
  if (!actual) {
    throw new Error(
      `FAIL-CLOSED: missing ${expected.prop} finding on ${oracle.element.label} (before=${beforePath}, after=${afterPath})`,
    );
  }
  const prop = actual.props.find((entry) => entry.prop === expected.prop);
  if (!prop) {
    throw new Error(`FAIL-CLOSED: finding on ${oracle.element.label} lacks prop ${expected.prop}`);
  }
  if (prop.before !== expected.before) {
    throw new Error(
      `FAIL-CLOSED: ${oracle.element.label} ${expected.prop} before expected "${expected.before}" got "${prop.before}"`,
    );
  }
  if (prop.after !== expected.after) {
    throw new Error(
      `FAIL-CLOSED: ${oracle.element.label} ${expected.prop} after expected "${expected.after}" got "${prop.after}"`,
    );
  }
  return actual;
}

type ReportJsonShape = {
  comparison?: {
    rawChangedSurfaces?: number;
    reviewableChangedSurfaces?: number;
    rawCounts?: { style?: number };
  };
  rawCounts?: { style?: number };
  counts?: { style?: number };
  surfaces?: Array<{ representative?: string; surface?: string; findings?: unknown[] }>;
};

export function assertPhase1CssReportMapping(input: {
  reportMd: string;
  reportJson: ReportJsonShape;
  oracle: Phase1CssDeltaOracle;
}): void {
  const { reportMd, reportJson, oracle } = input;
  const styleCount =
    reportJson.comparison?.rawCounts?.style ?? reportJson.rawCounts?.style ?? reportJson.counts?.style ?? 0;
  if (styleCount < 1) {
    throw new Error('FAIL-CLOSED: report.json shows zero style changes for a known CSS delta');
  }
  const changedSurfaces =
    reportJson.comparison?.rawChangedSurfaces ??
    reportJson.comparison?.reviewableChangedSurfaces ??
    reportJson.surfaces?.length ??
    0;
  if (changedSurfaces < 1) {
    throw new Error('FAIL-CLOSED: report.json shows zero changed surfaces for a known CSS delta');
  }

  const surfaceFilePrefix = `${oracle.surfaceKey}@${oracle.width}`;
  const surfaceFinding = reportJson.surfaces?.find(
    (surface) =>
      surface.representative?.startsWith(surfaceFilePrefix) || surface.surface?.startsWith(surfaceFilePrefix),
  );
  if (!surfaceFinding || !surfaceFinding.findings?.length) {
    throw new Error(`FAIL-CLOSED: report.json lacks findings for ${surfaceFilePrefix}`);
  }

  const requiredMd = [
    oracle.report.surfaceCaption,
    oracle.report.elementHeading,
    oracle.report.propLine,
    oracle.report.beforeHex,
    oracle.report.afterHex,
    oracle.report.trustGlanceContains,
  ];
  for (const needle of requiredMd) {
    if (!reportMd.includes(needle)) {
      throw new Error(`FAIL-CLOSED: report.md missing "${needle}" for the known CSS delta`);
    }
  }
  if (/No reviewable computed-style changes/i.test(reportMd)) {
    throw new Error('FAIL-CLOSED: report.md claims no reviewable changes despite a known CSS delta');
  }
}

type MigrationReportJsonShape = ReportJsonShape & {
  migrationGallery?: {
    newRemovedElements?: Array<{ surface: string; added: number; removed: number; retagged: number }>;
  };
  gateMode?: string;
};

export function assertPhase1StructureContentFinding(
  changes: ContentChange[],
  afterPath: string,
  oracle: Phase1StructureDeltaOracle,
): Extract<ContentChange, { kind: 'structure' }> {
  const expected = oracle.expectedFinding;
  const actual = changes.find(
    (change): change is Extract<ContentChange, { kind: 'structure' }> =>
      change.kind === expected.kind && change.path === afterPath && change.change === expected.change,
  );
  if (!actual) {
    throw new Error(
      `FAIL-CLOSED: missing ${expected.change} structure finding on ${oracle.element.label} (after=${afterPath})`,
    );
  }
  if (actual.cls !== oracle.element.cls) {
    throw new Error(`FAIL-CLOSED: ${oracle.element.label} cls expected "${oracle.element.cls}" got "${actual.cls}"`);
  }
  return actual;
}

export function assertPhase1StructureReportMapping(input: {
  reportMd: string;
  reportJson: MigrationReportJsonShape;
  oracle: Phase1StructureDeltaOracle;
  migrationGallery?: MigrationReportJsonShape['migrationGallery'];
}): void {
  const { reportMd, reportJson, oracle, migrationGallery } = input;
  const surfaceFilePrefix = `${oracle.surfaceKey}@${oracle.width}`;
  const galleryEntry =
    migrationGallery?.newRemovedElements?.find((entry) => entry.surface.startsWith(surfaceFilePrefix)) ??
    reportJson.migrationGallery?.newRemovedElements?.find((entry) => entry.surface.startsWith(surfaceFilePrefix));
  if (!galleryEntry || galleryEntry.added < 1) {
    const mdGalleryFallback =
      reportMd.includes(oracle.report.galleryAddedCount) && reportMd.includes(oracle.report.gallerySurfaceLine);
    if (!mdGalleryFallback) {
      throw new Error(`FAIL-CLOSED: migration gallery lacks added element on ${surfaceFilePrefix}`);
    }
  }

  const requiredMd = [
    oracle.report.migrationHeader,
    MIGRATION_GALLERY_LABELS.newRemovedElements,
    oracle.report.galleryLabel,
    oracle.report.gallerySurfaceLine,
    oracle.report.galleryAddedCount,
    oracle.report.trustGlanceContains,
  ];
  for (const needle of requiredMd) {
    if (!reportMd.includes(needle)) {
      throw new Error(`FAIL-CLOSED: report.md missing "${needle}" for the known structure delta`);
    }
  }
  if (reportJson.gateMode !== 'migration' && reportJson.migration !== true) {
    throw new Error('FAIL-CLOSED: report.json must record migration mode (gateMode or migration marker)');
  }
}

export type Phase1NoopEquivalentOracle = {
  description: string;
  softPass: string;
  surfaceKey: string;
  width: number;
  element: { tag: string; cls: string; label: string };
  cases: Array<{
    id: string;
    description: string;
    queryParams: { base: string; head: string };
    expectedComputed?: Record<string, string>;
  }>;
  report: {
    surfaceCaption: string;
    cleanMatchLine: string;
    forbiddenTrustStates: StyleProofTrustState[];
  };
};

export function loadPhase1NoopEquivalentOracle(oraclePath = PHASE1_NOOP_ORACLE_PATH): Phase1NoopEquivalentOracle {
  return JSON.parse(fs.readFileSync(oraclePath, 'utf8')) as Phase1NoopEquivalentOracle;
}

type NoopReportJsonShape = {
  comparison?: {
    rawChangedSurfaces?: number;
    reviewableChangedSurfaces?: number;
    hasReviewableEvidence?: boolean;
    rawCounts?: { dom?: number; style?: number; state?: number };
    reviewableCounts?: { dom?: number; style?: number; state?: number };
    blocksCertification?: boolean;
  };
  rawCounts?: { dom?: number; style?: number; state?: number };
  counts?: { dom?: number; style?: number; state?: number };
  reviewableCounts?: { dom?: number; style?: number; state?: number };
  reportConsistency?: { ok?: boolean; reason?: string };
  surfaces?: Array<{ representative?: string; surface?: string; findings?: unknown[] }>;
};

function reviewableStyleCount(reportJson: NoopReportJsonShape): number {
  return (
    reportJson.comparison?.reviewableCounts?.style ??
    reportJson.reviewableCounts?.style ??
    reportJson.comparison?.rawCounts?.style ??
    reportJson.rawCounts?.style ??
    reportJson.counts?.style ??
    0
  );
}

function reviewableTotal(reportJson: NoopReportJsonShape): number {
  const counts =
    reportJson.comparison?.reviewableCounts ??
    reportJson.reviewableCounts ??
    reportJson.comparison?.rawCounts ??
    reportJson.rawCounts ??
    reportJson.counts;
  if (!counts) return 0;
  return (counts.dom ?? 0) + (counts.style ?? 0) + (counts.state ?? 0);
}

/** Fail closed when a known no-op/equivalent case invents reviewable evidence. */
export function assertPhase1NoopReportMapping(input: {
  reportMd: string;
  reportJson: NoopReportJsonShape;
  oracle: Phase1NoopEquivalentOracle;
  caseId: string;
}): void {
  const { reportMd, reportJson, oracle, caseId } = input;

  if (reviewableStyleCount(reportJson) > 0) {
    throw new Error(
      `FAIL-CLOSED [${caseId}]: report.json shows reviewable style changes for a known no-op/equivalent case`,
    );
  }
  if (reviewableTotal(reportJson) > 0) {
    throw new Error(
      `FAIL-CLOSED [${caseId}]: report.json shows reviewable dom/style/state changes for a known no-op/equivalent case`,
    );
  }

  const changedSurfaces =
    reportJson.comparison?.reviewableChangedSurfaces ?? reportJson.comparison?.rawChangedSurfaces ?? 0;
  if (changedSurfaces > 0) {
    throw new Error(
      `FAIL-CLOSED [${caseId}]: report.json shows ${changedSurfaces} changed surface(s) for a no-op case`,
    );
  }
  if (reportJson.comparison?.hasReviewableEvidence === true) {
    throw new Error(`FAIL-CLOSED [${caseId}]: report.json comparison.hasReviewableEvidence is true for a no-op case`);
  }

  const surfaceFilePrefix = `${oracle.surfaceKey}@${oracle.width}`;
  const surfaceFinding = reportJson.surfaces?.find(
    (surface) =>
      surface.representative?.startsWith(surfaceFilePrefix) || surface.surface?.startsWith(surfaceFilePrefix),
  );
  if (surfaceFinding?.findings?.length) {
    throw new Error(`FAIL-CLOSED [${caseId}]: report.json lists findings for ${surfaceFilePrefix} on a no-op case`);
  }

  if (!new RegExp(oracle.report.cleanMatchLine, 'i').test(reportMd)) {
    throw new Error(
      `FAIL-CLOSED [${caseId}]: report.md missing "${oracle.report.cleanMatchLine}" for a known no-op/equivalent case`,
    );
  }
  if (/STYLE_REVIEW_REQUIRED/i.test(reportMd)) {
    throw new Error(`FAIL-CLOSED [${caseId}]: report.md advertises STYLE_REVIEW_REQUIRED for a no-op case`);
  }

  const verdict = classifyStyleProofVerdict(
    {
      comparison: reportJson.comparison ?? {},
      reportConsistency: reportJson.reportConsistency ?? { ok: true, reason: 'aligned' },
      reviewableCounts: reportJson.comparison?.reviewableCounts ??
        reportJson.reviewableCounts ?? {
          dom: 0,
          style: 0,
          state: 0,
        },
      surfaces: reportJson.surfaces ?? [],
    },
    { gateInventoryRemovals: true, baseCaptureFailed: false, changed: false },
  );
  for (const forbidden of oracle.report.forbiddenTrustStates) {
    if (verdict.state === forbidden) {
      throw new Error(`FAIL-CLOSED [${caseId}]: trust verdict ${forbidden} invented for a known no-op/equivalent case`);
    }
  }
  if (verdict.reviewableChanged) {
    throw new Error(`FAIL-CLOSED [${caseId}]: trust verdict reviewableChanged=true for a known no-op/equivalent case`);
  }
}

export function assertPhase1NoopDiffFindings(findings: Finding[], caseId: string): void {
  if (findings.length > 0) {
    throw new Error(
      `FAIL-CLOSED [${caseId}]: diffStyleMaps returned ${findings.length} finding(s) for a known no-op/equivalent case`,
    );
  }
}
