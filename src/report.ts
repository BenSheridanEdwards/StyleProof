import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  loadStyleMap,
  readInventories,
  readResidue,
  surfaceElementPaths,
  captureKeysIn,
  mergeSurfaceKeyLookup,
  type ElementEntry,
  type LiveRegionCandidate,
  type Rect,
  type StyleMap,
  STATE_LAYER_NAMES,
} from './capture.js';
import {
  isMapFile,
  readBaselineProvenance,
  readMapManifest,
  surfaceMissingMatchesBaselineFailure,
  type BaselineProvenance,
  type SurfaceCaptureFailure,
} from './map-store.js';
import { fillRect, type RGB } from './png-util.js';
import {
  diffStyleMapDirs,
  diffContentDirs,
  presentationDiffStyleMaps,
  summarizeComparability,
  type ComparabilitySummary,
  type ContentChange,
  type DiffCounts,
  type Finding,
  type PropChange,
  type SurfaceComparability,
  type SurfaceDiff,
} from './diff.js';
import { presentationBeforeMap } from './path-correspondence.js';
import { describeChange, tokenIndex, toHex, type ElementChange, type DescribeCtx } from './describe.js';
import {
  auditCoverage,
  auditDeterminism,
  type CoverageLedger,
  type CoverageVerdict,
  type DeterminismVerdict,
} from './coverage.js';
import { auditRunInventory, readAckFile } from './inventory.js';
import { auditRunResidue, readResidueAckFile } from './data-residue.js';
import {
  bundleSurfaceKeys,
  CONFIDENCE_LEDGER,
  readCoverageLedgerLenient,
  resolveBundleConfidence,
  summarizeConfidence,
  type ConfidenceLedgerFile,
  type ConfidenceSummary,
} from './confidence-ledger.js';
// The pure grouping / classification brain — shared with the CLI. report.ts keeps
// the crop-and-PNG rendering on top of these.

import {
  cleanFindingsForDisplay,
  groupByPath,
  groupTitle,
  isNonValue,
  prettyLabel,
  safeKey,
  signatureOf,
  summarizeProps,
  surfaceBase,
  surfaceWidth,
  pushSurfaceWidth,
  renderSurfaceGroups,
  formatSurfaceList,
  countChangedSurfaceScope,
  formatChangedSurfaceScope,
  countCapturedSurfaceBases,
  classifyChrome,
  assessComparisonTruth,
  type ComparisonTruth,
} from './change-groups.js';
// Re-export the plain-English summariser so consumers (and tests) reach it
// through the package's report module rather than a deep path.
export { describeChange, colorName, tokenIndex, toHex } from './describe.js';
// Re-export the grouping primitives historically exported from here so existing
// imports (`from 'styleproof'` → report) keep resolving.
export { summarizeProps, prettyLabel, assessComparisonTruth } from './change-groups.js';
export type { ComparisonTruth } from './change-groups.js';

/**
 * Visual diff report: for every surface with findings, crop the before/after
 * full-page screenshots around the changed elements and write a markdown
 * report with side-by-side images plus the exact property changes.
 *
 * Cropping zooms out to the OUTERMOST changed element: changed paths that are
 * descendants of other changed paths are folded into their ancestor, nearby
 * regions are merged, and both sides are cropped at the SAME page rectangle (the
 * union of where the change sits on each side) so the pair lines up exactly —
 * the reviewer compares like-for-like instead of playing spot-the-difference.
 */

export type ReportOptions = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  /** Prefix for image URLs in report.md (default: relative paths). */
  imageBaseUrl?: string;
  /** Padding around the union of changed rects (default 12px). */
  pad?: number;
  /** Minimum crop size, for context around tiny changes (default 320×180). */
  minWidth?: number;
  minHeight?: number;
  /** Crops taller than this are clamped (default 1600px). */
  maxHeight?: number;
  /**
   * Changed-element footprint (max of its width/height, in px) at or below which a
   * magnified zoom crop is added so a sub-pixel change is visible by default
   * (default 64). Set to 0 to disable zoom crops.
   */
  zoomBelow?: number;
  /** Max crop regions per surface before collapsing into one union crop (default 8). */
  maxCrops?: number;
  /**
   * Row count at which a crop's property tables fold under a `<details>` toggle
   * (default 0 = always fold; the plain-English bullets and screenshot stay
   * visible). Set to e.g. 5 to keep small changes inline and fold only verbose
   * ones, or `Infinity` to never fold.
   */
  foldDetailsAt?: number;
  /**
   * Include size/position-derived longhands (height, width, transform-origin…)
   * in the report. Off by default: on a reflow they change up the whole ancestor
   * chain and would anchor crops to the entire page. The certification differ
   * (`styleproof-diff`) always keeps them.
   */
  includeLayoutNoise?: boolean;
  /**
   * Render the opt-in content layer (default OFF): a separate, ADVISORY section
   * listing elements whose own text changed, each with a before/after crop.
   * Requires captures taken with `captureText: true`; otherwise there's no text
   * to diff and the section is empty. Copy edits stay advisory. A wholesale
   * product-state flip (distinct mode labels, or a tree rewrite) withholds that
   * surface's style findings from certification so a reviewer is not asked to
   * approve a restyle the product did not make. Small copy edits next to a real
   * restyle still certify.
   */
  includeContent?: boolean;
  /** Require explicit matching productState identity on every paired capture. */
  requireStateIdentity?: boolean;
  /**
   * Byte ceiling for report.md so GitHub can always render it (its markdown viewer
   * refuses to render files past ~512 KB). Once the accumulated report would exceed
   * this, the remaining changed surfaces are listed as one-liners (name · change
   * count · crop link) instead of full property tables — the exhaustive per-row
   * detail is always kept in report.json and every crop in crops/, so nothing is
   * lost, just relocated. Default 400_000 (~0.4 MB). Set to Infinity to never cap.
   */
  maxReportBytes?: number;
};

export type ReportComparison = ComparisonTruth & ComparabilitySummary;

export type ReportResult = {
  /** Surfaces carrying a reviewable change (excludes new, one-sided surfaces). */
  changedSurfaces: number;
  /** New surfaces present on only one side, with no baseline to compare. */
  newSurfaces: number;
  totalFindings: number;
  /** Advisory content-layer changes rendered (0 unless includeContent + captured text). Never gates. */
  contentChanges: number;
  /**
   * Canonical comparison truth vs the certification differ. When
   * `rawOnlyNoReviewable` is true the report has no crops/sections but raw
   * computed-style deltas exist — callers must fail closed, never approve.
   */
  comparison: ReportComparison;
  /** Bounded per-capture receipts; identity values and page observations are never included. */
  comparability: SurfaceComparability[];
  /** Presentation-vs-certification coherence. Any false value must fail closed. */
  reportConsistency: ReportConsistency;
  /**
   * The head bundle's confidence badge (#399): completeness + per-status counts,
   * separate from the visual verdict. `completeness: 'unknown'` on bundles from
   * before the ledger existed — advisory, never a retroactive block.
   */
  confidence: ConfidenceSummary;
  reportMdPath: string;
  reportJsonPath: string;
};

type Box = { x: number; y: number; w: number; h: number };

// Hidden marker appended to a new-surface heading. Invisible in rendered
// markdown; lets the PR-comment layer recognize one-sided surfaces.
const NEW_SURFACE_MARKER = '<!-- styleproof-new -->';

const rectToBox = (r: Rect): Box => ({ x: r[0], y: r[1], w: r[2], h: r[3] });
const pad = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by });
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const visible = (b: Box | null): b is Box => !!b && b.w > 0 && b.h > 0;

/** Bounding box that encloses every rect (the changed-element footprint). */
function unionRects(rects: Rect[]): Box | null {
  const boxes = rects.map(rectToBox).filter(visible);
  if (!boxes.length) return null;
  return boxes.reduce(union);
}

/** Outermost changed paths: drop any path that has a changed strict ancestor.
 *  Used to ANCHOR a crop (zoom to the whole changed region, not a leaf). */
function outermost(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(q + ' > ')));
}

/** Innermost changed paths: drop any path that has a changed strict descendant.
 *  Used to ANNOTATE — box the leaf elements that actually changed (the added
 *  avatars, the restyled cards), not their container, whose box ≈ the whole crop. */
function innermost(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && q.startsWith(p + ' > ')));
}

function sortedProperties(props: Record<string, string>): [string, string][] {
  return Object.entries(props).sort(([left], [right]) => left.localeCompare(right, 'en'));
}

function restingAnnotationIdentity(entry: ElementEntry | undefined): unknown {
  if (!entry) return null;
  const sortedPseudo = Object.fromEntries(
    Object.entries(entry.pseudo ?? {})
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([pseudo, properties]) => [pseudo, sortedProperties(properties)]),
  );
  return [
    entry.tag,
    entry.cls,
    entry.rect?.[2] ?? null,
    entry.rect?.[3] ?? null,
    sortedProperties(entry.style),
    sortedPseudo,
  ];
}

function normalizeStructuralPath(elementPath: string): string {
  return elementPath.replace(/:nth-(?:child|of-type)\(\d+\)/g, (selector) => selector.replace(/\d+/, '*'));
}

function annotationScope(elementPath: string): string {
  const parentSeparator = elementPath.lastIndexOf(' > ');
  return normalizeStructuralPath(parentSeparator === -1 ? '' : elementPath.slice(0, parentSeparator));
}

function relativeStateTarget(ownerPath: string, targetPath: string): string {
  if (targetPath === ownerPath) return '';
  const ownerPseudoPrefix = `${ownerPath}::`;
  if (targetPath.startsWith(ownerPseudoPrefix)) return targetPath.slice(ownerPath.length);
  const descendantPrefix = `${ownerPath} > `;
  const relativePath = targetPath.startsWith(descendantPrefix) ? targetPath.slice(descendantPrefix.length) : targetPath;
  return normalizeStructuralPath(relativePath);
}

function canonicalForcedStates(map: StyleMap, ownerPath: string): unknown[] {
  return Object.entries(map.states?.[ownerPath] ?? {})
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([stateName, deltas]) => [
      stateName,
      Object.entries(deltas)
        .map(([targetPath, properties]) => [
          relativeStateTarget(ownerPath, targetPath),
          restingAnnotationIdentity(map.elements[targetPath]),
          sortedProperties(properties),
        ])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
    ]);
}

function annotationIdentity(map: StyleMap, elementPath: string, entry: ElementEntry): string {
  return JSON.stringify([restingAnnotationIdentity(entry), canonicalForcedStates(map, elementPath)]);
}

function sortedAnnotationPaths(paths: string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
}

function indexAnnotationIdentities(map: StyleMap): Map<string, string[]> {
  const pathsByIdentity = new Map<string, string[]>();
  for (const [elementPath, entry] of Object.entries(map.elements)) {
    const identity = annotationIdentity(map, elementPath, entry);
    pathsByIdentity.set(identity, [...(pathsByIdentity.get(identity) ?? []), elementPath]);
  }
  return pathsByIdentity;
}

type AnnotationPathMatches = {
  beforeToAfter: Map<string, string>;
  afterToBefore: Map<string, string>;
};

function pathsByAnnotationScope(paths: Iterable<string>): Map<string, string[]> {
  const pathsByScope = new Map<string, string[]>();
  for (const elementPath of paths) {
    const scope = annotationScope(elementPath);
    pathsByScope.set(scope, [...(pathsByScope.get(scope) ?? []), elementPath]);
  }
  for (const scopedPaths of pathsByScope.values())
    scopedPaths.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  return pathsByScope;
}

/** Captured children per concrete container path, for the displacement proof. */
function containerChildCounts(map: StyleMap): Map<string, number> {
  const counts = new Map<string, number>();
  for (const elementPath of Object.keys(map.elements)) {
    const separator = elementPath.lastIndexOf(' > ');
    const container = separator === -1 ? '' : elementPath.slice(0, separator);
    counts.set(container, (counts.get(container) ?? 0) + 1);
  }
  return counts;
}

/** The concrete container where two element paths diverge (never the leaf itself). */
function deepestCommonContainer(beforePath: string, afterPath: string): string {
  const beforeSegments = beforePath.split(' > ');
  const afterSegments = afterPath.split(' > ');
  const shared: string[] = [];
  const limit = Math.min(beforeSegments.length, afterSegments.length) - 1;
  for (let i = 0; i < limit && beforeSegments[i] === afterSegments[i]; i++) shared.push(beforeSegments[i]);
  return shared.join(' > ');
}

function containerOf(elementPath: string): string {
  const separator = elementPath.lastIndexOf(' > ');
  return separator === -1 ? '' : elementPath.slice(0, separator);
}

/**
 * A cross-path match is a MOVE claim, and a matched pair's annotations are
 * suppressed — so the move must be PROVABLE from the captured data, one of:
 *
 * - the container where the two paths diverge gained or lost captured children
 *   (a sibling insertion/removal displaced everything after it), or
 * - a same-container slide into a vacated slot: the source slot emptied and the
 *   destination slot is new. That is displacement by an UNCAPTURED sibling — an
 *   injected `<style>`/`<script>` shifts `nth-child` without entering the census.
 *
 * A pair with neither proof — a style swap between siblings, a pure reorder of
 * occupied slots, or a coincidental twin in a cousin container — stays
 * annotated, because the data cannot prove nothing changed there.
 */
function canReconcileAnnotationPair(
  beforeMap: StyleMap,
  afterMap: StyleMap,
  beforeCounts: Map<string, number>,
  afterCounts: Map<string, number>,
  beforePath: string,
  afterPath: string,
  remainingAfter: Set<string>,
): boolean {
  if (!remainingAfter.has(afterPath)) return false;
  const divergence = deepestCommonContainer(beforePath, afterPath);
  if ((beforeCounts.get(divergence) ?? 0) !== (afterCounts.get(divergence) ?? 0)) return true;
  if (containerOf(beforePath) !== containerOf(afterPath)) return false;
  return !beforeMap.elements[afterPath] && !afterMap.elements[beforePath];
}

function reconcileIdentityPaths(
  beforeMap: StyleMap,
  afterMap: StyleMap,
  beforeCounts: Map<string, number>,
  afterCounts: Map<string, number>,
  beforePaths: string[],
  afterPaths: string[],
  matches: AnnotationPathMatches,
): void {
  const remainingBefore = new Set(beforePaths);
  const remainingAfter = new Set(afterPaths);

  // Preserve stable paths first. This keeps duplicate occurrences deterministic
  // without claiming which indistinguishable physical node was inserted.
  for (const beforePath of beforePaths) {
    if (!remainingAfter.has(beforePath)) continue;
    matches.beforeToAfter.set(beforePath, beforePath);
    matches.afterToBefore.set(beforePath, beforePath);
    remainingBefore.delete(beforePath);
    remainingAfter.delete(beforePath);
  }

  const remainingAfterPathsByScope = pathsByAnnotationScope(remainingAfter);

  // Reconcile only within the same normalized structural neighborhood. Any
  // excess occurrence remains unmatched and is annotated as an addition/removal.
  for (const beforePath of sortedAnnotationPaths([...remainingBefore])) {
    const candidates = remainingAfterPathsByScope.get(annotationScope(beforePath)) ?? [];
    const afterPath = candidates.find((candidate) =>
      canReconcileAnnotationPair(beforeMap, afterMap, beforeCounts, afterCounts, beforePath, candidate, remainingAfter),
    );
    if (!afterPath) continue;
    matches.beforeToAfter.set(beforePath, afterPath);
    matches.afterToBefore.set(afterPath, beforePath);
    remainingBefore.delete(beforePath);
    remainingAfter.delete(afterPath);
  }
}

function reconcileAnnotationPaths(beforeMap: StyleMap, afterMap: StyleMap): AnnotationPathMatches {
  const beforePathsByIdentity = indexAnnotationIdentities(beforeMap);
  const afterPathsByIdentity = indexAnnotationIdentities(afterMap);
  const beforeCounts = containerChildCounts(beforeMap);
  const afterCounts = containerChildCounts(afterMap);
  const matches: AnnotationPathMatches = {
    beforeToAfter: new Map(),
    afterToBefore: new Map(),
  };
  const identities = new Set([...beforePathsByIdentity.keys(), ...afterPathsByIdentity.keys()]);

  for (const identity of identities) {
    reconcileIdentityPaths(
      beforeMap,
      afterMap,
      beforeCounts,
      afterCounts,
      sortedAnnotationPaths(beforePathsByIdentity.get(identity) ?? []),
      sortedAnnotationPaths(afterPathsByIdentity.get(identity) ?? []),
      matches,
    );
  }

  return matches;
}

function annotationSides(
  finding: Finding,
  beforeMoved: boolean,
  afterMoved: boolean,
): { before: boolean; after: boolean } {
  if (finding.kind !== 'dom') return { before: !beforeMoved, after: !afterMoved };
  if (finding.change === 'removed') return { before: !beforeMoved, after: false };
  if (finding.change === 'added') return { before: false, after: !afterMoved };
  return { before: true, after: true };
}

function annotationPaths(
  findings: Finding[],
  beforeMap: StyleMap,
  afterMap: StyleMap,
): { before: string[]; after: string[] } {
  const matches = reconcileAnnotationPaths(beforeMap, afterMap);
  const beforePaths = new Set<string>();
  const afterPaths = new Set<string>();

  for (const finding of findings) {
    const beforeMatch = matches.beforeToAfter.get(finding.path);
    const afterMatch = matches.afterToBefore.get(finding.path);
    const beforeMoved = beforeMatch !== undefined && beforeMatch !== finding.path;
    const afterMoved = afterMatch !== undefined && afterMatch !== finding.path;
    const sides = annotationSides(finding, beforeMoved, afterMoved);
    if (sides.before) beforePaths.add(finding.path);
    if (sides.after) afterPaths.add(finding.path);
  }

  return { before: innermost([...beforePaths]), after: innermost([...afterPaths]) };
}

/** Headline counts with the zeros dropped — `0 state-delta difference(s)` is noise.
 *  `style`/`state` here are matched-path restyles only (see {@link countShownChanges});
 *  one-sided added-node inventories are billed under DOM, never as differences. */
function changeCountLabel(shown: DiffCounts): string {
  const parts: string[] = [];
  if (shown.dom) parts.push(`${shown.dom} DOM change(s)`);
  if (shown.style) parts.push(`${shown.style} computed-style difference(s)`);
  if (shown.state) parts.push(`${shown.state} state-delta difference(s)`);
  return parts.join(' · ');
}

/** Paths that are one-sided DOM adds/removes — their style/state rows are full
 *  head- or base-side inventories, not before→after restyles on a matched path. */
function oneSidedDomPaths(findings: Finding[]): Set<string> {
  const paths = new Set<string>();
  for (const f of findings) {
    if (f.kind === 'dom' && (f.change === 'added' || f.change === 'removed')) paths.add(f.path);
  }
  return paths;
}

type Group = { paths: string[]; before: Box | null; after: Box | null };
type GroupPair = { left: number; right: number };

function groupForPath(pathKey: string, a: StyleMap, b: StyleMap, padBy: number): Group {
  const beforeRect = a.elements[pathKey]?.rect;
  const afterRect = b.elements[pathKey]?.rect;
  const before = beforeRect ? pad(rectToBox(beforeRect), padBy) : null;
  const after = afterRect ? pad(rectToBox(afterRect), padBy) : null;
  return {
    paths: [pathKey],
    before: visible(before) ? before : null,
    after: visible(after) ? after : null,
  };
}

function boxesOverlap(left: Box | null, right: Box | null): boolean {
  return visible(left) && visible(right) && intersects(left, right);
}

function groupsOverlap(left: Group, right: Group): boolean {
  return boxesOverlap(left.after, right.after) || boxesOverlap(left.before, right.before);
}

function firstOverlappingPair(groups: Group[]): GroupPair | null {
  for (let left = 0; left < groups.length; left++) {
    for (let right = left + 1; right < groups.length; right++) {
      if (groupsOverlap(groups[left], groups[right])) return { left, right };
    }
  }
  return null;
}

function unionVisibleBoxes(left: Box | null, right: Box | null): Box | null {
  return visible(left) && visible(right) ? union(left, right) : (left ?? right);
}

function mergeGroupPair(groups: Group[], pair: GroupPair): void {
  const left = groups[pair.left];
  const right = groups[pair.right];
  left.paths.push(...right.paths);
  left.before = unionVisibleBoxes(left.before, right.before);
  left.after = unionVisibleBoxes(left.after, right.after);
  groups.splice(pair.right, 1);
}

function groupRegions(paths: string[], a: StyleMap, b: StyleMap, padBy: number): Group[] {
  const groups = paths.map((pathKey) => groupForPath(pathKey, a, b, padBy));

  // Merge the first overlapping pair, then restart until the groups reach a fixpoint.
  for (let pair = firstOverlappingPair(groups); pair; pair = firstOverlappingPair(groups)) {
    mergeGroupPair(groups, pair);
  }
  return groups;
}

// A crop plus the document-space origin it was taken from, so callers can map an
// element's page coordinates into the crop to annotate it.
type Crop = { png: PNG; ox: number; oy: number };
function cropPng(src: PNG, box: Box, w: number, h: number): Crop {
  // Center the fixed-size crop on the box, clamped to the image.
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ox = Math.max(0, Math.min(Math.round(cx - w / 2), src.width - w));
  const oy = Math.max(0, Math.min(Math.round(cy - h / 2), src.height - h));
  const cw = Math.min(w, src.width);
  const ch = Math.min(h, src.height);
  const out = new PNG({ width: cw, height: ch });
  PNG.bitblt(src, out, Math.max(0, ox), Math.max(0, oy), cw, ch, 0, 0);
  return { png: out, ox, oy };
}

// Lossless but lean: drop the alpha channel (every crop/composite is opaque),
// max deflate, adaptive per-row filtering. ~15% smaller than the default, and
// faithful — these images are eyeballed for intentional change, so no lossy
// artifacts that could masquerade as a real diff. The bigger lever is in the
// action: it commits only the composite, never the separate before/after crops.
const PNG_OPTS = { deflateLevel: 9, filterType: -1, colorType: 2, inputColorType: 6 } as const;
function writePng(file: string, png: PNG): void {
  fs.writeFileSync(file, PNG.sync.write(png, PNG_OPTS));
}

// The annotation hue: a magenta no real UI palette tends to use, so an outline
// reads as a marker, not content. Drawn as a hollow rectangle (never filled) so
// the UI underneath stays visible — and the clean image alongside proves the box
// isn't part of the design.
const HILITE: RGB = [255, 0, 200];
function strokeRect(png: PNG, x: number, y: number, w: number, h: number, t = 2, color: RGB = HILITE): void {
  fillRect(png, x, y, w, t, color); // top
  fillRect(png, x, y + h - t, w, t, color); // bottom
  fillRect(png, x, y, t, h, color); // left
  fillRect(png, x + w - t, y, t, h, color); // right
}

/** Clone a crop and outline each changed element's box (page coords mapped into
 *  the crop via its origin), so the eye lands on exactly what the bullet named. */
function annotateCrop(crop: Crop, rects: Rect[]): { png: PNG; highlighted: boolean } {
  const out = new PNG({ width: crop.png.width, height: crop.png.height });
  PNG.bitblt(crop.png, out, 0, 0, crop.png.width, crop.png.height, 0, 0);
  let highlighted = false;
  for (const [rx, ry, rw, rh] of rects) {
    if (rw <= 0 || rh <= 0) continue;
    const left = Math.max(0, rx - crop.ox);
    const top = Math.max(0, ry - crop.oy);
    const right = Math.min(crop.png.width, rx - crop.ox + rw);
    const bottom = Math.min(crop.png.height, ry - crop.oy + rh);
    if (right <= left || bottom <= top) continue;
    strokeRect(out, left, top, right - left, bottom - top, Math.min(2, right - left, bottom - top));
    highlighted = true;
  }
  return { png: out, highlighted };
}

const PAIR_LABEL_COLOR: RGB = [139, 148, 158];
const PAIR_LABEL_SCALE = 2;
const PAIR_LABEL_GLYPHS: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};

function pairDirectionLabel(label: string, fallback: 'BEFORE' | 'AFTER'): string {
  const normalized = label.trim().toUpperCase();
  if (/^BASE(?:\s|:|$)/.test(normalized)) return 'BASE';
  if (/^HEAD(?:\s|:|$)/.test(normalized)) return 'HEAD';
  return fallback;
}

function pairLabelWidth(label: string): number {
  const glyphWidth = 5 * PAIR_LABEL_SCALE;
  const gap = PAIR_LABEL_SCALE;
  return label.length * glyphWidth + (label.length - 1) * gap;
}

function drawPairLabel(canvas: PNG, label: string, x: number, width: number): void {
  const glyphWidth = 5 * PAIR_LABEL_SCALE;
  const gap = PAIR_LABEL_SCALE;
  const textWidth = pairLabelWidth(label);
  const startX = x + Math.floor((width - textWidth) / 2);
  const startY = 3;
  for (let glyphIndex = 0; glyphIndex < label.length; glyphIndex++) {
    const glyph = PAIR_LABEL_GLYPHS[label[glyphIndex]];
    if (!glyph) continue;
    const glyphX = startX + glyphIndex * (glyphWidth + gap);
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] !== '1') continue;
        fillRect(
          canvas,
          glyphX + col * PAIR_LABEL_SCALE,
          startY + row * PAIR_LABEL_SCALE,
          PAIR_LABEL_SCALE,
          PAIR_LABEL_SCALE,
          PAIR_LABEL_COLOR,
        );
      }
    }
  }
}

/**
 * One before|after image: the two equal-size crops on a dark canvas with a
 * neutral divider between them. Direction labels live inside the top canvas
 * padding, so the PNG remains understandable when detached from report prose
 * without covering or mutating captured UI pixels.
 */
function compositePair(before: PNG, after: PNG, leftLabel = 'before', rightLabel = 'after'): PNG {
  const PAD = 20;
  const GAP = 28;
  const w = Math.max(before.width, after.width);
  const h = Math.max(before.height, after.height);
  const leftDirection = pairDirectionLabel(leftLabel, 'BEFORE');
  const rightDirection = pairDirectionLabel(rightLabel, 'AFTER');
  const panelWidth = Math.max(w, pairLabelWidth(leftDirection) + 8, pairLabelWidth(rightDirection) + 8);
  const width = PAD + panelWidth + GAP + panelWidth + PAD;
  const height = PAD + h + PAD;
  const canvas = new PNG({ width, height });
  fillRect(canvas, 0, 0, width, height, [13, 17, 23]); // GitHub dark
  const leftPanelX = PAD;
  const rightPanelX = PAD + panelWidth + GAP;
  const captureOffset = Math.floor((panelWidth - w) / 2);
  drawPairLabel(canvas, leftDirection, leftPanelX, panelWidth);
  drawPairLabel(canvas, rightDirection, rightPanelX, panelWidth);
  PNG.bitblt(before, canvas, 0, 0, before.width, before.height, leftPanelX + captureOffset, PAD);
  PNG.bitblt(after, canvas, 0, 0, after.width, after.height, rightPanelX + captureOffset, PAD);
  fillRect(canvas, PAD + panelWidth + GAP / 2 - 1, PAD, 2, h, [48, 54, 61]); // divider
  return canvas;
}

// Integer nearest-neighbor upscale. Nearest-neighbor (not smoothing) so the
// zoom invents no colours that weren't captured — a magnified crop is still a
// faithful pixel-for-pixel view, just bigger.
function scalePng(src: PNG, s: number): PNG {
  if (s <= 1) return src;
  const out = new PNG({ width: src.width * s, height: src.height * s });
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / s);
    for (let x = 0; x < out.width; x++) {
      const si = (sy * src.width + Math.floor(x / s)) << 2;
      const oi = (y * out.width + x) << 2;
      out.data[oi] = src.data[si];
      out.data[oi + 1] = src.data[si + 1];
      out.data[oi + 2] = src.data[si + 2];
      out.data[oi + 3] = src.data[si + 3];
    }
  }
  return out;
}

// A magnified crop centered on the changed box, for changes too small to see at
// 1:1 (e.g. a 2px font bump on a caret). Crops the tight context box, upscales by
// an integer factor, then outlines the changes (stroke scaled to stay visible).
function zoomCrop(src: PNG, box: Box, rects: Rect[], factor: number): PNG {
  const crop = cropPng(src, box, box.w, box.h);
  const scaled = scalePng(crop.png, factor);
  const t = Math.max(2, factor);
  for (const [rx, ry, rw, rh] of rects) {
    strokeRect(scaled, (rx - crop.ox) * factor, (ry - crop.oy) * factor, rw * factor, rh * factor, t);
  }
  return scaled;
}

function readPng(file: string): PNG | null {
  if (!fs.existsSync(file)) return null;
  return PNG.sync.read(fs.readFileSync(file));
}

// --- readable findings: the dedupe/summarise/label brain lives in
//     change-groups.ts (shared with the CLI). report.ts renders crops on top. ---

function surfaceContext(...maps: Array<StyleMap | undefined>): string {
  const metadata = maps.find((m) => m?.metadata)?.metadata;
  if (!metadata?.variantKey) return '';
  if (metadata.variantKind === 'live-state') return `live state \`${metadata.variantKey}\``;
  if (metadata.variantKind === 'popup') return `popup \`${metadata.variantKey}\``;
  if (metadata.variantKind === 'state-recipe') return `state recipe \`${metadata.variantKey}\``;
  return `variant \`${metadata.variantKey}\``;
}

function formatSurfaceWithContext(surface: string, ...maps: Array<StyleMap | undefined>): string {
  const context = surfaceContext(...maps);
  return context ? `${formatSurfaceList([surface])} · ${context}` : formatSurfaceList([surface]);
}

function formatSurfaceListWithContext(surfaces: string[], beforeDir: string): string {
  const byBase = new Map<string, number[]>();
  for (const surface of surfaces) {
    const map = loadStyleMap(findCapture(beforeDir, surface));
    const context = surfaceContext(map);
    const base = context ? `${surfaceBase(surface)} · ${context}` : surfaceBase(surface);
    pushSurfaceWidth(byBase, base, surface);
  }
  return renderSurfaceGroups(byBase);
}

function liveCandidateLabel(candidate: LiveRegionCandidate): string {
  const label = candidate.cls ? `${candidate.tag}.${candidate.cls.split(/\s+/)[0]}` : candidate.tag;
  return `${label} (${candidate.reason})`;
}

function captureFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(isMapFile) : [];
}

function collectLiveCandidateLabels(beforeDir: string, afterDir: string): string[] {
  const seen = new Set<string>();
  for (const dir of [beforeDir, afterDir]) {
    for (const file of captureFiles(dir)) {
      const map = loadStyleMap(path.join(dir, file));
      for (const candidate of map.liveCandidates ?? []) seen.add(liveCandidateLabel(candidate));
    }
  }
  return [...seen].sort();
}

/**
 * A crop's heading: the element it's anchored on, then what happened inside it —
 * `` `who-grid` · 5 elements restyled ``. Naming the anchor is what ties the
 * table of changes below to the screenshot above it.
 */
function regionHeading(regionPaths: string[], findings: Finding[]): string {
  const anchors = [...regionPaths].sort((a, b) => a.split(' > ').length - b.split(' > ').length);
  const clsFor = (p: string) => findings.find((f) => f.path === p)?.cls ?? '';
  const head = prettyLabel(anchors[0] ?? '', clsFor(anchors[0] ?? ''));
  const label = anchors.length > 1 ? `\`${head}\` + ${anchors.length - 1} more` : `\`${head}\``;
  return `${label} · ${groupTitle(findings)}`;
}

// CSS values are author/attacker-influenced (content:"…", url("…"), font-family
// strings), so at the render boundary they get their OWN escaper — distinct from
// safeKey, which strips control chars from surface keys. Values must stay READABLE
// (a mangled url(…) is useless), so we ESCAPE rather than strip:
//   • `|` → `\|`   — an unescaped pipe splits the table row (GitHub honours the
//                     backslash even inside a code span).
//   • backticks   — a bare backtick would close the code span and leak live
//                     Markdown; widen the fence to one more backtick than the
//                     value's longest run, padding a space when it touches an edge
//                     (GitHub's rule for a code span that starts/ends with a tick).
/** Escape capture error text embedded in Markdown list prose (not inside code spans). */
function escapeMarkdownFailureReason(reason: string): string {
  const line = reason.split('\n')[0];
  return line
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/[*_[`#|]/g, '\\$&');
}

function codeValue(v: string): string {
  const escaped = v.replace(/\|/g, '\\|');
  const longestRun = Math.max(0, ...(escaped.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = /^`|`$/.test(escaped) ? ' ' : '';
  return `${fence}${pad}${escaped}${pad}${fence}`;
}

// A "no value here" marker renders as an em dash; colours render as `#hex` so the
// table cell shows GitHub's live swatch.
const cell = (v: string): string => (isNonValue(v) ? '—' : codeValue(toHex(v)));

// Long values (gradients, data URIs) would swamp the table, but truncating each
// side independently can show two IDENTICAL cells for a real diff: both
// sides of a gradient rendered as the same rgba while the actual change — a
// dropped `0px` stop — was elsewhere in the string. Instead, trim the shared
// prefix/suffix and show each side's differing substring with a little context.
const EXCERPT_AT = 64; // both sides at or under this → show whole values
const EXCERPT_CTX = 12; // chars of shared context kept around the diff
const EXCERPT_MAX = 96; // hard cap per excerpt; the diff itself may be huge
export function excerptPair(before: string, after: string): [string, string] {
  if (before.length <= EXCERPT_AT && after.length <= EXCERPT_AT) return [before, after];
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  const maxS = Math.min(before.length, after.length) - p;
  while (s < maxS && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const cut = (v: string): string => {
    const start = Math.max(0, p - EXCERPT_CTX);
    let end = Math.min(v.length, v.length - s + EXCERPT_CTX);
    if (end - start > EXCERPT_MAX) end = start + EXCERPT_MAX;
    return (start > 0 ? '…' : '') + v.slice(start, end) + (end < v.length ? '…' : '');
  };
  return [cut(before), cut(after)];
}

/** Before/After cells as a pair, so long values excerpt around their actual diff. */
function cellPair(before: string, after: string): [string, string] {
  if (isNonValue(before) || isNonValue(after)) return [cell(before), cell(after)];
  const [b, a] = excerptPair(before, after);
  return [codeValue(toHex(b)), codeValue(toHex(a))];
}

/** One line per property change, stacked above the crop. No bullets. */
function glancePart(prefix: string, change: { prop: string; before: string; after: string }, added: boolean): string {
  if (added) return `${prefix}${codeValue(change.prop)} ${cell(change.after)}`;
  const [b, a] = cellPair(change.before, change.after);
  return `${prefix}${codeValue(change.prop)} ${b} → ${a}`;
}

export function propertyGlanceLine(findings: Finding[]): string {
  const parts: string[] = [];
  for (const group of groupByPath(findings)) {
    const added = group.some((f) => f.kind === 'dom' && f.change === 'added');
    for (const s of group.filter((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style')) {
      const prefix = s.pseudo ? `${codeValue(s.pseudo)} ` : '';
      for (const c of summarizeProps(s.props)) parts.push(glancePart(prefix, c, added));
    }
    for (const st of group.filter((f): f is Extract<Finding, { kind: 'state' }> => f.kind === 'state')) {
      const prefix = `${codeValue(`:${st.state}`)} `;
      for (const c of summarizeProps(st.props)) parts.push(glancePart(prefix, c, added));
    }
  }
  // <br> is required: GitHub collapses adjacent markdown lines into one paragraph.
  return parts.join('<br>\n');
}

function beforeAfterTable(rows: PropChange[]): string[] {
  return [
    '| Property | Before | After |',
    '| --- | --- | --- |',
    ...rows.map((r) => {
      const [b, a] = cellPair(r.before, r.after);
      return `| ${codeValue(r.prop)} | ${b} | ${a} |`;
    }),
  ];
}

// A brand-new element has no meaningful "before", so its resting style renders
// value-only (the After column), mirroring the added-element interaction-states table.
function valueTable(rows: PropChange[]): string[] {
  return ['| Property | Value |', '| --- | --- |', ...rows.map((r) => `| ${codeValue(r.prop)} | ${cell(r.after)} |`)];
}

/** Heading for an added node's style block — inventory, never a before→after restyle. */
function addedStyleHeading(pseudo: string | null): string {
  return pseudo
    ? `On \`${pseudo}\` (head-side inventory — no baseline):`
    : 'Style inventory (head-side — no baseline):';
}

/** `Button (variant=primary, size=sm)` — the React component + sanitized props
 *  the element captured (advisory; present only with captureComponent). */
function renderComponent(c: { name: string; props?: Record<string, string> }): string {
  const entries = Object.entries(c.props ?? {});
  const props = entries.length ? ` (${entries.map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  return `\`${c.name}\`${props}`;
}

/** One element's heading + body lines (no leading blank, no ×N suffix). */
// Base/pseudo style rows. Added elements render value-only inventory (no baseline).
function styleSection(styles: Extract<Finding, { kind: 'style' }>[], added: boolean): string[] {
  const out: string[] = [];
  for (const s of styles) {
    const rows = summarizeProps(s.props);
    if (rows.length)
      out.push(
        '',
        added ? addedStyleHeading(s.pseudo) : s.pseudo ? `On \`${s.pseudo}\`:` : 'Style:',
        '',
        ...(added ? valueTable(rows) : beforeAfterTable(rows)),
      );
  }
  return out;
}

// Forced :hover/:focus/:active rows. Added: value-only; changed: before → after.
function statesSection(states: Extract<Finding, { kind: 'state' }>[], added: boolean): string[] {
  const rows: string[] = [];
  for (const st of states)
    for (const c of summarizeProps(st.props)) {
      const [b, a] = cellPair(c.before, c.after);
      rows.push(
        added
          ? `| ${codeValue(`:${st.state}`)} | ${codeValue(c.prop)} | ${cell(c.after)} |`
          : `| ${codeValue(`:${st.state}`)} | ${codeValue(c.prop)} | ${b} → ${a} |`,
      );
    }
  if (!rows.length) return [];
  return [
    '',
    added ? 'Interactive states:' : 'Interactive-state changes:',
    '',
    added ? '| State | Property | Value |' : '| State | Property | Before → After |',
    '| --- | --- | --- |',
    ...rows,
  ];
}

function renderOneElement(group: Finding[]): { head: string; body: string[] } | null {
  const label = prettyLabel(group[0].path, group[0].cls);
  const dom = group.find((f): f is Extract<Finding, { kind: 'dom' }> => f.kind === 'dom');
  if (dom?.change === 'removed') return { head: `**Removed** \`${label}\``, body: [] };
  const added = dom?.change === 'added';
  const head = added
    ? `**Added** \`${label}\``
    : dom?.change === 'retagged'
      ? `**Retagged** \`${label}\` ${dom.detail ?? ''}`
      : `**\`${label}\`**`;

  const body: string[] = [];
  // React component that rendered the element (added/retagged carry it on the dom
  // finding) — surfaced first so a reviewer sees `Button (variant=primary)`.
  if (dom?.component) body.push('', `React component: ${renderComponent(dom.component)}`);
  body.push(
    ...styleSection(
      group.filter((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style'),
      added,
    ),
  );
  body.push(
    ...statesSection(
      group.filter((f): f is Extract<Finding, { kind: 'state' }> => f.kind === 'state'),
      added,
    ),
  );
  // Existing element with nothing left to show (all derived) → skip; an
  // added/removed/retagged element always renders its heading.
  if (!dom && !body.length) return null;
  return { head, body };
}

/**
 * Render each changed element ONCE — its base / pseudo / state findings grouped
 * under a single heading — then collapse identical siblings (same label, same
 * change at the same level) into one block with a `×N` count. A newly-added
 * element shows only the values it takes (a brand-new element has no meaningful
 * "before"); an existing element shows before → after.
 */
function renderElements(findings: Finding[], maxElements = 40): string[] {
  type Block = { head: string; body: string[]; count: number };
  const blocks: Block[] = [];
  const bySig = new Map<string, Block>();
  for (const group of groupByPath(findings)) {
    const el = renderOneElement(group);
    if (!el) continue;
    const sig = `${el.head}\n${el.body.join('\n')}`;
    const seen = bySig.get(sig);
    if (seen) seen.count++;
    else {
      const block = { ...el, count: 1 };
      bySig.set(sig, block);
      blocks.push(block);
    }
  }
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i >= maxElements) {
      out.push('', `_…and ${blocks.length - i} more element(s) — see report.json._`);
      break;
    }
    const b = blocks[i];
    out.push('', b.count > 1 ? `${b.head} ×${b.count}` : b.head, ...b.body);
  }
  return out;
}

/** Plain-text `<summary>` affordance — GitHub renders markdown inside `<summary>`
 *  literally, so no backticks or bold here. Added-node-only inventories say
 *  "inventory", not "property change", so reviewers don't read them as restyles. */
function foldSummary(findings: Finding[]): string {
  const oneSided = oneSidedDomPaths(findings);
  const propFindings = findings.filter((f) => f.kind !== 'dom');
  const n = propFindings.flatMap((f) => summarizeProps(f.props)).length;
  if (!n) return 'Show details';
  const allInventory = propFindings.length > 0 && propFindings.every((f) => oneSided.has(f.path));
  if (allInventory) {
    return n === 1 ? 'Show the head-side style inventory' : `Show all ${n} head-side inventory properties`;
  }
  return n === 1 ? 'Show the property change' : `Show all ${n} property changes`;
}

/** Render a crop's changes: plain-English bullets that tell the reviewer what to
 *  look for, then the exact property tables — folded under a toggle once they would
 *  be a wall (the screenshot and approval checkbox above always stay visible).
 *  Blank lines around the table block are mandatory or GitHub prints the tables as
 *  literal text. `foldAt` is the row count at which the tables collapse; ≤ 0 folds
 *  always, Infinity never. */
function renderCropChanges(findings: Finding[], foldAt: number, ctx: DescribeCtx): string[] {
  const tables = renderElements(findings);
  if (!tables.length) return [];
  const rows = findings.flatMap((f) => (f.kind === 'dom' ? [] : summarizeProps(f.props))).length;
  // Small enough to read at a glance: the tables speak for themselves.
  if (rows < foldAt) return tables;
  // Folded: plain-English bullets are the visible stand-in for what the toggle hides.
  const bullets = describeChange(buildElementChanges(findings), ctx);
  const summary = bullets.length ? bullets.map((b) => `- ${b}`) : ['_see changes_'];
  return ['', ...summary, '', '<details>', `<summary>${foldSummary(findings)}</summary>`, ...tables, '', '</details>'];
}

/** Per-element view for the plain-English summariser: the base deltas (summarised)
 *  plus which interactive states genuinely changed. */
function buildElementChanges(findings: Finding[]): ElementChange[] {
  const els: ElementChange[] = [];
  for (const group of groupByPath(findings)) {
    const dom = group.find((f): f is Extract<Finding, { kind: 'dom' }> => f.kind === 'dom');
    const styleProps = group
      .filter((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style')
      .flatMap((f) => f.props);
    els.push({
      label: prettyLabel(group[0].path, group[0].cls),
      added: dom?.change === 'added',
      removed: dom?.change === 'removed',
      retagged: dom?.change === 'retagged',
      props: summarizeProps(styleProps),
      states: [
        ...new Set(
          group.filter((f) => f.kind === 'state').map((f) => (f as Extract<Finding, { kind: 'state' }>).state),
        ),
      ],
    });
  }
  return els;
}

/** One-line, backtick-safe display text, clipped so the report stays scannable. */
function clipText(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Shared inputs for the opt-in content layer, bundled so each helper stays small.
type ContentCtx = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  img: (rel: string) => string;
  padBy: number;
  minWidth: number;
  minHeight: number;
  maxHeight: number;
  zoomBelow: number;
};

/** An element's padded box on one side, or null when it has no visible rect. */
function paddedRect(entry: ElementEntry | undefined, padBy: number): Box | null {
  if (!entry?.rect) return null;
  const b = pad(rectToBox(entry.rect), padBy);
  return visible(b) ? b : null;
}

/** Crop box for a content change: the union of where the element sits on each
 * side, expanded to the nearest useful shared visible ancestor. Body/full-page
 * shells and ancestors outside the configured crop bounds do not manufacture
 * context; those deterministically retain the leaf-centred crop. */
function isFullPageContentShell(entry: ElementEntry, png: PNG): boolean {
  if (entry.tag.toLowerCase() === 'body' || !entry.rect) return true;
  const [, , w, h] = entry.rect;
  return w >= png.width * 0.9 && h >= png.height * 0.9;
}

type ContentAncestorDecision = { kind: 'skip' } | { kind: 'fallback' } | { kind: 'use'; box: Box };

function contentAncestorDecision(
  entryA: ElementEntry | undefined,
  entryB: ElementEntry | undefined,
  leaf: Box,
  padBy: number,
  maxHeight: number,
  pngA: PNG,
  pngB: PNG,
): ContentAncestorDecision {
  if (!entryA?.rect || !entryB?.rect) return { kind: 'skip' };
  if (isFullPageContentShell(entryA, pngA) || isFullPageContentShell(entryB, pngB)) return { kind: 'fallback' };
  const ancestorA = paddedRect(entryA, padBy);
  const ancestorB = paddedRect(entryB, padBy);
  if (!ancestorA || !ancestorB) return { kind: 'skip' };
  const candidate = union(ancestorA, ancestorB);
  if (candidate.h > maxHeight || candidate.w > Math.min(pngA.width, pngB.width)) return { kind: 'fallback' };
  return candidate.w > leaf.w || candidate.h > leaf.h ? { kind: 'use', box: candidate } : { kind: 'skip' };
}

function sharedContentAncestor(
  mapA: StyleMap,
  mapB: StyleMap,
  pathKey: string,
  leaf: Box,
  padBy: number,
  maxHeight: number,
  pngA: PNG,
  pngB: PNG,
): Box | null {
  let ancestorPath = pathKey;
  while (ancestorPath.includes(' > ')) {
    ancestorPath = ancestorPath.slice(0, ancestorPath.lastIndexOf(' > '));
    const decision = contentAncestorDecision(
      mapA.elements[ancestorPath],
      mapB.elements[ancestorPath],
      leaf,
      padBy,
      maxHeight,
      pngA,
      pngB,
    );
    if (decision.kind === 'fallback') return null;
    if (decision.kind === 'use') return decision.box;
  }
  return null;
}

function contentBox(
  mapA: StyleMap,
  mapB: StyleMap,
  p: string,
  padBy: number,
  maxHeight: number,
  pngA: PNG,
  pngB: PNG,
): Box | null {
  const ba = paddedRect(mapA.elements[p], padBy);
  const bb = paddedRect(mapB.elements[p], padBy);
  const leaf = ba && bb ? union(ba, bb) : (bb ?? ba);
  if (!leaf) return null;
  return sharedContentAncestor(mapA, mapB, p, leaf, padBy, maxHeight, pngA, pngB) ?? leaf;
}

/** before|after crop lines for one content change, or [] when there's no box or
 *  no screenshots. Writes the composite PNG as a side effect. */
function contentCropLines(
  ctx: ContentCtx,
  surface: string,
  c: ContentChange,
  mapA: StyleMap,
  mapB: StyleMap,
  pngA: PNG | null,
  pngB: PNG | null,
  seq: number,
): string[] {
  if (!pngA || !pngB) return [];
  const box = contentBox(mapA, mapB, c.path, ctx.padBy, ctx.maxHeight, pngA, pngB);
  if (!box) return [];
  const w = Math.max(ctx.minWidth, box.w);
  const h = Math.min(ctx.maxHeight, Math.max(ctx.minHeight, box.h));
  const beforeCrop = cropPng(pngA, box, w, h);
  const afterCrop = cropPng(pngB, box, w, h);
  // A structural change whose location renders identically on both sides (an
  // element inside a collapsed <details>, for example) has no visual evidence —
  // presenting the same pixels twice as before/after proof reads as a broken
  // report, so name the absence instead. A consumer report repeated one such
  // identical pair 420 times.
  if (beforeCrop.png.data.equals(afterCrop.png.data)) {
    return ['', NO_CONTENT_PIXEL_DIFFERENCE_NOTE];
  }
  const stem = `crops/${surface.replace(/[^a-z0-9-]/gi, '-')}-content-${seq}`;
  writePng(path.join(ctx.outDir, `${stem}-composite.png`), compositePair(beforeCrop.png, afterCrop.png));

  const rectA = c.kind === 'structure' && c.change === 'added' ? undefined : mapA.elements[c.path]?.rect;
  const rectB = c.kind === 'structure' && c.change === 'removed' ? undefined : mapB.elements[c.path]?.rect;
  const rectsA = rectA ? [rectA] : [];
  const rectsB = rectB ? [rectB] : [];
  const annotatedBefore = annotateCrop(beforeCrop, rectsA);
  const annotatedAfter = annotateCrop(afterCrop, rectsB);
  const lines = [
    '',
    `![before ◀ │ ▶ after](${ctx.img(`${stem}-composite.png`)})`,
    '',
    `<sub>◀ before  ·  after ▶ — ${surface}</sub>`,
  ];
  if (annotatedBefore.highlighted || annotatedAfter.highlighted) {
    writePng(path.join(ctx.outDir, `${stem}-annotated.png`), compositePair(annotatedBefore.png, annotatedAfter.png));
    lines.push(
      '',
      `![highlighted before ◀ │ ▶ after](${ctx.img(`${stem}-annotated.png`)})`,
      '',
      '<sub>🔍 magenta boxes mark the changed content</sub>',
    );
  }

  const changed = unionRects([...rectsA, ...rectsB]);
  const maxDim = changed ? Math.max(changed.w, changed.h) : 0;
  if (ctx.zoomBelow > 0 && changed && maxDim > 0 && maxDim <= ctx.zoomBelow) {
    const zoomBox = pad(changed, Math.max(maxDim, 16));
    const zoomFactor = Math.min(8, Math.max(2, Math.round(240 / Math.max(zoomBox.w, zoomBox.h))));
    writePng(
      path.join(ctx.outDir, `${stem}-zoom.png`),
      compositePair(zoomCrop(pngA, zoomBox, rectsA, zoomFactor), zoomCrop(pngB, zoomBox, rectsB, zoomFactor)),
    );
    lines.push(
      '',
      `![zoomed before ◀ │ ▶ after](${ctx.img(`${stem}-zoom.png`)})`,
      '',
      `<sub>🔬 magnified ${zoomFactor}×: content change too small to read at 1:1</sub>`,
    );
  }
  return lines;
}

/** One surface's content block: heading, then per content/structure change
 *  and its crop. Returns the markdown plus the advanced crop counter. */
function renderContentSurface(
  ctx: ContentCtx,
  surface: string,
  changes: ContentChange[],
  seq: number,
): { md: string[]; seq: number } {
  const mapA = loadStyleMap(findCapture(ctx.beforeDir, surface));
  const mapB = loadStyleMap(findCapture(ctx.afterDir, surface));
  const pngA = readPng(path.join(ctx.beforeDir, `${surface}.png`));
  const pngB = readPng(path.join(ctx.afterDir, `${surface}.png`));
  const md: string[] = ['', `### \`${safeKey(surface)}\` · ${changes.length} content/structure change(s)`];
  for (const c of changes) {
    seq++;
    const changeLines =
      c.kind === 'text'
        ? [`- before: \`${clipText(c.before) || '(empty)'}\``, `- after: \`${clipText(c.after) || '(empty)'}\``]
        : [`- ${c.change === 'retagged' ? `element retagged: \`${c.detail}\`` : `element ${c.change}`}`];
    md.push(
      '',
      `**\`${prettyLabel(c.path, c.cls)}\`**`,
      '',
      ...changeLines,
      ...contentCropLines(ctx, surface, c, mapA, mapB, pngA, pngB, seq),
    );
  }
  return { md, seq };
}

/**
 * The opt-in content layer, rendered as its own ADVISORY section. Reuses the
 * style report's crop/composite machinery so every copy change gets a
 * before/after screenshot — the whole point being to make a silent text change,
 * and any overflow or clipping it triggers, visible in review. Returns the
 * markdown plus a count; the caller keeps both out of the gate (counts/exit live
 * on the computed-style path).
 */
function renderContentSection(ctx: ContentCtx): { md: string[]; count: number } {
  const { surfaces, count } = diffContentDirs(ctx.beforeDir, ctx.afterDir);
  if (!count) return { md: [], count: 0 };
  const md: string[] = [
    '',
    '---',
    '',
    '## 📝 Content and structure changes (advisory)',
    '',
    `_${count} content/structure change(s). **Advisory only** — content and DOM structure are not part of the ` +
      `computed-style certification and do not affect the check. Surfaced so copy, element, and reflow changes are ` +
      `visible when content comparison is enabled._`,
  ];
  let seq = 0;
  for (const { surface, changes } of surfaces) {
    const out = renderContentSurface(ctx, surface, changes, seq);
    md.push(...out.md);
    seq = out.seq;
  }
  return { md, count };
}

// ── Certification renderers ──────────────────────────────────────────────────────
// Each maps one source-of-truth verdict to its report line. Kept as separate one-
// verdict functions so certificationLines stays a thin orchestrator (and each stays
// well under the complexity gate).

function coverageLine(cov: CoverageVerdict, exclusionCount = 0): string {
  if (cov.basis === 'complete') {
    if (exclusionCount > 0) {
      const capturedCount = Math.max(0, (cov.registrySize ?? 0) - exclusionCount);
      return `- **Coverage** — ✓ complete (${capturedCount} of ${cov.registrySize} registered surface(s) captured; ${exclusionCount} explicitly excluded)`;
    }
    return `- **Coverage** — ✓ complete (all ${cov.registrySize} registered surface(s) captured)`;
  }
  if (cov.basis === 'incomplete')
    return `- **Coverage** — ✗ INCOMPLETE (${cov.uncovered.length} registered surface(s) not captured: ${cov.uncovered.map(safeKey).join(', ')})`;
  return '- **Coverage** — ⚠ not asserted (no `expected` registry; certifies only the captured surfaces)';
}

function explicitExclusionCount(ledger: CoverageLedger | null): number {
  if (ledger?.expected == null) return 0;
  const expected = new Set(ledger.expected);
  return new Set(Object.keys(ledger.exclude).filter((key) => expected.has(key))).size;
}

function determinismLine(det: DeterminismVerdict): string {
  if (det.status === 'proven') return `- **Determinism** — ✓ proven (base ${det.base}, head ${det.head})`;
  if (det.status === 'unproven')
    return `- **Determinism** — ✗ NOT proven (base ${det.base}, head ${det.head}) — a clean diff could be two nondeterministic reads`;
  return '- **Determinism** — ⚠ unknown (a capture predates the determinism ledger)';
}

// Truncated, escaped, comma-joined key list — the same discipline for removals and
// additions, so neither can inject Markdown into the privileged PR-comment summary.
function keyList(items: { key: string }[]): string {
  const keys = items.map((i) => safeKey(i.key));
  return `${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}`;
}

// Additions never gate, but the report must not contradict the diff (which prints
// them) — so echo them as an informational, still-✓-class clause. Returns a leading
// `; …` fragment to append after whatever the removal side decided, or '' when none.
function additionsClause(added: { key: string }[]): string {
  if (added.length === 0) return '';
  return `; ${added.length} navigable affordance(s) added: ${keyList(added)} (additions don't gate)`;
}

function inventoryLine(inv: ReturnType<typeof auditRunInventory>): string {
  const added = additionsClause(inv.delta.added);
  if (inv.unexplained.length > 0)
    return `- **Inventory** — ⚠ ${inv.unexplained.length} navigable affordance(s) removed, unacknowledged: ${keyList(inv.unexplained)}${added}`;
  if (inv.delta.removed.length > 0)
    return `- **Inventory** — ✓ ${inv.delta.removed.length} removal(s), all acknowledged${added}`;
  // Addition-only: drop the leading `; ` so the clause reads as the whole ✓ line.
  if (added) return `- **Inventory** — ✓${added.slice(1)}`;
  return '- **Inventory** — ✓ navigable set unchanged';
}

// Acknowledged removals for the report — lenient: a missing OR malformed ack file
// just means no acknowledgements. (The diff CLI fails loud on malformed instead,
// because in CI an unreadable ack file must not silently un-acknowledge a real loss;
// the report is advisory, so it degrades quietly.)
function readAcknowledgedRemovals(): Record<string, string> {
  try {
    return readAckFile();
  } catch {
    return {};
  }
}

// Lenient acknowledged-residue read — same advisory degradation as the inventory one.
function readAcknowledgedResidue(): Record<string, string> {
  try {
    return readResidueAckFile();
  } catch {
    return {};
  }
}

function describeFailedDataRequests(entries: { surface: string; endpoint: string; reason: string }[]): string {
  return entries.map((entry) => `${entry.surface} called \`${entry.endpoint}\` (${entry.reason})`).join('; ');
}

// A failed data request captured the fallback UI, so the real data state is unproven.
function dataResidueLine(res: ReturnType<typeof auditRunResidue>): string {
  const { residue, unacknowledged, staleAcknowledgements, armed } = res;
  const meaning = 'this page called an API that failed, so the screenshot is the fallback UI, not the real data';
  if (armed && (unacknowledged.length > 0 || staleAcknowledgements.length > 0)) {
    const fail = unacknowledged.length
      ? `${describeFailedDataRequests(unacknowledged)}. Fixture the API, or declare why the fallback is the intended capture.`
      : '';
    const stale = staleAcknowledgements.length
      ? ` ${staleAcknowledgements.length} declared failure(s) no longer happen; remove them from styleproof.data-residue.json.`
      : '';
    return `- **Failed data request**: ✗ ${meaning}. ${fail}${stale}`;
  }
  if (unacknowledged.length > 0) {
    return `- **Failed data request**: ⚠ ${meaning}. ${describeFailedDataRequests(unacknowledged)} (recorded, not gating: dataResidue warn opt-out)`;
  }
  if (residue.length > 0) {
    return `- **Failed data request**: ✓ ${residue.length} failed API call(s), all declared as intended fallbacks`;
  }
  return `- **Failed data request**: ✓ no API failed during capture`;
}

// One confidence clause (#399): the completeness badge, always separate from the
// visual verdict in the headline — never one green. Counts only, no percentages;
// a bundle from before the ledger existed reads ⚠ unknown and never blocks.
function confidenceLine(
  ledger: ConfidenceLedgerFile | null,
  summary: ConfidenceSummary,
  confidenceSidecarPresent = false,
): string {
  const { counts, completeness } = summary;
  if (completeness === 'unknown') {
    const reason = confidenceSidecarPresent
      ? 'confidence sidecar is missing or malformed; not blocking retroactively'
      : 'capture predates the confidence ledger; not blocking retroactively';
    return `- **Confidence** — ⚠ unknown (${reason})`;
  }
  const parts = [
    `${counts.captured} captured`,
    ...(counts['excluded-with-reason'] ? [`${counts['excluded-with-reason']} excluded-with-reason`] : []),
    ...(counts.inaccessible ? [`${counts.inaccessible} inaccessible`] : []),
    ...(counts.unknown ? [`${counts.unknown} unknown`] : []),
    ...(counts['unproven-determinism'] ? [`${counts['unproven-determinism']} unproven-determinism`] : []),
  ].join(', ');
  if (completeness === 'complete') return `- **Confidence** — ✓ complete (${parts})`;
  if (completeness === 'unasserted')
    return `- **Confidence** — ⚠ unasserted (no \`expected\` registry — certifies only the ${counts.captured} captured surface(s), not that they are all of them)`;
  const inaccessible = (ledger?.entries ?? []).filter((e) => e.status === 'inaccessible');
  const named = inaccessible.length ? `; inaccessible: ${keyList(inaccessible.map((e) => ({ key: e.surface })))}` : '';
  const blockerDetails = inaccessible
    .slice(0, 8)
    .map(
      (entry) =>
        `  - \`${safeKey(entry.surface)}\`: ${escapeMarkdownFailureReason(entry.reason ?? 'blocked continuation reason unavailable')}`,
    );
  const incompleteUiPresent = inaccessible.some((entry) => entry.producer === 'incomplete-ui');
  const guidance = incompleteUiPresent
    ? [
        '  - **Next:** fixture the blocked state to increase the certified area, or exclude the surface with a non-empty reason when it is intentionally outside scope.',
      ]
    : [];
  const details = [...blockerDetails, ...guidance];
  return `- **Confidence** — ⚠ limited (${parts})${named}${details.length ? `\n${details.join('\n')}` : ''}`;
}

/**
 * The certification block a reviewer reads FIRST — the source-of-truth gates (coverage
 * complete? determinism proven? did the navigable set shrink? how complete was the
 * capture?), not just the pixel diff. Empty when the bundle carries no certification
 * metadata (an old capture).
 */
function certificationLines(
  beforeDir: string,
  afterDir: string,
  confidence: { ledger: ConfidenceLedgerFile | null; summary: ConfidenceSummary },
): string[] {
  // Lenient reads (advisory renderer): missing or corrupt sidecars degrade to null.
  const baseLedger = readCoverageLedgerLenient(beforeDir);
  const headLedger = readCoverageLedgerLenient(afterDir);
  const inv = auditRunInventory(readInventories(beforeDir), readInventories(afterDir), readAcknowledgedRemovals());
  const res = auditRunResidue(readResidue(afterDir), readAcknowledgedResidue(), headLedger?.dataResidue === 'gate');

  const hasLedger = baseLedger !== null || headLedger !== null || confidence.ledger !== null;
  const confidenceSidecarPresent = fs.existsSync(path.join(afterDir, CONFIDENCE_LEDGER));
  const hasConfidence = hasLedger || confidenceSidecarPresent;
  const hasInvChange = inv.delta.removed.length > 0 || inv.delta.added.length > 0;
  const hasResidue = res.residue.length > 0 || res.armed;
  if (!hasConfidence && !hasInvChange && !hasResidue) return [];

  return [
    '**Certification**',
    coverageLine(
      auditCoverage(bundleSurfaceKeys(afterDir, headLedger?.expected ?? null), headLedger),
      explicitExclusionCount(headLedger),
    ),
    determinismLine(auditDeterminism(baseLedger, headLedger)),
    inventoryLine(inv),
    // Only add the residue line when there's residue or the gate was armed — an ordinary
    // bundle (no failing endpoint, not armed) keeps its exact prior 3-line block.
    ...(hasResidue ? [dataResidueLine(res)] : []),
    confidenceLine(confidence.ledger, confidence.summary, confidenceSidecarPresent),
    '',
  ];
}

/** A commit label safe to embed in the privileged PR-comment markdown: the sidecar
 *  is a plain JSON file on disk, so hex-filter rather than trust its spelling. */
function safeShaLabel(sha: string | undefined): string {
  const hex = (sha ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 12);
  return hex || 'unknown';
}

/**
 * Where the BASELINE maps came from, when the run recorded it (#367: reuse must
 * never be silent). Empty without a provenance sidecar, so default runs keep
 * their exact prior report bytes; with one, names exact-SHA restore, nearest-
 * ancestor reuse (with the changed-path-count proof), or a fresh capture.
 */
function baselineProvenanceLines(provenance: BaselineProvenance | null): string[] {
  if (!provenance) return [];
  if (provenance.baseline === 'ancestor-reuse') {
    return [
      `**Baseline** — ♻ restored from nearest ancestor \`${safeShaLabel(provenance.restoredSha)}\` of base ` +
        `\`${safeShaLabel(provenance.requestedSha)}\` (${provenance.changedPathCount ?? 0} path(s) changed between ` +
        `them, none capture-relevant)`,
      '',
    ];
  }
  if (provenance.baseline === 'exact-restore') {
    return [`**Baseline** — ✓ restored from the exact base commit \`${safeShaLabel(provenance.requestedSha)}\``, ''];
  }
  return [`**Baseline** — ✓ captured fresh at base commit \`${safeShaLabel(provenance.requestedSha)}\``, ''];
}

// A prepared surface: its diff plus the findings kept after noise-cleaning.
type PreparedSurface = { sd: SurfaceDiff; findings: Finding[] };
// Surfaces that changed the SAME way, collapsed to one group with a representative.
type ChangeGroup = { surfaces: string[]; rep: PreparedSurface; findings: Finding[] };
// The dirs/dimensions threaded through the per-surface render helpers, so each takes
// one ctx instead of a dozen positional args.
type RenderCtx = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  img: (rel: string) => string;
  padBy: number;
  minWidth: number;
  minHeight: number;
  maxHeight: number;
  zoomBelow: number;
  foldDetailsAt: number;
};

/** A changed element can anchor useful visual proof only when the captured page can show it. */
function isPaintedEntry(map: StyleMap, entry: ElementEntry | undefined): boolean {
  if (!entry?.rect || !visible(rectToBox(entry.rect))) return false;
  if (entry.style.display === 'none' || entry.style.visibility === 'hidden') return false;
  if (Number(entry.style.opacity ?? '1') <= 0) return false;
  const [x, y, width, height] = entry.rect;
  if (x + width <= 0 || y + height <= 0) return false;
  return map.viewport?.width === undefined || x < map.viewport.width;
}

function isSameOrDescendantPath(candidatePath: string, ancestorPath: string): boolean {
  return candidatePath === ancestorPath || candidatePath.startsWith(`${ancestorPath} > `);
}

/** A modal leaves its background in the DOM but makes it unsuitable as visual proof.
 * A change inside the modal itself is foreground content and remains eligible. */
function isBackgroundBehindActiveModal(map: StyleMap, changedPath: string): boolean {
  return (map.overlays ?? []).some(
    (overlay) => overlay.ariaModal === 'true' && !isSameOrDescendantPath(changedPath, overlay.path),
  );
}

function isExposedChangedEntry(map: StyleMap, changedPath: string): boolean {
  return isPaintedEntry(map, map.elements[changedPath]) && !isBackgroundBehindActiveModal(map, changedPath);
}

function hasExposedChangedEntry(mapA: StyleMap, mapB: StyleMap, changedPaths: string[]): boolean {
  return changedPaths.some(
    (changedPath) => isExposedChangedEntry(mapA, changedPath) || isExposedChangedEntry(mapB, changedPath),
  );
}

type RepresentativeScore = { hasExposedChange: boolean; hasActiveModal: boolean; isPopup: boolean; width: number };

const MISLEADING_CROP_REASON =
  'The changed element is not visible in the captured page (it is outside the screenshot canvas, hidden at this breakpoint, or background content behind an active modal), so a before/after crop would be misleading.';

const NO_CONTENT_PIXEL_DIFFERENCE_NOTE =
  "_This element's location renders identically before and after (the change has no visible effect in the captured state), so there is no before/after crop to show._";

/** Prefer proof a reviewer can see: an exposed changed element, then a non-modal
 * ordinary page over a popup state that can leave shared chrome in the background,
 * then the widest width. */
function representativeScore(candidate: PreparedSurface, beforeDir: string, afterDir: string): RepresentativeScore {
  const rawBefore = loadStyleMap(findCapture(beforeDir, candidate.sd.surface));
  const afterMap = loadStyleMap(findCapture(afterDir, candidate.sd.surface));
  // Presentation findings may sit on corresponded head paths — score against the
  // remapped before map so those paths resolve on both sides.
  const beforeMap = presentationBeforeMap(rawBefore, afterMap);
  const changedPaths = [...new Set(candidate.findings.map((finding) => finding.path))];
  const hasExposedChange = hasExposedChangedEntry(beforeMap, afterMap, changedPaths);
  const hasActiveModal = [...(beforeMap.overlays ?? []), ...(afterMap.overlays ?? [])].some(
    (overlay) => overlay.ariaModal === 'true',
  );
  const isPopup = beforeMap.metadata?.variantKind === 'popup' || afterMap.metadata?.variantKind === 'popup';
  return { hasExposedChange, hasActiveModal, isPopup, width: surfaceWidth(candidate.sd.surface) };
}

function isBetterRepresentative(candidate: RepresentativeScore, current: RepresentativeScore): boolean {
  if (candidate.hasExposedChange !== current.hasExposedChange) return candidate.hasExposedChange;
  if (candidate.hasActiveModal !== current.hasActiveModal) return !candidate.hasActiveModal;
  if (candidate.isPopup !== current.isPopup) return !candidate.isPopup;
  return candidate.width > current.width;
}

// Group surfaces that changed in the SAME way (the rects differ per width; the change
// itself does not) so an identical change shows once, not once per surface. Select
// the representative by visible proof first; width only breaks otherwise-equal ties.
function groupBySignature(prepared: PreparedSurface[], beforeDir: string, afterDir: string): ChangeGroup[] {
  const bySig = new Map<string, ChangeGroup>();
  const scoreBySurface = new Map<string, RepresentativeScore>();
  const score = (candidate: PreparedSurface): RepresentativeScore => {
    const existing = scoreBySurface.get(candidate.sd.surface);
    if (existing) return existing;
    const computed = representativeScore(candidate, beforeDir, afterDir);
    scoreBySurface.set(candidate.sd.surface, computed);
    return computed;
  };
  for (const p of prepared) {
    if (p.sd.missing) continue;
    const sig = signatureOf(p.findings);
    const existing = bySig.get(sig);
    if (existing) {
      existing.surfaces.push(p.sd.surface);
      if (isBetterRepresentative(score(p), score(existing.rep))) existing.rep = p;
    } else {
      bySig.set(sig, { surfaces: [p.sd.surface], rep: p, findings: p.findings });
    }
  }
  return [...bySig.values()];
}

// Counts reflect the GROUPED view: each distinct change counts once, not once per
// surface it appears on (after shorthand/dedupe collapsing). Style/state tallies
// are matched-path restyles only — props on a one-sided added/removed path are
// head- or base-side inventories and already covered by the DOM count; billing
// them as "computed-style difference(s)" mislabels path churn as restyles.
function countShownChanges(changeGroups: ChangeGroup[]): DiffCounts {
  const shown: DiffCounts = { dom: 0, style: 0, state: 0 };
  for (const cg of changeGroups) {
    const oneSided = oneSidedDomPaths(cg.findings);
    for (const f of cg.findings) {
      if (f.kind === 'dom') shown.dom++;
      else if (oneSided.has(f.path)) continue;
      else if (f.kind === 'style') shown.style += summarizeProps(f.props).length;
      else shown.state += summarizeProps(f.props).length;
    }
  }
  return shown;
}

// The identical / changed / new-surface summary line(s). Split out (with an early
// return for the all-identical case) so reportHeadline stays flat.
function newSurfaceSummary(missing: PreparedSurface[], maxNamed = 8): string {
  const bases = [...new Set(missing.map((p) => surfaceBase(p.sd.surface)))].sort();
  const shownBases = new Set(bases.slice(0, maxNamed));
  const shownSurfaces = missing.map((p) => p.sd.surface).filter((surface) => shownBases.has(surfaceBase(surface)));
  const more = bases.length > maxNamed ? `, +${bases.length - maxNamed} more` : '';
  return '`' + formatSurfaceList(shownSurfaces) + '`' + more;
}

/** One-line glossary so headline base vs variant counts read consistently with the chrome banner. */
const SURFACE_SCOPE_GLOSSARY =
  '_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._';

function baselineFailureSummaryLines(failures: SurfaceCaptureFailure[]): string[] {
  if (failures.length === 0) return [];
  const md = [
    `⚠️ **${failures.length} baseline capture failure(s)** — these surfaces failed on the **base branch** and were omitted from the baseline bundle. **Repair base capture** on the base branch; do not approve indefinitely as if they were greenfield new surfaces. Failure details remain in the local capture manifest and are not echoed from untrusted artifacts.`,
    '',
  ];
  return md;
}

function missingSurfaceSummaryLines(
  missing: PreparedSurface[],
  greenfieldMissing: PreparedSurface[],
  brokenBaseMissing: PreparedSurface[],
): string[] {
  const md: string[] = [];
  // A surface captured only on BASE is a REMOVAL — a feature going invisible —
  // never a "new surface" for the approval box to welcome in.
  const removed = missing.filter((p) => p.sd.missing === 'after');
  if (removed.length > 0) {
    md.push(
      `🗑️ **${removed.length} REMOVED surface(s)** — present in the baseline, not captured on head: ${newSurfaceSummary(removed)}. ` +
        `Review as removals; approving accepts the disappearance.`,
      '',
    );
  }
  if (brokenBaseMissing.length > 0) {
    md.push(
      `⚠️ **${brokenBaseMissing.length} head surface(s)** have no base map because baseline capture failed (not first adoption): ${newSurfaceSummary(brokenBaseMissing)}.`,
      '',
    );
  }
  if (greenfieldMissing.length > 0) {
    md.push(
      `🆕 **${greenfieldMissing.length} new surface(s)** captured with no baseline to compare: ${newSurfaceSummary(greenfieldMissing)}. ` +
        `Approve them before they become the baseline.`,
    );
  }
  return md;
}

function comparabilityLines(comparison: ComparabilitySummary): string[] {
  const counts = comparison.counts;
  if (comparison.status === 'comparable') {
    return [
      `**Product-state comparison** — ✓ comparable on ${counts.comparable} paired capture(s) using explicit consumer-owned identity.`,
      '',
    ];
  }
  if (comparison.status === 'not-required') {
    return ['**Product-state comparison** — not required; there are no paired capture obligations.', ''];
  }
  if (!comparison.blocksCertification) {
    return [
      `⚠️ **Product-state comparison** — unproven on ${counts.unproven} undeclared legacy pair(s). Legacy compatibility preserves the existing visual-review path, but this is not proof that both captures reached the same product state.`,
      '',
    ];
  }
  const reasons = [
    counts.incomparable ? `${counts.incomparable} incomparable` : '',
    counts.requiredUnproven ? `${counts.requiredUnproven} required-unproven` : '',
    counts.globalRequiredUnproven ? `${counts.globalRequiredUnproven} globally required-unproven` : '',
  ].filter(Boolean);
  return [
    `⛔ **Product-state comparison** — ${comparison.status}; ${reasons.join(', ')} paired capture(s). Raw detector evidence is diagnostic only, is not approval evidence, and cannot certify this comparison.`,
    '',
  ];
}

function changedSurfaceSummaryLines(
  changeGroups: ChangeGroup[],
  shown: DiffCounts,
  changedScope: { bases: number; variants: number },
  prependSeparator: boolean,
): string[] {
  if (changeGroups.length === 0) return [];
  return [
    ...(prependSeparator ? [''] : []),
    `**${changeCountLabel(shown)}** across ${changeGroups.length} distinct change(s) in ${formatChangedSurfaceScope(changedScope.bases, changedScope.variants)} with an existing baseline.`,
    SURFACE_SCOPE_GLOSSARY,
  ];
}

function reportConsistencyFailureSummaryLines(
  reportConsistency: ReportConsistency,
  rawCounts: DiffCounts | undefined,
  baselineSurfaceFailures: SurfaceCaptureFailure[],
): string[] | undefined {
  if (reportConsistency.ok || !rawCounts) return undefined;

  const explanation =
    reportConsistency.reason === 'raw_only_no_reviewable'
      ? 'every delta is a derived/reflow longhand the visual report strips — **no reviewable crops or change sections**.'
      : 'report-only path correspondence collapsed every presentation finding — **no reviewable crops or change sections remain**.';
  const remediation =
    reportConsistency.reason === 'raw_only_no_reviewable'
      ? '_This is **not** a clean no-change and **not** a visual-approval gate. Fail closed (`CERTIFICATION_FAILED`): fix the reflow source, or re-run with `--include-layout-noise` to inspect the raw longhands._'
      : '_This is **not** a clean no-change and cannot be approved visually. Fail closed (`CERTIFICATION_FAILED`): inspect the raw path churn or tighten the correspondence signal before trusting this comparison._';
  const md = [
    `⚠ **Report consistency failure:** the certification differ found **${rawCounts.dom} DOM**, **${rawCounts.style} computed-style**, and **${rawCounts.state} state** difference(s), but ${explanation}`,
    '',
    remediation,
  ];
  if (baselineSurfaceFailures.length > 0) {
    md.push('', ...baselineFailureSummaryLines(baselineSurfaceFailures));
  }
  return md;
}

function summaryLines(args: {
  changeGroups: ChangeGroup[];
  missing: PreparedSurface[];
  shown: DiffCounts;
  changedScope: { bases: number; variants: number };
  contentCount: number;
  contentEvaluated: boolean;
  /** Any raw-vs-presentation contradiction: must not claim "identical". */
  reportConsistency: ReportConsistency;
  rawCounts?: DiffCounts;
  baselineSurfaceFailures: SurfaceCaptureFailure[];
  confidenceBlocked: boolean;
  comparisonBlocked: boolean;
}): string[] {
  const {
    changeGroups,
    missing,
    shown,
    changedScope,
    contentCount,
    contentEvaluated,
    reportConsistency,
    rawCounts,
    baselineSurfaceFailures,
    confidenceBlocked,
    comparisonBlocked,
  } = args;
  // Greenfield/broken-base classification applies to surfaces missing a BASE map
  // (missing 'before'); a surface missing on HEAD is a removal, handled separately.
  const missingOnBase = missing.filter((p) => p.sd.missing === 'before');
  const greenfieldMissing = missingOnBase.filter(
    (p) => !surfaceMissingMatchesBaselineFailure(p.sd.surface, baselineSurfaceFailures),
  );
  const brokenBaseMissing = missingOnBase.filter((p) =>
    surfaceMissingMatchesBaselineFailure(p.sd.surface, baselineSurfaceFailures),
  );
  if (changeGroups.length === 0 && missing.length === 0) {
    const failureSummary = reportConsistencyFailureSummaryLines(reportConsistency, rawCounts, baselineSurfaceFailures);
    if (failureSummary) return failureSummary;
    if (baselineSurfaceFailures.length === 0) {
      const scopedSummary = contentEvaluated
        ? contentCount > 0
          ? `✓ No reviewable computed-style changes among semantically matched elements. See ${contentCount} advisory content/structure change(s) below.`
          : '✓ No reviewable computed-style changes among semantically matched elements. No advisory content/structure changes detected.'
        : '✓ No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.';
      return [
        confidenceBlocked || comparisonBlocked
          ? scopedSummary.replace(/^✓ /, 'Computed-style scope only: ')
          : scopedSummary,
      ];
    }
  }
  const md = [
    ...baselineFailureSummaryLines(baselineSurfaceFailures),
    ...missingSurfaceSummaryLines(missing, greenfieldMissing, brokenBaseMissing),
  ];
  md.push(...changedSurfaceSummaryLines(changeGroups, shown, changedScope, md.length > 0));
  return md;
}

// The headline summary lines between the certification block and the per-surface
// detail: identical-vs-changed, new-surface count, live-region note, advisory-content
// note. Extracted so generateStyleMapReport stays orchestration, not prose.
function reportHeadline(args: {
  changeGroups: ChangeGroup[];
  missing: PreparedSurface[];
  shown: DiffCounts;
  changedScope: { bases: number; variants: number };
  volatileCount: number;
  liveCandidateLabels: string[];
  contentCount: number;
  contentEvaluated: boolean;
  reportConsistency: ReportConsistency;
  rawCounts?: DiffCounts;
  baselineSurfaceFailures: SurfaceCaptureFailure[];
  confidenceBlocked: boolean;
  comparisonBlocked: boolean;
}): string[] {
  const {
    changeGroups,
    missing,
    shown,
    changedScope,
    volatileCount,
    liveCandidateLabels,
    contentCount,
    contentEvaluated,
    reportConsistency,
    rawCounts,
    baselineSurfaceFailures,
    confidenceBlocked,
    comparisonBlocked,
  } = args;
  const md: string[] = summaryLines({
    changeGroups,
    missing,
    shown,
    changedScope,
    contentCount,
    contentEvaluated,
    reportConsistency,
    rawCounts,
    baselineSurfaceFailures,
    confidenceBlocked,
    comparisonBlocked,
  });
  if (volatileCount > 0) {
    const candidates = liveCandidateLabels.length
      ? ` Auto-detected live-state candidate(s): ${liveCandidateLabels.slice(0, 5).join('; ')}.`
      : '';
    md.push(
      '',
      `_${volatileCount} live region(s) auto-excluded as nondeterministic (a stream, ticker, or late-loading content) — changes inside them are NOT certified by this check.${candidates}_`,
    );
  }
  if (contentCount > 0 && (changeGroups.length > 0 || missing.length > 0)) {
    md.push('', `📝 _${contentCount} advisory content change(s) below — they don't affect the check._`);
  }
  return md;
}

// Collapse many crops into one merged frame when a change scatters across more regions
// than maxCrops would show — the union of all their boxes on each side.
function collapseGroups(groups: Group[]): Group[] {
  return [
    groups.reduce((acc, g) => ({
      paths: [...acc.paths, ...g.paths],
      before: visible(acc.before) && visible(g.before) ? union(acc.before, g.before) : (acc.before ?? g.before),
      after: visible(acc.after) && visible(g.after) ? union(acc.after, g.after) : (acc.after ?? g.after),
    })),
  ];
}

// Crop, composite, annotate and (for small changes) zoom the before/after pair for one
// region, writing the PNGs and returning the image markdown + the images sidecar. The
// dense pixel work, isolated from renderRegion's prose.
function buildRegionImages(args: {
  g: Group;
  region: Box;
  regionFindings: Finding[];
  sd: SurfaceDiff;
  mapA: StyleMap;
  mapB: StyleMap;
  pngA: PNG;
  pngB: PNG;
  ctx: RenderCtx;
  cropSeq: number;
  pairCaption?: { left: string; right: string; note?: string };
}): { md: string[]; images: { composite?: string; annotated?: string; zoom?: string } } {
  const { g, region, regionFindings, sd, mapA, mapB, pngA, pngB, ctx, cropSeq } = args;
  const { img, outDir, minWidth, minHeight, maxHeight, zoomBelow } = ctx;
  const leftLabel = args.pairCaption?.left ?? 'before';
  const rightLabel = args.pairCaption?.right ?? 'after';
  // Crop the SAME page rectangle from both sides — the union of where the change sits
  // on each side — so the pair lines up exactly and the reviewer compares like-for-like
  // instead of playing spot-the-difference. (Centring each side on its own moved box
  // would shift the background between them.)
  const cropBox = visible(g.before) && visible(g.after) ? union(g.before, g.after) : region;
  const w = Math.max(minWidth, cropBox.w);
  const h = Math.min(maxHeight, Math.max(minHeight, cropBox.h));
  // Path-safe, report-unique stem: `hero@1280` → `hero-1280-3` so relative image links
  // resolve cleanly and two crops never collide on one filename.
  const stem = `crops/${sd.surface.replace(/[^a-z0-9-]/gi, '-')}-${cropSeq}`;
  const before = cropPng(pngA, cropBox, w, h);
  const after = cropPng(pngB, cropBox, w, h);
  const composite = compositePair(before.png, after.png, leftLabel, rightLabel);
  writePng(path.join(outDir, `${stem}-composite.png`), composite);
  // Annotated twin: outline the LEAF changed elements (the added avatars, the restyled
  // cards) on each side — not the merged container the crop anchors on, whose box would
  // just trace the whole frame. An element present on only one side (added/removed) is
  // boxed only there.
  const markedPaths = annotationPaths(regionFindings, mapA, mapB);
  const rectsA = markedPaths.before.map((p) => mapA.elements[p]?.rect).filter((r): r is Rect => !!r);
  const rectsB = markedPaths.after.map((p) => mapB.elements[p]?.rect).filter((r): r is Rect => !!r);
  const annotatedBefore = annotateCrop(before, rectsA);
  const annotatedAfter = annotateCrop(after, rectsB);
  const images: { composite?: string; annotated?: string; zoom?: string } = {
    composite: `${stem}-composite.png`,
  };
  if (annotatedBefore.highlighted || annotatedAfter.highlighted) {
    const annotated = compositePair(annotatedBefore.png, annotatedAfter.png, leftLabel, rightLabel);
    writePng(path.join(outDir, `${stem}-annotated.png`), annotated);
    images.annotated = `${stem}-annotated.png`;
  }

  // Name the changed element(s) so the reviewer knows where to look without expanding
  // anything (e.g. `changed: span.caret`).
  const changedNames = [
    ...new Set(
      [
        ...markedPaths.before.map((elementPath) => mapA.elements[elementPath]),
        ...markedPaths.after.map((elementPath) => mapB.elements[elementPath]),
      ]
        .filter((e): e is ElementEntry => !!e)
        .map((e) => (e.cls ? `${e.tag}.${e.cls.split(/\s+/)[0]}` : e.tag)),
    ),
  ].slice(0, 3);
  const changedLabel = changedNames.length ? ` — changed: \`${changedNames.join('`, `')}\`` : '';
  const ctxLabel = args.pairCaption?.note ?? formatSurfaceWithContext(sd.surface, mapA, mapB);

  // A sub-pixel change (e.g. a 2px font bump on a caret) is invisible at 1:1, so when
  // the changed-element footprint is small, add a magnified crop that makes it obvious
  // without the reviewer hunting. Anchored on the leaf rects.
  const changed = unionRects([...rectsA, ...rectsB]);
  const maxDim = changed ? Math.max(changed.w, changed.h) : 0;
  let zoomFactor = 0;
  if (zoomBelow > 0 && changed && maxDim > 0 && maxDim <= zoomBelow) {
    const zBox = pad(changed, Math.max(maxDim, 16)); // ~3× the change for context
    zoomFactor = Math.min(8, Math.max(2, Math.round(240 / Math.max(zBox.w, zBox.h))));
    const zoom = compositePair(
      zoomCrop(pngA, zBox, rectsA, zoomFactor),
      zoomCrop(pngB, zBox, rectsB, zoomFactor),
      leftLabel,
      rightLabel,
    );
    writePng(path.join(outDir, `${stem}-zoom.png`), zoom);
    images.zoom = `${stem}-zoom.png`;
  }

  // Both views shown by default: the clean before|after (the real UI) and the
  // highlighted twin (magenta boxes on each change) so a reviewer sees WHAT changed and
  // WHERE without expanding anything. Plain images (no link wrap) so a click opens the
  // full-resolution file.
  const md = [
    '',
    `![${leftLabel} ◀ │ ▶ ${rightLabel}](${img(images.composite!)})`,
    '',
    `<sub>◀ ${leftLabel}  ·  ${rightLabel} ▶ — ${ctxLabel}</sub>`,
  ];
  if (images.annotated) {
    md.push(
      '',
      `![highlighted ${leftLabel} ◀ │ ▶ ${rightLabel}](${img(images.annotated)})`,
      '',
      `<sub>🔍 magenta boxes mark each change${changedLabel}</sub>`,
    );
  }
  if (images.zoom) {
    md.push(
      '',
      `![zoomed ${leftLabel} ◀ │ ▶ ${rightLabel}](${img(images.zoom)})`,
      '',
      `<sub>🔬 magnified ${zoomFactor}× — change too small to see at 1:1${changedLabel}</sub>`,
    );
  }
  return { md, images };
}

type CropPack = {
  md: string[];
  images: { composite?: string; annotated?: string; zoom?: string };
  cropSeq: number;
  visualEvidence?: 'not-rendered';
  reason?: string;
};

function cropNote(region: Box | null, pngA: PNG | null, pngB: PNG | null): string | undefined {
  if (!region) return '_Changed element is not visible in this state (zero-size box) — see the property list._';
  if (pngA && pngB) return `_${MISLEADING_CROP_REASON}_`;
  return '_No screenshots in these capture sets (run captures with `screenshots: true` for side-by-side crops)._';
}

function appendCrop(args: {
  g: Group;
  region: Box | null;
  regionFindings: Finding[];
  sd: SurfaceDiff;
  mapA: StyleMap;
  mapB: StyleMap;
  pngA: PNG | null;
  pngB: PNG | null;
  ctx: RenderCtx;
  cropSeq: number;
  pairCaption?: { left: string; right: string; note?: string };
}): CropPack {
  const { g, region, regionFindings, sd, mapA, mapB, pngA, pngB, ctx } = args;
  let cropSeq = args.cropSeq;
  if (region && pngA && pngB && hasExposedChangedEntry(mapA, mapB, g.paths)) {
    cropSeq++;
    const built = buildRegionImages({
      g,
      region,
      regionFindings,
      sd,
      mapA,
      mapB,
      pngA,
      pngB,
      ctx,
      cropSeq,
      pairCaption: args.pairCaption,
    });
    return { md: built.md, images: built.images, cropSeq };
  }
  const note = cropNote(region, pngA, pngB);
  return {
    md: note ? ['', note] : [],
    images: {},
    cropSeq,
    ...(pngA && pngB && region ? { visualEvidence: 'not-rendered' as const, reason: MISLEADING_CROP_REASON } : {}),
  };
}

type StateSectionArgs = {
  g: Group;
  regionFindings: Finding[];
  sd: SurfaceDiff;
  mapA: StyleMap;
  mapB: StyleMap;
  region: Box | null;
  ctx: RenderCtx;
  describeCtx: DescribeCtx;
  surfaceList: string;
  cropSeq: number;
  firstHeadingUsesAll: boolean;
};

function appendOneState(
  args: StateSectionArgs,
  state: (typeof STATE_LAYER_NAMES)[number],
  md: string[],
): {
  cropSeq: number;
  images?: { composite?: string; annotated?: string; zoom?: string };
} {
  const { g, regionFindings, sd, mapA, mapB, region, ctx, describeCtx, surfaceList } = args;
  const sf = regionFindings.filter(
    (f): f is Extract<Finding, { kind: 'state' }> => f.kind === 'state' && f.state === state,
  );
  if (!sf.length) return { cropSeq: args.cropSeq };
  const headingFindings = args.firstHeadingUsesAll && md.length === 0 ? regionFindings : sf;
  md.push('', `### ${regionHeading(g.paths, headingFindings)} \`:${state}\``, '', surfaceList);
  md.push('', `_Both sides are :${state}. Left is the old :${state}. Right is the new :${state}._`);
  const glance = propertyGlanceLine(sf);
  if (glance) md.push('', glance);
  const layerA = readPng(path.join(ctx.beforeDir, `${sd.surface}.${state}.png`));
  const layerB = readPng(path.join(ctx.afterDir, `${sd.surface}.${state}.png`));
  let cropSeq = args.cropSeq;
  let images: { composite?: string; annotated?: string; zoom?: string } | undefined;
  if (layerA && layerB) {
    const packed = appendCrop({
      g,
      region,
      regionFindings: sf,
      sd,
      mapA,
      mapB,
      pngA: layerA,
      pngB: layerB,
      ctx,
      cropSeq,
      pairCaption: {
        left: `base :${state}`,
        right: `head :${state}`,
        note: `both sides are :${state}`,
      },
    });
    cropSeq = packed.cropSeq;
    md.push(...packed.md);
    if (packed.images.composite) images = packed.images;
  } else {
    md.push('', `_No :${state} screenshot in these capture sets (re-capture to compare both sides in :${state})._`);
  }
  md.push(...renderCropChanges(sf, ctx.foldDetailsAt, describeCtx));
  return { cropSeq, images };
}

function appendStateSections(args: StateSectionArgs): {
  md: string[];
  stateImages: Record<string, { composite?: string; annotated?: string; zoom?: string }>;
  firstImages: { composite?: string; annotated?: string; zoom?: string };
  cropSeq: number;
} {
  const md: string[] = [];
  const stateImages: Record<string, { composite?: string; annotated?: string; zoom?: string }> = {};
  const firstImages: { composite?: string; annotated?: string; zoom?: string } = {};
  let cropSeq = args.cropSeq;
  for (const state of STATE_LAYER_NAMES) {
    const one = appendOneState({ ...args, cropSeq }, state, md);
    cropSeq = one.cropSeq;
    if (!one.images) continue;
    stateImages[state] = one.images;
    if (!firstImages.composite) Object.assign(firstImages, one.images);
  }
  return { md, stateImages, firstImages, cropSeq };
}

function appendRestBlock(args: {
  g: Group;
  sd: SurfaceDiff;
  mapA: StyleMap;
  mapB: StyleMap;
  pngA: PNG | null;
  pngB: PNG | null;
  region: Box | null;
  cropFindings: Finding[];
  ctx: RenderCtx;
  describeCtx: DescribeCtx;
  surfaceList: string;
  cropSeq: number;
}): CropPack & { headingMd: string[] } {
  const headingMd = ['', `### ${regionHeading(args.g.paths, args.cropFindings)}`, '', args.surfaceList];
  const glance = propertyGlanceLine(args.cropFindings);
  if (glance) headingMd.push('', glance);
  const packed = appendCrop({
    g: args.g,
    region: args.region,
    regionFindings: args.cropFindings,
    sd: args.sd,
    mapA: args.mapA,
    mapB: args.mapB,
    pngA: args.pngA,
    pngB: args.pngB,
    ctx: args.ctx,
    cropSeq: args.cropSeq,
  });
  packed.md = [
    ...headingMd,
    ...packed.md,
    ...renderCropChanges(args.cropFindings, args.ctx.foldDetailsAt, args.describeCtx),
  ];
  return { ...packed, headingMd };
}

// Render one crop region: heading, rest crop, then each forced-state crop.
function renderRegion(args: {
  g: Group;
  cg: ChangeGroup;
  mapA: StyleMap;
  mapB: StyleMap;
  pngA: PNG | null;
  pngB: PNG | null;
  describeCtx: DescribeCtx;
  ctx: RenderCtx;
  cropSeq: number;
}): { md: string[]; regionJson: Record<string, unknown>; cropSeq: number } {
  const { g, cg, mapA, mapB, pngA, pngB, describeCtx, ctx } = args;
  const { sd } = cg.rep;
  const regionFindings = cg.rep.findings.filter((f) =>
    g.paths.some((root) => f.path === root || f.path.startsWith(root + ' > ')),
  );
  const rest = regionFindings.filter((f) => f.kind !== 'state');
  const hasDom = regionFindings.some((f) => f.kind === 'dom');
  const stateOnly = !hasDom && rest.length === 0 && regionFindings.some((f) => f.kind === 'state');
  const surfaceList =
    cg.surfaces.length > 1
      ? `_Identical across ${cg.surfaces.length} surfaces: ${formatSurfaceListWithContext(cg.surfaces, ctx.beforeDir)}_`
      : `_${formatSurfaceWithContext(sd.surface, mapA, mapB)}_`;
  const md: string[] = [];
  const images: { composite?: string; annotated?: string; zoom?: string } = {};
  let cropSeq = args.cropSeq;
  let visualEvidence: 'not-rendered' | undefined;
  let reason: string | undefined;
  const region = visible(g.after) ? g.after : g.before;
  const cropFindings = hasDom ? regionFindings : rest;
  if (!stateOnly && cropFindings.length) {
    const packed = appendRestBlock({
      g,
      sd,
      mapA,
      mapB,
      pngA,
      pngB,
      region,
      cropFindings,
      ctx,
      describeCtx,
      surfaceList,
      cropSeq,
    });
    cropSeq = packed.cropSeq;
    md.push(...packed.md);
    Object.assign(images, packed.images);
    visualEvidence = packed.visualEvidence;
    reason = packed.reason;
  }

  const states = hasDom
    ? { md: [] as string[], stateImages: {}, firstImages: {}, cropSeq }
    : appendStateSections({
        g,
        regionFindings,
        sd,
        mapA,
        mapB,
        region,
        ctx,
        describeCtx,
        surfaceList,
        cropSeq,
        firstHeadingUsesAll: stateOnly,
      });
  cropSeq = states.cropSeq;
  md.push(...states.md);
  if (stateOnly && !images.composite) Object.assign(images, states.firstImages);
  if (!md.length) {
    md.push('', `### ${regionHeading(g.paths, regionFindings)}`, '', surfaceList);
    const note = cropNote(region, pngA, pngB);
    if (note) md.push('', note);
    md.push(...renderCropChanges(regionFindings, ctx.foldDetailsAt, describeCtx));
  }

  return {
    md,
    regionJson: {
      paths: g.paths,
      before: g.before,
      after: g.after,
      images,
      ...(Object.keys(states.stateImages).length ? { stateImages: states.stateImages } : {}),
      ...(visualEvidence ? { visualEvidence, reason } : {}),
    },
    cropSeq,
  };
}

// Render one change group: load its representative maps/screenshots, split it into
// crop regions (collapsing past maxCrops), and render each region top-to-bottom.
function renderChangeGroup(
  cg: ChangeGroup,
  ctx: RenderCtx,
  maxCrops: number,
  cropSeq: number,
): { md: string[]; json: Record<string, unknown>; findingCount: number; cropSeq: number } {
  const { sd, findings: surfaceFindings } = cg.rep;
  const rawBefore = loadStyleMap(findCapture(ctx.beforeDir, sd.surface));
  const mapB = loadStyleMap(findCapture(ctx.afterDir, sd.surface));
  // Same correspondence rewrite as prepareReportSurfaces so crops/annotations
  // resolve corresponded head paths on the before side too.
  const mapA = presentationBeforeMap(rawBefore, mapB);
  // Theme-token reverse-indexes so colour changes can name `red-200` per side.
  const describeCtx: DescribeCtx = { tokensBefore: tokenIndex(mapA.tokens), tokensAfter: tokenIndex(mapB.tokens) };
  const changedPaths = outermost([...new Set(surfaceFindings.map((f) => f.path))]);
  if (!hasExposedChangedEntry(mapA, mapB, changedPaths)) {
    const reason = MISLEADING_CROP_REASON;
    return {
      md: ['', `_${reason}_`, '', ...renderCropChanges(surfaceFindings, ctx.foldDetailsAt, describeCtx)],
      json: {
        surfaces: cg.surfaces,
        representative: sd.surface,
        regions: [],
        findings: surfaceFindings,
        visualEvidence: 'not-rendered',
        reason,
      },
      findingCount: surfaceFindings.length,
      cropSeq,
    };
  }
  const pngA = readPng(path.join(ctx.beforeDir, `${sd.surface}.png`));
  const pngB = readPng(path.join(ctx.afterDir, `${sd.surface}.png`));
  let groups = groupRegions(changedPaths, mapA, mapB, ctx.padBy);
  if (groups.length > maxCrops) groups = collapseGroups(groups);
  // Read top-to-bottom: one section per crop, in page order.
  const topY = (g: Group) => (visible(g.after) ? g.after.y : visible(g.before) ? g.before.y : Infinity);
  groups.sort((a, b) => topY(a) - topY(b));

  const md: string[] = [];
  const regions: unknown[] = [];
  for (const g of groups) {
    const r = renderRegion({ g, cg, mapA, mapB, pngA, pngB, describeCtx, ctx, cropSeq });
    cropSeq = r.cropSeq;
    md.push(...r.md);
    regions.push(r.regionJson);
  }
  const json: Record<string, unknown> = {
    surfaces: cg.surfaces,
    representative: sd.surface,
    regions,
    findings: surfaceFindings,
  };
  return { md, json, findingCount: surfaceFindings.length, cropSeq };
}

// Render a new surface: present on only one side, so there's nothing to diff. Show the
// captured side as a single screenshot and mark the heading for the PR comment.
function renderNewSurface(
  p: PreparedSurface,
  ctx: RenderCtx,
  cropSeq: number,
): { md: string[]; json: Record<string, unknown>; cropSeq: number } {
  const { img, outDir, maxHeight } = ctx;
  const side = p.sd.missing === 'before' ? 'after' : 'before';
  const srcDir = side === 'after' ? ctx.afterDir : ctx.beforeDir;
  const map = loadStyleMap(findCapture(srcDir, p.sd.surface));
  const png = readPng(path.join(srcDir, `${p.sd.surface}.png`));
  // missing 'before' = captured only on head (a NEW surface); missing 'after' =
  // captured only on base (a REMOVED surface). Rendering a removal under a "new
  // surface 🆕" heading invited reviewers to approve a feature going invisible
  // believing it was an addition.
  const isRemoved = p.sd.missing === 'after';
  const md: string[] = [
    '',
    isRemoved
      ? `### \`${safeKey(p.sd.surface)}\` · REMOVED surface 🗑️`
      : `### \`${safeKey(p.sd.surface)}\` · new surface ${NEW_SURFACE_MARKER}`,
    '',
    `_${formatSurfaceWithContext(p.sd.surface, map)}_`,
  ];
  const json: Record<string, unknown> = { surface: p.sd.surface, missing: p.sd.missing, isNew: !isRemoved, isRemoved };
  if (png) {
    cropSeq++;
    const h = Math.min(maxHeight, png.height, map.viewport?.height ?? png.height);
    const crop = cropPng(png, { x: 0, y: 0, w: png.width, h }, png.width, h).png;
    const stem = `crops/${p.sd.surface.replace(/[^a-z0-9-]/gi, '-')}-${cropSeq}-new`;
    writePng(path.join(outDir, `${stem}.png`), crop);
    md.push(
      '',
      `![${isRemoved ? 'removed surface' : 'new surface'} — ${side}](${img(`${stem}.png`)})`,
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
  md.push(
    '',
    isRemoved
      ? `_Present in the baseline but not captured on head — the surface stopped rendering (or its capture key changed). This is a **removal** to review, not an addition; approving accepts the disappearance._`
      : `_No baseline to compare against — this surface is new. Review and approve it before it becomes part of the baseline._`,
  );
  return { md, json, cropSeq };
}

/** The shared-chrome tier banner (#193), emitted once above the promoted groups:
 *  "the frame every view draws changed" — so the reviewer reads it as one global
 *  change, not a per-view surprise. The affected group(s) render in full beneath.
 *  `nChrome` is how many distinct chrome changes were promoted; `nSurfaces` is the
 *  captured-surface-base count they span. */
function chromeCalloutLines(nChrome: number, nSurfaces: number): string[] {
  const what = nChrome === 1 ? 'change' : 'changes';
  return [
    '',
    '---',
    '',
    `## 🧱 Global chrome ${what} — across all ${nSurfaces} captured surface base(s)`,
    '',
    `_${nChrome} change(s) rode the shared frame every view draws (a persistent nav, header, or footer): ` +
      `each touched every surface that renders the affected element, so it reads as ONE global change, not a ` +
      `per-view one. The detail is folded beneath — review it once._`,
  ];
}

/** The one-time banner where report.md switches from full detail to one-line
 *  summaries, so the reader knows nothing is missing — only relocated to report.json. */
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

/** One-line summary for a changed surface whose full detail was budget-capped: its
 *  name (and how many surfaces share the identical change) · change count · a crop
 *  link so the reviewer can still see it without opening report.json. */
function compactChangeSummary(cg: ChangeGroup, json: Record<string, unknown>, img: (rel: string) => string): string {
  const surface = safeKey(cg.rep.sd.surface);
  const more = cg.surfaces.length > 1 ? ` (+${cg.surfaces.length - 1} more)` : '';
  const regions = (json.regions as Array<{ images?: { composite?: string } }> | undefined) ?? [];
  const composite = regions[0]?.images?.composite;
  const link = composite ? ` — [crop](${img(composite)})` : '';
  return `- \`${surface}\`${more} · ${cg.rep.findings.length} change(s)${link}`;
}

/**
 * When includeLayoutNoise is on, prepared findings include derived longhands so
 * raw-only is not a consistency failure. Otherwise preserve fail-closed truth.
 */
function comparisonForReport(
  comparison: ComparisonTruth,
  includeNoise: boolean,
  reviewableChangedSurfaces: number,
): ComparisonTruth {
  const rawOnlyNoReviewable = !includeNoise && comparison.rawOnlyNoReviewable;
  return {
    ...comparison,
    rawOnlyNoReviewable,
    hasReviewableEvidence: comparison.hasReviewableEvidence || (includeNoise && reviewableChangedSurfaces > 0),
  };
}

/**
 * Focus each surface on styling intent unless layout noise is requested.
 *
 * Presentation findings run through report-only path correspondence first:
 * uniquely paired removed→added elements are rewritten onto the head path so
 * `diffStyleMaps` can emit real before→after property deltas (or collapse a
 * pure path move). Raw `sd.findings`, `rawCounts`, exit codes, and approval
 * gates stay on the concrete-path certification differ.
 *
 * A surface whose ONLY changes are derived longhands keeps them
 * (cleanFindingsForDisplay): those findings still gate, and a report that
 * renders nothing for a gating change asks a reviewer to approve evidence
 * that doesn't exist.
 */
function prepareReportSurfaces(
  surfaces: ReturnType<typeof diffStyleMapDirs>['surfaces'],
  comparability: SurfaceComparability[],
  requireStateIdentity: boolean,
  includeNoise: boolean,
  includeStructure: boolean,
  beforeDir: string,
  afterDir: string,
): PreparedSurface[] {
  const comparisonBySurface = new Map(comparability.map((entry) => [entry.surface, entry]));
  return surfaces
    .map((sd) => {
      if (sd.missing) return { sd, findings: sd.findings };
      const receipt = comparisonBySurface.get(sd.surface);
      if (
        receipt?.status === 'incomparable' ||
        (receipt?.status === 'unproven' && (receipt.required || requireStateIdentity))
      ) {
        return { sd, findings: [] };
      }
      const beforeMap = loadStyleMap(findCapture(beforeDir, sd.surface));
      const afterMap = loadStyleMap(findCapture(afterDir, sd.surface));
      const corresponded = presentationDiffStyleMaps(beforeMap, afterMap, { includeStructure });
      return {
        sd,
        findings: includeNoise ? corresponded : cleanFindingsForDisplay(corresponded),
      };
    })
    .filter((p) => p.sd.missing || p.findings.length > 0);
}

type ReportConsistency =
  | { ok: true; reason: 'aligned' }
  | {
      ok: false;
      reason: 'raw_only_no_reviewable' | 'presentation_collapsed_while_raw_reviewable';
    };

/**
 * The presentation may simplify raw evidence, but it may never erase every
 * reviewable finding and then claim the surfaces are identical.
 */
function assessReportConsistency(comparison: ComparisonTruth, hasPresentationEvidence: boolean): ReportConsistency {
  if (comparison.rawOnlyNoReviewable) return { ok: false, reason: 'raw_only_no_reviewable' };
  if (comparison.hasReviewableEvidence && !hasPresentationEvidence) {
    return { ok: false, reason: 'presentation_collapsed_while_raw_reviewable' };
  }
  return { ok: true, reason: 'aligned' };
}

function writeReportArtifacts(
  outDir: string,
  md: string[],
  shown: DiffCounts,
  comparison: ReportComparison,
  comparability: SurfaceComparability[],
  reportConsistency: ReportConsistency,
  content: { evaluated: boolean; changes: number; advisory: true },
  surfacesJson: Array<Record<string, unknown>>,
  baselineProvenance: BaselineProvenance | null = null,
  confidence: ConfidenceSummary | null = null,
): { reportMdPath: string; reportJsonPath: string } {
  const reportMdPath = path.join(outDir, 'report.md');
  const reportJsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportMdPath, md.join('\n') + '\n');
  fs.writeFileSync(
    reportJsonPath,
    JSON.stringify(
      {
        counts: shown,
        rawCounts: comparison.rawCounts,
        reviewableCounts: comparison.reviewableCounts,
        comparison,
        comparability,
        reportConsistency,
        content,
        surfaces: surfacesJson,
        // Additive (#399): the completeness badge, machine-readable — a consumer
        // must never read one green as full certification.
        ...(confidence ? { confidence } : {}),
        // Additive (#367): where the baseline maps came from, when recorded —
        // exact-SHA restore, nearest-ancestor reuse (with proof), or fresh capture.
        ...(baselineProvenance ? { baselineProvenance } : {}),
      },
      null,
      2,
    ),
  );
  return { reportMdPath, reportJsonPath };
}

function stateCoverageLines(afterDir: string): string[] {
  const entries = new Map<string, { surface: string; state: string; action: string; evidence: string }>();
  for (const captureKey of captureKeysIn(afterDir)) {
    const metadata = loadStyleMap(findCapture(afterDir, captureKey)).metadata;
    const recipe = metadata?.stateRecipe;
    if (metadata?.variantKind !== 'state-recipe' || !recipe) continue;
    const action = ['hover', 'focus', 'press', 'click', 'route'].includes(recipe.action) ? recipe.action : 'unknown';
    const surface = safeKey(metadata.surfaceKey || surfaceBase(captureKey)).slice(0, 120);
    const state = safeKey(recipe.stateKey || metadata.variantKey || captureKey).slice(0, 120);
    let evidence = 'captured';
    if (
      typeof recipe.observationMs === 'number' &&
      Number.isInteger(recipe.observationMs) &&
      recipe.observationMs >= 50 &&
      recipe.observationMs <= 5_000
    ) {
      evidence = `observation ${recipe.observationMs} ms`;
    } else if (
      action === 'route' &&
      typeof recipe.status === 'number' &&
      Number.isInteger(recipe.status) &&
      recipe.status >= 400 &&
      recipe.status <= 599
    ) {
      evidence = `response ${recipe.status}`;
    }
    entries.set(`${surface}\u0000${state}\u0000${action}\u0000${evidence}`, { surface, state, action, evidence });
  }
  if (entries.size === 0) return [];
  const ordered = [...entries.values()].sort(
    (a, b) => a.surface.localeCompare(b.surface) || a.state.localeCompare(b.state) || a.action.localeCompare(b.action),
  );
  const surfaceCount = new Set(ordered.map((entry) => entry.surface)).size;
  return [
    '',
    '## State coverage',
    '',
    `Captured recipe states: ${ordered.length} across ${surfaceCount} surface${surfaceCount === 1 ? '' : 's'}.`,
    '',
    '| Surface | State | Action | Evidence |',
    '| --- | --- | --- | --- |',
    ...ordered.map(
      (entry) => `| \`${entry.surface}\` | \`${entry.state}\` | \`${entry.action}\` | ${entry.evidence} |`,
    ),
    '',
    '_Discovery outcomes such as skipped, deduplicated, timed out, or requires fixture are recorded by the state harvester; this capture report does not infer them._',
  ];
}

function generateStyleMapReportInternal(opts: ReportOptions, includeStructure: boolean): ReportResult {
  const {
    beforeDir,
    afterDir,
    outDir,
    imageBaseUrl = '',
    // Tighter than before (was 24) so the change fills the frame — the annotation
    // box keeps enough context legible.
    pad: padBy = 12,
    minWidth = 320,
    minHeight = 180,
    maxHeight = 1600,
    zoomBelow = 64,
    // More, smaller crops before collapsing (was 6), so distinct changes get their
    // own focused frame rather than one wide merged one.
    maxCrops = 8,
    foldDetailsAt = 0,
    maxReportBytes = 400_000,
    requireStateIdentity = false,
  } = opts;

  const includeNoise = opts.includeLayoutNoise === true;
  const includeContent = opts.includeContent === true;
  // Base first, head second: current capture metadata is authoritative when a
  // surface's product key changed between revisions.
  const surfaceKeyOf = mergeSurfaceKeyLookup(beforeDir, afterDir);
  const {
    surfaces,
    volatile: volatileCount,
    counts: rawCounts,
    comparability,
  } = diffStyleMapDirs(beforeDir, afterDir, { includeStructure });
  // Canonical truth shared with styleproof-diff / action trust: when raw
  // certification deltas exist but cleanFindings leaves nothing reviewable,
  // never claim "identical" and never enable visual approval.
  const rawComparison = assessComparisonTruth(surfaces, rawCounts, comparability, { requireStateIdentity });
  const comparabilitySummary = summarizeComparability(comparability, requireStateIdentity);
  const liveCandidateLabels = volatileCount === 0 ? [] : collectLiveCandidateLabels(beforeDir, afterDir);
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });

  // Focus each surface on styling intent: drop reflow-casualty props, suppress
  // forced-state echoes of base changes, and remove non-value noise (see
  // cleanFindings), unless includeLayoutNoise is set. Surfaces left with no real
  // change are dropped.
  const preparedCertified = prepareReportSurfaces(
    surfaces,
    comparability,
    requireStateIdentity,
    includeNoise,
    includeStructure,
    beforeDir,
    afterDir,
  );

  const missing = preparedCertified.filter((p) => p.sd.missing);
  const changeGroups = groupBySignature(
    preparedCertified.filter((p) => !p.sd.missing),
    beforeDir,
    afterDir,
  );
  // Shared-chrome tier (#193): promote a change that rode the frame every view
  // draws (nav rail, header) to a callout, so the reviewer reads "the nav changed
  // everywhere" once instead of inferring it from a long surface list on several
  // entries. Purely presentational — counts, groups, exit code, and report.json
  // are unchanged; only the render order and one heading differ. In the common
  // small-surface case (e.g. the demo) nothing qualifies and this is a no-op.
  const { chrome, rest } = classifyChrome(changeGroups, surfaceElementPaths(beforeDir, afterDir), surfaceKeyOf);
  const orderedGroups = [...chrome, ...rest];
  const shown = countShownChanges(changeGroups);
  // Surface bases (and variant keys when widths/states differ) carrying a reviewable
  // change — NOT the new (one-sided) ones, which have no baseline and get their own line.
  const changedScope = countChangedSurfaceScope(changeGroups, surfaceKeyOf);
  const baselineSurfaceFailures = readMapManifest(beforeDir)?.surfaceCaptureFailures ?? [];
  const comparison: ReportComparison = {
    ...comparisonForReport(rawComparison, includeNoise, preparedCertified.length - missing.length),
    ...comparabilitySummary,
  };
  const reportConsistency = assessReportConsistency(comparison, changeGroups.length > 0 || missing.length > 0);

  const md: string[] = [];
  const json: Array<Record<string, unknown>> = [];
  const img = (rel: string) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, '')}/${rel}` : rel);
  const ctx: RenderCtx = {
    beforeDir,
    afterDir,
    outDir,
    img,
    padBy,
    minWidth,
    minHeight,
    maxHeight,
    zoomBelow,
    foldDetailsAt,
  };

  // Opt-in, advisory: computed here so its count can colour the headline, but its
  // markdown is appended at the very end and it NEVER feeds the gate below.
  const contentSection = includeContent
    ? renderContentSection({ beforeDir, afterDir, outDir, img, padBy, minWidth, minHeight, maxHeight, zoomBelow })
    : { md: [], count: 0 };

  md.push('## 🗺️ StyleProof report', '');
  // Lead with the source-of-truth gates (coverage / determinism / inventory /
  // confidence) so a reviewer reads "is this green trustworthy?" before the
  // pixel details. Confidence is resolved once and shared with report.json so
  // the badge and the machine-readable summary can never disagree.
  const confidenceLedger = resolveBundleConfidence(afterDir);
  const confidence = summarizeConfidence(confidenceLedger);
  md.push(...certificationLines(beforeDir, afterDir, { ledger: confidenceLedger, summary: confidence }));
  // Baseline provenance (#367): when the run recorded where the base maps came
  // from, say so up front — an ancestor reuse must be visible, never inferred.
  const baselineProvenance = readBaselineProvenance(beforeDir);
  md.push(...baselineProvenanceLines(baselineProvenance));
  md.push(...comparabilityLines(comparison));
  md.push(
    ...reportHeadline({
      changeGroups,
      missing,
      shown,
      changedScope,
      volatileCount,
      liveCandidateLabels,
      contentCount: contentSection.count,
      contentEvaluated: includeContent,
      reportConsistency,
      rawCounts: comparison.rawCounts,
      baselineSurfaceFailures,
      confidenceBlocked: confidence.counts.inaccessible > 0,
      comparisonBlocked: comparison.blocksCertification,
    }),
  );
  md.push(...stateCoverageLines(afterDir));
  let totalFindings = 0;
  let cropSeq = 0;
  // report.md must stay renderable — GitHub refuses to render markdown past ~512 KB.
  // Emit full detail greedily until the byte budget is reached, then list any remaining
  // surfaces as one-liners. The exhaustive per-row detail is always in report.json and
  // every crop in crops/, so the cap changes what's shown inline, never what's certified.
  let reportBytes = md.join('\n').length;
  let capped = false;
  const emitDetail = (detail: string[], summary: string): void => {
    const cost = detail.join('\n').length + 1;
    if (!capped && reportBytes + cost <= maxReportBytes) {
      md.push(...detail);
      reportBytes += cost;
      return;
    }
    if (!capped) {
      md.push(...cappedNoticeLines(maxReportBytes));
      capped = true;
    }
    md.push(summary);
    reportBytes += summary.length + 1;
  };
  // The captured-surface-base count (all surfaces, not just changed ones) so the
  // chrome callout can read "N of M surfaces". M is bases, matching the tier's
  // base-keyed coverage rule.
  const totalSurfaceBases = countCapturedSurfaceBases(captureKeysIn(afterDir), surfaceKeyOf);
  const chromeSet = new Set(chrome);
  let chromeHeaderEmitted = false;
  if (missing.length > 0) {
    md.push('', '## 🆕 New pages, states, or surfaces — review first');
  }
  for (const p of missing) {
    const r = renderNewSurface(p, ctx, cropSeq);
    json.push(r.json);
    cropSeq = r.cropSeq;
    emitDetail(r.md, `- \`${safeKey(p.sd.surface)}\` · new surface`);
  }
  if (orderedGroups.length > 0) {
    md.push('', '## Element-level changes');
  }
  for (const cg of orderedGroups) {
    const r = renderChangeGroup(cg, ctx, maxCrops, cropSeq);
    json.push(r.json);
    totalFindings += r.findingCount;
    cropSeq = r.cropSeq;
    // Prepend the shared-chrome banner once, above the first promoted group. It
    // rides on the same emitDetail budget so the cap still applies.
    const detail =
      chromeSet.has(cg) && !chromeHeaderEmitted
        ? ((chromeHeaderEmitted = true), [...chromeCalloutLines(chrome.length, totalSurfaceBases), ...r.md])
        : r.md;
    emitDetail(detail, compactChangeSummary(cg, r.json, img));
  }
  emitDetail(
    contentSection.md,
    `- ${contentSection.count} advisory content/structure change(s); full image evidence remains in the published report artifacts.`,
  );

  const { reportMdPath, reportJsonPath } = writeReportArtifacts(
    outDir,
    md,
    shown,
    comparison,
    comparability,
    reportConsistency,
    { evaluated: includeContent, changes: contentSection.count, advisory: true },
    json,
    baselineProvenance,
    confidence,
  );
  return {
    changedSurfaces: preparedCertified.length - missing.length,
    newSurfaces: missing.length,
    totalFindings,
    contentChanges: contentSection.count,
    comparison,
    comparability,
    reportConsistency,
    confidence,
    reportMdPath,
    reportJsonPath,
  };
}

/** Generate the public report. DOM structure is never part of certification. */
export function generateStyleMapReport(opts: ReportOptions): ReportResult {
  return generateStyleMapReportInternal(opts, false);
}

/** @internal Retains direct coverage of the low-level structural renderer. */
export function generateStructuralStyleMapReportForTesting(opts: ReportOptions): ReportResult {
  return generateStyleMapReportInternal(opts, true);
}

function findCapture(dir: string, surface: string): string {
  for (const ext of ['.json.gz', '.json']) {
    const p = path.join(dir, surface + ext);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no capture for ${surface} in ${dir}`);
}
