/**
 * #766 A-narrowed: elevate Global chrome *navigable* additions into the shared
 * reviewable path (STYLE_REVIEW_REQUIRED / styleproof-diff exit 1).
 *
 * Non-navigable Global chrome and per-surface-only structure stay advisory.
 * Ambiguous multi-base navigable adds fail closed toward reviewable.
 * Soft-pass HOLD — Approve still clears only STYLE_REVIEW_REQUIRED.
 */
import { mergeSurfaceKeyLookup, surfaceElementPaths, type ElementEntry } from './capture.js';
import { countCapturedSurfaceBases } from './change-groups.js';
import type { ContentChange } from './diff.js';
import {
  contentHostingSurfacePaths,
  contentSurfaces,
  splitChromeStructure,
  type ChromeStructureChange,
} from './report/content-layer.js';
import { createMapLoader, type RenderCtx } from './report/shared.js';
import { emptyLiveTextAudit } from './live-text.js';

type StructureChange = Extract<ContentChange, { kind: 'structure' }>;

const NAV_CLASS_RE = /navtab|nav-tab|subnav|subtab|\btabs\b|\btab\b|menuitem|sidebar/i;

/** Inventory-class element from captured entry + path (no live DOM). */
export function isInventoryClassElement(entry: Pick<ElementEntry, 'tag' | 'cls'>, path: string): boolean {
  const tag = entry.tag.toLowerCase();
  if (tag === 'a') return true;
  if (tag !== 'button') return false;
  if (NAV_CLASS_RE.test(entry.cls ?? '')) return true;
  // Buttons under a nav/sidebar/tablist path match Inventory's nav-button harvest.
  if (/nav|sidebar|tablist|menubar/i.test(path)) return true;
  return false;
}

export type ElevatedNavigableChrome = {
  elevated: ChromeStructureChange[];
  /** Count of elevated navigable additions (reviewable). */
  count: number;
};

function oneSidedIdentity(c: StructureChange): string {
  return `${c.change}\0${c.path}\0${c.cls}`;
}

function gateRenderCtx(beforeDir: string, afterDir: string): RenderCtx {
  return {
    beforeDir,
    afterDir,
    outDir: afterDir,
    img: (rel) => rel,
    load: createMapLoader(),
    padBy: 0,
    minWidth: 0,
    minHeight: 0,
    maxHeight: 10_000,
    zoomBelow: 0,
    maxCrops: 0,
    foldDetailsAt: 0,
    liveText: emptyLiveTextAudit(),
    includeNoise: false,
    requireStateIdentity: false,
  };
}

function headEntryFor(
  load: RenderCtx['load'],
  afterDir: string,
  surfaces: string[],
  change: StructureChange,
): ElementEntry | undefined {
  for (const surface of surfaces) {
    try {
      const entry = load(afterDir, surface).elements[change.path];
      if (entry) return entry;
    } catch {
      // missing map — keep looking
    }
  }
  return undefined;
}

function looksNavigableWithoutEntry(change: StructureChange): boolean {
  // Fail closed when the head entry is missing but the path/class still looks like an affordance.
  return (
    /\ba:nth-child|\ba\.| > a:|\[role=["']?(?:tab|menuitem)/i.test(change.path) || /link|nav|tab/i.test(change.cls)
  );
}

function isNavigableAddition(change: StructureChange, entry: ElementEntry | undefined): boolean {
  if (change.change !== 'added') return false;
  if (!entry) return looksNavigableWithoutEntry(change);
  return isInventoryClassElement(entry, change.path);
}

/**
 * Collect Global chrome navigable *additions* that must elevate to reviewable,
 * plus multi-base navigable adds that chromeHosted failed to collapse (fail-closed).
 */
export function collectElevatedNavigableChromeAdds(opts: {
  beforeDir: string;
  afterDir: string;
  surfacePaths?: Map<string, Set<string>>;
  surfaceKeyOf?: (captureKey: string) => string | undefined;
}): ElevatedNavigableChrome {
  const { beforeDir, afterDir } = opts;
  const surfaceKeyOf = opts.surfaceKeyOf ?? mergeSurfaceKeyLookup(beforeDir, afterDir);
  const surfacePaths = opts.surfacePaths ?? surfaceElementPaths(beforeDir, afterDir);
  const ctx = gateRenderCtx(beforeDir, afterDir);

  const withContent = contentSurfaces(ctx);
  const hosting = contentHostingSurfacePaths(beforeDir, afterDir, surfacePaths);
  const split = splitChromeStructure(withContent, hosting, surfaceKeyOf);

  const elevated: ChromeStructureChange[] = [];
  const seen = new Set<string>();

  const consider = (entry: ChromeStructureChange) => {
    const id = oneSidedIdentity(entry.change);
    if (seen.has(id)) return;
    const head = headEntryFor(ctx.load, afterDir, entry.surfaces, entry.change);
    if (!isNavigableAddition(entry.change, head)) return;
    seen.add(id);
    elevated.push(entry);
  };

  for (const c of split.chrome) consider(c);

  // Fail-closed: navigable additions that hit ≥2 surface bases but were not chrome-promoted
  // (collapse residual / ambiguous host coverage) still elevate.
  const byIdentity = new Map<string, { change: StructureChange; surfaces: string[] }>();
  for (const { surface, changes } of withContent) {
    for (const c of changes) {
      if (c.kind !== 'structure' || c.change !== 'added') continue;
      const id = oneSidedIdentity(c);
      const row = byIdentity.get(id) ?? { change: c, surfaces: [] };
      row.surfaces.push(surface);
      byIdentity.set(id, row);
    }
  }
  for (const row of byIdentity.values()) {
    const bases = countCapturedSurfaceBases(row.surfaces, surfaceKeyOf);
    if (bases < 2) continue;
    consider({ change: row.change, surfaces: row.surfaces, bases });
  }

  return { elevated, count: elevated.length };
}

/** Merge elevated navigable chrome adds into reviewableCounts.dom (shared certification path). */
export function withElevatedChromeReviewableCounts(
  reviewableCounts: { dom: number; style: number; state: number },
  elevatedCount: number,
): { dom: number; style: number; state: number } {
  if (elevatedCount <= 0) return reviewableCounts;
  return { ...reviewableCounts, dom: reviewableCounts.dom + elevatedCount };
}
