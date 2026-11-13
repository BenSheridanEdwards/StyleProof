import fs from 'node:fs';
import { PNG } from 'pngjs';
import { type Box } from './geometry.js';

/** A crop plus the document-space origin it was taken from. */
export type Crop = { png: PNG; ox: number; oy: number };

/** Fixed-size crop centred on the box, clamped to the image. */
export function cropPng(src: PNG, box: Box, w: number, h: number): Crop {
  const ox = Math.max(0, Math.min(Math.round(box.x + box.w / 2 - w / 2), src.width - w));
  const oy = Math.max(0, Math.min(Math.round(box.y + box.h / 2 - h / 2), src.height - h));
  const cw = Math.min(w, src.width);
  const ch = Math.min(h, src.height);
  const out = new PNG({ width: cw, height: ch });
  PNG.bitblt(src, out, Math.max(0, ox), Math.max(0, oy), cw, ch, 0, 0);
  return { png: out, ox, oy };
}

/** Deterministic 2×2 box average; duplicate the edge pixel for odd dimensions. */
export function halvePng(src: PNG): PNG {
  const out = new PNG({ width: Math.ceil(src.width / 2), height: Math.ceil(src.height / 2) });

  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const left = x * 2;
      const right = Math.min(left + 1, src.width - 1);
      const top = y * 2;
      const bottom = Math.min(top + 1, src.height - 1);

      for (let c = 0; c < 4; c++) {
        const value = (px: number, py: number) => src.data[(py * src.width + px) * 4 + c];
        out.data[(y * out.width + x) * 4 + c] = Math.round(
          (value(left, top) + value(right, top) + value(left, bottom) + value(right, bottom)) / 4,
        );
      }
    }
  }

  return out;
}

// Lossless but lean: opaque output, max deflate, adaptive filtering. Never lossy —
// these images are eyeballed for intentional change.
const PNG_OPTS = { deflateLevel: 9, filterType: -1, colorType: 2, inputColorType: 6 } as const;

export function encodePng(png: PNG): Buffer {
  return PNG.sync.write(png, PNG_OPTS);
}

export function writePng(file: string, png: PNG): void {
  fs.writeFileSync(file, encodePng(png));
}

export function readPng(file: string): PNG | null {
  return fs.existsSync(file) ? PNG.sync.read(fs.readFileSync(file)) : null;
}

/** Path-safe, report-unique crop stem: `hero@1280` + `3` → `crops/hero-1280-3`. */
export const cropStem = (surface: string, suffix: string): string =>
  `crops/${surface.replace(/[^a-z0-9-]/gi, '-')}-${suffix}`;
