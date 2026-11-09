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

/** The 2×2 average of the page pixels under one map pixel, clamped to the page. */
function averagePixel(page: PNG, x: number, y: number): [number, number, number] {
  const left = Math.min(x, page.width - 1);
  const right = Math.min(left + 1, page.width - 1);
  const top = Math.min(y, page.height - 1);
  const bottom = Math.min(top + 1, page.height - 1);
  const at = (px: number, py: number, c: number) => page.data[(py * page.width + px) * 4 + c];
  const channel = (c: number) =>
    Math.round((at(left, top, c) + at(right, top, c) + at(left, bottom, c) + at(right, bottom, c)) / 4);
  return [channel(0), channel(1), channel(2)];
}

type MapBox = { x: number; y: number; w: number; h: number };

const insideAny = (boxes: MapBox[], x: number, y: number, inset: number): boolean =>
  boxes.some((b) => x >= b.x + inset && x < b.x + b.w - inset && y >= b.y + inset && y < b.y + b.h - inset);

/** A map pixel: the ring colour on a box edge, the page inside a box, faded page outside. */
function shade(rgb: [number, number, number], boxes: MapBox[], x: number, y: number): [number, number, number] {
  if (!insideAny(boxes, x, y, 0))
    return rgb.map((v) => Math.round(v * (1 - FADE) + 255 * FADE)) as [number, number, number];
  return insideAny(boxes, x, y, RING_WIDTH) ? rgb : RING;
}

/** Half-scale overview of the window: faded outside the padded boxes, with a ring round each. */
function drawWhereMap(page: PNG, view: Box, boxes: Box[]): PNG {
  const out = new PNG({ width: Math.max(1, Math.ceil(view.w / 2)), height: Math.max(1, Math.ceil(view.h / 2)) });
  const mapped = boxes.map((b) => ({
    x: (b.x - view.x - RING_PAD) / 2,
    y: (b.y - view.y - RING_PAD) / 2,
    w: (b.w + 2 * RING_PAD) / 2,
    h: (b.h + 2 * RING_PAD) / 2,
  }));
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const o = (y * out.width + x) * 4;
      out.data.set([...shade(averagePixel(page, view.x + 2 * x, view.y + 2 * y), mapped, x, y), 255], o);
    }
  }
  return out;
}

/** Write the Where map for these rects on this capture, or null when no rect is on the page or the budget is spent. */
export function writeWhereMap(
  ctx: RenderCtx,
  spec: { surface: string; suffix: string; page: PNG; side: 'before' | 'after'; rects: Rect[] },
): WhereMap | null {
  const page = { w: spec.page.width, h: spec.page.height };
  const boxes = pageBoxes(spec.rects, page);
  if (boxes.length === 0) return null;
  const view = whereView(page, boxes);
  const image = `${cropStem(spec.surface, spec.suffix)}-where.png`;
  if (!writeBudgetedPng(ctx, image, drawWhereMap(spec.page, view, boxes))) return null;
  return { image, side: spec.side, page, view, boxes };
}

/** The compact report.json receipt for a Where map: its image, the capture it is drawn on, and the boxes. */
export const whereReceipt = (map: WhereMap) => ({
  image: map.image,
  side: map.side,
  boxes: map.boxes.map((b) => [b.x, b.y, b.w, b.h]),
});

/** Escape for an attribute or caption; entities already in the text (escaped page text) stay single. */
const escapeAttribute = (value: string): string =>
  value
    .replace(/&(?!(?:amp|lt|gt|quot);)/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * The map's Markdown: one line, so GitHub keeps the image inline with its caption
 * (a line holding only an `<img>` would start a raw HTML block).
 */
export function whereMapLine(ctx: RenderCtx, map: WhereMap, things: string, page?: string): string {
  const on = page ? `on ${page}` : 'on the page';
  const where = map.side === 'after' ? on : `${on} before the change`;
  return (
    `<img src="${escapeAttribute(ctx.img(map.image))}" width="320" alt="${escapeAttribute(`Where ${where}: ${things} highlighted`)}">` +
    `<br><sub>Where: ${escapeAttribute(things)} ${escapeAttribute(where)}</sub>`
  );
}
