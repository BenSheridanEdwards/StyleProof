// Shared test fixtures for the playwright-stylemap suite. Zero new deps:
// node builtins + pngjs (already a runtime dependency).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';

/** Make a unique temp dir; returns its path. Caller removes via rmTmp. */
export function mkTmp(prefix = 'stylemap-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal StyleMap. `elements` is { path: { tag, cls?, rect?, style?,
 * pseudo? } } with sensible defaults so tests stay terse. `defaults` and
 * `states` default to empty.
 */
export function makeMap({ elements = {}, defaults = {}, states = {} } = {}) {
  const els = {};
  for (const [p, e] of Object.entries(elements)) {
    els[p] = {
      tag: e.tag ?? 'div',
      cls: e.cls ?? '',
      ...(e.rect ? { rect: e.rect } : {}),
      style: e.style ?? {},
      ...(e.pseudo ? { pseudo: e.pseudo } : {}),
    };
  }
  return { defaults, elements: els, states };
}

/** A solid-fill, fully opaque PNG of the given size — a real, decodable image. */
export function solidPng(width, height, [r, g, b] = [200, 200, 200]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * Write a map (gzipped) and, optionally, a screenshot into `dir/<surface>.*`.
 * `dir` is created if missing. Returns the dir.
 */
export function writeCapture(dir, surface, map, png /* Buffer | null */) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  if (png) fs.writeFileSync(path.join(dir, `${surface}.png`), png);
  return dir;
}

/**
 * Convenience: lay down a before/after pair under a fresh tmp root.
 * Returns { root, beforeDir, afterDir, outDir }.
 */
export function pairFixture({ surface, before, after, beforePng = null, afterPng = null } = {}) {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  writeCapture(beforeDir, surface, before, beforePng);
  writeCapture(afterDir, surface, after, afterPng);
  return { root, beforeDir, afterDir, outDir };
}
