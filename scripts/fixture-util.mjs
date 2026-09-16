// Synthetic capture fixtures shared by the demo, dogfood, and README scripts.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';

/** A solid-colour PNG (as a pngjs image, for further drawing). */
export function solidPng(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([r, g, b, 255], i);
  return png;
}

/** Write one surface's `<surface>.json.gz` map and `<surface>.png` screenshot into `dir`. */
export function writeCapture(dir, surface, map, png) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  fs.writeFileSync(path.join(dir, `${surface}.png`), png);
}
