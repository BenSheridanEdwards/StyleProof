/**
 * First-class confidence ledger (#399): how complete and trustworthy was the
 * capture, stated per surface — separate from whether captured styles changed.
 *
 * A green visual verdict answers "did captured computed styles change?". This
 * ledger answers the second question a reviewer needs: "was everything that
 * matters captured, and what prevented stronger confidence?" The two are
 * rendered as two badges and never merged into one green.
 *
 * Producers write into this ledger; they do not compete with it:
 * - the capture itself (`captured` entries, downgraded to `unproven-determinism`
 *   when the run recorded no self-check/replay basis);
 * - the coverage registry (`excluded-with-reason` opt-outs, `unknown` for
 *   declared-but-never-captured surfaces);
 * - the auth-boundary classifier (#390 — `inaccessible` walls, or
 *   `excluded-with-reason` when acknowledged);
 * - the incomplete-UI classifier (#398 — `inaccessible` blocked continuations).
 *
 * Honesty rules: no coverage percentage is ever invented for surfaces that
 * cannot be enumerated (`basis: 'unasserted'` says so instead); bundles from
 * before this ledger existed degrade to `unknown` and never block
 * retroactively; every non-`captured` entry carries a non-empty reason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { COVERAGE_LEDGER, type CoverageLedger } from './coverage.js';
import { CONFIDENCE_LEDGER, isMapFile } from './map-store.js';

/** Bundled next to the maps, like the coverage ledger, so confidence travels with the capture. */
export { CONFIDENCE_LEDGER };

/** Per-surface trust statuses — the vocabulary of the ledger (#399). */
export type ConfidenceStatus =
  'captured' | 'excluded-with-reason' | 'inaccessible' | 'unknown' | 'unproven-determinism';

/** Which subsystem asserted a status — named producers, not competing formats. */
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
  /**
   * Whether a declared `expected` registry backed the captured set. `unasserted`
   * means the surface universe cannot be enumerated, so completeness can never
   * be claimed — and no percentage is invented for it.
   */
  basis: 'asserted' | 'unasserted';
  entries: ConfidenceEntry[];
};

/** The run-level completeness badge, distinct from the visual verdict. */
export type ConfidenceCompleteness = 'complete' | 'limited' | 'unasserted' | 'unknown';

export type ConfidenceSummary = {
  counts: Record<ConfidenceStatus, number>;
  completeness: ConfidenceCompleteness;
};

/** Auth-boundary observations already resolved by {@link resolveCrawlConfidence}. */
export type ConfidenceAuthInput = {
  acknowledged: Array<{ key: string; reason: string }>;
  unacknowledged: Array<{ key: string }>;
};

/** Blocked-continuation residue from the incomplete-UI classifier (#398). */
export type ConfidenceIncompleteUiInput = {
  surface: string;
  /** Deterministic classifier reasons (e.g. `form-present`) — never field values. */
  reasons: string[];
};

// One row per surface: when several producers speak about the same surface, the
// strongest honesty signal wins — a wall outranks an unproven capture outranks a
// reasoned opt-out outranks "declared but never seen" outranks "captured fine".
const STATUS_PRECEDENCE: Record<ConfidenceStatus, number> = {
  inaccessible: 0,
  'unproven-determinism': 1,
  'excluded-with-reason': 2,
  unknown: 3,
  captured: 4,
};

const STATUSES = Object.keys(STATUS_PRECEDENCE) as ConfidenceStatus[];

function addEntry(byKey: Map<string, ConfidenceEntry>, entry: ConfidenceEntry): void {
  if (entry.status !== 'captured' && !entry.reason?.trim()) {
    throw new Error(`confidence ledger: "${entry.surface}" (${entry.status}) needs a non-empty reason`);
  }
  const prev = byKey.get(entry.surface);
  if (!prev || STATUS_PRECEDENCE[entry.status] < STATUS_PRECEDENCE[prev.status]) byKey.set(entry.surface, entry);
}

// ── per-producer entry builders ──────────────────────────────────────────────────
// One small function per producer, folded together by buildConfidenceLedger, so
// each stays well under the complexity gate (mirrors the certification renderers).

function capturedEntries(captured: ReadonlySet<string>, coverage: CoverageLedger | null): ConfidenceEntry[] {
  const unproven = coverage?.determinism === 'unproven';
  return [...captured].map((surface) =>
    unproven
      ? {
          surface,
          status: 'unproven-determinism' as const,
          producer: 'determinism' as const,
          reason: 'captured without self-check or replay — the styles could have drifted unnoticed',
        }
      : { surface, status: 'captured' as const, producer: 'capture' as const },
  );
}

function coverageEntries(captured: ReadonlySet<string>, coverage: CoverageLedger | null): ConfidenceEntry[] {
  const exclude = coverage?.exclude ?? {};
  const excluded = Object.entries(exclude)
    // A captured surface outranks its own stale opt-out.
    .filter(([key]) => !captured.has(key))
    .map(([surface, reason]) => ({
      surface,
      status: 'excluded-with-reason' as const,
      producer: 'coverage' as const,
      reason,
    }));
  const uncovered = (coverage?.expected ?? [])
    .filter((key) => !captured.has(key) && !(key in exclude))
    .map((surface) => ({
      surface,
      status: 'unknown' as const,
      producer: 'coverage' as const,
      reason: 'declared in the expected registry but never captured',
    }));
  return [...excluded, ...uncovered];
}

function authEntries(auth: ConfidenceAuthInput | undefined): ConfidenceEntry[] {
  if (!auth) return [];
  return [
    ...auth.acknowledged.map((wall) => ({
      surface: wall.key,
      status: 'excluded-with-reason' as const,
      producer: 'auth-boundary' as const,
      reason: wall.reason,
    })),
    ...auth.unacknowledged.map((wall) => ({
      surface: wall.key,
      status: 'inaccessible' as const,
      producer: 'auth-boundary' as const,
      reason: 'authentication boundary — the surfaces behind it were not captured',
    })),
  ];
}

function incompleteUiEntries(blockedSurfaces: ConfidenceIncompleteUiInput[] | undefined): ConfidenceEntry[] {
  return (blockedSurfaces ?? []).map((blocked) => {
    const reasonList = [...new Set(blocked.reasons.map((r) => r.trim()).filter(Boolean))].sort();
    if (reasonList.length === 0) {
      // The wrapper text below would otherwise smuggle an empty classifier verdict
      // past the non-empty-reason rule — silence cannot mark scope limited.
      throw new Error(`confidence ledger: "${blocked.surface}" (inaccessible) needs a non-empty reason`);
    }
    return {
      surface: blocked.surface,
      status: 'inaccessible' as const,
      producer: 'incomplete-ui' as const,
      reason: `blocked continuation (${reasonList.join(', ')}) — the states behind it were not captured`,
    };
  });
}

/**
 * Build the ledger from the producers' signals. Pure and deterministic: entries
 * are keyed by surface (strongest status wins) and sorted by surface key.
 */
export function buildConfidenceLedger(input: {
  capturedKeys: Iterable<string>;
  /** The bundle's coverage ledger, or null when it carries none. */
  coverage: CoverageLedger | null;
  /** Resolved auth-boundary walls (#390). */
  auth?: ConfidenceAuthInput;
  /** Blocked-continuation residue (#398). */
  incompleteUi?: ConfidenceIncompleteUiInput[];
}): ConfidenceLedgerFile {
  const captured = new Set(input.capturedKeys);
  const byKey = new Map<string, ConfidenceEntry>();
  for (const entry of [
    ...capturedEntries(captured, input.coverage),
    ...coverageEntries(captured, input.coverage),
    ...authEntries(input.auth),
    ...incompleteUiEntries(input.incompleteUi),
  ]) {
    addEntry(byKey, entry);
  }
  return {
    version: 1,
    basis: input.coverage?.expected != null ? 'asserted' : 'unasserted',
    entries: [...byKey.values()].sort((a, b) => a.surface.localeCompare(b.surface)),
  };
}

/**
 * Collapse a ledger to the completeness badge + per-status counts. `null`
 * (a bundle from before the ledger existed) degrades to `unknown` — it never
 * blocks retroactively. No percentage is ever computed: `unasserted` says the
 * universe cannot be enumerated, and counts stay counts.
 */
export function summarizeConfidence(ledger: ConfidenceLedgerFile | null): ConfidenceSummary {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ConfidenceStatus, number>;
  if (!ledger) return { counts, completeness: 'unknown' };
  for (const e of ledger.entries) counts[e.status] += 1;
  // A named gap always outranks the basis badge: a crawl bundle (unasserted
  // universe) that hit an auth wall must read "limited", not merely "unasserted".
  if (ledger.entries.some((e) => e.status !== 'captured')) return { counts, completeness: 'limited' };
  return { counts, completeness: ledger.basis === 'unasserted' ? 'unasserted' : 'complete' };
}

/** Write the ledger into a capture bundle (next to the maps). */
export function writeConfidenceLedger(dir: string, ledger: ConfidenceLedgerFile): string {
  const p = path.join(dir, CONFIDENCE_LEDGER);
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2));
  return p;
}

/**
 * Read a bundle's persisted ledger. Missing OR malformed → null (degrade to
 * `unknown`). Lenient deliberately, unlike the coverage ledger's fail-loud read:
 * this ledger arms no gate, so a corrupt file can only understate confidence —
 * it can never disarm coverage, determinism, or residue enforcement.
 */
export function readConfidenceLedger(dir: string): ConfidenceLedgerFile | null {
  const p = path.join(dir, CONFIDENCE_LEDGER);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as ConfidenceLedgerFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null;
    if (parsed.basis !== 'asserted' && parsed.basis !== 'unasserted') return null;
    const ok = parsed.entries.every(
      (e) =>
        typeof e?.surface === 'string' &&
        typeof e?.status === 'string' &&
        e.status in STATUS_PRECEDENCE &&
        (e.status === 'captured' || (typeof e.reason === 'string' && e.reason.trim() !== '')),
    );
    return ok ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The ledger a REPORT should state for a bundle: the persisted file when a
 * producer wrote one (a crawl capture), merged with what the bundle's own
 * coverage ledger + map files prove (a spec capture — whose parallel test
 * runner cannot know the captured set at write time, so the report derives it).
 * A bundle with neither source returns null → the `unknown` badge.
 */
export function resolveBundleConfidence(dir: string): ConfidenceLedgerFile | null {
  const persisted = readConfidenceLedger(dir);
  const coverage = readCoverageLedgerLenient(dir);
  if (!persisted && !coverage) return null;
  const derived = buildConfidenceLedger({ capturedKeys: bundleSurfaceKeys(dir), coverage });
  if (!persisted) return derived;
  // Merge: re-add persisted entries over the derived set (strongest status wins),
  // and let an asserted registry on either side keep completeness assertable.
  const byKey = new Map<string, ConfidenceEntry>(derived.entries.map((e) => [e.surface, e]));
  for (const e of persisted.entries) addEntry(byKey, e);
  return {
    version: 1,
    basis: persisted.basis === 'asserted' || derived.basis === 'asserted' ? 'asserted' : 'unasserted',
    entries: [...byKey.values()].sort((a, b) => a.surface.localeCompare(b.surface)),
  };
}

/**
 * Lenient coverage-ledger read for ADVISORY consumers (this resolver, the
 * report's certification renderer): a missing or corrupt file degrades to null.
 * The diff CLI keeps its own fail-loud read — there, an unreadable ledger would
 * silently disarm the coverage/determinism/residue gates.
 */
export function readCoverageLedgerLenient(dir: string): CoverageLedger | null {
  const p = path.join(dir, COVERAGE_LEDGER);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CoverageLedger;
  } catch {
    return null;
  }
}

/** Deduped surface keys captured in a bundle dir (`<key>@<width>.json[.gz]` → `<key>`). */
export function bundleSurfaceKeys(dir: string): string[] {
  return [
    ...new Set(
      fs
        .readdirSync(dir)
        .filter(isMapFile)
        .map((f) => f.replace(/@\d+\.json(\.gz)?$/, '')),
    ),
  ];
}
