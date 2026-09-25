// Bundle-level vocabulary: file names, errors, the sidecars written beside the maps,
// the capture-failure ledger, and the evidence digest that binds a capture directory.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE_LEDGER } from '../coverage.js';
import { sha256 } from '../node-util.js';
import { readRegularFileNoFollow } from '../safe-filesystem.js';
import { boundedText, readJsonSidecar } from './json.js';

export const DEFAULT_MAP_DIR = '.styleproof/maps';
export const DEFAULT_MAP_LABEL = 'current';
export const DEFAULT_MAP_STORE_BRANCH = 'styleproof-maps';
export const DEFAULT_REMOTE = 'origin';
export const MAP_MANIFEST = 'styleproof-manifest.json';
/** Per-surface capture failures recorded when baseline-only tolerate mode is on. */
export const SURFACE_CAPTURE_FAILURES_DIR = 'styleproof-surface-capture-failures';
/** Run-level marker proving that capture hit a fatal determinism/self-check failure. */
export const FATAL_CAPTURE_MARKER = 'styleproof-fatal-capture.flag';
/** Real browser build recorded during capture; the manifest writer runs after Playwright exits and reads it back. */
export const BROWSER_BUILD_SIDECAR = 'styleproof-browser.json';
/** Where a run's baseline maps came from: exact restore, ancestor reuse, or fresh capture. */
export const BASELINE_PROVENANCE_FILE = 'styleproof-baseline-provenance.json';
/** Named here (not in confidence-ledger.ts) so RESERVED_BUNDLE_FILES needs no import cycle. */
export const CONFIDENCE_LEDGER = 'styleproof-confidence.json';
/** The `--prove-determinism` receipt; preserved during import as owned metadata. */
export const DETERMINISM_RECEIPT = 'styleproof-determinism.json';
export const MAP_STORE_README =
  '# StyleProof maps\n\nMachine-generated reusable map bundles. Each folder is keyed by commit SHA and capture compatibility.\n';

/** Bundle files beside the maps that are NOT surfaces; every surface enumeration must skip them. */
export const RESERVED_BUNDLE_FILES: ReadonlySet<string> = new Set([
  MAP_MANIFEST,
  COVERAGE_LEDGER,
  BROWSER_BUILD_SIDECAR,
  BASELINE_PROVENANCE_FILE,
  CONFIDENCE_LEDGER,
  DETERMINISM_RECEIPT,
]);

export class MapStoreError extends Error {}
/** An expected cache miss (no branch, or no bundle for this SHA/compatibility): recapture, never retry. */
export class MapStoreNotFoundError extends MapStoreError {}
/** An upload refused by the consumer's own state (dirty tree, missing manifest): exit 2, never retried. */
export class MapStorePreconditionError extends MapStoreError {}

export type SurfaceCaptureFailure = {
  /** Capture key (`<surface>@<width>` or crawl label). */
  key: string;
  /** Local diagnostic detail. Never publish this raw value. */
  reason: string;
  /** `self-check` failures are never tolerated and should not appear here. */
  kind?: 'capture';
};

/** True for a captured surface map (`<key>@<width>.json[.gz]`), false for metadata. */
export const isMapFile = (name: string): boolean => !RESERVED_BUNDLE_FILES.has(name) && /\.json(\.gz)?$/.test(name);

const CRAWL_BUNDLE_FILES = new Set([...RESERVED_BUNDLE_FILES, FATAL_CAPTURE_MARKER]);
const GENERATED_CAPTURE_ARTIFACT = /@\d+\.(?:json(?:\.gz)?|png|(?:hover|focus|active)\.png)$/;

/** True when a top-level entry is owned by StyleProof capture generation. */
export function isOwnedCaptureArtifact(name: string): boolean {
  return CRAWL_BUNDLE_FILES.has(name) || name === SURFACE_CAPTURE_FAILURES_DIR || GENERATED_CAPTURE_ARTIFACT.test(name);
}

/** Clear only the artifacts a crawl owns; unrelated names survive. Preflights every
 *  candidate before removing any so malformed state cannot leave a half-cleared bundle. */
export function clearCaptureOutput(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const classified = fs
    .readdirSync(dir)
    .filter(isOwnedCaptureArtifact)
    .map((name) => {
      const target = path.join(dir, name);
      const stat = fs.lstatSync(target);
      if (name !== SURFACE_CAPTURE_FAILURES_DIR && stat.isDirectory()) {
        throw new MapStoreError(`generated capture artifact is a directory: ${target}`);
      }
      return { name, target, stat };
    });
  for (const { name, target, stat } of classified) {
    const recursive = name === SURFACE_CAPTURE_FAILURES_DIR && stat.isDirectory() && !stat.isSymbolicLink();
    fs.rmSync(target, { force: true, recursive });
  }
}

/** Canonical byte identity for every regular artifact consumed from one capture directory. */
export type CaptureEvidenceReceipt = {
  algorithm: 'sha256';
  digest: string;
  fileCount: number;
  mapCount: number;
  byteCount: number;
};

export type CaptureEvidenceBindingReceipt = {
  version: 1;
  before: CaptureEvidenceReceipt;
  after: CaptureEvidenceReceipt;
};

export const MAX_CAPTURE_EVIDENCE_FILES = 100_000;
export const MAX_CAPTURE_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
/** Screenshots ride along with the maps, so the aggregate bound is generous but finite. */
export const MAX_CAPTURE_EVIDENCE_TOTAL_BYTES = 512 * 1024 * 1024;

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function unsafeCaptureEvidence(): never {
  throw new MapStoreError('unsafe capture evidence — expected a bounded tree of regular files');
}

function listEvidenceFiles(directory: string, prefix: string, files: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => byCodeUnit(a.name, b.name));
  } catch {
    return unsafeCaptureEvidence();
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listEvidenceFiles(path.join(directory, entry.name), relative, files);
    else if (entry.isFile()) files.push(relative);
    else unsafeCaptureEvidence();
    if (files.length > MAX_CAPTURE_EVIDENCE_FILES) unsafeCaptureEvidence();
  }
}

function readEvidenceFile(file: string): Buffer {
  try {
    return readRegularFileNoFollow(file, MAX_CAPTURE_EVIDENCE_FILE_BYTES);
  } catch {
    return unsafeCaptureEvidence();
  }
}

/** Hash a complete capture directory with unambiguous path/content framing: every entry
 *  is read no-follow and its sorted relative path is part of the digest. */
export function captureEvidenceReceipt(dir: string): CaptureEvidenceReceipt {
  const files: string[] = [];
  listEvidenceFiles(dir, '', files);
  files.sort(byCodeUnit);
  const digest = createHash('sha256').update('styleproof-capture-evidence-v1\0');
  let byteCount = 0;
  let mapCount = 0;
  for (const relative of files) {
    const bytes = readEvidenceFile(path.join(dir, ...relative.split('/')));
    byteCount += bytes.length;
    if (!Number.isSafeInteger(byteCount) || byteCount > MAX_CAPTURE_EVIDENCE_TOTAL_BYTES) unsafeCaptureEvidence();
    if (!relative.includes('/') && isMapFile(relative)) mapCount++;
    const relativeBytes = Buffer.from(relative, 'utf8');
    digest.update(`${relativeBytes.length}:`).update(relativeBytes).update(`${bytes.length}:`).update(bytes);
  }
  return { algorithm: 'sha256', digest: digest.digest('hex'), fileCount: files.length, mapCount, byteCount };
}

export function captureEvidenceBindingReceipt(beforeDir: string, afterDir: string): CaptureEvidenceBindingReceipt {
  return { version: 1, before: captureEvidenceReceipt(beforeDir), after: captureEvidenceReceipt(afterDir) };
}

/** Record one tolerated surface failure (safe under parallel Playwright workers). A hash of
 *  the RAW key keeps colliding sanitized names (`a/b@1280` vs `a_b@1280`) from clobbering. */
export function recordSurfaceCaptureFailure(dir: string, failure: SurfaceCaptureFailure): void {
  const sub = path.join(dir, SURFACE_CAPTURE_FAILURES_DIR);
  const normalized: SurfaceCaptureFailure = {
    key: boundedText(failure.key, 256, 'capture'),
    reason: boundedText(failure.reason, 1024, 'capture failed'),
    ...(failure.kind ? { kind: failure.kind } : {}),
  };
  const stem = failure.key.replace(/[^a-zA-Z0-9@._-]+/g, '_').slice(0, 200);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `${stem}-${sha256(failure.key).slice(0, 8)}.json`), JSON.stringify(normalized));
}

/** Read tolerated failures written during capture (sorted by key). */
export function readSurfaceCaptureFailures(dir: string): SurfaceCaptureFailure[] {
  const sub = path.join(dir, SURFACE_CAPTURE_FAILURES_DIR);
  if (!fs.existsSync(sub)) return [];
  return fs
    .readdirSync(sub)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(sub, name), 'utf8')) as SurfaceCaptureFailure)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Env var naming the dir where each capture test records its outcome (set by `styleproof-map`). */
export const CAPTURE_OUTCOMES_ENV = 'STYLEPROOF_CAPTURE_OUTCOMES_DIR';

/** One capture test's outcome: `running` until its afterEach runs (a crashed worker never gets there). */
export type CaptureTestOutcome = { title: string; status: 'running' | 'passed' | 'failed' };

/** Record one capture test's outcome (one file per test id, safe under parallel workers; a retry overwrites). */
export function recordCaptureTestOutcome(dir: string, testId: string, outcome: CaptureTestOutcome): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha256(testId).slice(0, 16)}.json`), JSON.stringify(outcome));
}

/** Every capture test outcome recorded in `dir` (empty when none ran). */
export function readCaptureTestOutcomes(dir: string): CaptureTestOutcome[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as CaptureTestOutcome);
}

/** Record a run-level capture failure that must never be tolerated or published. */
export function markFatalCaptureFailure(dir: string, reason: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FATAL_CAPTURE_MARKER), reason);
}

/** Read the fatal marker written by a capture worker: `undefined` ONLY when it is absent. A marker
 *  that exists but cannot be read safely (symlink, non-regular, I/O error) throws — reading it as
 *  "no fatal failure" would let a self-check failure publish. */
export function readFatalCaptureFailure(dir: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readRegularFileNoFollow(path.join(dir, FATAL_CAPTURE_MARKER));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new MapStoreError(
      `unreadable fatal capture marker ${path.join(dir, FATAL_CAPTURE_MARKER)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return bytes.toString('utf8').trim() || 'unknown fatal capture failure';
}

/** Write-or-CLEAR: an undefined version removes a stale sidecar so a reused capture dir can
 *  never stamp a prior run's browser build into this run's manifest. */
export function writeBrowserBuildSidecar(dir: string, browserVersion: string | undefined): void {
  const sidecar = path.join(dir, BROWSER_BUILD_SIDECAR);
  if (!browserVersion) return fs.rmSync(sidecar, { force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sidecar, JSON.stringify({ browserVersion }, null, 2));
}

export const readBrowserBuildSidecar = (dir: string): string | undefined =>
  readJsonSidecar<{ browserVersion?: string }>(path.join(dir, BROWSER_BUILD_SIDECAR))?.browserVersion;

/** `ancestor-reuse` carries the no-relevant-changes proof (changed path count and the
 *  source roots the gate ran against); the restored bundle itself is never rewritten. */
export type BaselineProvenance = {
  version: 1;
  baseline: 'exact-restore' | 'ancestor-reuse' | 'captured';
  requestedSha: string;
  /** The commit whose stored bundle was restored (absent for `captured`). */
  restoredSha?: string;
  /** 1 = the base commit's direct first-parent parent. */
  ancestorDepth?: number;
  /** `git diff --name-only <restoredSha> <requestedSha>` path count — the proof. */
  changedPathCount?: number;
  sourceRoots?: string[];
};

export function writeBaselineProvenance(dir: string, provenance: BaselineProvenance): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, BASELINE_PROVENANCE_FILE), JSON.stringify(provenance, null, 2));
}

/** `null` when absent or unreadable. */
export const readBaselineProvenance = (dir: string): BaselineProvenance | null =>
  readJsonSidecar<BaselineProvenance>(path.join(dir, BASELINE_PROVENANCE_FILE)) ?? null;
