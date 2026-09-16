import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { STATE_LAYER_NAMES, stateLayerScreenshotPath, type Rect, type StyleMap } from './capture.js';

/**
 * Pixel gate: compare the screenshots a capture already writes (`<surface>.png`
 * plus the forced-state layers) and attribute every changed region to the
 * captured elements under it. Pixels are the EFFECT signal (image content, canvas
 * paint, font rasterisation) and need no element correspondence. Deterministic
 * captures render byte-identical, so only anti-aliasing noise is tolerated: a
 * YIQ distance under `threshold`, and regions smaller than `minRegionPixels`.
 */

/** Defaults: threshold 0.1 (YIQ distance, pixelmatch convention), minRegionPixels 4 (smaller is anti-aliasing noise), cell 8 (px clustering grid), attributionLimit 3 (element paths per region). */
export type PixelOptions = { threshold?: number; minRegionPixels?: number; cell?: number; attributionLimit?: number };

/** A captured element under a changed region: its structural path and class list. */
export type AttributedElement = { path: string; cls: string };

export type PixelRegion = {
  /** Document-space bounding box of the changed region: [x, y, width, height]. */
  rect: Rect;
  changedPixels: number;
  /** Captured elements whose box covers the region, smallest box first. */
  elements: AttributedElement[];
};

export type PixelLayer = 'rest' | (typeof STATE_LAYER_NAMES)[number];

export type PixelComparison = {
  /** Compared area: the overlap of both screenshots. */
  width: number;
  height: number;
  /** Set when the screenshots differ in size — the non-overlapping band counts as changed. */
  sizeMismatch?: { before: [number, number]; after: [number, number] };
  changedPixels: number;
  comparedPixels: number;
  regions: PixelRegion[];
};

export type PixelLayerResult =
  | { layer: PixelLayer; status: 'compared'; comparison: PixelComparison }
  | { layer: PixelLayer; status: 'missing-before' | 'missing-after' };

export type PixelSurfaceResult = {
  surface: string;
  layers: PixelLayerResult[];
  /** Regions across every compared layer. */
  regionCount: number;
  /** Layers with a screenshot on one side only — the gate cannot certify those. */
  uncompared: PixelLayer[];
};

const DEFAULTS = { threshold: 0.1, minRegionPixels: 4, cell: 8, attributionLimit: 3 };

// Colour distance (YIQ, pixelmatch convention): RGB→YIQ rows, then weighted squared difference.
const RGB_TO_YIQ = [
  [0.29889531, 0.58662247, 0.11448223],
  [0.59597799, -0.2741761, -0.32180189],
  [0.21147017, -0.52261711, 0.31114694],
];
const YIQ_WEIGHTS = [0.5053, 0.299, 0.1957];

/** The pixel at byte offset `k`, alpha-blended onto white, as [y, i, q]. */
function yiq(data: Uint8Array, k: number): number[] {
  const alpha = data[k + 3]! / 255;
  const rgb = [0, 1, 2].map((c) => 255 + (data[k + c]! - 255) * alpha);
  return RGB_TO_YIQ.map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);
}

/** Perceptual distance between the pixels at byte offset `k` (a) and `m` (b). */
function colorDelta(a: Uint8Array, b: Uint8Array, k: number, m: number): number {
  const p = yiq(a, k);
  const q = yiq(b, m);
  return YIQ_WEIGHTS.reduce((sum, w, i) => sum + w * (p[i] - q[i]) ** 2, 0);
}

type Cluster = { minX: number; minY: number; maxX: number; maxY: number; changed: number };

const NEIGHBOURS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/** Grow one 4-connected cluster of changed cells from `start`, marking cells as seen. */
function floodFillCluster(
  start: number,
  cellCounts: Uint32Array,
  seen: Uint8Array,
  cols: number,
  rows: number,
): Cluster {
  const cluster: Cluster = { minX: cols, minY: rows, maxX: -1, maxY: -1, changed: 0 };
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const index = stack.pop()!;
    const cx = index % cols;
    const cy = (index - cx) / cols;
    cluster.changed += cellCounts[index]!;
    cluster.minX = Math.min(cluster.minX, cx);
    cluster.minY = Math.min(cluster.minY, cy);
    cluster.maxX = Math.max(cluster.maxX, cx);
    cluster.maxY = Math.max(cluster.maxY, cy);
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const neighbour = ny * cols + nx;
      if (!cellCounts[neighbour] || seen[neighbour]) continue;
      seen[neighbour] = 1;
      stack.push(neighbour);
    }
  }
  return cluster;
}

/** Scale a cell-space cluster back to pixel space, clamped to the compared area. */
const toPixelSpace = (c: Cluster, cell: number, width: number, height: number): Cluster => ({
  ...c,
  minX: c.minX * cell,
  minY: c.minY * cell,
  maxX: Math.min(width, (c.maxX + 1) * cell),
  maxY: Math.min(height, (c.maxY + 1) * cell),
});

/** Flood-fill 4-connected grid cells that contain changed pixels into bounding boxes. */
function clusterCells(
  cellCounts: Uint32Array,
  cols: number,
  rows: number,
  cell: number,
  width: number,
  height: number,
): Cluster[] {
  const seen = new Uint8Array(cols * rows);
  const clusters: Cluster[] = [];
  for (let start = 0; start < cellCounts.length; start++) {
    if (cellCounts[start] && !seen[start]) clusters.push(floodFillCluster(start, cellCounts, seen, cols, rows));
  }
  return clusters.map((c) => toPixelSpace(c, cell, width, height));
}

type ChangedCells = { cols: number; rows: number; cellCounts: Uint32Array; changedPixels: number };

/** Count changed pixels over the shared area, bucketed into grid cells. */
function countChangedCells(
  before: PNG,
  after: PNG,
  width: number,
  height: number,
  maxDelta: number,
  cell: number,
): ChangedCells {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const cellCounts = new Uint32Array(cols * rows);
  let changedPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * before.width + x) << 2;
      const m = (y * after.width + x) << 2;
      if (colorDelta(before.data, after.data, k, m) <= maxDelta) continue;
      changedPixels++;
      cellCounts[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
    }
  }
  return { cols, rows, cellCounts, changedPixels };
}

/** The band present on one side only (a page that grew or shrank) is one whole region. */
function sizeMismatchRegion(before: PNG, after: PNG, width: number, height: number): PixelRegion {
  const bandWidth = Math.max(before.width, after.width);
  const bandHeight = Math.max(before.height, after.height);
  const changedPixels = bandWidth * bandHeight - width * height;
  const rect: Rect =
    after.height !== before.height
      ? [0, height, bandWidth, bandHeight - height]
      : [width, 0, bandWidth - width, bandHeight];
  return { rect, changedPixels, elements: [] };
}

/** Compare two decoded PNGs. Regions carry no element attribution yet. */
export function comparePngs(before: PNG, after: PNG, options: PixelOptions = {}): PixelComparison {
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const minRegionPixels = options.minRegionPixels ?? DEFAULTS.minRegionPixels;
  const cell = options.cell ?? DEFAULTS.cell;
  const width = Math.min(before.width, after.width);
  const height = Math.min(before.height, after.height);

  const counted = countChangedCells(before, after, width, height, 35215 * threshold * threshold, cell);
  const regions: PixelRegion[] = clusterCells(counted.cellCounts, counted.cols, counted.rows, cell, width, height)
    .filter((c) => c.changed >= minRegionPixels)
    .map((c) => ({ rect: [c.minX, c.minY, c.maxX - c.minX, c.maxY - c.minY], changedPixels: c.changed, elements: [] }));

  let changedPixels = counted.changedPixels;
  const mismatched = before.width !== after.width || before.height !== after.height;
  if (mismatched) {
    const band = sizeMismatchRegion(before, after, width, height);
    changedPixels += band.changedPixels;
    regions.push(band);
  }
  return {
    width,
    height,
    ...(mismatched
      ? { sizeMismatch: { before: [before.width, before.height], after: [after.width, after.height] } }
      : {}),
    changedPixels,
    comparedPixels: width * height,
    regions,
  };
}

/** Compare two PNG files on disk. */
export function comparePngFiles(beforePath: string, afterPath: string, options: PixelOptions = {}): PixelComparison {
  return comparePngs(PNG.sync.read(fs.readFileSync(beforePath)), PNG.sync.read(fs.readFileSync(afterPath)), options);
}

const intersects = ([ax, ay, aw, ah]: Rect, [bx, by, bw, bh]: Rect): boolean =>
  ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

/** Elements whose box intersects `rect`, smallest first (innermost named before its containers); `html`/`body` skipped. */
export function attributeRegion(map: StyleMap, rect: Rect, limit = DEFAULTS.attributionLimit): AttributedElement[] {
  const candidates: Array<{ path: string; cls: string; area: number }> = [];
  for (const [elementPath, element] of Object.entries(map.elements)) {
    if (!element.rect || elementPath === 'html' || elementPath === 'body') continue;
    const [, , w, h] = element.rect;
    if (w <= 0 || h <= 0 || !intersects(element.rect, rect)) continue;
    candidates.push({ path: elementPath, cls: element.cls, area: w * h });
  }
  return candidates
    .sort((a, b) => a.area - b.area || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ path: elementPath, cls }) => ({ path: elementPath, cls }));
}

/** Attribute every region: head-side elements first, base-side when the head has none there. */
function attributeComparison(
  comparison: PixelComparison,
  before: StyleMap,
  after: StyleMap,
  limit?: number,
): PixelComparison {
  return {
    ...comparison,
    regions: comparison.regions.map((region) => {
      const head = attributeRegion(after, region.rect, limit);
      return { ...region, elements: head.length ? head : attributeRegion(before, region.rect, limit) };
    }),
  };
}

const LAYERS: PixelLayer[] = ['rest', ...STATE_LAYER_NAMES];

function layerPath(dir: string, surface: string, layer: PixelLayer): string {
  const stem = path.join(dir, surface);
  return layer === 'rest' ? `${stem}.png` : stateLayerScreenshotPath(stem, layer);
}

/** Compare every screenshot layer of one paired surface; a layer on one side only is reported as uncompared. */
export function pixelDiffSurface(
  dirA: string,
  dirB: string,
  surface: string,
  before: StyleMap,
  after: StyleMap,
  options: PixelOptions = {},
): PixelSurfaceResult {
  const layers: PixelLayerResult[] = [];
  for (const layer of LAYERS) {
    const beforePath = layerPath(dirA, surface, layer);
    const afterPath = layerPath(dirB, surface, layer);
    const hasBefore = fs.existsSync(beforePath);
    const hasAfter = fs.existsSync(afterPath);
    if (!hasBefore && !hasAfter) continue;
    if (!hasBefore || !hasAfter) {
      layers.push({ layer, status: hasBefore ? 'missing-after' : 'missing-before' });
      continue;
    }
    const comparison = attributeComparison(
      comparePngFiles(beforePath, afterPath, options),
      before,
      after,
      options.attributionLimit,
    );
    layers.push({ layer, status: 'compared', comparison });
  }
  return {
    surface,
    layers,
    regionCount: layers.reduce((n, l) => n + (l.status === 'compared' ? l.comparison.regions.length : 0), 0),
    uncompared: layers.filter((l) => l.status !== 'compared').map((l) => l.layer),
  };
}
