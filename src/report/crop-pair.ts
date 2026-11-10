import type { PNG } from 'pngjs';
import { STATE_WORDS } from './change-line.js';
import type { Box } from './geometry.js';
import { cropPng, cropStem } from './png.js';
import { cropBudgetNote, cropBudgetOpen, writeBudgetedPair } from './crop-budget.js';
import type { RenderCtx } from './shared.js';

/** Relative paths of the images written for one crop region (the report.json sidecar). */
export type CropImages = { before?: string; after?: string };

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
  state?: string;
  /** Noun phrase describing the changed element or content. */
  what: string;
  /** Skip (return null) when the crop renders identically on both sides. */
  skipIdentical?: boolean;
};

/** Human-readable label for a forced-state capture. */
export function stateLabel(state: string): string | undefined {
  return STATE_WORDS[state] ? `While ${STATE_WORDS[state]}` : undefined;
}

/** Escape for an attribute in a table cell; entities already in the text (escaped page text) stay single. */
const escapeCellAttribute = (value: string): string =>
  value
    .replace(/&(?!(?:amp|lt|gt|quot);)/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');

const MAX_CROP_W = 1280;
const MAX_CROP_AREA = 1_024_000;

function omittedCrop(ctx: RenderCtx) {
  ctx.crops.omitted++;

  return { md: ['', cropBudgetNote(ctx.crops)], images: {}, omitted: true };
}

/**
 * Write two clean crops and return a GitHub-safe before/after table plus its image paths.
 * Returns null only for `skipIdentical` pairs whose pixels match.
 */
export function renderCropPair(
  ctx: RenderCtx,
  spec: CropPairSpec,
): { md: string[]; images: CropImages; size?: { w: number; h: number }; omitted?: boolean } | null {
  const { box, pngA, pngB } = spec;
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
  const before = cropPng(pngA, inCommon ? aligned : box, w, h);
  const after = cropPng(pngB, inCommon ? aligned : box, w, h);
  if (spec.skipIdentical && before.png.data.equals(after.png.data)) return null;

  if (!cropBudgetOpen(ctx.crops)) return omittedCrop(ctx);
  const stem = cropStem(spec.surface, spec.suffix);
  const images: CropImages = {};
  const beforeRel = `${stem}-before.png`;
  const afterRel = `${stem}-after.png`;
  if (!writeBudgetedPair(ctx, [beforeRel, before.png], [afterRel, after.png])) return omittedCrop(ctx);
  images.before = beforeRel;
  images.after = afterRel;
  const image = (rel: string, side: string) =>
    `<img src="${escapeCellAttribute(ctx.img(rel))}" width="340" alt="${escapeCellAttribute(`${side}: ${spec.what}`)}">`;
  const label = spec.state ? stateLabel(spec.state) : undefined;
  const md = [
    '',
    ...(label ? [`**${label}**`, ''] : []),
    '| Before | After |',
    '| --- | --- |',
    `| ${image(beforeRel, 'Before')} | ${image(afterRel, 'After')} |`,
  ];
  return { md, images, size: { w: before.png.width, h: before.png.height } };
}
