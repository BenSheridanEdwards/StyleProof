/**
 * Coverage guard for the surface list.
 *
 * StyleProof captures exactly the surfaces a spec declares, and the diff matches
 * surfaces by key — so a route nobody added to `surfaces` is invisible to the
 * gate: the change it introduces has no baseline capture AND no head capture, so
 * it never appears in any diff. The gate goes green having never looked at it.
 * This is the one failure StyleProof can't catch from the captures alone, because
 * it's about a capture that was never taken.
 *
 * `expected` closes the hole: a spec declares its full route/view/state universe
 * (e.g. an app's route + overlay-flow registry), and the guard fails when that
 * universe drifts from what's actually captured — turning a silent coverage hole
 * into a red test, in the app's own suite, the moment the route or flow is added.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CoverageConfig } from './config.js';

export type CoverageGaps = {
  /** Expected surfaces that are neither captured nor explicitly excluded. */
  uncovered: string[];
  /** `exclude` entries absent from `expected` — a renamed or removed route whose
   *  opt-out has gone stale (the same drift, in reverse). */
  staleExclusions: string[];
};

/**
 * Compare the captured surface keys against a declared `expected` universe.
 *
 * A surface is covered if it's captured OR listed in `exclude` (a deliberate,
 * documented opt-out — `key → reason`). Captured surfaces NOT in `expected` are
 * allowed: a project may start by requiring only route keys, then tighten the
 * universe with explicit state keys such as `landing-nav-open` or
 * `dashboard-dialog-open`.
 *
 * Pure and side-effect-free so it's unit-testable; `defineStyleMapCapture` wraps
 * it in a Playwright test that runs in the normal suite (not gated on a capture
 * dir), and it's exported so a consumer can assert coverage however it likes.
 */
export function coverageGaps(
  capturedKeys: Iterable<string>,
  expected: Iterable<string>,
  exclude: Record<string, string> = {},
): CoverageGaps {
  const captured = new Set(capturedKeys);
  const expectedList = [...expected];
  const expectedSet = new Set(expectedList);
  const uncovered = expectedList.filter((k) => !captured.has(k) && !(k in exclude));
  const staleExclusions = Object.keys(exclude).filter((k) => !expectedSet.has(k));
  return { uncovered, staleExclusions };
}

/**
 * Translate captured surface keys into the DECLARED keys they satisfy for coverage.
 *
 * `expected` is stated in base surface keys (`home`), but a surface with `liveStates`
 * is captured ONLY as its split expansions (`home-loading`, `home-loaded`) — the bare
 * base key is dropped by design (the base live state is fuzzy). Comparing the expanded
 * keys literally against `expected` would report the declared `home` as uncovered on a
 * fully-captured app. Each expansion still carries its originating `surfaceKey`, so the
 * declared base key is exactly recoverable: a capture satisfies its own key AND its
 * `surfaceKey`. This is precise (it maps only real expansions back to their real base),
 * not a suffix heuristic — an unrelated `home-banner` never satisfies an uncaptured `home`.
 */
export function coverageKeys(captured: Iterable<{ key: string; metadata?: { surfaceKey?: string } }>): string[] {
  const keys = new Set<string>();
  for (const c of captured) {
    keys.add(c.key);
    if (c.metadata?.surfaceKey) keys.add(c.metadata.surfaceKey);
  }
  return [...keys];
}

/**
 * Rewrite a declared `expected` universe (base keys) into the keys that are actually
 * captured to disk, so the GATE — which reads expanded map filenames (`home-loading`)
 * and can't see each capture's `surfaceKey` metadata — can compare literally.
 *
 * A declared key `K` is replaced by its captured liveState expansions when `K` is NOT
 * itself a captured key but expansions carrying `surfaceKey === K` exist. A directly
 * captured `K` is kept; a genuinely uncaptured `K` is kept verbatim so the gate still
 * flags it. This is the write-time half of {@link coverageKeys}: the ledger travels
 * pre-translated, so `auditCoverage` needs no metadata at gate time.
 */
export function translateExpected(
  expected: readonly string[],
  captured: Iterable<{ key: string; metadata?: { surfaceKey?: string } }>,
): string[] {
  const capturedKeys = new Set<string>();
  const expansionsByBase = new Map<string, string[]>();
  for (const c of captured) {
    capturedKeys.add(c.key);
    const base = c.metadata?.surfaceKey;
    if (base && base !== c.key) {
      const list = expansionsByBase.get(base) ?? [];
      list.push(c.key);
      expansionsByBase.set(base, list);
    }
  }
  const out = new Set<string>();
  for (const k of expected) {
    if (capturedKeys.has(k) || !expansionsByBase.has(k)) out.add(k);
    else for (const exp of expansionsByBase.get(k)!) out.add(exp);
  }
  return [...out];
}

// ── coverage provenance (the gate-level completeness assertion) ──────────────────
// The guard above runs in the app's SUITE. That fails a build when the spec forgets a
// route, but the GATE (styleproof-diff, reading captured maps) never learns whether
// coverage was asserted at all — so a green silently implies a completeness it can't
// back up. The capture writes this ledger into the bundle; the gate reads it and
// certifies "clean" only against a STATED basis, enforcing the registry against the
// maps actually captured (a declared surface whose capture FAILED is caught here, where
// the suite guard — which checks the declared list — cannot see it).

/** Bundled next to the maps, so the completeness basis travels with the capture. */
export const COVERAGE_LEDGER = 'styleproof-coverage.json';

/**
 * How a capture's determinism was established — the second half of a trustworthy green.
 * `oracle-proven`: the five-run oracle (`styleproof-map --prove-determinism`) captured the
 * whole surface set five times in fresh contexts and every canonical map hash matched — the
 * strongest basis, and the only one that can see a flake which happens to repeat twice.
 * `self-checked`: captured twice and the computed styles matched (a drift would have
 * failed the capture). `replayed`: rendered against a recorded HAR, so deterministic by
 * construction. `unproven`: neither — the styles could have drifted and no one checked.
 */
export type DeterminismBasis = 'oracle-proven' | 'self-checked' | 'replayed' | 'unproven';

export type CoverageLedger = {
  version: 1;
  /** The declared surface registry, or null when the spec asserted none. */
  expected: string[] | null;
  /** Reviewed opt-outs (`key → reason`). */
  exclude: Record<string, string>;
  /** How this capture's determinism was established (3.10.0). Absent on older bundles. */
  determinism?: DeterminismBasis;
  /**
   * The data-residue guard mode this capture ran under (issue #205). `'gate'` (the v4
   * default) — an unacknowledged failing data endpoint blocks the diff; `'warn'` — the
   * explicit opt-out, residue is recorded and warned but never blocks. Absent on bundles
   * captured before the field existed, and read as warn so they never gate retroactively.
   */
  dataResidue?: 'warn' | 'gate';
};

export type DeterminismVerdict = {
  /** `proven` — both sides self-checked or replayed; `unproven` — a side was neither, so
   *  a clean diff might just be two matching NONDETERMINISTIC captures; `unknown` — an
   *  older bundle with no determinism field (fail closed at the gate unless diagnostic
   *  `--allow-unasserted`). */
  status: 'proven' | 'unproven' | 'unknown';
  base: DeterminismBasis | 'unknown';
  head: DeterminismBasis | 'unknown';
};

/** The gate's determinism call: a green needs BOTH sides proven (oracle, self-check, or replay). */
export function auditDeterminism(base: CoverageLedger | null, head: CoverageLedger | null): DeterminismVerdict {
  const b = base?.determinism ?? 'unknown';
  const h = head?.determinism ?? 'unknown';
  const proven = (d: DeterminismBasis | 'unknown') => d === 'oracle-proven' || d === 'self-checked' || d === 'replayed';
  if (b === 'unproven' || h === 'unproven') return { status: 'unproven', base: b, head: h };
  if (proven(b) && proven(h)) return { status: 'proven', base: b, head: h };
  return { status: 'unknown', base: b, head: h };
}

export type CoverageVerdict = {
  /** `complete` — every registered surface captured; `incomplete` — a registered
   *  surface is missing (gates); `unasserted` — no registry (gates certification
   *  unless `--allow-unasserted` diagnostic mode). */
  basis: 'complete' | 'incomplete' | 'unasserted';
  /** Size of the declared registry, or null when unasserted. */
  registrySize: number | null;
  /** Registered surfaces neither captured nor excluded — the coverage hole. */
  uncovered: string[];
  /** `exclude` entries no longer in `expected` — a rotted opt-out. */
  staleExclusions: string[];
};

/** The gate's completeness call: audit what was actually captured against the ledger. */
export function auditCoverage(capturedKeys: Iterable<string>, ledger: CoverageLedger | null): CoverageVerdict {
  if (!ledger || ledger.expected == null) {
    return { basis: 'unasserted', registrySize: null, uncovered: [], staleExclusions: [] };
  }
  const { uncovered, staleExclusions } = coverageGaps(capturedKeys, ledger.expected, ledger.exclude);
  return {
    basis: uncovered.length ? 'incomplete' : 'complete',
    registrySize: ledger.expected.length,
    uncovered,
    staleExclusions,
  };
}

// ── coverage manifest loading (config-driven expected surfaces) ──────────────────

/**
 * Coverage manifest format (version 1). Generated by routers, sitemaps, or other
 * sources of truth. Loaded by StyleProof at capture time to provide the `expected`
 * surface registry without programmatic declaration.
 */
export type CoverageManifest = {
  version: 1;
  surfaces: string[];
};

/**
 * Load a coverage manifest JSON file from the given path.
 * Validates the manifest format and fails LOUD on any malformation.
 *
 * @param manifestPath - Absolute or repo-relative path to the manifest JSON file.
 * @returns The array of expected surface keys from the manifest.
 * @throws Error if the file cannot be read, parsed, or has invalid format.
 */
export function loadCoverageManifest(manifestPath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `Cannot read coverage manifest at ${manifestPath}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`,
      { cause: e },
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Coverage manifest at ${manifestPath} contains invalid JSON: ${(e as Error).message}`, {
      cause: e,
    });
  }

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`Coverage manifest at ${manifestPath} must be a JSON object`);
  }

  const m = manifest as Record<string, unknown>;
  if (m.version === undefined) {
    throw new Error(`Coverage manifest at ${manifestPath} is missing required "version" field`);
  }
  if (m.version !== 1) {
    throw new Error(
      `Coverage manifest at ${manifestPath} has unsupported manifest version ${m.version} (only version 1 is supported)`,
    );
  }
  if (!Array.isArray(m.surfaces)) {
    throw new Error(`Coverage manifest at ${manifestPath}: "surfaces" must be an array`);
  }
  for (let i = 0; i < m.surfaces.length; i++) {
    if (typeof m.surfaces[i] !== 'string') {
      throw new Error(`Coverage manifest at ${manifestPath}: surface entries must be strings (index ${i} is not)`);
    }
  }

  return m.surfaces as string[];
}

/**
 * Result of merging coverage configuration with programmatic values.
 */
export type MergedCoverageConfig = {
  /** The merged expected surface keys (union of manifest and programmatic). */
  expected: string[] | undefined;
  /** The merged exclude map (config wins over programmatic for same key). */
  exclude: Record<string, string>;
  /** Whether strict mode is enabled (from config). */
  strict: boolean;
};

/** Load manifest surfaces if path is specified, resolving relative paths from cwd. */
function loadManifestSurfaces(manifestPath: string | undefined, cwd: string): string[] | undefined {
  if (!manifestPath) return undefined;
  const resolved = path.isAbsolute(manifestPath) ? manifestPath : path.join(cwd, manifestPath);
  return loadCoverageManifest(resolved);
}

/** Merge two optional string arrays into a deduped union, or return one if the other is absent. */
function mergeExpected(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  return [...new Set([...a, ...b])];
}

/** Merge exclude maps: second wins over first for shared keys. */
function mergeExclude(
  base: Record<string, string>,
  override: Record<string, string> | undefined,
): Record<string, string> {
  return override ? { ...base, ...override } : base;
}

/**
 * Merge coverage configuration from styleproof.config.ts with programmatic values
 * from `defineStyleMapCapture`. Union semantics for expected (neither can hide a hole);
 * config exclude wins over programmatic for same key; strict comes from config only.
 */
export function mergeCoverageConfig(
  config: CoverageConfig | undefined,
  programmaticExpected: string[] | undefined,
  programmaticExclude: Record<string, string>,
  cwd: string,
): MergedCoverageConfig {
  if (!config) {
    return { expected: programmaticExpected, exclude: programmaticExclude, strict: false };
  }
  const manifestSurfaces = loadManifestSurfaces(config.manifest, cwd);
  return {
    expected: mergeExpected(manifestSurfaces, programmaticExpected),
    exclude: mergeExclude(programmaticExclude, config.exclude),
    strict: config.strict ?? false,
  };
}
