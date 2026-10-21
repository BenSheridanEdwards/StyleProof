/**
 * Visible element additions/removals on paired surfaces elevate into the
 * shared reviewable path (STYLE_REVIEW_REQUIRED / styleproof-diff exit 1).
 *
 * Invisible or zero-size DOM churn, pure text-content changes, retags, and
 * live/age/clock regions keep their existing advisory handling.
 */
import { isUnder, type ElementEntry, type StyleMap } from './capture.js';
import type { ContentChange } from './diff.js';
import { concreteContentChanges, contentSurfaces, type ContentSurface } from './report/content-layer.js';
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

function intersectsCapturedArea(rect: ElementEntry['rect'], viewport: StyleMap['viewport'], bottom: number): boolean {
  if (!rect) return false;
  const [x, y, w, h] = rect;
  if (!(w > 0 && h > 0)) return false;
  if (!viewport) return true;
  if (!(
    typeof viewport.width === 'number' &&
    typeof viewport.height === 'number' &&
    viewport.width > 0 &&
    viewport.height > 0
  ))
    return true;
  const { width } = viewport;
  const scrollX = viewport.scrollX ?? 0;
  const scrollY = viewport.scrollY ?? 0;
  const top = Math.min(0, scrollY);
  return !(x >= scrollX + width || x + w <= scrollX || y >= bottom || y + h <= top);
}

/** True when a non-hidden entry's driven or screenshot box intersects its captured area. */
export function isVisibleCapturedElement(
  entry: Pick<ElementEntry, 'rect' | 'screenshotRect' | 'style'>,
  map?: Pick<StyleMap, 'viewport'> | null,
): boolean {
  const style = entry.style ?? {};
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  const opacityRaw = style.opacity;
  if (opacityRaw !== undefined) {
    const opacity = Number.parseFloat(opacityRaw);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
  }
  const viewport = map?.viewport;
  // Preserve the original driven check: expansion must never make the gate laxer.
  const drivenBottom = Math.max(
    (viewport?.scrollY ?? 0) + (viewport?.height ?? 0),
    viewport?.documentHeight ?? Infinity,
  );
  // Missing or invalid screenshot heights fail closed, even with a driven document height.
  const screenshotHeight = viewport?.screenshotHeight;
  const screenshotBottom =
    typeof screenshotHeight === 'number' && Number.isFinite(screenshotHeight) && screenshotHeight > 0
      ? screenshotHeight
      : Infinity;
  return (
    intersectsCapturedArea(entry.rect, viewport, drivenBottom) ||
    intersectsCapturedArea(entry.screenshotRect ?? entry.rect, viewport, screenshotBottom)
  );
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

function isOneSided(change: ContentChange): change is StructureChange {
  return change.kind === 'structure' && (change.change === 'added' || change.change === 'removed');
}

function isVisibleOneSided(change: StructureChange, mapA: StyleMap, mapB: StyleMap): boolean {
  const { entry, map } = entryForChange(change, mapA, mapB);
  return !!entry && isVisibleCapturedElement(entry, map);
}

/**
 * A root with no box of its own (display:contents, a wrapper around a fixed child)
 * still elevates when a same-direction change folded into it is visible (#950).
 */
function isElevatableVisibleStructure(
  change: ContentChange,
  mapA: StyleMap,
  mapB: StyleMap,
  concrete: () => ContentChange[],
): change is StructureChange {
  if (!isOneSided(change)) return false;
  if (isVisibleOneSided(change, mapA, mapB)) return true;
  return concrete().some(
    (c) =>
      isOneSided(c) && c.change === change.change && isUnder(c.path, [change.path]) && isVisibleOneSided(c, mapA, mapB),
  );
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
    // contentSurfaces folds one-sided descendants into their root; unfold only on demand.
    let concrete: ContentChange[] | undefined;
    const unfolded = (): ContentChange[] => (concrete ??= concreteContentChanges(mapA, mapB));
    for (const c of changes) {
      if (!isElevatableVisibleStructure(c, mapA, mapB, unfolded)) continue;
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
