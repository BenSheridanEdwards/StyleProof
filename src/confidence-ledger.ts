/**
 * Confidence ledger: how complete and trustworthy was the capture, per surface — a second badge,
 * never merged with the visual verdict. Honesty rules: no coverage percentage for a universe that
 * cannot be enumerated (`basis: 'unasserted'`), pre-ledger bundles degrade to `unknown` and never
 * block retroactively, and every non-`captured` entry carries a non-empty reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COVERAGE_LEDGER, type CoverageLedger } from './coverage.js';
import { surfaceKeyByCaptureKey } from './capture.js';
import { loadDirMaps } from './capture/map-io.js';
import { CONFIDENCE_LEDGER } from './map-store.js';
import { readRegularFileNoFollow } from './safe-filesystem.js';

/** Bundled next to the maps, like the coverage ledger, so confidence travels with the capture. */
export { CONFIDENCE_LEDGER };

export type ConfidenceStatus =
  'captured' | 'excluded-with-reason' | 'inaccessible' | 'unknown' | 'unproven-determinism';
export type ConfidenceProducer = 'capture' | 'coverage' | 'determinism' | 'auth-boundary' | 'incomplete-ui';

export type ConfidenceEntry = {
  /** Captured surface key, declared registry key, or redacted auth observation key. */
  surface: string;
  status: ConfidenceStatus;
  producer: ConfidenceProducer;
  /** Present and non-empty on every non-`captured` status. */
  reason?: string;
};

export type ConfidenceLedgerFile = {
  version: 1;
  /** `unasserted`: no `expected` registry backed the captured set, so completeness can never be claimed. */
  basis: 'asserted' | 'unasserted';
  entries: ConfidenceEntry[];
};

/** The run-level completeness badge, distinct from the visual verdict. */
export type ConfidenceCompleteness = 'complete' | 'limited' | 'unasserted' | 'unknown';
export type ConfidenceSummary = { counts: Record<ConfidenceStatus, number>; completeness: ConfidenceCompleteness };

/** Auth-boundary observations already resolved by `resolveCrawlConfidence`. */
export type ConfidenceAuthInput = {
  acknowledged: Array<{ key: string; reason: string }>;
  unacknowledged: Array<{ key: string }>;
};

/** Blocked-continuation residue from the incomplete-UI classifier. */
export type ConfidenceIncompleteUiInput = {
  surface: string;
  /** Deterministic classifier reasons (e.g. `form-present`) — never field values. */
  reasons: string[];
  /** Explicit consumer reason when this blocked continuation is outside scope. */
  acknowledgedReason?: string;
};

// One row per surface: when several producers speak about the same surface, the strongest
// honesty signal wins (a wall outranks an unproven capture outranks a reasoned opt-out …).
const STATUS_PRECEDENCE: Record<ConfidenceStatus, number> = {
  inaccessible: 0,
  'unproven-determinism': 1,
  'excluded-with-reason': 2,
  unknown: 3,
  captured: 4,
};
const STATUSES = Object.keys(STATUS_PRECEDENCE) as ConfidenceStatus[];
const STATUS_PRODUCERS: Record<ConfidenceStatus, readonly ConfidenceProducer[]> = {
  captured: ['capture'],
  'excluded-with-reason': ['coverage', 'auth-boundary', 'incomplete-ui'],
  inaccessible: ['auth-boundary', 'incomplete-ui'],
  unknown: ['coverage', 'capture'],
  'unproven-determinism': ['determinism'],
};
const DETERMINISM = ['oracle-proven', 'self-checked', 'replayed', 'unproven'];
const UNPROVEN_REASON = 'captured without self-check or replay — the styles could have drifted unnoticed';
const AUTH_WALL_REASON = 'authentication boundary — the surfaces behind it were not captured';
const UNCOVERED_REASON = 'declared in the expected registry but never captured';

const isConfidenceStatus = (value: unknown): value is ConfidenceStatus =>
  typeof value === 'string' && Object.hasOwn(STATUS_PRECEDENCE, value);

const entry = (
  surface: string,
  status: ConfidenceStatus,
  producer: ConfidenceProducer,
  reason?: string,
): ConfidenceEntry => ({ surface, status, producer, ...(reason === undefined ? {} : { reason }) });

function addEntry(byKey: Map<string, ConfidenceEntry>, e: ConfidenceEntry): void {
  if (typeof e.surface !== 'string' || e.surface.trim() === '') {
    throw new Error('confidence ledger: every entry needs a non-empty surface');
  }
  if (e.status !== 'captured' && !e.reason?.trim()) {
    throw new Error(`confidence ledger: "${e.surface}" (${e.status}) needs a non-empty reason`);
  }
  const prev = byKey.get(e.surface);
  if (!prev || STATUS_PRECEDENCE[e.status] < STATUS_PRECEDENCE[prev.status]) byKey.set(e.surface, e);
}

function capturedEntries(captured: ReadonlySet<string>, coverage: CoverageLedger | null): ConfidenceEntry[] {
  // A missing basis is legacy provenance, not proof: the badge stays limited until the capture records one.
  const proven = coverage?.determinism === 'self-checked' || coverage?.determinism === 'replayed';
  return [...captured].map((surface) =>
    proven
      ? entry(surface, 'captured', 'capture')
      : entry(surface, 'unproven-determinism', 'determinism', UNPROVEN_REASON),
  );
}

function coverageEntries(captured: ReadonlySet<string>, coverage: CoverageLedger | null): ConfidenceEntry[] {
  const exclude = coverage?.exclude ?? {};
  return [
    // A captured surface outranks its own stale opt-out.
    ...Object.entries(exclude)
      .filter(([key]) => !captured.has(key))
      .map(([surface, reason]) => entry(surface, 'excluded-with-reason', 'coverage', reason)),
    ...(coverage?.expected ?? [])
      .filter((key) => !captured.has(key) && !Object.hasOwn(exclude, key))
      .map((surface) => entry(surface, 'unknown', 'coverage', UNCOVERED_REASON)),
  ];
}

function authEntries(auth: ConfidenceAuthInput | undefined): ConfidenceEntry[] {
  if (!auth) return [];
  return [
    ...auth.acknowledged.map((wall) => entry(wall.key, 'excluded-with-reason', 'auth-boundary', wall.reason)),
    ...auth.unacknowledged.map((wall) => entry(wall.key, 'inaccessible', 'auth-boundary', AUTH_WALL_REASON)),
  ];
}

function incompleteUiEntries(blockedSurfaces: ConfidenceIncompleteUiInput[] = []): ConfidenceEntry[] {
  return blockedSurfaces.map((blocked) => {
    const reasonList = [...new Set(blocked.reasons.map((r) => r.trim()).filter(Boolean))].sort();
    // The wrapper text below would otherwise smuggle an empty classifier verdict past the non-empty-reason rule.
    if (reasonList.length === 0) {
      throw new Error(`confidence ledger: "${blocked.surface}" (inaccessible) needs a non-empty reason`);
    }
    const acknowledgedReason = blocked.acknowledgedReason?.trim();
    const blockedReason = `blocked continuation (${reasonList.join(', ')}) — the states behind it were not captured`;
    return acknowledgedReason
      ? entry(blocked.surface, 'excluded-with-reason', 'incomplete-ui', acknowledgedReason)
      : entry(blocked.surface, 'inaccessible', 'incomplete-ui', blockedReason);
  });
}

function toLedger(basis: ConfidenceLedgerFile['basis'], byKey: Map<string, ConfidenceEntry>): ConfidenceLedgerFile {
  return { version: 1, basis, entries: [...byKey.values()].sort((a, b) => a.surface.localeCompare(b.surface)) };
}

/** Build the ledger from the producers' signals: keyed by surface (strongest status wins), sorted by key. */
export function buildConfidenceLedger(input: {
  capturedKeys: Iterable<string>;
  /** The bundle's coverage ledger, or null when it carries none. */
  coverage: CoverageLedger | null;
  auth?: ConfidenceAuthInput;
  incompleteUi?: ConfidenceIncompleteUiInput[];
  /** Discovered crawl surfaces that did not produce a complete map sweep. */
  captureGaps?: Array<{ surface: string; reason: string }>;
}): ConfidenceLedgerFile {
  const captured = new Set(input.capturedKeys);
  const byKey = new Map<string, ConfidenceEntry>();
  for (const e of [
    ...capturedEntries(captured, input.coverage),
    ...coverageEntries(captured, input.coverage),
    ...authEntries(input.auth),
    ...incompleteUiEntries(input.incompleteUi),
    ...(input.captureGaps ?? []).map((gap) => entry(gap.surface, 'unknown', 'capture', gap.reason)),
  ]) {
    addEntry(byKey, e);
  }
  return toLedger(input.coverage?.expected != null ? 'asserted' : 'unasserted', byKey);
}

/** Collapse a ledger to the completeness badge + per-status counts. `null` (a pre-ledger bundle)
 *  degrades to `unknown` and never blocks retroactively. No percentage is ever computed. */
export function summarizeConfidence(ledger: ConfidenceLedgerFile | null): ConfidenceSummary {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ConfidenceStatus, number>;
  if (!ledger) return { counts, completeness: 'unknown' };
  for (const e of ledger.entries) {
    if (!isConfidenceStatus(e.status)) throw new Error(`confidence ledger: invalid status "${String(e.status)}"`);
    counts[e.status] += 1;
  }
  // A named gap always outranks the basis badge: an unasserted crawl that hit a wall reads "limited".
  if (ledger.entries.some((e) => e.status !== 'captured')) return { counts, completeness: 'limited' };
  return { counts, completeness: ledger.basis === 'unasserted' ? 'unasserted' : 'complete' };
}

/** Write the ledger into a capture bundle (next to the maps). */
export function writeConfidenceLedger(dir: string, ledger: ConfidenceLedgerFile): string {
  const p = path.join(dir, CONFIDENCE_LEDGER);
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2));
  return p;
}

/** Lenient read: missing OR malformed → null. A corrupt advisory file can only understate confidence. */
function readLedger<T>(p: string, valid: (parsed: T) => boolean): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readRegularFileNoFollow(p).toString('utf8')) as T;
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validEntry(e: ConfidenceEntry, seen: Set<string>): boolean {
  if (typeof e?.surface !== 'string' || e.surface.trim() === '' || seen.has(e.surface)) return false;
  if (!isConfidenceStatus(e.status) || !STATUS_PRODUCERS[e.status].includes(e.producer)) return false;
  if (e.status !== 'captured' && (typeof e.reason !== 'string' || e.reason.trim() === '')) return false;
  seen.add(e.surface);
  return true;
}

/** Read a bundle's persisted ledger; missing or malformed → null (degrade to `unknown`). This ledger
 *  arms no gate, so leniency can never disarm coverage, determinism, or residue enforcement. */
export function readConfidenceLedger(dir: string): ConfidenceLedgerFile | null {
  return readLedger<ConfidenceLedgerFile>(path.join(dir, CONFIDENCE_LEDGER), (parsed) => {
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return false;
    if (parsed.basis !== 'asserted' && parsed.basis !== 'unasserted') return false;
    const seen = new Set<string>();
    return parsed.entries.every((e) => validEntry(e, seen));
  });
}

/** The ledger a REPORT should state: the persisted file (a crawl) merged with what the coverage ledger
 *  + map files prove (a spec capture, whose parallel runner cannot know the captured set at write time). */
export function resolveBundleConfidence(dir: string): ConfidenceLedgerFile | null {
  const confidenceExists = fs.existsSync(path.join(dir, CONFIDENCE_LEDGER));
  const coverageExists = fs.existsSync(path.join(dir, COVERAGE_LEDGER));
  const persisted = readConfidenceLedger(dir);
  const coverage = withCaptureDeterminism(dir, readCoverageLedgerLenient(dir));
  // Present-but-malformed provenance is not "absent": deriving from maps would launder corruption into complete.
  if ((confidenceExists && !persisted) || (coverageExists && !coverage)) return null;
  if (!persisted && !coverage) return null;
  // A crawl's persisted producer ledger is authoritative: re-deriving could launder a partial map.
  if (persisted && !coverage) return persisted;
  const derived = buildConfidenceLedger({ capturedKeys: bundleSurfaceKeys(dir, coverage?.expected), coverage });
  if (!persisted) return derived;
  // Persisted entries win over the derived set (strongest status); an asserted registry on either side keeps completeness assertable.
  const byKey = new Map<string, ConfidenceEntry>(derived.entries.map((e) => [e.surface, e]));
  for (const e of persisted.entries) addEntry(byKey, e);
  return toLedger(persisted.basis === 'asserted' || derived.basis === 'asserted' ? 'asserted' : 'unasserted', byKey);
}

/**
 * The ledger's determinism as the captures actually achieved it. The ledger is written from
 * settings before any capture runs, so a `replayed` basis is downgraded to `unproven` when any
 * map in `dir` fell back to live inputs (no replay HAR) — a live capture is not replay-proven.
 */
export function withCaptureDeterminism(dir: string, ledger: CoverageLedger | null): CoverageLedger | null {
  if (ledger?.determinism !== 'replayed') return ledger;
  const live = loadDirMaps(dir).some(([, map]) => map.metadata?.inputs === 'live');
  return live ? { ...ledger, determinism: 'unproven' } : ledger;
}

/** Lenient coverage-ledger read for ADVISORY consumers. The diff CLI keeps its own fail-loud read. */
export function readCoverageLedgerLenient(dir: string): CoverageLedger | null {
  return readLedger<CoverageLedger>(path.join(dir, COVERAGE_LEDGER), (parsed) => {
    if (parsed?.version !== 1) return false;
    if (parsed.expected !== null && !stringArray(parsed.expected)) return false;
    if (!plainReasonMap(parsed.exclude)) return false;
    if (parsed.determinism !== undefined && !DETERMINISM.includes(parsed.determinism)) return false;
    return parsed.dataResidue === undefined || parsed.dataResidue === 'warn' || parsed.dataResidue === 'gate';
  });
}

/** Deduped surface keys captured in a bundle dir (`<key>@<width>.json[.gz]` → `<key>`). */
export function bundleSurfaceKeys(dir: string, expected: readonly string[] | null = null): string[] {
  const registry = expected ? new Set(expected) : null;
  const keys = [...surfaceKeyByCaptureKey(dir)].map(([captureKey, surfaceKey]) => {
    const capturedKey = captureKey.replace(/@\d+$/, '');
    return registry?.has(capturedKey) ? capturedKey : (surfaceKey ?? capturedKey);
  });
  return [...new Set(keys)];
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

function plainReasonMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, reason]) => key.trim() !== '' && typeof reason === 'string' && reason.trim() !== '',
  );
}
