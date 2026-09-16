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
import type { Finding } from '../src/diff.js';

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

export function loadPhase1CssDeltaOracle(oraclePath = PHASE1_ORACLE_PATH): Phase1CssDeltaOracle {
  return JSON.parse(fs.readFileSync(oraclePath, 'utf8')) as Phase1CssDeltaOracle;
}

export function phase1DemoUrl(demoFileUrl: string, query: string): string {
  const joiner = demoFileUrl.includes('?') ? '&' : '?';
  return `${demoFileUrl}${joiner}${query}`;
}

export function findDemoElementPath(map: StyleMap, oracle: Phase1CssDeltaOracle): string | undefined {
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
