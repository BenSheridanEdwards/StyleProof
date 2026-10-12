/**
 * Visible element additions/removals on paired surfaces elevate into the
 * shared reviewable path (STYLE_REVIEW_REQUIRED / styleproof-diff exit 1).
 *
 * Invisible or zero-size DOM churn, pure text-content changes, retags, and
 * live/age/clock regions keep their existing advisory handling.
 */
import { type ElementEntry, type StyleMap } from './capture.js';
import type { ContentChange } from './diff.js';
import { contentSurfaces, type ContentSurface } from './report/content-layer.js';
import { structureGateRenderCtx } from './report/shared.js';

type StructureChange = Extract<ContentChange, { kind: 'structure' }>;

export type ElevatedVisibleStructure = {
  surface: string;
  change: StructureChange;
};

export type ElevatedVisibleStructureResult = {
  elevated: ElevatedVisibleStructure[];
  /** Count of unique visible added/removed elements (reviewable). */
  count: number;
};

function intersectsCapturedViewport(
  rect: NonNullable<ElementEntry['rect']>,
  viewport: NonNullable<StyleMap['viewport']>,
): boolean {
  const [x, y, w, h] = rect;
  const { width, height } = viewport;
  const scrollX = viewport.scrollX ?? 0;
  const scrollY = viewport.scrollY ?? 0;
  // Intersect document-space boxes with the viewport the surface actually reached.
  return !(x >= scrollX + width || y >= scrollY + height || x + w <= scrollX || y + h <= scrollY);
}

/** True when the captured entry has a non-zero box, is not hidden, and intersects the capture viewport. */
export function isVisibleCapturedElement(
  entry: Pick<ElementEntry, 'rect' | 'style'>,
  map?: Pick<StyleMap, 'viewport'> | null,
): boolean {
  if (!entry.rect) return false;
  const [, , w, h] = entry.rect;
  if (!(w > 0 && h > 0)) return false;
  const style = entry.style ?? {};
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  const opacityRaw = style.opacity;
  if (opacityRaw !== undefined) {
    const opacity = Number.parseFloat(opacityRaw);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
  }
  const viewport = map?.viewport;
  if (!viewport) return true;
  const { width: vw, height: vh } = viewport;
  if (typeof vw === 'number' && typeof vh === 'number' && vw > 0 && vh > 0) {
    return intersectsCapturedViewport(entry.rect, viewport);
  }
  return true;
}

export function structureChangeIdentity(change: Pick<StructureChange, 'change' | 'path' | 'cls'>): string {
  return `${change.change}\0${change.path}\0${change.cls}`;
}

function entryForChange(
  change: StructureChange,
  mapA: StyleMap,
  mapB: StyleMap,
): { entry: ElementEntry | undefined; map: StyleMap } {
  if (change.change === 'added') return { entry: mapB.elements[change.path], map: mapB };
  return { entry: mapA.elements[change.path], map: mapA };
}

function isElevatableVisibleStructure(
  change: ContentChange,
  mapA: StyleMap,
  mapB: StyleMap,
): change is StructureChange {
  if (change.kind !== 'structure') return false;
  if (change.change !== 'added' && change.change !== 'removed') return false;
  const { entry, map } = entryForChange(change, mapA, mapB);
  if (!entry) return false;
  return isVisibleCapturedElement(entry, map);
}

/**
 * Collect visible added/removed elements on paired surfaces that must elevate
 * to reviewable. Dedupes the same element identity across surfaces.
 */
export function collectElevatedVisibleStructure(opts: {
  beforeDir: string;
  afterDir: string;
  surfacePaths?: Map<string, Set<string>>;
  surfaceKeyOf?: (captureKey: string) => string | undefined;
}): ElevatedVisibleStructureResult {
  const { beforeDir, afterDir } = opts;
  void opts.surfacePaths;
  void opts.surfaceKeyOf;
  const ctx = structureGateRenderCtx(beforeDir, afterDir);
  const withContent: ContentSurface[] = contentSurfaces(ctx);

  const elevated: ElevatedVisibleStructure[] = [];
  const seen = new Set<string>();

  for (const { surface, changes } of withContent) {
    let mapA: StyleMap;
    let mapB: StyleMap;
    try {
      mapA = ctx.load(beforeDir, surface);
      mapB = ctx.load(afterDir, surface);
    } catch {
      continue;
    }
    for (const c of changes) {
      if (!isElevatableVisibleStructure(c, mapA, mapB)) continue;
      const id = structureChangeIdentity(c);
      if (seen.has(id)) continue;
      seen.add(id);
      elevated.push({ surface, change: c });
    }
  }

  return { elevated, count: elevated.length };
}

/** Merge elevated visible structure into reviewableCounts.dom (shared certification path). */
export function withElevatedVisibleStructureCounts(
  reviewableCounts: { dom: number; style: number; state: number },
  elevatedCount: number,
): { dom: number; style: number; state: number } {
  if (elevatedCount <= 0) return reviewableCounts;
  return { ...reviewableCounts, dom: reviewableCounts.dom + elevatedCount };
}

/**
 * Total DOM elevation: every visible add/remove, plus navigable chrome additions
 * that did not already qualify as visible (fail-closed #766 residual).
 */
export function combinedStructureElevationCount(
  visible: ElevatedVisibleStructureResult,
  chromeChanges: ReadonlyArray<Pick<StructureChange, 'change' | 'path' | 'cls'>>,
): number {
  const visibleIds = new Set(visible.elevated.map((e) => structureChangeIdentity(e.change)));
  let chromeExtra = 0;
  for (const change of chromeChanges) {
    if (!visibleIds.has(structureChangeIdentity(change))) chromeExtra++;
  }
  return visible.count + chromeExtra;
}
