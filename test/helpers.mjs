// Shared test fixtures for the styleproof suite. Zero new deps:
// node builtins + pngjs (already a runtime dependency).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
/** Default bound for CLI-test children so a leaked handle cannot hang the suite forever. */
export const CLI_SPAWN_TIMEOUT_MS = 60_000;

/**
 * spawnSync with a hard wall-clock timeout. On expiry Node kills the child
 * (SIGTERM by default) and returns status=null with error.code === 'ETIMEDOUT'.
 * Call sites may override `timeout`; omitting it applies CLI_SPAWN_TIMEOUT_MS.
 */
export function spawnSyncBounded(command, args = [], options = {}) {
  const timeout = options.timeout ?? CLI_SPAWN_TIMEOUT_MS;
  return spawnSync(command, args, { ...options, timeout });
}

/** Parse a spawned CLI's `--json` output file. A child that exits early never writes
 *  it, and a bare readFileSync surfaces an undiagnosable ENOENT — report the child's
 *  status, error, and stderr instead so the real failure is what gets logged. */
export function readSpawnedJson(jsonPath, result) {
  if (!fs.existsSync(jsonPath)) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `child exited ${result.status ?? 'null'}${result.error ? ` (${result.error.message})` : ''} without writing ${path.basename(jsonPath)}${detail ? `: ${detail}` : ''}`,
    );
  }
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

/** Make a unique temp dir; returns its path. Caller removes via rmTmp. */
export function mkTmp(prefix = 'styleproof-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Make a temp directory that Git cannot accidentally attribute to an ancestor
 * checkout when TMPDIR itself lives inside a repository. An initialized but
 * unborn repository is a deterministic discovery boundary whose HEAD remains
 * unresolved, matching the non-repository behavior these tests exercise.
 */
export function mkNonGitTmp(prefix = 'styleproof-non-git-test-') {
  const dir = mkTmp(prefix);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

export function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Turn readable fixture labels into deterministic full commit SHAs for strict manifest tests. */
export function fixtureCommitSha(value) {
  if (typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  return createHash('sha1').update(String(value)).digest('hex');
}

/** Deterministic canonical SHA-256 content hash for strict manifest fixtures. */
export function fixtureContentHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** Deterministic canonical 16-hex compatibility identity for strict manifest fixtures. */
export function fixtureCompatibilityKey(value) {
  if (typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)) return value;
  return fixtureContentHash(value).slice(0, 16);
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
      ...(e.computedValueStyle ? { computedValueStyle: e.computedValueStyle } : {}),
      ...(e.pseudo ? { pseudo: e.pseudo } : {}),
      ...(e.ownTextLength !== undefined ? { ownTextLength: e.ownTextLength } : {}),
      ...(e.text !== undefined ? { text: e.text } : {}),
      ...(e.component ? { component: e.component } : {}),
    };
  }
  return { defaults, elements: els, states };
}

// pngjs's adaptive-filter encode dominates fixture setup (and is ~7× slower under
// --experimental-test-coverage), so encode each size+colour once per test file.
const solidPngCache = new Map();

/** A solid-fill, fully opaque PNG of the given size — a real, decodable image. */
export function solidPng(width, height, [r, g, b] = [200, 200, 200]) {
  const key = `${width}x${height}:${r},${g},${b}`;
  let encoded = solidPngCache.get(key);
  if (!encoded) {
    const png = new PNG({ width, height });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
    encoded = PNG.sync.write(png);
    solidPngCache.set(key, encoded);
  }
  // A fresh copy, so a caller that edits its buffer cannot change a later fixture.
  return Buffer.from(encoded);
}

/** A page with a reflowed body and one restyled button (the report tests' standard scene). */
export function sceneMap({ buttonColor, bodyHeight }) {
  // body is a reflow casualty: its only change is height (a DERIVED prop).
  // The real, styling-intent change is the button's background-color.
  return makeMap({
    defaults: {},
    elements: {
      body: {
        tag: 'body',
        cls: '',
        rect: [0, 0, 1280, bodyHeight],
        ownTextLength: 0,
        style: { height: `${bodyHeight}px` },
      },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'wrap',
        rect: [20, 20, 1240, 300],
        ownTextLength: 0,
        style: { display: 'block' },
      },
      'body > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta primary',
        rect: [100, 100, 160, 48],
        ownTextLength: 0,
        style: { 'background-color': buttonColor },
      },
    },
  });
}

/** Count magenta highlight pixels on each half of a side-by-side annotated crop. */
export function highlightPixelsBySide(filePath) {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  const dividerWidth = 12;
  const halfWidth = (png.width - dividerWidth) / 2;
  let before = 0;
  let after = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      if (png.data[offset] !== 255 || png.data[offset + 1] !== 0 || png.data[offset + 2] !== 200) continue;
      if (x < halfWidth) before++;
      else if (x >= halfWidth + dividerWidth) after++;
    }
  }
  return { before, after };
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

/** A fresh tmp root with the standard before/after/out subdir paths (no writes). */
export function tmpDirs() {
  const root = mkTmp();
  return {
    root,
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'out'),
  };
}

/**
 * Convenience: lay down a before/after pair under a fresh tmp root.
 * Returns { root, beforeDir, afterDir, outDir }.
 */
export function pairFixture({ surface, before, after, beforePng = null, afterPng = null } = {}) {
  const dirs = tmpDirs();
  writeCapture(dirs.beforeDir, surface, before, beforePng);
  writeCapture(dirs.afterDir, surface, after, afterPng);
  return dirs;
}
