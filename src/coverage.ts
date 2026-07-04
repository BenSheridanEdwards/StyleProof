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
 * `self-checked`: captured twice and the computed styles matched (a drift would have
 * failed the capture). `replayed`: rendered against a recorded HAR, so deterministic by
 * construction. `unproven`: neither — the styles could have drifted and no one checked.
 */
export type DeterminismBasis = 'self-checked' | 'replayed' | 'unproven';

export type CoverageLedger = {
  version: 1;
  /** The declared surface registry, or null when the spec asserted none. */
  expected: string[] | null;
  /** Reviewed opt-outs (`key → reason`). */
  exclude: Record<string, string>;
  /** How this capture's determinism was established (3.10.0). Absent on older bundles. */
  determinism?: DeterminismBasis;
};

export type DeterminismVerdict = {
  /** `proven` — both sides self-checked or replayed; `unproven` — a side was neither, so
   *  a clean diff might just be two matching NONDETERMINISTIC captures; `unknown` — an
   *  older bundle with no determinism field (degrade, don't block). */
  status: 'proven' | 'unproven' | 'unknown';
  base: DeterminismBasis | 'unknown';
  head: DeterminismBasis | 'unknown';
};

/** The gate's determinism call: a green needs BOTH sides proven (self-checked or replayed). */
export function auditDeterminism(base: CoverageLedger | null, head: CoverageLedger | null): DeterminismVerdict {
  const b = base?.determinism ?? 'unknown';
  const h = head?.determinism ?? 'unknown';
  const proven = (d: DeterminismBasis | 'unknown') => d === 'self-checked' || d === 'replayed';
  if (b === 'unproven' || h === 'unproven') return { status: 'unproven', base: b, head: h };
  if (proven(b) && proven(h)) return { status: 'proven', base: b, head: h };
  return { status: 'unknown', base: b, head: h };
}

export type CoverageVerdict = {
  /** `complete` — every registered surface captured; `incomplete` — a registered
   *  surface is missing (gates); `unasserted` — no registry, so a green can only
   *  certify the captured surfaces, not that they are all of them. */
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
