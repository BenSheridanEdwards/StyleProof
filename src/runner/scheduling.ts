import fs from 'node:fs';
import path from 'node:path';
import { captureKeyFromMapFile } from '../capture/map-io.js';
import { isMapFile } from '../map-store.js';
import { surfaceBase } from '../surface-keys.js';

type CaptureUnit<T> = { surface: T; width?: number };

/** Estimate capture cost from on-disk bytes without reading or decompressing maps.
 * Auto-width tests use their largest base map.
 * Unknown costs follow known ones in declaration order. Never mutate the coverage order. */
export function orderSurfacesByBaseSize<T extends { key: string; widths?: number[] }>(
  surfaces: readonly T[],
  baseDir?: string,
): CaptureUnit<T>[] {
  const sizes = new Map<string, number>();
  const autoSizes = new Map<string, number>();
  let files: string[] = [];
  try {
    if (baseDir) files = fs.readdirSync(baseDir).filter(isMapFile);
  } catch {
    // Scheduling is advisory; absent/unreadable base maps retain declaration order.
  }
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(baseDir!, file));
      if (!stat.isFile()) continue;
      const key = captureKeyFromMapFile(file);
      sizes.set(key, stat.size);
      const base = surfaceBase(key);
      autoSizes.set(base, Math.max(autoSizes.get(base) ?? 0, stat.size));
    } catch {
      // An unavailable map supplies no estimate; the comparison path validates contents.
    }
  }
  const units: CaptureUnit<T>[] = surfaces.flatMap((surface) =>
    surface.widths?.length ? surface.widths.map((width) => ({ surface, width })) : [{ surface }],
  );
  const cost = ({ surface, width }: CaptureUnit<T>): number =>
    (width === undefined ? autoSizes.get(surface.key) : sizes.get(`${surface.key}@${width}`)) ?? -1;
  return units.sort((a, b) => cost(b) - cost(a));
}
