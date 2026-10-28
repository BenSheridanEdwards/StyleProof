import fs from 'node:fs';
import path from 'node:path';
import type { PNG } from 'pngjs';
import { encodePng } from './png.js';
import type { RenderCtx } from './shared.js';

export type CropBudget = {
  maxFiles: number;
  maxBytes: number;
  files: number;
  bytes: number;
  exhausted: boolean;
  omitted: number;
};

export function createCropBudget(maxFiles: number, maxBytes: number): CropBudget {
  return { maxFiles, maxBytes, files: 0, bytes: 0, exhausted: false, omitted: 0 };
}

export const cropBudgetOpen = (b: CropBudget): boolean => !b.exhausted && b.files < b.maxFiles;

/** Stop after the first PNG that does not fit; later crops never encode. */
export function writeBudgetedPng(ctx: RenderCtx, rel: string, png: PNG): boolean {
  const b = ctx.crops;

  if (!cropBudgetOpen(b)) return false;
  const encoded = encodePng(png);

  if (b.files + 1 > b.maxFiles || b.bytes + encoded.length > b.maxBytes) {
    b.exhausted = true;

    return false;
  }

  fs.writeFileSync(path.join(ctx.outDir, rel), encoded);
  b.files++;
  b.bytes += encoded.length;

  return true;
}

export const cropBudgetNote = (b: CropBudget): string =>
  `_Crop omitted: the report reached its crop budget (${b.maxFiles} files / ${b.maxBytes / 1_000_000} MB, ` +
  '`--max-crop-files` / `--max-crop-bytes`). The change is still listed and counted._';
