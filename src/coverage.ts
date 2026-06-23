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
 * `expected` closes the hole: a spec declares its full route/surface universe
 * (e.g. an app's view registry), and the guard fails when that universe drifts
 * from what's actually captured — turning a silent coverage hole into a red test,
 * in the app's own suite, the moment the route is added.
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
 * allowed: one route legitimately has several captured states (`landing`,
 * `landing-nav-open`), and only the routes themselves form the universe.
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
