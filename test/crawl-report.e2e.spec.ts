/**
 * Crawl-to-report E2E flow tests (#520 gap 4).
 *
 * This test exercises the full pipeline:
 * 1. Crawl a simple fixture site
 * 2. Run diff between two crawl captures
 * 3. Generate report
 * 4. Assert surface discovery and report generation succeed
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlAndCapture, CRAWL_DEFAULTS, diffStyleMapDirs } from '../dist/index.js';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';

test.describe.configure({ mode: 'parallel' });

const baseHtml = (buttonColor: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: sans-serif; }
  nav { display: flex; gap: 16px; padding: 16px; background: #f0f0f0; }
  nav a { color: #333; text-decoration: none; }
  main { padding: 20px; }
  .cta { background: ${buttonColor}; color: white; border: 0; padding: 12px 20px; }
</style></head><body>
  <nav>
    <a href="/">Home</a>
    <a href="/?tab=about">About</a>
    <a href="/?tab=contact">Contact</a>
  </nav>
  <main>
    <h1>Welcome</h1>
    <button class="cta">Get Started</button>
  </main>
</body></html>`;

function baseCrawlOpts(url: string, out: string) {
  return {
    url,
    out,
    widths: [900] as number[],
    ignore: [] as string[],
    height: 700,
    maxDepth: CRAWL_DEFAULTS.maxDepth,
    maxStates: CRAWL_DEFAULTS.maxStates,
    resetStorage: true,
  };
}

test('crawlAndCapture discovers surfaces from a multi-link fixture', async ({ page }) => {
  const id = Math.random().toString(36).slice(2);
  const file = path.join(os.tmpdir(), `styleproof-crawl-report-${id}.html`);
  const out = path.join(os.tmpdir(), `styleproof-crawl-report-out-${id}`);

  fs.writeFileSync(file, baseHtml('rgb(0, 100, 200)'));
  try {
    const report = await crawlAndCapture(page, baseCrawlOpts('file://' + file, out));

    expect(report.surfaces.length).toBeGreaterThanOrEqual(1);
    expect(report.surfaces.some((s) => s.key === 'base' || s.key === 'index')).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
    const files = fs.readdirSync(out);
    expect(files.some((f) => f.endsWith('.json.gz'))).toBe(true);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('crawl-to-diff: comparing two crawl captures produces a diff', async ({ page }) => {
  const id = Math.random().toString(36).slice(2);
  const file = path.join(os.tmpdir(), `styleproof-crawl-diff-${id}.html`);
  const beforeOut = path.join(os.tmpdir(), `styleproof-crawl-diff-before-${id}`);
  const afterOut = path.join(os.tmpdir(), `styleproof-crawl-diff-after-${id}`);

  fs.writeFileSync(file, baseHtml('rgb(0, 100, 200)'));
  try {
    await crawlAndCapture(page, baseCrawlOpts('file://' + file, beforeOut));

    fs.writeFileSync(file, baseHtml('rgb(255, 0, 0)'));
    await crawlAndCapture(page, baseCrawlOpts('file://' + file, afterOut));

    const diff = await diffStyleMapDirs(beforeOut, afterOut);

    expect(diff.identical).toBe(false);
    expect(diff.surfaces.length).toBeGreaterThanOrEqual(1);
    const changedSurface = diff.surfaces.find((s) => s.changes && s.changes.length > 0);
    expect(changedSurface).toBeDefined();
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(beforeOut, { recursive: true, force: true });
    fs.rmSync(afterOut, { recursive: true, force: true });
  }
});

test('crawl-to-report: full pipeline produces valid report.json and report.md', async ({ page }) => {
  const id = Math.random().toString(36).slice(2);
  const file = path.join(os.tmpdir(), `styleproof-crawl-full-${id}.html`);
  const beforeOut = path.join(os.tmpdir(), `styleproof-crawl-full-before-${id}`);
  const afterOut = path.join(os.tmpdir(), `styleproof-crawl-full-after-${id}`);
  const reportOut = path.join(os.tmpdir(), `styleproof-crawl-full-report-${id}`);

  fs.writeFileSync(file, baseHtml('rgb(0, 100, 200)'));
  try {
    await crawlAndCapture(page, baseCrawlOpts('file://' + file, beforeOut));

    fs.writeFileSync(file, baseHtml('rgb(255, 0, 0)'));
    await crawlAndCapture(page, baseCrawlOpts('file://' + file, afterOut));

    const result = await generateStyleMapReport({
      beforeDir: beforeOut,
      afterDir: afterOut,
      outDir: reportOut,
      baselineSurfaceFailures: [],
    });

    expect(fs.existsSync(result.reportJsonPath)).toBe(true);
    expect(fs.existsSync(result.reportMdPath)).toBe(true);

    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const md = fs.readFileSync(result.reportMdPath, 'utf8');

    expect(json.comparison).toBeDefined();
    expect(json.surfaces).toBeInstanceOf(Array);
    expect(typeof json.partialBaseline).toBe('boolean');
    expect(md.length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(beforeOut, { recursive: true, force: true });
    fs.rmSync(afterOut, { recursive: true, force: true });
    fs.rmSync(reportOut, { recursive: true, force: true });
  }
});

test('crawl-to-report: identical captures produce identical comparison', async ({ page }) => {
  const id = Math.random().toString(36).slice(2);
  const file = path.join(os.tmpdir(), `styleproof-crawl-identical-${id}.html`);
  const beforeOut = path.join(os.tmpdir(), `styleproof-crawl-identical-before-${id}`);
  const afterOut = path.join(os.tmpdir(), `styleproof-crawl-identical-after-${id}`);
  const reportOut = path.join(os.tmpdir(), `styleproof-crawl-identical-report-${id}`);

  fs.writeFileSync(file, baseHtml('rgb(0, 100, 200)'));
  try {
    await crawlAndCapture(page, baseCrawlOpts('file://' + file, beforeOut));
    await crawlAndCapture(page, baseCrawlOpts('file://' + file, afterOut));

    const result = await generateStyleMapReport({
      beforeDir: beforeOut,
      afterDir: afterOut,
      outDir: reportOut,
      baselineSurfaceFailures: [],
    });

    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const md = fs.readFileSync(result.reportMdPath, 'utf8');

    expect(json.comparison).toBe('identical');
    expect(md).toMatch(/identical/i);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(beforeOut, { recursive: true, force: true });
    fs.rmSync(afterOut, { recursive: true, force: true });
    fs.rmSync(reportOut, { recursive: true, force: true });
  }
});

test('crawl captures include expected metadata files', async ({ page }) => {
  const id = Math.random().toString(36).slice(2);
  const file = path.join(os.tmpdir(), `styleproof-crawl-meta-${id}.html`);
  const out = path.join(os.tmpdir(), `styleproof-crawl-meta-out-${id}`);

  fs.writeFileSync(file, baseHtml('rgb(0, 100, 200)'));
  try {
    await crawlAndCapture(page, baseCrawlOpts('file://' + file, out));

    const files = fs.readdirSync(out);

    expect(files.some((f) => f.endsWith('.json.gz'))).toBe(true);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
