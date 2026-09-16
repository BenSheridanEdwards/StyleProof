// Pure aggregation and rendering of a multi-page crawl run, so the capture CLI stays thin and
// every console line is unit-testable. Wording here is asserted by the CLI tests.
import { cliSafeLine, type CrawlConfidence, type CrawlConfidenceStatus } from '../crawl-confidence.js';
import type { CrawlCoverage, CrawlReport } from './types.js';

export type AggregatedConfidence = {
  blocked: boolean;
  status: CrawlConfidenceStatus;
  unack: CrawlConfidence['unacknowledged'];
  ack: CrawlConfidence['acknowledged'];
  stale: string[];
};

export type IncompleteUiEntry = { surface: string; reasons: string[]; acknowledgedReason?: string };

/** A page that was discovered but never fully crawled — named in the ledger, never silently dropped. */
export type ScopeGap = { surface: string; reason: string };

export function aggregateConfidence(reports: CrawlReport[]): AggregatedConfidence {
  const all = reports.map((r) => r.confidence).filter(Boolean);
  const has = (status: CrawlConfidenceStatus): boolean => all.some((c) => c.status === status);
  return {
    blocked: all.some((c) => c.blocked),
    status: has('incomplete-auth') ? 'incomplete-auth' : has('incomplete-unknown') ? 'incomplete-unknown' : 'complete',
    unack: all.flatMap((c) => c.unacknowledged ?? []),
    ack: all.flatMap((c) => c.acknowledged ?? []),
    stale: [...new Set(all.flatMap((c) => c.staleExclusions ?? []))].sort(),
  };
}

export function aggregateIncompleteUi(
  reports: CrawlReport[],
  exclude: Record<string, string> = {},
): IncompleteUiEntry[] {
  const bySurface = new Map<string, Set<string>>();
  for (const observation of reports.flatMap((report) => report.incompleteUi ?? [])) {
    const reasons = bySurface.get(observation.surface) ?? new Set<string>();
    for (const diagnostic of observation.diagnostics ?? []) reasons.add(diagnostic.reason);
    bySurface.set(observation.surface, reasons);
  }
  return [...bySurface.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([surface, reasons]) => ({
      surface,
      reasons: [...reasons].sort(),
      ...(exclude[surface] ? { acknowledgedReason: exclude[surface] } : {}),
    }));
}

/** Pages share stylesheets, so a class unrendered on one page but rendered on another IS covered. */
export function aggregateCoverage(reports: CrawlReport[]): Omit<CrawlCoverage, 'renderedClasses'> {
  const rendered = new Set(reports.flatMap((r) => r.coverage.renderedClasses));
  const missing = [...new Set(reports.flatMap((r) => r.coverage.missing))].filter((c) => !rendered.has(c)).sort();
  const unreadable = [...new Set(reports.flatMap((r) => r.coverage.unreadable ?? []))];
  return { defined: rendered.size + missing.length, rendered: rendered.size, missing, unreadable };
}

export function incompleteUiLines(entries: IncompleteUiEntry[]): string[] {
  if (!entries.length) return [];
  const blocked = entries.some((entry) => !entry.acknowledgedReason);
  const tail = blocked ? 'fail closed' : 'scope explicitly limited';
  const lines = [
    `${blocked ? '✗' : '⚠'} incomplete UI — blocked continuations leave reachable states uncaptured (${tail})`,
    ...entries.map((entry) => {
      const reasons = entry.reasons.map(cliSafeLine).join(', ');
      const ack = entry.acknowledgedReason ? ` — acknowledged: ${cliSafeLine(entry.acknowledgedReason)}` : '';
      return `    ${cliSafeLine(entry.surface)} (${reasons})${ack}`;
    }),
  ];
  if (blocked) {
    lines.push(
      '    Next: add deterministic setup/fixtures to reach these states, or --incomplete-ui-exclude with a non-empty reason when outside scope.',
    );
  }
  return lines;
}

function authIncompleteLines({ blocked, unack, ack, stale }: AggregatedConfidence): string[] {
  const tail = blocked ? ' — unacknowledged (fail closed)' : ' — acknowledged; scope explicitly limited';
  const lines = [
    `${blocked ? '✗' : '⚠'} crawl confidence: incomplete-auth — authentication boundary observed; ` +
      `surfaces behind it are unknown (no coverage percentage invented)${tail}`,
    ...unack.map((u) => {
      const reasons = cliSafeLine((u.diagnostics ?? []).map((d) => d.reason).join(', '));
      return `    unacknowledged: ${cliSafeLine(String(u.key ?? ''))}${reasons ? ` (${reasons})` : ''}`;
    }),
    ...ack.map((a) => `    acknowledged: ${cliSafeLine(String(a.key ?? ''))} — ${cliSafeLine(String(a.reason ?? ''))}`),
  ];
  if (stale.length) lines.push(`    stale exclusions: ${stale.map((s) => cliSafeLine(String(s))).join(', ')}`);
  if (blocked) {
    lines.push(
      '    Next: add --setup with env-interpolated credentials, or --auth-boundary-exclude ' +
        'with a non-empty reason when the wall is outside certification scope.',
    );
  }
  return lines;
}

/** Confidence verdict lines. A skipped linked page downgrades a `complete` run to `incomplete-unknown`. */
export function confidenceLines(conf: AggregatedConfidence, scopeGaps: ScopeGap[] = []): string[] {
  const status = conf.status === 'complete' && scopeGaps.length > 0 ? 'incomplete-unknown' : conf.status;
  const lines =
    status === 'complete'
      ? ['✓ crawl confidence: complete — no authentication boundary observed']
      : status === 'incomplete-auth'
        ? authIncompleteLines(conf)
        : ['⚠ crawl confidence: incomplete-unknown'];
  if (status !== 'complete') {
    lines.push('    certification: not full — visual PASS does not imply complete surface access');
  }
  return lines;
}

export function coverageLines(cov: Omit<CrawlCoverage, 'renderedClasses'>, label: string): string[] {
  const lines: string[] = [];
  const unreadable = cov.unreadable ?? [];
  if (unreadable.length > 0) {
    lines.push(
      `⚠ coverage${label}: ${unreadable.length} stylesheet(s) unreadable — class coverage not provable against them ` +
        `(cross-origin, no CORS; make them same-origin / CORS-readable, or pin --widths):\n    ${unreadable.join(' ')}`,
    );
  }
  if (cov.missing.length > 0) {
    lines.push(
      `⚠ coverage${label}: ${cov.rendered}/${cov.defined} stylesheet classes rendered — ${cov.missing.length} never seen ` +
        `(dead CSS, or a state the crawl could not reach):\n    ${cov.missing.join(' ')}`,
    );
  } else if (unreadable.length === 0) {
    lines.push(`✓ coverage${label}: all ${cov.defined} stylesheet classes rendered in at least one captured surface`);
  }
  return lines;
}

export function crawlSummaryLine(reports: CrawlReport[], opts: { widths: number[]; out: string }): string {
  const sum = (pick: (r: CrawlReport) => number): number => reports.reduce((n, r) => n + pick(r), 0);
  const failed = sum((r) => r.failed.length);
  const widths = opts.widths.length ? `${opts.widths.length} width(s)` : 'auto widths';
  return (
    `✓ ${sum((r) => r.captured)}/${sum((r) => r.surfaces.length)} surface(s) across ${reports.length} page(s) × ${widths} → ${opts.out}  ` +
    `(${sum((r) => r.actionsTried)} actions tried, ${sum((r) => r.skipped)} skipped${failed ? `, ${failed} capture-failed` : ''})`
  );
}

/** Discovered surfaces with no complete map on disk, plus the page-level gaps — the ledger's
 *  `unknown` entries. Failed captures are neither certified nor silently forgotten. */
export function captureGaps(
  reports: CrawlReport[],
  capturedKeys: ReadonlySet<string>,
  scopeGaps: ScopeGap[],
): ScopeGap[] {
  const failedKeys = new Set(reports.flatMap((r) => r.failed));
  const discoveredKeys = [...new Set(reports.flatMap((r) => r.surfaces.map((s) => s.key)))];
  return [
    ...discoveredKeys
      .filter((key) => !capturedKeys.has(key))
      .map((surface) => ({
        surface,
        reason: failedKeys.has(surface)
          ? 'capture failed before every configured viewport completed'
          : 'crawl stopped before this discovered surface was captured',
      })),
    ...scopeGaps,
  ];
}
