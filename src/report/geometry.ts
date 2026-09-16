import type { ElementEntry, Rect } from '../capture.js';

/** Axis-aligned page rectangle in document pixels. */
export type Box = { x: number; y: number; w: number; h: number };

export const rectToBox = (r: Rect): Box => ({ x: r[0], y: r[1], w: r[2], h: r[3] });
export const pad = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by });
export const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
export const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const visible = (b: Box | null | undefined): b is Box => !!b && b.w > 0 && b.h > 0;

/** Bounding box that encloses every visible rect, or null when none is visible. */
export function unionRects(rects: Rect[]): Box | null {
  const boxes = rects.map(rectToBox).filter(visible);
  return boxes.length ? boxes.reduce(union) : null;
}

/** Union of two boxes when both are visible; otherwise whichever exists. */
export function unionVisibleBoxes(left: Box | null, right: Box | null): Box | null {
  return visible(left) && visible(right) ? union(left, right) : (left ?? right);
}

/** An element's padded box, or null when it has no visible rect. */
export function paddedRect(entry: ElementEntry | undefined, padBy: number): Box | null {
  if (!entry?.rect) return null;
  const b = pad(rectToBox(entry.rect), padBy);
  return visible(b) ? b : null;
}

export const isDescendant = (candidate: string, ancestor: string): boolean => candidate.startsWith(`${ancestor} > `);
export const isSameOrDescendant = (candidate: string, ancestor: string): boolean =>
  candidate === ancestor || isDescendant(candidate, ancestor);

/** The concrete parent path ('' at the root). */
export function containerOf(elementPath: string): string {
  const separator = elementPath.lastIndexOf(' > ');
  return separator === -1 ? '' : elementPath.slice(0, separator);
}

/** Outermost changed paths (anchor a crop on the whole changed region). */
export const outermost = (paths: string[]): string[] =>
  paths.filter((p) => !paths.some((q) => q !== p && isDescendant(p, q)));

/** Innermost changed paths (box the leaf elements that actually changed). */
export const innermost = (paths: string[]): string[] =>
  paths.filter((p) => !paths.some((q) => q !== p && isDescendant(q, p)));
