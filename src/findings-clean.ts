import { type DiffCounts, type Finding, type PropChange } from './diff.js';
import { trackCount } from './describe.js';
import { isNonValue, summarizeProps } from './prop-summary.js';

/**
 * Path grouping, change signatures, titles, reflow-noise cleaning, and the
 * canonical comparison-truth assessment shared by the certification differ and
 * the visual report.
 */

/** Group findings by their element path (one group per changed element). */
export function groupByPath(findings: Finding[]): Finding[][] {
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byPath.get(f.path) ?? [];
    arr.push(f);
    byPath.set(f.path, arr);
  }
  return [...byPath.values()];
}

// Grid-track longhands compute to width-dependent pixels (`282px ×2` at one width,
// `282px 228px` at another), so the SAME responsive change would otherwise get a
// different signature per width. Key them by track COUNT — what actually
// identifies the change — so responsive variants group into one section.
function sigValue(c: PropChange): string {
  if (c.prop === 'grid-template-columns' || c.prop === 'grid-template-rows') {
    return `${c.prop}=${trackCount(c.before)}t>${trackCount(c.after)}t`;
  }
  return `${c.prop}=${c.before}>${c.after}`;
}

/** Canonical signature of a surface's findings: surfaces that changed in the
 *  same way collapse into one section + one image (the rects differ per width;
 *  the change itself does not). */
export function signatureOf(findings: Finding[]): string {
  return JSON.stringify(
    findings
      .map((f) => ({
        p: f.path,
        k: f.kind,
        t: f.kind === 'dom' ? f.change : f.kind === 'state' ? f.state : (f.pseudo ?? ''),
        v: f.kind === 'dom' ? '' : summarizeProps(f.props).map(sigValue).join('|'),
      }))
      .sort((a, b) => `${a.p}|${a.k}|${a.t}`.localeCompare(`${b.p}|${b.k}|${b.t}`)),
  );
}

/** A one-line heading for a change group: "1 element added", "2 elements restyled". */
export function groupTitle(findings: Finding[]): string {
  const added = new Set(findings.filter((f) => f.kind === 'dom' && f.change === 'added').map((f) => f.path));
  const removed = new Set(findings.filter((f) => f.kind === 'dom' && f.change === 'removed').map((f) => f.path));
  const retagged = new Set(findings.filter((f) => f.kind === 'dom' && f.change === 'retagged').map((f) => f.path));
  const restyled = new Set(
    findings.filter((f) => f.kind !== 'dom' && !added.has(f.path) && !removed.has(f.path)).map((f) => f.path),
  );
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (added.size) parts.push(`${n(added.size, 'element')} added`);
  if (removed.size) parts.push(`${n(removed.size, 'element')} removed`);
  if (retagged.size) parts.push(`${n(retagged.size, 'element')} retagged`);
  if (restyled.size) parts.push(`${n(restyled.size, 'element')} restyled`);
  return parts.join(', ') || `${n(new Set(findings.map((f) => f.path)).size, 'element')} changed`;
}

// Computed values that follow from an element's box size or position rather than
// its styling. On any reflow they change all the way up the ancestor chain
// (body, main, section…), so an element whose ONLY changes are these is a reflow
// casualty: it must not anchor a crop region (that would zoom to the whole page)
// nor clutter the findings. The certification differ keeps them — a reflow IS a
// change to certify — but the visual report focuses on styling intent.
const DERIVED_PROPS = new Set([
  'width',
  'height',
  'block-size',
  'inline-size',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'perspective-origin',
  'transform-origin',
  // position offsets shift with the document on any reflow
  'top',
  'right',
  'bottom',
  'left',
  'inset-block-start',
  'inset-block-end',
  'inset-inline-start',
  'inset-inline-end',
]);
// Props stripped from forced :hover/:focus/:active deltas specifically. Layout
// and grid-track values that shift when a state forces a relayout are capture
// noise, not interaction feedback — a state finding is meant to catch a changed
// hover/focus/active *style* (colour, outline, shadow), not a reflow.
const STATE_STRIP = new Set([
  ...DERIVED_PROPS,
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-columns',
  'grid-auto-rows',
  'grid-auto-flow',
]);

/** How many of a surface's summarised props are derived/box longhands — the count
 *  the CLI folds behind `(+N derived longhands)`. Counts on the RAW finding props
 *  (before cleaning) so the CLI can advertise exactly what it suppressed. */
export function derivedLonghandCount(findings: Finding[]): number {
  let n = 0;
  for (const f of findings) {
    if (f.kind === 'dom') continue;
    const strip = f.kind === 'state' ? STATE_STRIP : DERIVED_PROPS;
    for (const p of summarizeProps(f.props)) if (strip.has(p.prop)) n++;
  }
  return n;
}

/**
 * Strip the noise the visual report shouldn't carry, cross-referencing each
 * element's layers so the forced-state layer stops echoing the base:
 *   - base/pseudo styles: drop size/position-derived longhands (reflow casualties);
 *   - forced states: drop derived + grid-track props, drop a delta the BASE
 *     already changed (a `:hover color` that just follows a recoloured base is an
 *     echo, not a dropped variant), and drop non-value↔non-value rows;
 *   - any finding left with no props is removed entirely.
 */
export function cleanFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const group of groupByPath(findings)) {
    const base = group.find((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style' && f.pseudo === null);
    const baseChanged = new Set(base?.props.map((p) => p.prop) ?? []);
    // For an ADDED element the base style is a full (unset)→value snapshot, not a
    // delta — so a forced-state value is never an "echo" of a base *change*; keep
    // every state row (suppressing them would drop a real :hover/:focus value).
    const isAdded = group.some((f) => f.kind === 'dom' && f.change === 'added');
    for (const f of group) {
      if (f.kind === 'dom') {
        out.push(f);
        continue;
      }
      const props =
        f.kind === 'style'
          ? f.props.filter((p) => !DERIVED_PROPS.has(p.prop))
          : f.props.filter(
              (p) =>
                !STATE_STRIP.has(p.prop) &&
                (isAdded || !baseChanged.has(p.prop)) &&
                !(isNonValue(p.before) && isNonValue(p.after)),
            );
      if (props.length) out.push({ ...f, props });
    }
  }
  return out;
}

// ── comparison truth (diff / report / trust coherence) ───────────────────────

/** Tally DOM/style/state findings the same way the certification differ does. */
function countFindings(findings: Finding[]): DiffCounts {
  return findings.reduce<DiffCounts>(
    (counts, f) => {
      if (f.kind === 'dom') counts.dom += 1;
      else if (f.kind === 'style') counts.style += f.props.length;
      else counts.state += f.props.length;
      return counts;
    },
    { dom: 0, style: 0, state: 0 },
  );
}

function addCounts(a: DiffCounts, b: DiffCounts): DiffCounts {
  return { dom: a.dom + b.dom, style: a.style + b.style, state: a.state + b.state };
}

const ZERO_COUNTS: DiffCounts = { dom: 0, style: 0, state: 0 };

/**
 * Canonical comparison truth shared by styleproof-diff, generateStyleMapReport,
 * and the composite action trust verdict.
 *
 * The certification differ records every computed longhand (including reflow
 * casualties). The visual report strips derived size/position longhands so crops
 * stay on styling intent. Those two views must never independently invent a
 * trust state: VISUAL_APPROVAL_REQUIRED requires reviewable evidence (cleaned
 * findings, crops, or one-sided surfaces); raw-only derived noise fails closed
 * as a certification/consistency failure rather than a blind approval gate.
 */
export type ComparisonTruth = {
  rawCounts: DiffCounts;
  reviewableCounts: DiffCounts;
  newSurfaces: number;
  removedSurfaces: number;
  rawChangedSurfaces: number;
  reviewableChangedSurfaces: number;
  /** Cleaned findings, new surfaces, or removed surfaces a human can act on. */
  hasReviewableEvidence: boolean;
  /**
   * Raw certification deltas that cleanFindings strips entirely — the report
   * would show no change sections/crops. Never map this to VISUAL_APPROVAL_REQUIRED.
   */
  rawOnlyNoReviewable: boolean;
};

/** Surface shape both the differ and the report already produce. */
export type ComparisonSurface = {
  surface: string;
  missing?: 'before' | 'after';
  findings: Finding[];
};

/**
 * Assess one map-pair comparison for report/verdict coherence.
 *
 * When `rawCounts` is provided (from `diffStyleMapDirs`), it is used as-is so
 * JSON `counts` and the assessment share one tally. Otherwise counts are
 * recomputed from the surface findings.
 */
export function assessComparisonTruth(surfaces: ComparisonSurface[], rawCounts?: DiffCounts): ComparisonTruth {
  let raw = rawCounts ? { ...rawCounts } : { ...ZERO_COUNTS };
  let reviewable = { ...ZERO_COUNTS };
  let newSurfaces = 0;
  let removedSurfaces = 0;
  let rawChangedSurfaces = 0;
  let reviewableChangedSurfaces = 0;

  for (const sd of surfaces) {
    if (sd.missing === 'before') {
      newSurfaces++;
      continue;
    }
    if (sd.missing === 'after') {
      removedSurfaces++;
      continue;
    }
    if (!rawCounts) raw = addCounts(raw, countFindings(sd.findings));
    if (sd.findings.length > 0) rawChangedSurfaces++;
    const cleaned = cleanFindings(sd.findings);
    const rev = countFindings(cleaned);
    reviewable = addCounts(reviewable, rev);
    if (cleaned.length > 0) reviewableChangedSurfaces++;
  }

  const rawTotal = raw.dom + raw.style + raw.state;
  const revTotal = reviewable.dom + reviewable.style + reviewable.state;
  const hasReviewableEvidence = revTotal > 0 || newSurfaces > 0 || removedSurfaces > 0;
  const rawOnlyNoReviewable = rawTotal > 0 && revTotal === 0 && newSurfaces === 0 && removedSurfaces === 0;

  return {
    rawCounts: raw,
    reviewableCounts: reviewable,
    newSurfaces,
    removedSurfaces,
    rawChangedSurfaces,
    reviewableChangedSurfaces,
    hasReviewableEvidence,
    rawOnlyNoReviewable,
  };
}
