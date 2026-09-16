/**
 * Phase 1 no-op/equivalent harness (#672).
 *
 * Proves intentional non-change (or equivalent CSS) on the StyleProof-owned demo
 * fixture runs through the real capture → diff → report path without inventing a
 * false reviewable change or STYLE_REVIEW_REQUIRED trust state.
 *
 * Soft-pass: HOLD. Fail closed when a false positive appears.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/672
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/668
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStyleMapCapture, diffStyleMaps, generateStyleMapReport, loadStyleMap } from '../dist/index.js';
import {
  assertPhase1NoopDiffFindings,
  assertPhase1NoopReportMapping,
  findDemoElementPath,
  loadPhase1NoopEquivalentOracle,
  phase1DemoUrl,
  PHASE1_NOOP_ORACLE_PATH,
} from './phase1-foundation-harness-lib.js';

test.describe.configure({ mode: 'serial' });

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const DEMO = 'file://' + path.join(ROOT, 'example', 'demo', 'index.html');
const DIFF_BIN = path.join(ROOT, 'bin', 'styleproof-diff.mjs');
const REPORT_BIN = path.join(ROOT, 'bin', 'styleproof-report.mjs');
const HARNESS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-phase1-noop-'));
const oracle = loadPhase1NoopEquivalentOracle();

function caseDirs(caseId: string): { base: string; head: string; report: string; cliReport: string } {
  const slug = caseId.replace(/[^a-z0-9]+/gi, '-');
  return {
    base: `phase1-noop-${slug}-base`,
    head: `phase1-noop-${slug}-head`,
    report: `phase1-noop-${slug}-report`,
    cliReport: `phase1-noop-${slug}-cli-report`,
  };
}

function ctaSurface(caseId: string, tone: 'base' | 'head') {
  const caseDef = oracle.cases.find((entry) => entry.id === caseId);
  if (!caseDef) throw new Error(`missing oracle case ${caseId}`);
  const query = tone === 'head' ? caseDef.queryParams.head : caseDef.queryParams.base;
  return {
    key: oracle.surfaceKey,
    widths: [oracle.width],
    go: async (page: import('@playwright/test').Page) => {
      await page.goto(phase1DemoUrl(DEMO, query), { waitUntil: 'load' });
    },
  };
}

function runCli(bin: string, args: string[], cwd: string): { status: number; out: string } {
  const result = spawnSync('node', [bin, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

for (const caseDef of oracle.cases) {
  const dirs = caseDirs(caseDef.id);

  test.describe(`Phase 1 no-op harness capture: ${caseDef.id}`, () => {
    defineStyleMapCapture({
      parallel: false,
      surfaces: [ctaSurface(caseDef.id, 'base')],
      expected: [oracle.surfaceKey],
      dir: dirs.base,
      baseDir: HARNESS_ROOT,
      screenshots: true,
      selfCheck: true,
    });
  });

  test.describe(`Phase 1 no-op harness capture head: ${caseDef.id}`, () => {
    defineStyleMapCapture({
      parallel: false,
      surfaces: [ctaSurface(caseDef.id, 'head')],
      expected: [oracle.surfaceKey],
      dir: dirs.head,
      baseDir: HARNESS_ROOT,
      screenshots: true,
      selfCheck: true,
    });
  });
}

test.afterAll(() => {
  fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });
});

test('oracle and demo contract files exist', () => {
  expect(fs.existsSync(PHASE1_NOOP_ORACLE_PATH), 'phase1-noop-equivalent.json oracle missing').toBe(true);
  expect(fs.existsSync(path.join(ROOT, 'example', 'demo', 'index.html')), 'demo fixture missing').toBe(true);
});

test('fail-closed: invented reviewable change is rejected', () => {
  expect(() =>
    assertPhase1NoopReportMapping({
      reportMd: '## StyleProof report\n\nbackground-color changed on button.btn',
      reportJson: {
        comparison: {
          rawChangedSurfaces: 1,
          reviewableChangedSurfaces: 1,
          hasReviewableEvidence: true,
          reviewableCounts: { style: 1, dom: 0, state: 0 },
        },
        surfaces: [{ surface: `${oracle.surfaceKey}@${oracle.width}`, findings: [{ kind: 'style' }] }],
      },
      oracle,
      caseId: 'synthetic-false-positive',
    }),
  ).toThrow(/FAIL-CLOSED/);
});

for (const caseDef of oracle.cases) {
  test(`Phase 1 [${caseDef.id}]: no-op/equivalent maps through capture → diff → report without false review`, () => {
    const dirs = caseDirs(caseDef.id);
    const beforeDir = path.join(HARNESS_ROOT, dirs.base);
    const afterDir = path.join(HARNESS_ROOT, dirs.head);
    const outDir = path.join(HARNESS_ROOT, dirs.report);
    const surfaceFile = `${oracle.surfaceKey}@${oracle.width}`;

    const beforeMap = loadStyleMap(path.join(beforeDir, `${surfaceFile}.json.gz`));
    const afterMap = loadStyleMap(path.join(afterDir, `${surfaceFile}.json.gz`));
    const beforePath = findDemoElementPath(beforeMap, oracle);
    const afterPath = findDemoElementPath(afterMap, oracle);

    expect(beforePath, 'Save button missing from base capture').toBeDefined();
    expect(afterPath, 'Save button missing from head capture').toBeDefined();

    if (caseDef.expectedComputed) {
      for (const [prop, value] of Object.entries(caseDef.expectedComputed)) {
        expect(beforeMap.elements[beforePath!].style[prop], `${caseDef.id} base ${prop}`).toBe(value);
        expect(afterMap.elements[afterPath!].style[prop], `${caseDef.id} head ${prop}`).toBe(value);
      }
    } else {
      expect(beforeMap.elements[beforePath!].style['background-color']).toBe(
        afterMap.elements[afterPath!].style['background-color'],
      );
    }

    const findings = diffStyleMaps(beforeMap, afterMap);
    assertPhase1NoopDiffFindings(findings, caseDef.id);

    const report = generateStyleMapReport({ beforeDir, afterDir, outDir });
    expect(report.changedSurfaces, `${caseDef.id} changedSurfaces`).toBe(0);
    expect(report.totalFindings, `${caseDef.id} totalFindings`).toBe(0);

    const reportMd = fs.readFileSync(report.reportMdPath, 'utf8');
    const reportJson = JSON.parse(fs.readFileSync(report.reportJsonPath, 'utf8'));
    assertPhase1NoopReportMapping({ reportMd, reportJson, oracle, caseId: caseDef.id });

    const diff = runCli(DIFF_BIN, [dirs.base, dirs.head], HARNESS_ROOT);
    expect(diff.status, `styleproof-diff must certify the no-op case\n${diff.out}`).toBe(0);
    expect(diff.out).toMatch(/0 reviewable computed-style changes/i);

    const reportCli = runCli(REPORT_BIN, [dirs.base, dirs.head, '--out', dirs.cliReport], HARNESS_ROOT);
    expect(reportCli.status, `styleproof-report must not error on no-op\n${reportCli.out}`).not.toBe(2);
    expect(reportCli.out, 'report CLI must not claim reviewable style changes on no-op').toMatch(
      /no reviewable computed-style changes/i,
    );
    expect(reportCli.out, 'report CLI must not advertise STYLE_REVIEW_REQUIRED on no-op').not.toMatch(
      /STYLE_REVIEW_REQUIRED/i,
    );

    const cliReportMd = fs.readFileSync(path.join(HARNESS_ROOT, dirs.cliReport, 'report.md'), 'utf8');
    const cliReportJson = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, dirs.cliReport, 'report.json'), 'utf8'));
    assertPhase1NoopReportMapping({
      reportMd: cliReportMd,
      reportJson: cliReportJson,
      oracle,
      caseId: caseDef.id,
    });
  });
}
