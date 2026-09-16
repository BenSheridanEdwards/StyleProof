/**
 * Phase 1 foundation harness (#669).
 *
 * Proves a controlled CSS change on the StyleProof-owned demo fixture runs through
 * the real capture → diff → report path and surfaces the known mutation in the
 * reviewer-facing report — not a classifier-only unit stub.
 *
 * Soft-pass: HOLD. Fail closed when mapping is wrong or evidence incomplete.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/669
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
  assertPhase1CssDiffFinding,
  assertPhase1CssReportMapping,
  findDemoElementPath,
  loadPhase1CssDeltaOracle,
  phase1DemoUrl,
  PHASE1_ORACLE_PATH,
} from './phase1-foundation-harness-lib.js';

test.describe.configure({ mode: 'serial' });

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const DEMO = 'file://' + path.join(ROOT, 'example', 'demo', 'index.html');
const DIFF_BIN = path.join(ROOT, 'bin', 'styleproof-diff.mjs');
const REPORT_BIN = path.join(ROOT, 'bin', 'styleproof-report.mjs');
const HARNESS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-phase1-harness-'));
const oracle = loadPhase1CssDeltaOracle();

function ctaSurface(tone: 'base' | 'head') {
  const query = tone === 'head' ? oracle.queryParams.head : oracle.queryParams.base;
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

test.describe('Phase 1 foundation harness: demo CSS delta capture', () => {
  defineStyleMapCapture({
    parallel: false,
    surfaces: [ctaSurface('base')],
    dir: 'phase1-base',
    baseDir: HARNESS_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.describe('Phase 1 foundation harness: demo CSS delta head capture', () => {
  defineStyleMapCapture({
    parallel: false,
    surfaces: [ctaSurface('head')],
    dir: 'phase1-head',
    baseDir: HARNESS_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.afterAll(() => {
  fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });
});

test('oracle and demo contract files exist', () => {
  expect(fs.existsSync(PHASE1_ORACLE_PATH), 'phase1-css-delta.json oracle missing').toBe(true);
  expect(fs.existsSync(path.join(ROOT, 'example', 'demo', 'index.html')), 'demo fixture missing').toBe(true);
});

test('fail-closed: incomplete report mapping is rejected', () => {
  expect(() =>
    assertPhase1CssReportMapping({
      reportMd: '## StyleProof report\n\nNo reviewable computed-style changes.',
      reportJson: { comparison: { rawChangedSurfaces: 0, rawCounts: { style: 0 } }, surfaces: [] },
      oracle,
    }),
  ).toThrow(/FAIL-CLOSED/);
});

test('Phase 1: known demo CSS delta maps through capture → diff → report and real CLIs', () => {
  const beforeDir = path.join(HARNESS_ROOT, 'phase1-base');
  const afterDir = path.join(HARNESS_ROOT, 'phase1-head');
  const outDir = path.join(HARNESS_ROOT, 'phase1-report');
  const surfaceFile = `${oracle.surfaceKey}@${oracle.width}`;

  const beforeMap = loadStyleMap(path.join(beforeDir, `${surfaceFile}.json.gz`));
  const afterMap = loadStyleMap(path.join(afterDir, `${surfaceFile}.json.gz`));
  const beforePath = findDemoElementPath(beforeMap, oracle);
  const afterPath = findDemoElementPath(afterMap, oracle);

  expect(beforePath, 'Save button missing from base capture').toBeDefined();
  expect(afterPath, 'Save button missing from head capture').toBeDefined();
  expect(beforeMap.elements[beforePath!].style['background-color']).toBe(oracle.expectedFinding.before);
  expect(afterMap.elements[afterPath!].style['background-color']).toBe(oracle.expectedFinding.after);

  const findings = diffStyleMaps(beforeMap, afterMap);
  assertPhase1CssDiffFinding(findings, beforePath!, afterPath!, oracle);

  const report = generateStyleMapReport({ beforeDir, afterDir, outDir });
  expect(report.changedSurfaces).toBeGreaterThan(0);
  expect(report.totalFindings).toBeGreaterThan(0);

  const reportMd = fs.readFileSync(report.reportMdPath, 'utf8');
  const reportJson = JSON.parse(fs.readFileSync(report.reportJsonPath, 'utf8'));
  assertPhase1CssReportMapping({ reportMd, reportJson, oracle });
  expect(fs.existsSync(path.join(outDir, 'crops'))).toBe(true);

  const diff = runCli(DIFF_BIN, ['phase1-base', 'phase1-head'], HARNESS_ROOT);
  expect(diff.status, `styleproof-diff must block the known CSS delta\n${diff.out}`).toBe(1);
  expect(diff.out).toMatch(/background/);

  const reportOut = path.join(HARNESS_ROOT, 'phase1-cli-report');
  const reportCli = runCli(REPORT_BIN, ['phase1-base', 'phase1-head', '--out', 'phase1-cli-report'], HARNESS_ROOT);
  expect(reportCli.status, `styleproof-report must flag the known CSS delta\n${reportCli.out}`).toBe(1);

  const cliReportMd = fs.readFileSync(path.join(reportOut, 'report.md'), 'utf8');
  const cliReportJson = JSON.parse(fs.readFileSync(path.join(reportOut, 'report.json'), 'utf8'));
  assertPhase1CssReportMapping({ reportMd: cliReportMd, reportJson: cliReportJson, oracle });
});
