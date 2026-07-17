import { type Finding } from './diff.js';
import { signatureOf } from './findings-clean.js';
import { productSurfaceBase, surfaceWidth } from './surface-keys.js';

/**
 * Shared-chrome tier (#193): group surfaces that changed identically and promote
 * persistent frame elements (nav, header, footer) that moved on every hosting view.
 */

/** A surface's diff distilled to just what grouping needs: its key and the
 *  findings kept after noise-cleaning. */
export type SurfaceFindings = { surface: string; findings: Finding[] };

/** Surfaces that changed the SAME way, collapsed to one group + a representative. */
export type SignatureGroup = { surfaces: string[]; rep: SurfaceFindings; findings: Finding[] };

/**
 * Group surfaces that changed identically (same signature) into one group each,
 * keeping the widest surface as the representative. The rects differ per width;
 * the change itself does not. Callers pass the already-prepared per-surface
 * findings (missing/one-sided surfaces excluded upstream).
 */
export function groupBySignature(prepared: SurfaceFindings[]): SignatureGroup[] {
  const bySig = new Map<string, SignatureGroup>();
  for (const p of prepared) {
    const sig = signatureOf(p.findings);
    const existing = bySig.get(sig);
    if (existing) {
      existing.surfaces.push(p.surface);
      if (surfaceWidth(p.surface) > surfaceWidth(existing.rep.surface)) existing.rep = p;
    } else {
      bySig.set(sig, { surfaces: [p.surface], rep: p, findings: p.findings });
    }
  }
  return [...bySig.values()];
}

/**
 * The set of element paths that changed as SHARED CHROME — a persistent frame
 * element (nav rail, header, footer) that every view renders and that moved on
 * every view that renders it.
 *
 * The rule is STRUCTURAL, deliberately NOT a tunable percentage. For each changed
 * path we compare two base-key sets:
 *   - `hosting`  — the surface bases whose style map contains the path at all;
 *   - `changed`  — the surface bases where the path appears in a finding.
 * The path is chrome iff it is hosted on MORE THAN ONE base and it changed on
 * EVERY base that hosts it (`changed ⊇ hosting`). "Every surface that has this
 * element changed it" is exactly what shared chrome means; it needs no threshold
 * to tune or defend. A content element (hosted on one base) fails the >1 guard; a
 * partial change (some hosting bases unchanged) fails the coverage guard.
 *
 * Widths of one base collapse to the base key, so a nav present at @1280 and @390
 * counts once. `surfacePaths` maps each captured surface key → the element paths
 * it renders (union of both sides from the caller).
 */
export function chromePaths(
  changedOnSurfaces: Array<{ path: string; surfaces: string[] }>,
  surfacePaths: Map<string, Set<string>>,
  surfaceKeyOf?: (captureKey: string) => string | undefined,
): Set<string> {
  const baseOf = (captureKey: string) => productSurfaceBase(captureKey, surfaceKeyOf?.(captureKey));
  const hosting = new Map<string, Set<string>>();
  for (const [surface, paths] of surfacePaths) {
    const base = baseOf(surface);
    for (const p of paths) {
      const set = hosting.get(p) ?? new Set<string>();
      set.add(base);
      hosting.set(p, set);
    }
  }
  const changed = new Map<string, Set<string>>();
  for (const f of changedOnSurfaces) {
    const set = changed.get(f.path) ?? new Set<string>();
    for (const s of f.surfaces) set.add(baseOf(s));
    changed.set(f.path, set);
  }
  const chrome = new Set<string>();
  for (const [path, changedBases] of changed) {
    const hostingBases = hosting.get(path) ?? new Set([path]);
    if (hostingBases.size > 1 && [...hostingBases].every((b) => changedBases.has(b))) chrome.add(path);
  }
  return chrome;
}

/**
 * Split signature groups into the shared-chrome tier and the rest. A group is
 * promoted only when EVERY one of its affected element paths is a chrome path
 * (see `chromePaths`) — a group that entangles a frame change with a view's own
 * content change stays in `rest` and renders in place, so we never hide a
 * content change under a chrome banner.
 */
export function classifyChrome<G extends { surfaces: string[]; findings: Finding[] }>(
  groups: G[],
  surfacePaths: Map<string, Set<string>>,
  surfaceKeyOf?: (captureKey: string) => string | undefined,
): { chrome: G[]; rest: G[]; chromePaths: Set<string> } {
  // Findings tagged with the surfaces the group spans, so chromePaths sees which
  // bases each path changed on across ALL groups (a path bundled with content on
  // one view still counts as changed there).
  const tagged = groups.flatMap((g) => g.findings.map((f) => ({ path: f.path, surfaces: g.surfaces })));
  const paths = chromePaths(tagged, surfacePaths, surfaceKeyOf);

  const chrome: G[] = [];
  const rest: G[] = [];
  for (const g of groups) {
    const affected = new Set(g.findings.map((f) => f.path));
    const isChrome = affected.size > 0 && [...affected].every((p) => paths.has(p));
    (isChrome ? chrome : rest).push(g);
  }
  return { chrome, rest, chromePaths: paths };
}
