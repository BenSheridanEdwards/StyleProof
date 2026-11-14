import { escapeHtmlAttribute } from '../code-span.js';
import { PNG } from 'pngjs';
import type { Rect } from '../capture.js';
import { writeBudgetedPng } from './crop-budget.js';
import type { Box } from './geometry.js';
import { cropStem } from './png.js';
import type { RenderCtx } from './shared.js';

/**
 * The "Where" map: a small overview of the captured page that marks where the
 * changed elements are. It is the only image the report draws on; before/after
 * crops stay clean.
 */
export type WhereMap = {
  /** Relative path of the overview PNG (under `crops/`). */
  image: string;
  /** The capture the map is drawn on: the head page, or the base page when nothing is left on head. */
  side: 'before' | 'after';
  /** The captured page's size. */
  page: { w: number; h: number };
  /** The page window the map shows, in page pixels. */
  view: Box;
  /** The changed elements' boxes, in page pixels, clipped to the page. */
  boxes: Box[];
};

/** Ring padding round each box, page pixels; report.html's SVG map uses the same. */
const RING_PAD = 8;
const RING_WIDTH = 3;
const RING: [number, number, number] = [224, 17, 157];
/** Fade outside the boxes: 45% of the pixel, 55% white. */
const FADE = 0.55;
/** The map's minimum height for its width, from the approved preview (1280 × 340). */
const MIN_ASPECT = 340 / 1280;
const VIEW_MARGIN = 48;

/** Boxes of the given rects that intersect the page, clipped to it. */
export function pageBoxes(rects: Rect[], page: { w: number; h: number }): Box[] {
  const boxes: Box[] = [];
  for (const [x, y, w, h] of rects) {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const right = Math.min(page.w, Math.round(x + w));
    const bottom = Math.min(page.h, Math.round(y + h));
    if (right > left && bottom > top) boxes.push({ x: left, y: top, w: right - left, h: bottom - top });
  }
  return boxes;
}

/** The window the map shows: the full page width, tall enough for every box, centred on them. */
export function whereView(page: { w: number; h: number }, boxes: Box[]): Box {
  const top = boxes.reduce((min, b) => Math.min(min, b.y), Infinity);
  const bottom = boxes.reduce((max, b) => Math.max(max, b.y + b.h), -Infinity);
  const h = Math.min(page.h, Math.max(Math.round(page.w * MIN_ASPECT), bottom - top + 2 * VIEW_MARGIN));
  const y = Math.max(0, Math.min(Math.round((top + bottom) / 2 - h / 2), page.h - h));
  return { x: 0, y, w: page.w, h };
}

type MapBox = { x: number; y: number; width: number; height: number };

/** Map pixels: 0 (the default) faded page, 1 ring, 2 page inside a box. */
const RINGED = 1;
const INSIDE = 2;

/**
 * The drawing's work, counted only when a caller passes it (tests): map pixels written, and mask
 * rows filled while marking boxes. One pass writes each pixel once; marking costs each box's rows.
 */
export type WhereMapWork = { pixels: number; boxRows: number };

/**
 * Mark a box's pixels with `value`. A pixel x is in [start, end) when x >= start and x < end, so
 * it runs from ceil(start) to ceil(end) - 1, clipped to the map.
 */
function markBox(
  mask: Uint8Array,
  width: number,
  height: number,
  box: MapBox,
  inset: number,
  value: number,
  work?: WhereMapWork,
) {
  const left = Math.max(0, Math.ceil(box.x + inset));
  const right = Math.min(width, Math.ceil(box.x + box.width - inset));
  const top = Math.max(0, Math.ceil(box.y + inset));
  const bottom = Math.min(height, Math.ceil(box.y + box.height - inset));
  for (let y = top; y < bottom; y++) mask.fill(value, y * width + left, y * width + Math.max(left, right));
  if (work) work.boxRows += Math.max(0, bottom - top);
}

/**
 * Half-scale overview of the window: faded outside the padded boxes, with a ring round each. Each
 * box is marked once on a mask, then every map pixel is written in one pass (RV11-12).
 */
export function drawWhereMap(page: PNG, view: Box, boxes: Box[], work?: WhereMapWork): PNG {
  const width = Math.max(1, Math.ceil(view.w / 2));
  const height = Math.max(1, Math.ceil(view.h / 2));
  const out = new PNG({ width, height });
  const mapped = boxes.map((b) => ({
    x: (b.x - view.x - RING_PAD) / 2,
    y: (b.y - view.y - RING_PAD) / 2,
    width: (b.w + 2 * RING_PAD) / 2,
    height: (b.h + 2 * RING_PAD) / 2,
  }));
  // A pixel inside any box is ringed; inside any box's inner edge it shows the page.
  const mask = new Uint8Array(width * height);
  for (const box of mapped) markBox(mask, width, height, box, 0, RINGED, work);
  for (const box of mapped) markBox(mask, width, height, box, RING_WIDTH, INSIDE, work);
  for (let y = 0; y < height; y++) {
    if (work) work.pixels += width;
    drawMapRow(out, page, view, mask, y);
  }
  return out;
}

/** One map row: the ring colour, the page's 2×2 average inside a box, or that average faded. */
function drawMapRow(out: PNG, page: PNG, view: Box, mask: Uint8Array, y: number): void {
  const source = page.data;
  // The 2×2 page pixels under this map row, clamped to the page.
  const top = Math.min(view.y + 2 * y, page.height - 1);
  const bottom = Math.min(top + 1, page.height - 1);
  for (let x = 0; x < out.width; x++) {
    const at = y * out.width + x;
    const o = at * 4;
    out.data[o + 3] = 255;
    if (mask[at] === RINGED) {
      out.data.set(RING, o);
      continue;
    }
    const left = Math.min(view.x + 2 * x, page.width - 1);
    const right = Math.min(left + 1, page.width - 1);
    const a = (top * page.width + left) * 4;
    const b = (top * page.width + right) * 4;
    const c = (bottom * page.width + left) * 4;
    const d = (bottom * page.width + right) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const average = Math.round(
        (source[a + channel] + source[b + channel] + source[c + channel] + source[d + channel]) / 4,
      );
      out.data[o + channel] = mask[at] === INSIDE ? average : Math.round(average * (1 - FADE) + 255 * FADE);
    }
  }
}

/**
 * Write the Where map for these rects on this capture, or null when no rect is on the page or the
 * budget is spent. A map the budget leaves out counts as an omitted crop and calls `onOmitted`, so
 * the caller can record it for its section or entry (QA12-04).
 */
export function writeWhereMap(
  ctx: RenderCtx,
  spec: { surface: string; suffix: string; page: PNG; side: 'before' | 'after'; rects: Rect[]; onOmitted?: () => void },
): WhereMap | null {
  const page = { w: spec.page.width, h: spec.page.height };
  const boxes = pageBoxes(spec.rects, page);
  if (boxes.length === 0) return null;
  const view = whereView(page, boxes);
  const image = `${cropStem(spec.surface, spec.suffix)}-where.png`;
  if (!writeBudgetedPng(ctx, image, drawWhereMap(spec.page, view, boxes))) {
    ctx.crops.omitted++;
    spec.onOmitted?.();
    return null;
  }
  return { image, side: spec.side, page, view, boxes };
}
/** The compact report.json receipt for a Where map: its image, the capture it is drawn on, and the boxes. */
export const whereReceipt = (map: WhereMap) => ({
  image: map.image,
  side: map.side,
  boxes: map.boxes.map((b) => [b.x, b.y, b.w, b.h]),
});

/**
 * The map's Markdown: one line, so GitHub keeps the image inline with its caption
 * (a line holding only an `<img>` would start a raw HTML block).
 */
export function whereMapLine(ctx: RenderCtx, map: WhereMap, things: string, page?: string): string {
  const on = page ? `on ${page}` : 'on the page';
  const where = map.side === 'after' ? on : `${on} before the change`;
  return (
    `<img src="${escapeHtmlAttribute(ctx.img(map.image))}" width="320" alt="${escapeHtmlAttribute(`Where ${where}: ${things} highlighted`)}">` +
    `<br><sub>Where: ${escapeHtmlAttribute(things)} ${escapeHtmlAttribute(where)}</sub>`
  );
}
