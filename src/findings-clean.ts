import { summarizeComparability, type ProductStateComparabilityStatus } from './comparability-status.js';
import { type DiffCounts, type Finding, type PropChange } from './diff.js';
import { trackCount } from './describe.js';
import { isNonValue, summarizeProps } from './prop-summary.js';
import { emptyLiveTextAudit, isLiveTextGeometryPath, type LiveTextAudit } from './live-text.js';

/**
 * Path grouping, change signatures, titles, reflow-noise cleaning, and the
 * canonical comparison-truth assessment shared by the differ and the report.
 */

type StyleFinding = Extract<Finding, { kind: 'style' }>;
const isStyle = (f: Finding): f is StyleFinding => f.kind === 'style';

/** Group findings by their element path (one group per changed element). */
export function groupByPath(findings: Finding[]): Finding[][] {
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  return [...byPath.values()];
}

// Grid-track longhands compute to width-dependent pixels, so key them by track
// COUNT: the same responsive change then shares one signature across widths.
function sigValue(c: PropChange): string {
  if (c.prop === 'grid-template-columns' || c.prop === 'grid-template-rows') {
    return `${c.prop}=${trackCount(c.before)}t>${trackCount(c.after)}t`;
  }
  return `${c.prop}=${c.before}>${c.after}`;
}

/** Canonical signature of a surface's findings: surfaces that changed the same way share one section. */
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

const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`;

/** A one-line heading for a change group: "1 element added", "2 elements restyled". */
export function groupTitle(findings: Finding[]): string {
  const domPaths = (change: string) =>
    new Set(findings.filter((f) => f.kind === 'dom' && f.change === change).map((f) => f.path));
  const [added, removed, retagged] = ['added', 'removed', 'retagged'].map(domPaths);
  const restyled = new Set(
    findings.filter((f) => f.kind !== 'dom' && !added.has(f.path) && !removed.has(f.path)).map((f) => f.path),
  );
  const parts = (
    [
      [added, 'added'],
      [removed, 'removed'],
      [retagged, 'retagged'],
      [restyled, 'restyled'],
    ] as const
  )
    .filter(([paths]) => paths.size)
    .map(([paths, verb]) => `${plural(paths.size, 'element')} ${verb}`);
  const title = parts.join(', ') || `${plural(new Set(findings.map((f) => f.path)).size, 'element')} changed`;
  // No driving property: the size/position values ARE the change — usually content drift, not CSS.
  return isGeometryOnlyGroup(findings)
    ? `${title} — size/position only, no styling property changed (often content-length drift; check the rendered text before suspecting CSS)`
    : title;
}

// Computed values that follow from box size/position rather than styling. On any
// reflow they change all the way up the ancestor chain, so an element whose ONLY
// changes are these is a reflow casualty: the differ keeps them, the report hides them.
const DERIVED_PROPS = new Set(
  `width height block-size inline-size min-width min-height max-width max-height perspective-origin transform-origin
   top right bottom left inset-block-start inset-block-end inset-inline-start inset-inline-end`.split(/\s+/),
);
// Forced :hover/:focus/:active deltas also drop grid-track relayout noise.
const STATE_STRIP = new Set([
  ...DERIVED_PROPS,
  ...'grid-template-columns grid-template-rows grid-template-areas grid-auto-columns grid-auto-rows grid-auto-flow'.split(
    ' ',
  ),
]);

/** Derived/box longhands among a surface's RAW summarised props — what the CLI folds behind `(+N derived longhands)`. */
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
 * Strip the noise the visual report shouldn't carry: base/pseudo styles drop
 * derived longhands; forced states also drop grid-track props, deltas the BASE
 * already changed (an echo, not a dropped variant) and non-value↔non-value rows;
 * a finding left with no props is removed entirely.
 */
export function cleanFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const group of groupByPath(findings)) {
    const base = group.find((f): f is StyleFinding => f.kind === 'style' && f.pseudo === null);
    const baseChanged = new Set(base?.props.map((p) => p.prop) ?? []);
    // An ADDED element's base style is a full snapshot, not a delta, so a state
    // value is never an "echo" of a base change: keep every state row.
    const isAdded = group.some((f) => f.kind === 'dom' && f.change === 'added');
    const keep: Record<Finding['kind'], (p: PropChange) => boolean> = {
      dom: () => true,
      style: (p) => !DERIVED_PROPS.has(p.prop),
      state: (p) =>
        !STATE_STRIP.has(p.prop) &&
        (isAdded || !baseChanged.has(p.prop)) &&
        !(isNonValue(p.before) && isNonValue(p.after)),
    };
    for (const f of group) {
      if (f.kind === 'dom') {
        out.push(f);
        continue;
      }
      const props = f.props.filter(keep[f.kind]);
      if (props.length) out.push({ ...f, props });
    }
  }
  return out;
}

/** Style findings whose geometry moved WITH the element's own text length — a real
 *  visible change, never a reflow casualty. `'unknown'` deliberately does not qualify. */
function contentDrivenGeometry(findings: Finding[]): StyleFinding[] {
  return findings.filter(
    (f): f is StyleFinding =>
      f.kind === 'style' &&
      f.contentLengthSignal === 'changed' &&
      f.props.length > 0 &&
      f.props.some((p) => DERIVED_PROPS.has(p.prop)),
  );
}

/**
 * {@link cleanFindings}, but a surface is never cleaned into silence while it
 * still gates: content-driven geometry stays in the display set, and when
 * cleaning leaves nothing the original base/pseudo style findings are kept so
 * the verdict and the evidence describe the same run.
 */
export function cleanFindingsForDisplay(findings: Finding[]): Finding[] {
  const cleaned = cleanFindings(findings);
  const contentDriven = contentDrivenGeometry(findings);
  if (contentDriven.length > 0) {
    // cleanFindings rebuilds finding objects, so dedupe by element identity.
    const shown = new Set(cleaned.filter(isStyle).map((f) => `${f.path}|${f.pseudo ?? ''}`));
    return [...cleaned, ...contentDriven.filter((f) => !shown.has(`${f.path}|${f.pseudo ?? ''}`))];
  }
  if (cleaned.length > 0) return cleaned;
  return findings.filter((f): f is StyleFinding => f.kind === 'style' && f.props.length > 0);
}

/** True when every shown prop is a size/position longhand — the "geometry only" shape that usually means content drift. */
export function isGeometryOnlyGroup(findings: Finding[]): boolean {
  const styleFindings = findings.filter(isStyle);
  return styleFindings.length > 0 && styleFindings.every((f) => f.props.every((p) => DERIVED_PROPS.has(p.prop)));
}

// ── comparison truth (diff / report / trust coherence) ───────────────────────

/** Tally DOM/style/state findings the same way the certification differ does. */
export function countFindings(findings: Finding[]): DiffCounts {
  const counts: DiffCounts = { dom: 0, style: 0, state: 0 };
  for (const f of findings) {
    if (f.kind === 'dom') counts.dom += 1;
    else counts[f.kind] += f.props.length;
  }
  return counts;
}

export function addCounts(a: DiffCounts, b: DiffCounts): DiffCounts {
  return { dom: a.dom + b.dom, style: a.style + b.style, state: a.state + b.state };
}

/**
 * Canonical comparison truth shared by styleproof-diff, generateStyleMapReport,
 * and the Action trust verdict. STYLE_REVIEW_REQUIRED needs reviewable evidence
 * (cleaned findings, crops, or one-sided surfaces); raw-only derived noise fails
 * closed as a certification/consistency failure, never a blind approval gate.
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
  /** Raw deltas that cleanFindings strips entirely. Never map this to STYLE_REVIEW_REQUIRED. */
  rawOnlyNoReviewable: boolean;
  /** Geometry drift paired with a changed own-text length exists — informational, reviewable evidence. */
  contentGeometryUncertain: boolean;
  incomparableSurfaces: number;
  unprovenSurfaces: number;
  requiredUnprovenSurfaces: number;
  globalRequiredUnprovenSurfaces: number;
  /** liveText.freeze declared yet captured age/clock text drifted: CERTIFICATION_FAILED, never green. */
  liveTextFreezeViolated: boolean;
};

/** Surface shape both the differ and the report already produce. */
export type ComparisonSurface = {
  surface: string;
  missing?: 'before' | 'after';
  findings: Finding[];
};

export type ComparisonComparability = {
  surface: string;
  status: ProductStateComparabilityStatus;
  required: boolean;
};

export type ComparisonTruthOptions = {
  /** Require explicit identity even when both captures are legacy and undeclared. */
  requireStateIdentity?: boolean;
  /** Declared live/age/clock text audit. Absent = current undeclared behaviour. */
  liveText?: LiveTextAudit;
};

// What a live text change can plausibly move: its own box size and the sizes of
// the boxes that wrap it, plus the origins that compute from those sizes. Offsets
// (top/left/inset-*, …) and transforms are never a text reflow, so a live path
// can never launder them.
const LIVE_TEXT_REFLOW_PROPS = new Set(
  `width height block-size inline-size min-width min-height max-width max-height min-block-size max-block-size
   min-inline-size max-inline-size perspective-origin transform-origin`.split(/\s+/),
);

/**
 * Drop age-driven geometry so declared live/age text is not a style finding.
 * The rule: a base-layer style finding on a live path or one of its ancestors
 * is dropped only when EVERY changed prop is a size-type longhand in
 * {@link LIVE_TEXT_REFLOW_PROPS}. Anything else — an offset, a colour, a state
 * delta, a pseudo layer — stays, because text length cannot explain it.
 */
export function dropDeclaredLiveTextGeometry(findings: Finding[], liveText: LiveTextAudit | undefined): Finding[] {
  if (!liveText?.declared || liveText.livePaths.length === 0) return findings;
  return findings.filter(
    (f) =>
      f.kind !== 'style' ||
      f.pseudo !== null ||
      !isLiveTextGeometryPath(f.path, liveText.livePaths) ||
      !f.props.every((p) => LIVE_TEXT_REFLOW_PROPS.has(p.prop)),
  );
}

/** True when declared live text explains every RAW finding: nothing else changed on any paired surface. */
export function rawFindingsExplainedByLiveText(surfaces: ComparisonSurface[], liveText: LiveTextAudit): boolean {
  return surfaces.every((surface) => dropDeclaredLiveTextGeometry(surface.findings, liveText).length === 0);
}

function reviewableFindings(
  surface: ComparisonSurface,
  comparison: ComparisonComparability | undefined,
  requireStateIdentity: boolean,
  liveText: LiveTextAudit,
): Finding[] {
  // A single receipt summarised: an unknown status, incomparable, or a required unproven pair blocks review.
  if (comparison && summarizeComparability([comparison], requireStateIdentity).blocksCertification) return [];
  return dropDeclaredLiveTextGeometry(cleanFindingsForDisplay(surface.findings), liveText);
}

const sumSurfaceCounts = (surfaces: ComparisonSurface[]): DiffCounts =>
  surfaces.reduce((total, surface) => addCounts(total, countFindings(surface.findings)), {
    dom: 0,
    style: 0,
    state: 0,
  });

/**
 * Assess one map-pair comparison for report/verdict coherence. When `rawCounts`
 * is provided (from `diffStyleMapDirs`) it is used as-is so JSON `counts` and the
 * assessment share one tally; otherwise counts are recomputed from the findings.
 */
export function assessComparisonTruth(
  surfaces: ComparisonSurface[],
  rawCounts?: DiffCounts,
  comparability: ComparisonComparability[] = [],
  options: ComparisonTruthOptions = {},
): ComparisonTruth {
  const requireStateIdentity = options.requireStateIdentity === true;
  const liveText = options.liveText ?? emptyLiveTextAudit();
  const bySurface = new Map(comparability.map((entry) => [entry.surface, entry]));
  const paired = surfaces.filter((surface) => surface.missing === undefined);
  const reviewable = paired.map((surface) => ({
    ...surface,
    findings: reviewableFindings(surface, bySurface.get(surface.surface), requireStateIdentity, liveText),
  }));
  const raw = rawCounts ? { ...rawCounts } : sumSurfaceCounts(paired);
  const reviewableCounts = sumSurfaceCounts(reviewable);
  const newSurfaces = surfaces.filter((surface) => surface.missing === 'before').length;
  const removedSurfaces = surfaces.filter((surface) => surface.missing === 'after').length;
  const { counts } = summarizeComparability(comparability, requireStateIdentity);
  const hasReviewableEvidence =
    reviewableCounts.dom + reviewableCounts.style + reviewableCounts.state > 0 ||
    newSurfaces > 0 ||
    removedSurfaces > 0;
  // Only residue live text fully explains is exempt; any other raw delta the report
  // strips (a cleaned :hover width) still fails closed as raw-only.
  const declaredLiveTextResidue =
    liveText.declared &&
    liveText.livePaths.length > 0 &&
    !hasReviewableEvidence &&
    rawFindingsExplainedByLiveText(paired, liveText);
  return {
    rawCounts: raw,
    reviewableCounts,
    newSurfaces,
    removedSurfaces,
    rawChangedSurfaces: paired.filter((surface) => surface.findings.length > 0).length,
    reviewableChangedSurfaces: reviewable.filter((surface) => surface.findings.length > 0).length,
    hasReviewableEvidence,
    rawOnlyNoReviewable:
      raw.dom + raw.style + raw.state > 0 &&
      !hasReviewableEvidence &&
      !declaredLiveTextResidue &&
      counts.incomparable === 0 &&
      counts.requiredUnproven === 0 &&
      counts.globalRequiredUnproven === 0,
    contentGeometryUncertain: surfaces.some((item) => contentDrivenGeometry(item.findings).length > 0),
    // Key order is part of the report.json byte contract: the freeze flag precedes the counts.
    liveTextFreezeViolated: liveText.freeze && liveText.violations.length > 0,
    incomparableSurfaces: counts.incomparable,
    unprovenSurfaces: counts.unproven,
    requiredUnprovenSurfaces: counts.requiredUnproven,
    globalRequiredUnprovenSurfaces: counts.globalRequiredUnproven,
  };
}
