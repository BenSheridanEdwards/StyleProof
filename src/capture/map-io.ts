import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isMapFile } from '../map-store.js';
import { readRegularFileNoFollow } from '../safe-filesystem.js';
import type { NavigableItem } from '../inventory.js';
import type { DataResidueEntry } from '../data-residue.js';
import type { StyleMap } from './types.js';

/** Write a style map to disk; gzipped when the path ends in `.gz`. */
export function saveStyleMap(filePath: string, map: StyleMap): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(map);
  fs.writeFileSync(filePath, filePath.endsWith('.gz') ? gzipSync(json) : json);
}

/**
 * Size caps for reading one style map. Real maps are kilobytes to a few MiB (and the
 * Action's evidence binding already refuses any capture file over 16 MiB), so these are
 * generous backstops: a hostile or corrupt capture — e.g. a gzip bomb uploaded by an
 * untrusted fork capture job — fails closed instead of exhausting the runner's memory.
 */
export const MAX_STYLE_MAP_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_STYLE_MAP_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;

export type StyleMapReadLimits = { maxFileBytes?: number; maxDecompressedBytes?: number };

/** Read a style map written by {@link saveStyleMap} (`.json` or `.json.gz`). */
export function loadStyleMap(filePath: string, limits: StyleMapReadLimits = {}): StyleMap {
  const maxFileBytes = limits.maxFileBytes ?? MAX_STYLE_MAP_FILE_BYTES;
  const maxDecompressedBytes = limits.maxDecompressedBytes ?? MAX_STYLE_MAP_DECOMPRESSED_BYTES;
  let raw: Buffer;
  try {
    raw = readRegularFileNoFollow(filePath, maxFileBytes);
  } catch (e) {
    throw new Error(`styleproof: cannot read capture ${filePath}: ${(e as Error).message}`, { cause: e });
  }
  const oversized = (): Error =>
    new Error(
      `styleproof: capture ${filePath} is larger than the ${maxDecompressedBytes}-byte style-map limit once ` +
        'decompressed — refusing to parse it. A real map is far smaller; re-capture it.',
    );
  let bytes: Buffer;
  try {
    bytes = filePath.endsWith('.gz') ? gunzipSync(raw, { maxOutputLength: maxDecompressedBytes }) : raw;
  } catch (e) {
    // zlib throws a RangeError (ERR_BUFFER_TOO_LARGE) once output passes maxOutputLength.
    throw e instanceof RangeError ? oversized() : corruptCapture(filePath, e);
  }
  if (bytes.length > maxDecompressedBytes) throw oversized();
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw corruptCapture(filePath, e);
  }
}

function corruptCapture(filePath: string, e: unknown): Error {
  return new Error(
    `styleproof: capture ${filePath} is corrupt or truncated (${(e as Error).message}). ` +
      'Re-capture it — a partial write or interrupted upload produces an unreadable .gz.',
    { cause: e },
  );
}

/** Capture key from a map filename (`home@1280.json.gz` → `home@1280`). */
export function captureKeyFromMapFile(filename: string): string {
  return filename.replace(/\.json(\.gz)?$/, '');
}

const mapFiles = (dir: string): string[] => fs.readdirSync(dir).filter(isMapFile);

/** `[captureKey, map]` for every map file in `dir`; `[]` when the dir is missing. */
export function loadDirMaps(dir: string): Array<[string, StyleMap]> {
  if (!fs.existsSync(dir)) return [];
  return mapFiles(dir).map((f) => [captureKeyFromMapFile(f), loadStyleMap(path.join(dir, f))]);
}

/** Every surface map's navigable inventory, in the shape the inventory audit consumes. */
export function readInventories(dir: string): Array<{ inventory?: NavigableItem[] }> {
  return mapFiles(dir).map((f) => {
    const m = loadStyleMap(path.join(dir, f));
    return m.inventory ? { inventory: m.inventory } : {};
  });
}

/** Every surface map's `dataResidue`, in the shape the data-residue audit consumes. */
export function readResidue(dir: string): Array<{ dataResidue?: DataResidueEntry[] }> {
  return mapFiles(dir).map((f) => {
    const m = loadStyleMap(path.join(dir, f));
    return m.dataResidue ? { dataResidue: m.dataResidue } : {};
  });
}

/** Capture key → element paths it renders, unioned across `dirs` (feeds the shared-chrome tier). */
export function surfaceElementPaths(...dirs: string[]): Map<string, Set<string>> {
  const bySurface = new Map<string, Set<string>>();
  for (const dir of dirs) {
    for (const [surface, map] of loadDirMaps(dir)) {
      const set = bySurface.get(surface) ?? new Set<string>();
      for (const p of Object.keys(map.elements)) set.add(p);
      bySurface.set(surface, set);
    }
  }
  return bySurface;
}

/** Every capture key present as a map file in `dir`. */
export function captureKeysIn(dir: string): string[] {
  return fs.existsSync(dir) ? mapFiles(dir).map(captureKeyFromMapFile) : [];
}

/** Per capture key, the authoring `metadata.surfaceKey` from that map (if any). */
export function surfaceKeyByCaptureKey(dir: string): Map<string, string | undefined> {
  return new Map(loadDirMaps(dir).map(([key, map]) => [key, map.metadata?.surfaceKey]));
}

/** Authoring `surfaceKey` lookup across dirs: a later dir's defined value wins, undefined never clobbers. */
export function mergeSurfaceKeyLookup(...dirs: string[]): (captureKey: string) => string | undefined {
  const merged = new Map<string, string | undefined>();
  for (const dir of dirs) {
    for (const [k, v] of surfaceKeyByCaptureKey(dir)) {
      if (v !== undefined) merged.set(k, v);
      else if (!merged.has(k)) merged.set(k, undefined);
    }
  }
  return (captureKey) => merged.get(captureKey);
}
