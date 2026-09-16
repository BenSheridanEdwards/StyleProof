import type { PNG } from 'pngjs';
import type { Rect } from '../capture.js';
import { pad, unionRects, type Box } from './geometry.js';
import { annotateCrop, cropPng, cropStem, writeComposite, zoomCrop } from './png.js';
import type { RenderCtx } from './shared.js';

/** Relative paths of the images written for one crop region (the report.json sidecar). */
export type CropImages = { composite?: string; annotated?: string; zoom?: string };

export const MISLEADING_CROP_REASON =
  'The changed element is not visible in the captured page (it is outside the screenshot canvas, hidden at this breakpoint, or background content behind an active modal), so a before/after crop would be misleading.';

/** Why a region has no crop, or undefined when it should have one. */
export function cropNote(region: Box | null, pngA: PNG | null, pngB: PNG | null): string | undefined {
  if (!region) return '_Changed element is not visible in this state (zero-size box) — see the property list._';
  if (pngA && pngB) return `_${MISLEADING_CROP_REASON}_`;
  return '_No screenshots in these capture sets (run captures with `screenshots: true` for side-by-side crops)._';
}

export type CropPairSpec = {
  surface: string;
  /** Crop stem suffix after the surface slug: `3`, `content-2`. */
  suffix: string;
  /** The SAME page rectangle on both sides so the pair lines up like-for-like. */
  box: Box;
  pngA: PNG;
  pngB: PNG;
  /** Leaf rects to outline on each side. */
  rectsA: Rect[];
  rectsB: Rect[];
  labels?: { left: string; right: string };
  /** Caption fragments: the pair context, the annotated suffix, the zoom suffix. */
  captions: { pair: string; annotated: string; zoom: (factor: number) => string };
  /** Skip (return null) when the crop renders identically on both sides. */
  skipIdentical?: boolean;
};

function zoomPlan(rectsA: Rect[], rectsB: Rect[], zoomBelow: number): { box: Box; factor: number } | null {
  const changed = unionRects([...rectsA, ...rectsB]);
  const maxDim = changed ? Math.max(changed.w, changed.h) : 0;
  if (zoomBelow <= 0 || !changed || maxDim <= 0 || maxDim > zoomBelow) return null;
  const box = pad(changed, Math.max(maxDim, 16)); // ~3× the change for context
  return { box, factor: Math.min(8, Math.max(2, Math.round(240 / Math.max(box.w, box.h)))) };
}

/**
 * Crop, composite, annotate and (for small changes) zoom one before/after pair,
 * writing the PNGs and returning the image markdown plus the images sidecar.
 * Returns null only for `skipIdentical` pairs whose pixels match.
 */
export function renderCropPair(ctx: RenderCtx, spec: CropPairSpec): { md: string[]; images: CropImages } | null {
  const { box, pngA, pngB, rectsA, rectsB, captions } = spec;
  const left = spec.labels?.left ?? 'before';
  const right = spec.labels?.right ?? 'after';
  const labels: [string, string] = [left, right];
  const w = Math.max(ctx.minWidth, box.w);
  const h = Math.min(ctx.maxHeight, Math.max(ctx.minHeight, box.h));
  const before = cropPng(pngA, box, w, h);
  const after = cropPng(pngB, box, w, h);
  if (spec.skipIdentical && before.png.data.equals(after.png.data)) return null;
  const stem = cropStem(spec.surface, spec.suffix);
  const images: CropImages = { composite: `${stem}-composite.png` };
  writeComposite(ctx.outDir, images.composite!, [before.png, after.png], labels);
  const md = [
    '',
    `![${left} ◀ │ ▶ ${right}](${ctx.img(images.composite!)})`,
    '',
    `<sub>◀ ${left}  ·  ${right} ▶ — ${captions.pair}</sub>`,
  ];

  const annotatedA = annotateCrop(before, rectsA);
  const annotatedB = annotateCrop(after, rectsB);
  if (annotatedA.highlighted || annotatedB.highlighted) {
    images.annotated = `${stem}-annotated.png`;
    writeComposite(ctx.outDir, images.annotated, [annotatedA.png, annotatedB.png], labels);
    md.push(
      '',
      `![highlighted ${left} ◀ │ ▶ ${right}](${ctx.img(images.annotated)})`,
      '',
      `<sub>🔍 ${captions.annotated}</sub>`,
    );
  }

  const zoom = zoomPlan(rectsA, rectsB, ctx.zoomBelow);
  if (zoom) {
    images.zoom = `${stem}-zoom.png`;
    const zoomed = (png: PNG, rects: Rect[]): PNG => zoomCrop(png, zoom.box, rects, zoom.factor);
    writeComposite(ctx.outDir, images.zoom, [zoomed(pngA, rectsA), zoomed(pngB, rectsB)], labels);
    md.push(
      '',
      `![zoomed ${left} ◀ │ ▶ ${right}](${ctx.img(images.zoom)})`,
      '',
      `<sub>🔬 ${captions.zoom(zoom.factor)}</sub>`,
    );
  }
  return { md, images };
}
