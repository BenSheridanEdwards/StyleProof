/**
 * Phase 1 structure harness (#670).
 *
 * Proves a controlled DOM structure change on the StyleProof-owned demo fixture runs
 * through the real capture → diff → report path and surfaces the known addition in
 * the reviewer-facing migration report — not a classifier-only unit stub.
 *
 * Soft-pass: HOLD. Fail closed when mapping is wrong or evidence incomplete.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/670
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/668
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStyleMapCapture, generateStyleMapReport, loadStyleMap } from '../dist/index.js';
import { diffContentMaps } from '../dist/diff.js';
import {
  assertPhase1StructureContentFinding,
  assertPhase1StructureReportMapping,
  findDemoElementPath,
  loadPhase1StructureDeltaOracle,
  phase1DemoUrl,
  PHASE1_STRUCTURE_ORACLE_PATH,
} from './phase1-foundation-harness-lib.js';

test.describe.configure({ mode: 'serial' });

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const DEMO = 'file://' + path.join(ROOT, 'example', 'demo', 'index.html');
const DIFF_BIN = path.join(ROOT, 'bin', 'styleproof-diff.mjs');
const REPORT_BIN = path.join(ROOT, 'bin', 'styleproof-report.mjs');
const HARNESS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-phase1-structure-harness-'));
const oracle = loadPhase1StructureDeltaOracle();

function structureSurface(tone: 'base' | 'head') {
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

test.describe('Phase 1 structure harness: demo structure base capture', () => {
  defineStyleMapCapture({
    parallel: false,
    surfaces: [structureSurface('base')],
    dir: 'phase1-structure-base',
    baseDir: HARNESS_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.describe('Phase 1 structure harness: demo structure head capture', () => {
  defineStyleMapCapture({
    parallel: false,
    surfaces: [structureSurface('head')],
    dir: 'phase1-structure-head',
    baseDir: HARNESS_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.afterAll(() => {
  fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });
});

test('oracle and demo contract files exist', () => {
  expect(fs.existsSync(PHASE1_STRUCTURE_ORACLE_PATH), 'phase1-structure-delta.json oracle missing').toBe(true);
  expect(fs.existsSync(path.join(ROOT, 'example', 'demo', 'index.html')), 'demo fixture missing').toBe(true);
});

test('fail-closed: incomplete structure report mapping is rejected', () => {
  expect(() =>
    assertPhase1StructureReportMapping({
      reportMd: '## StyleProof report\n\nNo migration gallery.',
      reportJson: { migrationGallery: { newRemovedElements: [] }, gateMode: 'certify' },
      oracle,
    }),
  ).toThrow(/FAIL-CLOSED/);
});

test('Phase 1: known demo structure delta maps through capture → diff → report and real CLIs', () => {
  const beforeDir = path.join(HARNESS_ROOT, 'phase1-structure-base');
  const afterDir = path.join(HARNESS_ROOT, 'phase1-structure-head');
  const outDir = path.join(HARNESS_ROOT, 'phase1-structure-report');
  const surfaceFile = `${oracle.surfaceKey}@${oracle.width}`;

  const beforeMap = loadStyleMap(path.join(beforeDir, `${surfaceFile}.json.gz`));
  const afterMap = loadStyleMap(path.join(afterDir, `${surfaceFile}.json.gz`));
  const beforePath = findDemoElementPath(beforeMap, oracle);
  const afterPath = findDemoElementPath(afterMap, oracle);

  expect(beforePath, 'structure callout must be absent from base capture').toBeUndefined();
  expect(afterPath, 'structure callout missing from head capture').toBeDefined();

  const changes = diffContentMaps(beforeMap, afterMap);
  assertPhase1StructureContentFinding(changes, afterPath!, oracle);

  const report = generateStyleMapReport({
    beforeDir,
    afterDir,
    outDir,
    migration: true,
    gateMode: 'migration',
  });
  expect(report.migrationGallery?.newRemovedElements?.length ?? 0).toBeGreaterThan(0);

  const reportMd = fs.readFileSync(report.reportMdPath, 'utf8');
  const reportJson = JSON.parse(fs.readFileSync(report.reportJsonPath, 'utf8'));
  assertPhase1StructureReportMapping({ reportMd, reportJson, oracle });
  expect(fs.existsSync(path.join(outDir, 'crops'))).toBe(true);

  const diff = runCli(DIFF_BIN, ['--migration', 'phase1-structure-base', 'phase1-structure-head'], HARNESS_ROOT);
  expect(diff.status, `styleproof-diff --migration must block the known structure delta\n${diff.out}`).toBe(1);
  expect(diff.out).toMatch(/DOM|added|structure/i);

  const reportOut = path.join(HARNESS_ROOT, 'phase1-structure-cli-report');
  const reportCli = runCli(
    REPORT_BIN,
    ['--migration', 'phase1-structure-base', 'phase1-structure-head', '--out', 'phase1-structure-cli-report'],
    HARNESS_ROOT,
  );
  expect(reportCli.status, `styleproof-report --migration must flag the known structure delta\n${reportCli.out}`).toBe(
    1,
  );

  const cliReportMd = fs.readFileSync(path.join(reportOut, 'report.md'), 'utf8');
  const cliReportJson = JSON.parse(fs.readFileSync(path.join(reportOut, 'report.json'), 'utf8'));
  assertPhase1StructureReportMapping({ reportMd: cliReportMd, reportJson: cliReportJson, oracle });
});
