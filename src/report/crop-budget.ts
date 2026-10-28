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
    ? `_Crop omitted: the image could not fit the per-file size limit after downscaling. The change is still listed and counted._`
    : `_Crop omitted: the report reached its crop budget (${b.maxFiles} files / ${b.maxBytes / 1_000_000} MB, ` +
      '`--max-crop-files` / `--max-crop-bytes`). The change is still listed and counted._';
