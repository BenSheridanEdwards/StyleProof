import fs from 'node:fs';
import path from 'node:path';
import { captureKeysIn } from '../capture.js';
import type { DiffCounts } from '../diff.js';
import type { BaselineProvenance, SurfaceCaptureFailure } from '../map-store.js';
import type { ReportOptions, ReportResult } from '../report.js';
import { safeKey, surfaceBase } from '../change-groups.js';
import { cropPng, cropStem, readPng, writePng } from './png.js';
import { oneSidedStatus, type OneSidedStatus } from './headline.js';
import { renderChangeGroup } from './regions.js';
import { formatSurfaceWithContext, type ChangeGroup, type PreparedSurface, type RenderCtx } from './shared.js';

/** Section loops, the report.md byte budget, and the report.json writer. */

// Hidden marker on a new-surface heading so the PR-comment layer recognises one-sided surfaces.
const NEW_SURFACE_MARKER = '<!-- styleproof-new -->';

type OneSidedText = { heading: (key: string) => string; alt: string; note: (key: string) => string };

const ONE_SIDED: Record<OneSidedStatus, OneSidedText> = {
  removed: {
    heading: (key) => `### \`${key}\` · REMOVED surface 🗑️`,
    alt: 'removed surface',
    note: () =>
      `_Present in the baseline but not captured on head. This is a **removal** to review, not an addition; approving accepts the disappearance._`,
  },
  new: {
    heading: (key) => `### \`${key}\` · new surface ${NEW_SURFACE_MARKER}`,
    alt: 'new surface',
    note: () =>
      `_No baseline to compare against. This is a reviewable first-adoption surface; approve it before it becomes part of the baseline._`,
  },
  'capture-failed': {
    heading: (key) => `### \`${key}\` · baseline repair needed ⚠️`,
    alt: 'baseline repair needed',
    note: (key) =>
      `_The matching baseline surface capture failed. This is **baseline repair needed**, not first adoption and not a base recapture failure; repair \`${key}\` on the named SHA in the receipt above._`,
  },
};

/** A surface present on one side only: one screenshot of the captured side, no diff. */
function renderOneSided(
  ctx: RenderCtx,
  p: PreparedSurface,
  status: OneSidedStatus,
  seq: { crop: number },
): { md: string[]; json: Record<string, unknown> } {
  const side = p.sd.missing === 'before' ? 'after' : 'before';
  const srcDir = side === 'after' ? ctx.afterDir : ctx.beforeDir;
  const map = ctx.load(srcDir, p.sd.surface);
  const png = readPng(path.join(srcDir, `${p.sd.surface}.png`));
  const key = safeKey(p.sd.surface);
  const text = ONE_SIDED[status];
  const md: string[] = ['', text.heading(key), '', `_${formatSurfaceWithContext(p.sd.surface, map)}_`];
  const json: Record<string, unknown> = {
    surface: p.sd.surface,
    missing: p.sd.missing,
    isNew: status === 'new',
    isRemoved: status === 'removed',
    baselineStatus: status,
    classification: p.sd.classification,
  };
  if (png) {
    seq.crop++;
    const h = Math.min(ctx.maxHeight, png.height, map.viewport?.height ?? png.height);
    const stem = cropStem(p.sd.surface, `${seq.crop}-new`);
    writePng(path.join(ctx.outDir, `${stem}.png`), cropPng(png, { x: 0, y: 0, w: png.width, h }, png.width, h).png);
    md.push(
      '',
      `![${text.alt} — ${side}](${ctx.img(`${stem}.png`)})`,
      '',
      `<sub>${side} · ${formatSurfaceWithContext(p.sd.surface, map)}${png.height > h ? ' (top viewport of page)' : ''}</sub>`,
    );
    json.image = `${stem}.png`;
  } else {
    md.push(
      '',
      `_Captured only in the **${side}** set; no screenshot saved (run captures with \`screenshots: true\`)._`,
    );
  }
  md.push('', text.note(key));
  return { md, json };
}

/** The shared-chrome banner (#193), emitted once above the promoted groups. */
function chromeCalloutLines(nChrome: number, nSurfaces: number): string[] {
  return [
    '',
    '---',
    '',
    `## 🧱 Global chrome ${nChrome === 1 ? 'change' : 'changes'} — across all ${nSurfaces} captured surface base(s)`,
    '',
    `_${nChrome} change(s) rode the shared frame every view draws (a persistent nav, header, or footer): ` +
      `each touched every surface that renders the affected element, so it reads as ONE global change, not a ` +
      `per-view one. The detail is folded beneath — review it once._`,
  ];
}

function cappedNoticeLines(budget: number): string[] {
  return [
    '',
    '## … more changed surfaces (summarized to keep this report renderable)',
    '',
    `_This report reached its ~${Math.round(budget / 1000)} KB display budget (GitHub does not render ` +
      `markdown past ~512 KB), so the surfaces below are listed as one-liners. Their full property ` +
      `tables are in \`report.json\` and their crops in \`crops/\` — the certification above covers every ` +
      `surface; only the inline detail is capped._`,
    '',
  ];
}

/** One-liner for a budget-capped change group: name · change count · crop link. */
function compactChangeSummary(ctx: RenderCtx, cg: ChangeGroup, json: Record<string, unknown>): string {
  const more = cg.surfaces.length > 1 ? ` (+${cg.surfaces.length - 1} more)` : '';
  const composite = (json.regions as Array<{ images?: { composite?: string } }> | undefined)?.[0]?.images?.composite;
  const link = composite ? ` — [crop](${ctx.img(composite)})` : '';
  return `- \`${safeKey(cg.rep.sd.surface)}\`${more} · ${cg.rep.findings.length} change(s)${link}`;
}

const markdownByteLength = (lines: string[]): number => Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8');

/**
 * The report.md accumulator with its byte budget: GitHub refuses to render markdown
 * past ~512 KB, so once full detail would overflow, each remaining section is
 * replaced by its one-line summary (the data stays in report.json and crops/).
 */
export class ReportMarkdown {
  readonly lines: string[] = [];
  private capped = false;
  constructor(private readonly maxBytes: number) {}

  /** Append when it fits; returns false (and appends nothing) otherwise. */
  append(lines: string[]): boolean {
    if (lines.length === 0) return true;
    if (markdownByteLength([...this.lines, ...lines]) > this.maxBytes) return false;
    this.lines.push(...lines);
    return true;
  }

  /** Full detail while the budget lasts, then the one-line summary. */
  detail(detail: string[], summary: string): void {
    if (!this.capped && this.append(detail)) return;
    if (!this.capped) {
      this.capped = true;
      if (!this.append(cappedNoticeLines(this.maxBytes))) {
        this.append([
          '',
          `_Inline detail omitted at the ${this.maxBytes}-byte display budget; full data is in \`report.json\`._`,
          '',
        ]);
      }
    }
    this.append([summary]);
  }

  /** Drop trailing lines until the headline itself fits the budget. */
  trimToBudget(): void {
    while (this.lines.length > 0 && markdownByteLength(this.lines) > this.maxBytes) this.lines.pop();
  }
}

export type SectionState = { md: ReportMarkdown; json: Array<Record<string, unknown>>; seq: { crop: number } };

export function renderOneSidedSections(
  ctx: RenderCtx,
  out: SectionState,
  missing: PreparedSurface[],
  failures: SurfaceCaptureFailure[],
): { greenfieldNewSurfaces: number } {
  if (missing.length > 0) out.md.append(['', '## One-sided pages, states, or surfaces — review first']);
  let greenfieldNewSurfaces = 0;
  for (const p of missing) {
    const status = oneSidedStatus(p, failures);
    if (status === 'new') greenfieldNewSurfaces++;
    const rendered = renderOneSided(ctx, p, status, out.seq);
    out.json.push(rendered.json);
    out.md.detail(rendered.md, `- \`${safeKey(p.sd.surface)}\` · ${ONE_SIDED[status].alt}`);
  }
  return { greenfieldNewSurfaces };
}

export function renderChangedSections(
  ctx: RenderCtx,
  out: SectionState,
  groups: { chrome: ChangeGroup[]; rest: ChangeGroup[] },
  totalSurfaceBases: number,
): { totalFindings: number } {
  const ordered = [...groups.chrome, ...groups.rest];
  if (ordered.length > 0) out.md.append(['', '## Element-level changes']);
  // The chrome banner rides on the first promoted group only.
  let banner = groups.chrome.length > 0 ? chromeCalloutLines(groups.chrome.length, totalSurfaceBases) : [];
  let totalFindings = 0;
  for (const group of ordered) {
    const rendered = renderChangeGroup(ctx, group, out.seq);
    out.json.push(rendered.json);
    totalFindings += rendered.findingCount;
    const detail = groups.chrome.includes(group) ? [...banner, ...rendered.md] : rendered.md;
    if (groups.chrome.includes(group)) banner = [];
    out.md.detail(detail, compactChangeSummary(ctx, group, rendered.json));
  }
  return { totalFindings };
}

const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const RECIPE_ACTIONS = new Set(['hover', 'focus', 'press', 'click', 'route']);

/** One coverage-table row for a captured state-recipe variant, or undefined. */
function stateCoverageRow(ctx: RenderCtx, captureKey: string): string[] | undefined {
  const metadata = ctx.load(ctx.afterDir, captureKey).metadata;
  const recipe = metadata?.stateRecipe;
  if (metadata?.variantKind !== 'state-recipe' || !recipe) return undefined;
  const action = RECIPE_ACTIONS.has(recipe.action) ? recipe.action : 'unknown';
  let evidence = 'captured';
  if (inRange(recipe.observationMs, 50, 5_000)) evidence = `observation ${recipe.observationMs} ms`;
  else if (action === 'route' && inRange(recipe.status, 400, 599)) evidence = `response ${recipe.status}`;
  return [
    safeKey(metadata.surfaceKey || surfaceBase(captureKey)).slice(0, 120),
    safeKey(recipe.stateKey || metadata.variantKey || captureKey).slice(0, 120),
    action,
    evidence,
  ];
}

/** Captured state-recipe variants on head, as a coverage table. */
export function stateCoverageLines(ctx: RenderCtx): string[] {
  const rows = new Map<string, string[]>();
  for (const captureKey of captureKeysIn(ctx.afterDir)) {
    const row = stateCoverageRow(ctx, captureKey);
    if (row) rows.set(row.join('\0'), row);
  }
  if (rows.size === 0) return [];
  const ordered = [...rows.values()].sort(
    (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]),
  );
  const surfaceCount = new Set(ordered.map((r) => r[0])).size;
  return [
    '',
    '## State coverage',
    '',
    `Captured recipe states: ${ordered.length} across ${surfaceCount} surface${surfaceCount === 1 ? '' : 's'}.`,
    '',
    '| Surface | State | Action | Evidence |',
    '| --- | --- | --- | --- |',
    ...ordered.map(
      ([surface, state, action, evidence]) => `| \`${surface}\` | \`${state}\` | \`${action}\` | ${evidence} |`,
    ),
    '',
    '_Discovery outcomes such as skipped, deduplicated, timed out, or requires fixture are recorded by the state harvester; this capture report does not infer them._',
  ];
}

export type ReportArtifacts = Pick<
  ReportResult,
  | 'comparison'
  | 'comparability'
  | 'reportConsistency'
  | 'baselineFailures'
  | 'confidence'
  | 'legacyPairs'
  | 'criticalStates'
> & {
  outDir: string;
  md: string[];
  gateMode: NonNullable<ReportOptions['gateMode']>;
  counts: DiffCounts;
  content: { evaluated: boolean; changes: number; advisory: true };
  surfaces: Array<Record<string, unknown>>;
  baselineProvenance: BaselineProvenance | null;
  liveTextFreeze: { violated: boolean; reason?: string } | null;
};

/** Write report.md and report.json. The JSON key order is a byte-stable contract. */
export function writeReportArtifacts(a: ReportArtifacts): { reportMdPath: string; reportJsonPath: string } {
  const reportMdPath = path.join(a.outDir, 'report.md');
  const reportJsonPath = path.join(a.outDir, 'report.json');
  fs.writeFileSync(reportMdPath, a.md.length > 0 ? `${a.md.join('\n')}\n` : '');
  const json = {
    gateMode: a.gateMode,
    counts: a.counts,
    rawCounts: a.comparison.rawCounts,
    reviewableCounts: a.comparison.reviewableCounts,
    comparison: a.comparison,
    comparability: a.comparability,
    reportConsistency: a.reportConsistency,
    baselineFailures: a.baselineFailures,
    partialBaseline: a.baselineFailures.length > 0,
    content: a.content,
    surfaces: a.surfaces,
    // Additive (#399 confidence badge, #367 baseline provenance): a consumer must
    // never read one green as full certification.
    confidence: a.confidence,
    ...(a.baselineProvenance ? { baselineProvenance: a.baselineProvenance } : {}),
    ...(a.liveTextFreeze ? { liveTextFreeze: a.liveTextFreeze } : {}),
    ...(a.legacyPairs ? { legacyPairs: a.legacyPairs } : {}),
    ...(a.criticalStates ? { criticalStates: a.criticalStates } : {}),
  };
  fs.writeFileSync(reportJsonPath, JSON.stringify(json, null, 2));
  return { reportMdPath, reportJsonPath };
}
