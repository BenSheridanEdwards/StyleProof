import { escapeHtmlAttribute } from '../code-span.js';
import type { PNG } from 'pngjs';
import type { Rect } from '../capture.js';
import { pad, unionRects, type Box } from './geometry.js';
import { annotateCrop, compositePair, cropPng, cropStem, zoomCrop } from './png.js';
import { cropBudgetNote, cropBudgetOpen, writeBudgetedPair, writeBudgetedPng } from './crop-budget.js';
import type { RenderCtx } from './shared.js';

/** Relative paths of the images written for one crop region (the report.json sidecar). */
export type CropImages = { composite?: string; annotated?: string; zoom?: string; before?: string; after?: string };

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
  /** Caption fragments: the annotated suffix, the zoom suffix. */
  captions: { annotated: string; zoom: (factor: number) => string };
  /** Skip (return null) when the crop renders identically on both sides. */
  alsoInView?: string;
  what?: string;
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
 * Escape for an attribute in a table cell: the shared attribute escape, plus `|` as `&#124;`, so the
 * row stays whole and no `|` is left for the pair-row pattern to split on (RV15-03).
 */
const escapeCellAttribute = (value: string): string => escapeHtmlAttribute(value).replace(/\|/g, '&#124;');

export type PairSize = { w: number; h: number; base?: { w: number; h: number } };

function cleanPair(ctx: RenderCtx, spec: CropPairSpec, before: PNG, after: PNG) {
  if (ctx.crops.files + 2 > ctx.crops.maxFiles) {
    ctx.crops.exhausted = true;
    return omittedCrop(ctx);
  }
  const stem = cropStem(spec.surface, spec.suffix);
  const beforeRel = `${stem}-before.png`;
  const afterRel = `${stem}-after.png`;
  const written = writeBudgetedPair(ctx, [beforeRel, before], [afterRel, after]);
  if (!written) return omittedCrop(ctx);
  const [a, b] = written;
  const size: PairSize = { w: b.width, h: b.height };
  if (a.width !== b.width || a.height !== b.height) size.base = { w: a.width, h: a.height };
  const image = (rel: string, side: string) =>
    // The alt is an HTML attribute, where Markdown's `\|` is not unescaped: write the plain `|`.
    `<img src="${escapeCellAttribute(ctx.img(rel))}" width="340" alt="${escapeCellAttribute(`${side}: ${(spec.what ?? 'the changed element').replace(/\\\|/g, '|')}`)}">`;
  const md = [
    '',
    '| Before | After |',
    '| --- | --- |',
    `| ${image(beforeRel, 'Before')} | ${image(afterRel, 'After')} |`,
  ];
  if (spec.alsoInView) md.push('', spec.alsoInView);
  return { md, images: { before: beforeRel, after: afterRel }, size };
}

const MAX_CROP_W = 1280;
const MAX_CROP_AREA = 1_024_000;

function omittedCrop(ctx: RenderCtx) {
  ctx.crops.omitted++;

  return { md: ['', cropBudgetNote(ctx.crops)], images: {}, omitted: true };
}

function zoomOverlay(ctx: RenderCtx, spec: CropPairSpec, images: CropImages): string[] {
  const { pngA, pngB, rectsA, rectsB, captions } = spec;
  const zoom = zoomPlan(rectsA, rectsB, ctx.zoomBelow);

  if (!zoom || !cropBudgetOpen(ctx.crops)) return [];
  const rel = `${cropStem(spec.surface, spec.suffix)}-zoom.png`;
  const zoomed = (png: PNG, rects: Rect[]): PNG => zoomCrop(png, zoom.box, rects, zoom.factor);

  if (!writeBudgetedPng(ctx, rel, compositePair(zoomed(pngA, rectsA), zoomed(pngB, rectsB)))) return [];
  images.zoom = rel;
  const { left = 'before', right = 'after' } = spec.labels ?? {};

  return ['', `![zoomed ${left} ◀ │ ▶ ${right}](${ctx.img(rel)})`, '', `<sub>🔬 ${captions.zoom(zoom.factor)}</sub>`];
}

/**
 * Crop, composite, annotate and (for small changes) zoom one before/after pair,
 * writing the PNGs and returning the image markdown plus the images sidecar.
 * Returns null only for `skipIdentical` pairs whose pixels match.
 */
export function renderCropPair(
  ctx: RenderCtx,
  spec: CropPairSpec,
): { md: string[]; images: CropImages; size?: PairSize; omitted?: boolean } | null {
  const { box, pngA, pngB, rectsA, rectsB, captions } = spec;
  const left = spec.labels?.left ?? 'before';
  const right = spec.labels?.right ?? 'after';
  const { aligned, inCommon, w, h } = cropWindow(ctx, box, pngA, pngB);
  const before = cropPng(pngA, inCommon ? aligned : box, w, h);
  const after = cropPng(pngB, inCommon ? aligned : box, w, h);
  if (spec.skipIdentical && before.png.data.equals(after.png.data)) return null;

  if (!cropBudgetOpen(ctx.crops)) return omittedCrop(ctx);
  if (ctx.layout === 'visual-first') return cleanPair(ctx, spec, before.png, after.png);
  const stem = cropStem(spec.surface, spec.suffix);
  const images: CropImages = { composite: `${stem}-composite.png` };

  if (!writeBudgetedPng(ctx, images.composite!, compositePair(before.png, after.png))) return omittedCrop(ctx);
  const md = [
    '',
    `![${left} ◀ │ ▶ ${right}](${ctx.img(images.composite!)})`,
    '',
    `<sub>◀ ${left}  ·  ${right} ▶</sub>`,
  ];

  // One primary before/after. Annotated + zoom live under a single optional
  // highlight toggle so the report is not three duplicate carousels.
  const overlay: string[] = [];
  const annotatedA = annotateCrop(before, rectsA);
  const annotatedB = annotateCrop(after, rectsB);
  const annotated = `${stem}-annotated.png`;

  if (
    (annotatedA.highlighted || annotatedB.highlighted) &&
    writeBudgetedPng(ctx, annotated, compositePair(annotatedA.png, annotatedB.png))
  ) {
    images.annotated = annotated;
    overlay.push(
      '',
      `![highlighted ${left} ◀ │ ▶ ${right}](${ctx.img(images.annotated)})`,
      '',
      `<sub>🔍 ${captions.annotated}</sub>`,
    );
  }

  zoomOverlay(ctx, spec, images).forEach((appended) => overlay.push(appended));
  if (overlay.length) {
    md.push('', '<details>', '<summary>Show highlight overlay</summary>');
    overlay.forEach((appended) => md.push(appended));
    md.push('', '</details>');
  }
  return { md, images };
}

/** Shared crop geometry for section context and rendered pairs. */
export function cropWindow(ctx: RenderCtx, box: Box, pngA: PNG, pngB: PNG) {
  const w = Math.min(Math.max(ctx.minWidth, box.w), MAX_CROP_W);
  const h = Math.min(ctx.maxHeight, Math.max(ctx.minHeight, box.h), Math.floor(MAX_CROP_AREA / w));
  // When the box lies in the area both screenshots cover, crop one origin clamped to the
  // smaller screenshot so both sides show the SAME page rectangle even when the change grew
  // or shrank the page. A box past the shorter page's end (content added at the bottom)
  // keeps per-side clamping, so the side that has it still shows it. Measure the element
  // inside the ctx.padBy padding: a full-width or bottom-flush element's padding runs off
  // the canvas.
  const commonW = Math.min(pngA.width, pngB.width);
  const commonH = Math.min(pngA.height, pngB.height);
  const inCommon = box.x + box.w - ctx.padBy <= commonW && box.y + box.h - ctx.padBy <= commonH;
  const aligned: Box = {
    x: Math.max(0, Math.min(Math.round(box.x + box.w / 2 - w / 2), commonW - w)),
    y: Math.max(0, Math.min(Math.round(box.y + box.h / 2 - h / 2), commonH - h)),
    w,
    h,
  };
  return { aligned, inCommon, w, h };
}
