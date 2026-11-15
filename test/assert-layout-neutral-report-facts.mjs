import assert from 'node:assert/strict';
import fs from 'node:fs';

/** Layout-neutral inventory facts already written to report.json. */
export function layoutNeutralReportFacts(reportJsonPath) {
  const report = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
  const facts = { counts: report.counts };
  if (report.reach) {
    facts.reach = { blocking: report.reach.blocking, complete: report.reach.complete };
  }
  return facts;
}

/**
 * Wrap a report renderer so a default-layout call also builds visual-first
 * and asserts the same layout-neutral report.json facts. Callers that pass
 * `layout` are left alone.
 */
export function withLayoutNeutralReportFacts(renderReport) {
  return function generateStyleMapReport(options) {
    const result = renderReport(options);
    if (options.layout || !options.outDir) return result;
    const visualDir = options.outDir + '-visual';
    const visual = renderReport({ ...options, outDir: visualDir, layout: 'visual-first' });
    try {
      assert.deepEqual(
        layoutNeutralReportFacts(visual.reportJsonPath),
        layoutNeutralReportFacts(result.reportJsonPath),
      );
    } finally {
      fs.rmSync(visualDir, { recursive: true, force: true });
    }
    return result;
  };
}
