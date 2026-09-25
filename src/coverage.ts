/**
 * Coverage guard for the surface list. StyleProof captures exactly the surfaces
 * a spec declares, so a route nobody added is invisible to the gate: no baseline
 * capture, no head capture, no diff. `expected` closes the hole — the spec
 * declares its route/view/state universe and the guard fails when it drifts.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CoverageConfig } from './config.js';

/** `uncovered`: expected surfaces neither captured nor excluded; `staleExclusions`: opt-outs no longer in `expected`. */
export type CoverageGaps = { uncovered: string[]; staleExclusions: string[] };

/**
 * Compare captured surface keys against a declared `expected` universe. A
 * surface is covered if captured OR listed in `exclude` (`key → reason`).
 * Captured surfaces NOT in `expected` are allowed. Pure; `defineStyleMapCapture`
 * wraps it in a Playwright test that runs in the normal suite.
 */
export function coverageGaps(
  capturedKeys: Iterable<string>,
  expected: Iterable<string>,
  exclude: Record<string, string> = {},
): CoverageGaps {
  const captured = new Set(capturedKeys);
  const expectedList = [...expected];
  const expectedSet = new Set(expectedList);
  return {
    // Own keys only: `k in exclude` would read `constructor` / `toString` as reviewed opt-outs.
    uncovered: expectedList.filter((k) => !captured.has(k) && !Object.hasOwn(exclude, k)),
    staleExclusions: Object.keys(exclude).filter((k) => !expectedSet.has(k)),
  };
}

type CapturedKey = { key: string; metadata?: { surfaceKey?: string } };

/**
 * The DECLARED keys captured surfaces satisfy. A surface with `liveStates` is
 * captured only as its expansions (`home-loading`), each carrying its
 * originating `surfaceKey`, so a capture satisfies its own key AND that base key.
 * Precise, not a suffix heuristic: `home-banner` never satisfies `home`.
 */
export function coverageKeys(captured: Iterable<CapturedKey>): string[] {
  const keys = new Set<string>();
  for (const c of captured) {
    keys.add(c.key);
    if (c.metadata?.surfaceKey) keys.add(c.metadata.surfaceKey);
  }
  return [...keys];
}

/**
 * Rewrite a declared `expected` universe into the keys actually captured to disk,
 * so the GATE (which reads map filenames, not metadata) can compare literally. A
 * declared key is replaced by its liveState expansions when it is not itself
 * captured but expansions exist; a genuinely uncaptured key is kept verbatim.
 */
export function translateExpected(expected: readonly string[], captured: Iterable<CapturedKey>): string[] {
  const capturedKeys = new Set<string>();
  const expansionsByBase = new Map<string, string[]>();
  for (const c of captured) {
    capturedKeys.add(c.key);
    const base = c.metadata?.surfaceKey;
    if (base && base !== c.key) expansionsByBase.set(base, [...(expansionsByBase.get(base) ?? []), c.key]);
  }
  const out = new Set<string>();
  for (const k of expected) {
    if (capturedKeys.has(k) || !expansionsByBase.has(k)) out.add(k);
    else for (const exp of expansionsByBase.get(k)!) out.add(exp);
  }
  return [...out];
}

// ── coverage provenance: the capture writes this ledger into the bundle so the
// gate certifies "clean" only against a STATED completeness basis.

/** Bundled next to the maps, so the completeness basis travels with the capture. */
export const COVERAGE_LEDGER = 'styleproof-coverage.json';

/**
 * How a capture's determinism was established: `oracle-proven` (five-run oracle,
 * every canonical hash matched), `self-checked` (captured twice, styles matched),
 * `replayed` (recorded HAR), or `unproven`.
 */
export type DeterminismBasis = 'oracle-proven' | 'self-checked' | 'replayed' | 'unproven';

export type CoverageLedger = {
  version: 1;
  /** The declared surface registry, or null when the spec asserted none. */
  expected: string[] | null;
  /** Reviewed opt-outs (`key → reason`). */
  exclude: Record<string, string>;
  /** Absent on older bundles. */
  determinism?: DeterminismBasis;
  /** Data-residue guard mode this capture ran under; absent (older bundles) reads as warn. */
  dataResidue?: 'warn' | 'gate';
};

export type DeterminismVerdict = {
  /** `proven` — both sides proven; `unproven` — a side was not; `unknown` — an older bundle with no field. */
  status: 'proven' | 'unproven' | 'unknown';
  base: DeterminismBasis | 'unknown';
  head: DeterminismBasis | 'unknown';
};

const PROVEN_BASES = new Set<string>(['oracle-proven', 'self-checked', 'replayed']);

/** The gate's determinism call: a green needs BOTH sides proven. */
export function auditDeterminism(base: CoverageLedger | null, head: CoverageLedger | null): DeterminismVerdict {
  const b = base?.determinism ?? 'unknown';
  const h = head?.determinism ?? 'unknown';
  const status =
    b === 'unproven' || h === 'unproven'
      ? 'unproven'
      : PROVEN_BASES.has(b) && PROVEN_BASES.has(h)
        ? 'proven'
        : 'unknown';
  return { status, base: b, head: h };
}

export type CoverageVerdict = {
  /** `complete`, `incomplete` (a registered surface is missing), or `unasserted` (no registry). */
  basis: 'complete' | 'incomplete' | 'unasserted';
  /** Size of the declared registry, or null when unasserted. */
  registrySize: number | null;
  uncovered: string[];
  staleExclusions: string[];
};

/** The gate's completeness call: audit what was actually captured against the ledger. */
export function auditCoverage(capturedKeys: Iterable<string>, ledger: CoverageLedger | null): CoverageVerdict {
  if (!ledger || ledger.expected == null) {
    return { basis: 'unasserted', registrySize: null, uncovered: [], staleExclusions: [] };
  }
  const gaps = coverageGaps(capturedKeys, ledger.expected, ledger.exclude);
  return { basis: gaps.uncovered.length ? 'incomplete' : 'complete', registrySize: ledger.expected.length, ...gaps };
}

// ── coverage manifest loading (config-driven expected surfaces) ──────────────────

/** Coverage manifest format (version 1), generated by routers, sitemaps, or other sources of truth. */
export type CoverageManifest = { version: 1; surfaces: string[] };

/** Load a coverage manifest JSON file; fails LOUD on any malformation. */
export function loadCoverageManifest(manifestPath: string): string[] {
  const at = `Coverage manifest at ${manifestPath}`;
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `Cannot read coverage manifest at ${manifestPath}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`,
      {
        cause: e,
      },
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${at} contains invalid JSON: ${(e as Error).message}`, { cause: e });
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`${at} must be a JSON object`);
  }
  const m = manifest as Record<string, unknown>;
  if (m.version === undefined) throw new Error(`${at} is missing required "version" field`);
  if (m.version !== 1)
    throw new Error(`${at} has unsupported manifest version ${m.version} (only version 1 is supported)`);
  if (!Array.isArray(m.surfaces)) throw new Error(`${at}: "surfaces" must be an array`);
  const bad = m.surfaces.findIndex((s) => typeof s !== 'string');
  if (bad !== -1) throw new Error(`${at}: surface entries must be strings (index ${bad} is not)`);
  return m.surfaces as string[];
}

/** `expected`: union of manifest and programmatic keys; `exclude`: config wins per key; `strict`: config only. */
export type MergedCoverageConfig = { expected: string[] | undefined; exclude: Record<string, string>; strict: boolean };

/** Merge `styleproof.config.ts` coverage with `defineStyleMapCapture` values (`cwd` is the config directory). */
export function mergeCoverageConfig(
  config: CoverageConfig | undefined,
  programmaticExpected: string[] | undefined,
  programmaticExclude: Record<string, string>,
  cwd: string,
): MergedCoverageConfig {
  if (!config) return { expected: programmaticExpected, exclude: programmaticExclude, strict: false };
  const manifest = config.manifest
    ? loadCoverageManifest(path.isAbsolute(config.manifest) ? config.manifest : path.join(cwd, config.manifest))
    : undefined;
  const expected =
    manifest && programmaticExpected
      ? [...new Set([...manifest, ...programmaticExpected])]
      : (manifest ?? programmaticExpected);
  return { expected, exclude: { ...programmaticExclude, ...config.exclude }, strict: config.strict ?? false };
}
