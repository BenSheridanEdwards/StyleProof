import type { PNG } from 'pngjs';

/** An [r, g, b] colour triple, each channel 0–255. */
export type RGB = [number, number, number];

/** Paint a solid rectangle onto a PNG, clamped to the canvas bounds. */
export function fillRect(png: PNG, x: number, y: number, w: number, h: number, [r, g, b]: RGB): void {
  for (let yy = Math.max(0, y); yy < Math.min(png.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(png.width, x + w); xx++) {
      const i = (yy * png.width + xx) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
}
