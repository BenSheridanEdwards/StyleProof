import fs from 'node:fs';
import path from 'node:path';
import type { PNG } from 'pngjs';
import { loadStyleMap, type ElementEntry, type LiveRegionCandidate, type StyleMap } from '../capture.js';
import type { Finding, SurfaceDiff } from '../diff.js';
import { isMapFile } from '../map-store.js';
import { formatSurfaceList, pushSurfaceWidth, renderSurfaceGroups, surfaceBase } from '../change-groups.js';
import type { LiveTextAudit } from '../live-text.js';
import { isSameOrDescendant, rectToBox, visible } from './geometry.js';
import { readPng } from './png.js';

/** Loads a surface's style map from a capture dir, cached for the run. */
export type MapLoader = (dir: string, surface: string) => StyleMap;

export function findCapture(dir: string, surface: string): string {
  for (const ext of ['.json.gz', '.json']) {
    const p = path.join(dir, surface + ext);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no capture for ${surface} in ${dir}`);
}

export function createMapLoader(): MapLoader {
  const cache = new Map<string, StyleMap>();
  return (dir, surface) => {
    const key = path.join(dir, surface);
    if (!cache.has(key)) cache.set(key, loadStyleMap(findCapture(dir, surface)));
    return cache.get(key)!;
  };
}

/** Dirs, dimensions and loaders threaded through every render helper. */
export type RenderCtx = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  img: (rel: string) => string;
  load: MapLoader;
  padBy: number;
  minWidth: number;
  minHeight: number;
  maxHeight: number;
  zoomBelow: number;
  maxCrops: number;
  foldDetailsAt: number;
  liveText: LiveTextAudit;
  includeNoise: boolean;
  requireStateIdentity: boolean;
};

/** The before/after screenshots for a surface (`suffix` picks a forced-state layer). */
export function screenshotPair(ctx: RenderCtx, surface: string, suffix = ''): [PNG | null, PNG | null] {
  return [
    readPng(path.join(ctx.beforeDir, `${surface}${suffix}.png`)),
    readPng(path.join(ctx.afterDir, `${surface}${suffix}.png`)),
  ];
}

/** A prepared surface: its diff plus the findings kept after noise-cleaning. */
export type PreparedSurface = { sd: SurfaceDiff; findings: Finding[] };
/** Surfaces that changed the SAME way, collapsed to one group with a representative. */
export type ChangeGroup = { surfaces: string[]; rep: PreparedSurface; findings: Finding[] };

export type ReportConsistency =
  | { ok: true; reason: 'aligned' }
  | { ok: false; reason: 'raw_only_no_reviewable' | 'presentation_collapsed_while_raw_reviewable' };

const VARIANT_LABEL: Record<string, string> = {
  'live-state': 'live state',
  popup: 'popup',
  'state-recipe': 'state recipe',
};

export function surfaceContext(...maps: Array<StyleMap | undefined>): string {
  const metadata = maps.find((m) => m?.metadata)?.metadata;
  if (!metadata?.variantKey) return '';
  return `${VARIANT_LABEL[metadata.variantKind ?? ''] ?? 'variant'} \`${metadata.variantKey}\``;
}

export function formatSurfaceWithContext(surface: string, ...maps: Array<StyleMap | undefined>): string {
  const context = surfaceContext(...maps);
  return context ? `${formatSurfaceList([surface])} · ${context}` : formatSurfaceList([surface]);
}

export function formatSurfaceListWithContext(ctx: RenderCtx, surfaces: string[]): string {
  const byBase = new Map<string, number[]>();
  for (const surface of surfaces) {
    const context = surfaceContext(ctx.load(ctx.beforeDir, surface));
    pushSurfaceWidth(byBase, context ? `${surfaceBase(surface)} · ${context}` : surfaceBase(surface), surface);
  }
  return renderSurfaceGroups(byBase);
}

/** `tag.first-class` or `tag`. */
export const shortElementName = (e: { tag: string; cls?: string }): string =>
  e.cls ? `${e.tag}.${e.cls.split(/\s+/)[0]}` : e.tag;

const liveCandidateLabel = (c: LiveRegionCandidate): string => `${shortElementName(c)} (${c.reason})`;

export function collectLiveCandidateLabels(beforeDir: string, afterDir: string): string[] {
  const seen = new Set<string>();
  for (const dir of [beforeDir, afterDir]) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(isMapFile) : [];
    for (const file of files) {
      for (const candidate of loadStyleMap(path.join(dir, file)).liveCandidates ?? []) {
        seen.add(liveCandidateLabel(candidate));
      }
    }
  }
  return [...seen].sort();
}

/** A changed element can anchor visual proof only when the captured page can show it. */
function isPaintedEntry(map: StyleMap, entry: ElementEntry | undefined): boolean {
  if (!entry?.rect || !visible(rectToBox(entry.rect))) return false;
  if (entry.style.display === 'none' || entry.style.visibility === 'hidden') return false;
  if (Number(entry.style.opacity ?? '1') <= 0) return false;
  const [x, y, width, height] = entry.rect;
  if (x + width <= 0 || y + height <= 0) return false;
  return map.viewport?.width === undefined || x < map.viewport.width;
}

/** Background behind an active modal is unsuitable as proof; content inside the modal stays eligible. */
function isBehindActiveModal(map: StyleMap, changedPath: string): boolean {
  return (map.overlays ?? []).some((o) => o.ariaModal === 'true' && !isSameOrDescendant(changedPath, o.path));
}

const isExposed = (map: StyleMap, p: string): boolean =>
  isPaintedEntry(map, map.elements[p]) && !isBehindActiveModal(map, p);

export function hasExposedChangedEntry(mapA: StyleMap, mapB: StyleMap, changedPaths: string[]): boolean {
  return changedPaths.some((p) => isExposed(mapA, p) || isExposed(mapB, p));
}

export const hasActiveModal = (...maps: StyleMap[]): boolean =>
  maps.some((m) => (m.overlays ?? []).some((o) => o.ariaModal === 'true'));
