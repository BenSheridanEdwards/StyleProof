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
} from './capture.js';
import {
  isMapFile,
  readMapManifest,
  surfaceMissingMatchesBaselineFailure,
  type SurfaceCaptureFailure,
} from './map-store.js';
import { fillRect, type RGB } from './png-util.js';
import {
  diffStyleMapDirs,
  diffContentDirs,
  type ContentChange,
  type DiffCounts,
  type Finding,
  type PropChange,
  type SurfaceDiff,
} from './diff.js';
import { describeChange, tokenIndex, toHex, type ElementChange, type DescribeCtx } from './describe.js';
import {
  auditCoverage,
  auditDeterminism,
  COVERAGE_LEDGER,
  type CoverageLedger,
  type CoverageVerdict,
  type DeterminismVerdict,
} from './coverage.js';
import { auditRunInventory, readAckFile } from './inventory.js';
import { auditRunResidue, readResidueAckFile } from './data-residue.js';
// The pure grouping / classification brain — shared with the CLI. report.ts keeps
// the crop-and-PNG rendering on top of these.
import {
  cleanFindings,
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
} from './change-groups.js';
// Re-export the plain-English summariser so consumers (and tests) reach it
// through the package's report module rather than a deep path.
export { describeChange, colorName, tokenIndex, toHex } from './describe.js';
// Re-export the grouping primitives historically exported from here so existing
// imports (`from 'styleproof'` → report) keep resolving.
export { summarizeProps, prettyLabel } from './change-groups.js';

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
   * to diff and the section is empty. Never affects `changedSurfaces`,
   * `totalFindings`, or the exit code — StyleProof stays computed-styles-first;
   * this only surfaces copy changes (and any silent overflow/clipping they
   * cause) for the reviewer's eye.
   */
  includeContent?: boolean;
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

export type ReportResult = {
  /** Surfaces carrying a reviewable change (excludes new, one-sided surfaces). */
  changedSurfaces: number;
  /** New surfaces present on only one side, with no baseline to compare. */
  newSurfaces: number;
  totalFindings: number;
  /** Advisory content-layer changes rendered (0 unless includeContent + captured text). Never gates. */
  contentChanges: number;
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

/** Headline counts with the zeros dropped — `0 state-delta difference(s)` is noise. */
function changeCountLabel(shown: DiffCounts): string {
  const parts: string[] = [];
  if (shown.dom) parts.push(`${shown.dom} DOM change(s)`);
  if (shown.style) parts.push(`${shown.style} computed-style difference(s)`);
  if (shown.state) parts.push(`${shown.state} state-delta difference(s)`);
  return parts.join(' · ');
}

type Group = { paths: string[]; before: Box | null; after: Box | null };

function groupRegions(paths: string[], a: StyleMap, b: StyleMap, padBy: number): Group[] {
  const groups: Group[] = paths.map((p) => {
    const ra = a.elements[p]?.rect;
    const rb = b.elements[p]?.rect;
    const before = ra ? pad(rectToBox(ra), padBy) : null;
    const after = rb ? pad(rectToBox(rb), padBy) : null;
    return { paths: [p], before: visible(before) ? before : null, after: visible(after) ? after : null };
  });

  // Merge groups whose regions overlap on either side, to a fixpoint.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const gi = groups[i];
        const gj = groups[j];
        const hit =
          (visible(gi.after) && visible(gj.after) && intersects(gi.after, gj.after)) ||
          (visible(gi.before) && visible(gj.before) && intersects(gi.before, gj.before));
        if (hit) {
          gi.paths.push(...gj.paths);
          gi.before = visible(gi.before) && visible(gj.before) ? union(gi.before, gj.before) : (gi.before ?? gj.before);
          gi.after = visible(gi.after) && visible(gj.after) ? union(gi.after, gj.after) : (gi.after ?? gj.after);
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
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

/**
 * One before|after image: the two equal-size crops on a dark canvas with a
 * neutral divider between them. Left is always before; before/after is labelled
 * by the caption under the image. The divider is identical on both sides, so the
 * ONLY thing that differs across the pair is the actual change — no extra chrome
 * (e.g. a coloured accent strip) that reads as a second diff.
 */
function compositePair(before: PNG, after: PNG): PNG {
  const PAD = 20;
  const GAP = 28;
  const w = Math.max(before.width, after.width);
  const h = Math.max(before.height, after.height);
  const width = PAD + w + GAP + w + PAD;
  const height = PAD + h + PAD;
  const canvas = new PNG({ width, height });
  fillRect(canvas, 0, 0, width, height, [13, 17, 23]); // GitHub dark
  const leftX = PAD;
  const rightX = PAD + w + GAP;
  PNG.bitblt(before, canvas, 0, 0, before.width, before.height, leftX, PAD);
  PNG.bitblt(after, canvas, 0, 0, after.width, after.height, rightX, PAD);
  fillRect(canvas, PAD + w + GAP / 2 - 1, PAD, 2, h, [48, 54, 61]); // divider
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

/** `Button (variant=primary, size=sm)` — the React component + sanitized props
 *  the element captured (advisory; present only with captureComponent). */
function renderComponent(c: { name: string; props?: Record<string, string> }): string {
  const entries = Object.entries(c.props ?? {});
  const props = entries.length ? ` (${entries.map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  return `\`${c.name}\`${props}`;
}

/** One element's heading + body lines (no leading blank, no ×N suffix). */
// Base/pseudo style rows. Added elements render value-only (no meaningful before).
function styleSection(styles: Extract<Finding, { kind: 'style' }>[], added: boolean): string[] {
  const out: string[] = [];
  for (const s of styles) {
    const rows = summarizeProps(s.props);
    if (rows.length)
      out.push(
        '',
        s.pseudo ? `On \`${s.pseudo}\`:` : 'Style:',
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
 *  literally, so no backticks or bold here. */
function foldSummary(findings: Finding[]): string {
  const n = findings.flatMap((f) => (f.kind === 'dom' ? [] : summarizeProps(f.props))).length;
  if (!n) return 'Show details';
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
};

/** An element's padded box on one side, or null when it has no visible rect. */
function paddedRect(entry: ElementEntry | undefined, padBy: number): Box | null {
  if (!entry?.rect) return null;
  const b = pad(rectToBox(entry.rect), padBy);
  return visible(b) ? b : null;
}

/** Crop box for a content change: the union of where the element sits on each
 *  side (so the pair lines up), or null if it's not visible anywhere. */
function contentBox(mapA: StyleMap, mapB: StyleMap, p: string, padBy: number): Box | null {
  const ba = paddedRect(mapA.elements[p], padBy);
  const bb = paddedRect(mapB.elements[p], padBy);
  if (ba && bb) return union(ba, bb);
  return bb ?? ba;
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
  const box = contentBox(mapA, mapB, c.path, ctx.padBy);
  if (!box || !pngA || !pngB) return [];
  const w = Math.max(ctx.minWidth, box.w);
  const h = Math.min(ctx.maxHeight, Math.max(ctx.minHeight, box.h));
  const composite = compositePair(cropPng(pngA, box, w, h).png, cropPng(pngB, box, w, h).png);
  const stem = `crops/${surface.replace(/[^a-z0-9-]/gi, '-')}-content-${seq}`;
  writePng(path.join(ctx.outDir, `${stem}-composite.png`), composite);
  return [
    '',
    `![before ◀ │ ▶ after](${ctx.img(`${stem}-composite.png`)})`,
    '',
    `<sub>◀ before  ·  after ▶ — ${surface}</sub>`,
  ];
}

/** One surface's content block: heading, then per change the before/after text
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
  const md: string[] = ['', `### \`${safeKey(surface)}\` · ${changes.length} content change(s)`];
  for (const c of changes) {
    seq++;
    md.push(
      '',
      `**\`${prettyLabel(c.path, c.cls)}\`**`,
      '',
      `- before: \`${clipText(c.before) || '(empty)'}\``,
      `- after: \`${clipText(c.after) || '(empty)'}\``,
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
    '## 📝 Content changes (advisory)',
    '',
    `_${count} element(s) changed their own text. **Advisory only** — content is not part of the computed-style ` +
      `certification and does not affect the check. Surfaced so a copy change the style diff can't see (and any ` +
      `overflow or clipping it causes) is visible in review._`,
  ];
  let seq = 0;
  for (const { surface, changes } of surfaces) {
    const out = renderContentSurface(ctx, surface, changes, seq);
    md.push(...out.md);
    seq = out.seq;
  }
  return { md, count };
}

// Pre-existing, grandfathered in the health baseline; the content layer is
// rendered by extracted helpers, this only gained a call + headline branch.
// fallow-ignore-next-line complexity
function readLedgerFile(dir: string): CoverageLedger | null {
  const p = path.join(dir, COVERAGE_LEDGER);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CoverageLedger;
  } catch {
    return null;
  }
}

function surfaceKeysIn(dir: string): string[] {
  return [
    ...new Set(
      fs
        .readdirSync(dir)
        .filter(isMapFile)
        .map((f) => f.replace(/@\d+\.json(\.gz)?$/, '')),
    ),
  ];
}

// ── Certification renderers ──────────────────────────────────────────────────────
// Each maps one source-of-truth verdict to its report line. Kept as separate one-
// verdict functions so certificationLines stays a thin orchestrator (and each stays
// well under the complexity gate).

function coverageLine(cov: CoverageVerdict): string {
  if (cov.basis === 'complete')
    return `- **Coverage** — ✓ complete (all ${cov.registrySize} registered surface(s) captured)`;
  if (cov.basis === 'incomplete')
    return `- **Coverage** — ✗ INCOMPLETE (${cov.uncovered.length} registered surface(s) not captured: ${cov.uncovered.map(safeKey).join(', ')})`;
  return '- **Coverage** — ⚠ not asserted (no `expected` registry; certifies only the captured surfaces)';
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

// One data-residue clause. A failing data endpoint captured the fallback branch, so its
// response-driven states are unproven; an ARMED gate escalates an unacknowledged one to ✗.
function dataResidueLine(res: ReturnType<typeof auditRunResidue>): string {
  const { residue, unacknowledged, staleAcknowledgements, armed } = res;
  if (armed && (unacknowledged.length > 0 || staleAcknowledgements.length > 0)) {
    const stale = staleAcknowledgements.length ? `; ${staleAcknowledgements.length} stale acknowledgement(s)` : '';
    return `- **Data residue** — ✗ ${unacknowledged.length} failing data endpoint(s), unacknowledged: ${keyList(unacknowledged)}${stale}`;
  }
  if (unacknowledged.length > 0)
    return `- **Data residue** — ⚠ ${unacknowledged.length} failing data endpoint(s) (fallback branch captured): ${keyList(unacknowledged)} — recorded, not gating (\`dataResidue: 'warn'\` opt-out)`;
  if (residue.length > 0) return `- **Data residue** — ✓ ${residue.length} failing endpoint(s), all acknowledged`;
  return '- **Data residue** — ✓ no failing data-boundary request during capture';
}

/**
 * The certification block a reviewer reads FIRST — the source-of-truth gates (coverage
 * complete? determinism proven? did the navigable set shrink?), not just the pixel diff.
 * Empty when the bundle carries no certification metadata (an old capture).
 */
function certificationLines(beforeDir: string, afterDir: string): string[] {
  const baseLedger = readLedgerFile(beforeDir);
  const headLedger = readLedgerFile(afterDir);
  const inv = auditRunInventory(readInventories(beforeDir), readInventories(afterDir), readAcknowledgedRemovals());
  const res = auditRunResidue(readResidue(afterDir), readAcknowledgedResidue(), headLedger?.dataResidue === 'gate');

  const hasLedger = baseLedger !== null || headLedger !== null;
  const hasInvChange = inv.delta.removed.length > 0 || inv.delta.added.length > 0;
  const hasResidue = res.residue.length > 0 || res.armed;
  if (!hasLedger && !hasInvChange && !hasResidue) return [];

  return [
    '**Certification**',
    coverageLine(auditCoverage(surfaceKeysIn(afterDir), headLedger)),
    determinismLine(auditDeterminism(baseLedger, headLedger)),
    inventoryLine(inv),
    // Only add the residue line when there's residue or the gate was armed — an ordinary
    // bundle (no failing endpoint, not armed) keeps its exact prior 3-line block.
    ...(hasResidue ? [dataResidueLine(res)] : []),
    '',
  ];
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

/** A changed element can anchor useful visual proof only when the browser paints it. */
function isPaintedEntry(entry: ElementEntry | undefined): boolean {
  if (!entry?.rect || !visible(rectToBox(entry.rect))) return false;
  if (entry.style.display === 'none' || entry.style.visibility === 'hidden') return false;
  return Number(entry.style.opacity ?? '1') > 0;
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
  return isPaintedEntry(map.elements[changedPath]) && !isBackgroundBehindActiveModal(map, changedPath);
}

function hasExposedChangedEntry(mapA: StyleMap, mapB: StyleMap, changedPaths: string[]): boolean {
  return changedPaths.some(
    (changedPath) => isExposedChangedEntry(mapA, changedPath) || isExposedChangedEntry(mapB, changedPath),
  );
}

type RepresentativeScore = { hasExposedChange: boolean; hasActiveModal: boolean; isPopup: boolean; width: number };

/** Prefer proof a reviewer can see: an exposed changed element, then a non-modal
 * ordinary page over a popup state that can leave shared chrome in the background,
 * then the widest width. */
function representativeScore(candidate: PreparedSurface, beforeDir: string, afterDir: string): RepresentativeScore {
  const beforeMap = loadStyleMap(findCapture(beforeDir, candidate.sd.surface));
  const afterMap = loadStyleMap(findCapture(afterDir, candidate.sd.surface));
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
// surface it appears on (after shorthand/dedupe collapsing).
function countShownChanges(changeGroups: ChangeGroup[]): DiffCounts {
  const shown: DiffCounts = { dom: 0, style: 0, state: 0 };
  for (const cg of changeGroups)
    for (const f of cg.findings) {
      if (f.kind === 'dom') shown.dom++;
      else if (f.kind === 'style') shown.style += summarizeProps(f.props).length;
      else shown.state += summarizeProps(f.props).length;
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

function summaryLines(args: {
  changeGroups: ChangeGroup[];
  missing: PreparedSurface[];
  shown: DiffCounts;
  changedScope: { bases: number; variants: number };
  contentCount: number;
  baselineSurfaceFailures: SurfaceCaptureFailure[];
}): string[] {
  const { changeGroups, missing, shown, changedScope, contentCount, baselineSurfaceFailures } = args;
  const greenfieldMissing = missing.filter(
    (p) => !surfaceMissingMatchesBaselineFailure(p.sd.surface, baselineSurfaceFailures),
  );
  const brokenBaseMissing = missing.filter((p) =>
    surfaceMissingMatchesBaselineFailure(p.sd.surface, baselineSurfaceFailures),
  );
  if (changeGroups.length === 0 && missing.length === 0 && baselineSurfaceFailures.length === 0) {
    return [
      contentCount > 0
        ? '✓ Computed styles identical: every longhand, pseudo-element, and hover/focus/active state matches. See the advisory content changes below.'
        : '✓ All surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches.',
    ];
  }
  const md: string[] = [];
  if (baselineSurfaceFailures.length > 0) {
    md.push(
      `⚠️ **${baselineSurfaceFailures.length} baseline capture failure(s)** — these surfaces failed on the **base branch** and were omitted from the baseline bundle. **Repair base capture** on the base branch; do not approve indefinitely as if they were greenfield new surfaces.`,
    );
    for (const f of baselineSurfaceFailures.slice(0, 8))
      md.push(`- \`${safeKey(f.key)}\`: ${escapeMarkdownFailureReason(f.reason)}`);
    if (baselineSurfaceFailures.length > 8)
      md.push(`- _…and ${baselineSurfaceFailures.length - 8} more (see manifest \`surfaceCaptureFailures\`)_`);
    md.push('');
  }
  if (brokenBaseMissing.length > 0) {
    md.push(
      `⚠️ **${brokenBaseMissing.length} head surface(s)** have no base map because baseline capture failed (not first adoption): ${newSurfaceSummary(brokenBaseMissing)}.`,
    );
    md.push('');
  }
  if (greenfieldMissing.length > 0) {
    md.push(
      `🆕 **${greenfieldMissing.length} new surface(s)** captured with no baseline to compare: ${newSurfaceSummary(greenfieldMissing)}. ` +
        `Approve them before they become the baseline.`,
    );
  }
  if (missing.length > 0 && greenfieldMissing.length === 0 && brokenBaseMissing.length === 0) {
    md.push(
      `🆕 **${missing.length} new surface(s)** captured with no baseline to compare: ${newSurfaceSummary(missing)}. ` +
        `Approve them before they become the baseline.`,
    );
  }
  if (changeGroups.length > 0) {
    if (md.length > 0) md.push('');
    md.push(
      `**${changeCountLabel(shown)}** across ${changeGroups.length} distinct change(s) in ${formatChangedSurfaceScope(changedScope.bases, changedScope.variants)} with an existing baseline.`,
    );
    md.push(SURFACE_SCOPE_GLOSSARY);
  }
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
  baselineSurfaceFailures: SurfaceCaptureFailure[];
}): string[] {
  const {
    changeGroups,
    missing,
    shown,
    changedScope,
    volatileCount,
    liveCandidateLabels,
    contentCount,
    baselineSurfaceFailures,
  } = args;
  const md: string[] = summaryLines({
    changeGroups,
    missing,
    shown,
    changedScope,
    contentCount,
    baselineSurfaceFailures,
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
}): { md: string[]; images: { composite?: string; annotated?: string; zoom?: string } } {
  const { g, region, regionFindings, sd, mapA, mapB, pngA, pngB, ctx, cropSeq } = args;
  const { img, outDir, minWidth, minHeight, maxHeight, zoomBelow } = ctx;
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
  const composite = compositePair(before.png, after.png);
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
    const annotated = compositePair(annotatedBefore.png, annotatedAfter.png);
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
  const ctxLabel = formatSurfaceWithContext(sd.surface, mapA, mapB);

  // A sub-pixel change (e.g. a 2px font bump on a caret) is invisible at 1:1, so when
  // the changed-element footprint is small, add a magnified crop that makes it obvious
  // without the reviewer hunting. Anchored on the leaf rects.
  const changed = unionRects([...rectsA, ...rectsB]);
  const maxDim = changed ? Math.max(changed.w, changed.h) : 0;
  let zoomFactor = 0;
  if (zoomBelow > 0 && changed && maxDim > 0 && maxDim <= zoomBelow) {
    const zBox = pad(changed, Math.max(maxDim, 16)); // ~3× the change for context
    zoomFactor = Math.min(8, Math.max(2, Math.round(240 / Math.max(zBox.w, zBox.h))));
    const zoom = compositePair(zoomCrop(pngA, zBox, rectsA, zoomFactor), zoomCrop(pngB, zBox, rectsB, zoomFactor));
    writePng(path.join(outDir, `${stem}-zoom.png`), zoom);
    images.zoom = `${stem}-zoom.png`;
  }

  // Both views shown by default: the clean before|after (the real UI) and the
  // highlighted twin (magenta boxes on each change) so a reviewer sees WHAT changed and
  // WHERE without expanding anything. Plain images (no link wrap) so a click opens the
  // full-resolution file.
  const md = [
    '',
    `![before ◀ │ ▶ after](${img(images.composite!)})`,
    '',
    `<sub>◀ before  ·  after ▶ — ${ctxLabel}</sub>`,
  ];
  if (images.annotated) {
    md.push(
      '',
      `![highlighted before ◀ │ ▶ after](${img(images.annotated)})`,
      '',
      `<sub>🔍 magenta boxes mark each change${changedLabel}</sub>`,
    );
  }
  if (images.zoom) {
    md.push(
      '',
      `![zoomed before ◀ │ ▶ after](${img(images.zoom)})`,
      '',
      `<sub>🔬 magnified ${zoomFactor}× — change too small to see at 1:1${changedLabel}</sub>`,
    );
  }
  return { md, images };
}

// Render one crop region: its heading, the surface list, the before/after imagery (or a
// note when there's nothing to show), and the per-crop change tables.
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
}): { md: string[]; regionJson: Record<string, unknown> } {
  const { g, cg, mapA, mapB, pngA, pngB, describeCtx, ctx, cropSeq } = args;
  const { sd } = cg.rep;
  // Exactly the findings whose element lives inside THIS crop, so the tables sit
  // directly under the screenshot that shows them — never a wall of changes spanning
  // several crops with no way to tell which is which.
  const regionFindings = cg.rep.findings.filter((f) =>
    g.paths.some((root) => f.path === root || f.path.startsWith(root + ' > ')),
  );

  const surfaceList =
    cg.surfaces.length > 1
      ? `_Identical across ${cg.surfaces.length} surfaces: ${formatSurfaceListWithContext(cg.surfaces, ctx.beforeDir)}_`
      : `_${formatSurfaceWithContext(sd.surface, mapA, mapB)}_`;

  const md: string[] = ['', `### ${regionHeading(g.paths, regionFindings)}`, '', surfaceList];

  const region = visible(g.after) ? g.after : g.before;
  let images: { composite?: string; annotated?: string; zoom?: string } = {};
  if (region && pngA && pngB) {
    const built = buildRegionImages({ g, region, regionFindings, sd, mapA, mapB, pngA, pngB, ctx, cropSeq });
    md.push(...built.md);
    images = built.images;
  } else if (!region) {
    md.push('', '_Changed element is not visible in this state (zero-size box) — see the property list._');
  } else {
    md.push(
      '',
      '_No screenshots in these capture sets (run captures with `screenshots: true` for side-by-side crops)._',
    );
  }

  // What this crop changed: plain-English bullets, then the property tables — folded
  // under a toggle once they'd be a wall (foldDetailsAt).
  md.push(...renderCropChanges(regionFindings, ctx.foldDetailsAt, describeCtx));
  return { md, regionJson: { paths: g.paths, before: g.before, after: g.after, images } };
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
  const mapA = loadStyleMap(findCapture(ctx.beforeDir, sd.surface));
  const mapB = loadStyleMap(findCapture(ctx.afterDir, sd.surface));
  // Theme-token reverse-indexes so colour changes can name `red-200` per side.
  const describeCtx: DescribeCtx = { tokensBefore: tokenIndex(mapA.tokens), tokensAfter: tokenIndex(mapB.tokens) };
  const changedPaths = outermost([...new Set(surfaceFindings.map((f) => f.path))]);
  if (!hasExposedChangedEntry(mapA, mapB, changedPaths)) {
    const reason =
      'The changed element is not visibly painted in this representative state (it is hidden at this breakpoint or is background content behind an active modal), so a before/after crop would be misleading.';
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
    cropSeq++;
    const r = renderRegion({ g, cg, mapA, mapB, pngA, pngB, describeCtx, ctx, cropSeq });
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
  const md: string[] = [
    '',
    `### \`${safeKey(p.sd.surface)}\` · new surface ${NEW_SURFACE_MARKER}`,
    '',
    `_${formatSurfaceWithContext(p.sd.surface, map)}_`,
  ];
  const json: Record<string, unknown> = { surface: p.sd.surface, missing: p.sd.missing, isNew: true };
  if (png) {
    cropSeq++;
    const h = Math.min(maxHeight, png.height, map.viewport?.height ?? png.height);
    const crop = cropPng(png, { x: 0, y: 0, w: png.width, h }, png.width, h).png;
    const stem = `crops/${p.sd.surface.replace(/[^a-z0-9-]/gi, '-')}-${cropSeq}-new`;
    writePng(path.join(outDir, `${stem}.png`), crop);
    md.push(
      '',
      `![new surface — ${side}](${img(`${stem}.png`)})`,
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
    `_No baseline to compare against — this surface is new. Review and approve it before it becomes part of the baseline._`,
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

export function generateStyleMapReport(opts: ReportOptions): ReportResult {
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
  } = opts;

  const includeNoise = opts.includeLayoutNoise ?? false;
  const includeContent = opts.includeContent ?? false;
  // Base first, head second: current capture metadata is authoritative when a
  // surface's product key changed between revisions.
  const surfaceKeyOf = mergeSurfaceKeyLookup(beforeDir, afterDir);
  const { surfaces, volatile: volatileCount } = diffStyleMapDirs(beforeDir, afterDir);
  const liveCandidateLabels = volatileCount > 0 ? collectLiveCandidateLabels(beforeDir, afterDir) : [];
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });

  // Focus each surface on styling intent: drop reflow-casualty props, suppress
  // forced-state echoes of base changes, and remove non-value noise (see
  // cleanFindings), unless includeLayoutNoise is set. Surfaces left with no real
  // change are dropped.
  const prepared: PreparedSurface[] = surfaces
    .map((sd) => ({
      sd,
      findings: sd.missing || includeNoise ? sd.findings : cleanFindings(sd.findings),
    }))
    .filter((p) => p.sd.missing || p.findings.length > 0);

  const missing = prepared.filter((p) => p.sd.missing);
  const changeGroups = groupBySignature(prepared, beforeDir, afterDir);
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
    ? renderContentSection({ beforeDir, afterDir, outDir, img, padBy, minWidth, minHeight, maxHeight })
    : { md: [], count: 0 };

  md.push('## 🗺️ StyleProof report', '');
  // Lead with the source-of-truth gates (coverage / determinism / inventory) so a
  // reviewer reads "is this green trustworthy?" before the pixel details.
  md.push(...certificationLines(beforeDir, afterDir));
  md.push(
    ...reportHeadline({
      changeGroups,
      missing,
      shown,
      changedScope,
      volatileCount,
      liveCandidateLabels,
      contentCount: contentSection.count,
      baselineSurfaceFailures,
    }),
  );

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
  md.push(...contentSection.md);

  const reportMdPath = path.join(outDir, 'report.md');
  const reportJsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportMdPath, md.join('\n') + '\n');
  fs.writeFileSync(reportJsonPath, JSON.stringify({ counts: shown, surfaces: json }, null, 2));
  return {
    changedSurfaces: prepared.length - missing.length,
    newSurfaces: missing.length,
    totalFindings,
    contentChanges: contentSection.count,
    reportMdPath,
    reportJsonPath,
  };
}

function findCapture(dir: string, surface: string): string {
  for (const ext of ['.json.gz', '.json']) {
    const p = path.join(dir, surface + ext);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no capture for ${surface} in ${dir}`);
}
