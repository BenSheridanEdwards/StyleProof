import fs from 'node:fs';
import path from 'node:path';
import type { PNG } from 'pngjs';
import { encodePng, halvePng } from './png.js';
import type { RenderCtx } from './shared.js';

export type CropBudget = {
  maxFiles: number;
  maxBytes: number;
  files: number;
  bytes: number;
  exhausted: boolean;
  omitted: number;
  downscaled: number;
};

export function createCropBudget(maxFiles: number, maxBytes: number): CropBudget {
  return { maxFiles, maxBytes, files: 0, bytes: 0, exhausted: maxBytes === 0, omitted: 0, downscaled: 0 };
}

export const cropBudgetOpen = (b: CropBudget): boolean => !b.exhausted && b.files < b.maxFiles;

export const MAX_CROP_FILE_BYTES = 300_000;

/** Downscale large PNGs; stop encoding once the shared budget is exhausted. */
export function writeBudgetedPng(ctx: RenderCtx, rel: string, png: PNG): boolean {
  const b = ctx.crops;

  if (!cropBudgetOpen(b)) return false;
  const cap = Math.min(MAX_CROP_FILE_BYTES, b.maxBytes);
  const originalWidth = png.width;
  let encoded = encodePng(png);

  for (let tries = 0; encoded.length > cap && tries < 3; tries++) {
    png = halvePng(png);
    encoded = encodePng(png);
  }
  // Callers count omitted crops. An oversized file must not block later smaller ones.

  if (encoded.length > cap) return false;

  if (b.files + 1 > b.maxFiles || b.bytes + encoded.length > b.maxBytes) {
    b.exhausted = true;

    return false;
  }

  fs.writeFileSync(path.join(ctx.outDir, rel), encoded);

  if (png.width < originalWidth) b.downscaled++;
  b.files++;
  b.bytes += encoded.length;

  return true;
}

export const cropBudgetNote = (b: CropBudget): string =>
  !b.exhausted && b.files < b.maxFiles
    ? `_Crop omitted: the image could not fit the ${b.maxBytes < MAX_CROP_FILE_BYTES ? 'report byte limit' : 'per-file size limit'} after downscaling._`
    : '_Crop omitted: the report reached its crop budget._';

/**
 * Write a before/after pair at ONE scale: both sides are halved together until both fit the
 * per-file cap, then both are written or neither. Returns the written images (their size after any
 * halving), or null. `context` pages (whole pages) do not count toward the downscaled-crops notice.
 */
export function writeBudgetedPair(
  ctx: RenderCtx,
  [relA, pngA]: [string, PNG],
  [relB, pngB]: [string, PNG],
  options: { context?: boolean } = {},
): [PNG, PNG] | null {
  const b = ctx.crops;
  if (!cropBudgetOpen(b)) return null;
  const cap = Math.min(MAX_CROP_FILE_BYTES, b.maxBytes);
  let pair: PNG[] = [pngA, pngB];
  let encoded = pair.map(encodePng);
  let halved = false;
  for (let tries = 0; encoded.some((e) => e.length > cap) && tries < 3; tries++) {
    pair = pair.map(halvePng);
    encoded = pair.map(encodePng);
    halved = true;
  }
  if (encoded.some((e) => e.length > cap)) return null;
  const bytes = encoded[0].length + encoded[1].length;
  if (b.files + 2 > b.maxFiles || b.bytes + bytes > b.maxBytes) {
    b.exhausted = true;
    return null;
  }
  fs.writeFileSync(path.join(ctx.outDir, relA), encoded[0]);
  fs.writeFileSync(path.join(ctx.outDir, relB), encoded[1]);
  if (halved && !options.context) b.downscaled += 2;
  b.files += 2;
  b.bytes += bytes;
  return [pair[0], pair[1]];
}

/** Why a crop was just left out: the budget ran out, or this image could not fit the per-file limit. */
export const cropGapReason = (b: CropBudget): 'budget' | 'size' =>
  !b.exhausted && b.files < b.maxFiles ? 'size' : 'budget';

/** The limit a too-large crop could not fit: the report's own byte limit when it is the smaller one. */
export const sizeLimitName = (maxBytes: number): string =>
  maxBytes < MAX_CROP_FILE_BYTES ? 'report byte limit' : 'per-file size limit';
