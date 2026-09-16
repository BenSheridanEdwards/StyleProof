import { type Finding } from './diff.js';
import { signatureOf } from './findings-clean.js';
import { productSurfaceBase, surfaceWidth } from './surface-keys.js';

/** Shared-chrome tier: group surfaces that changed identically and promote frame elements that moved on every hosting view. */

/** A surface's diff distilled to its key and the findings kept after noise-cleaning. */
export type SurfaceFindings = { surface: string; findings: Finding[] };

/** Surfaces that changed the SAME way, collapsed to one group + a representative. */
export type SignatureGroup = { surfaces: string[]; rep: SurfaceFindings; findings: Finding[] };

/** Group surfaces by signature, keeping the widest surface as the representative. */
export function groupBySignature(prepared: SurfaceFindings[]): SignatureGroup[] {
  const bySig = new Map<string, SignatureGroup>();
  for (const p of prepared) {
    const sig = signatureOf(p.findings);
    const existing = bySig.get(sig);
    if (!existing) {
      bySig.set(sig, { surfaces: [p.surface], rep: p, findings: p.findings });
      continue;
    }
    existing.surfaces.push(p.surface);
    if (surfaceWidth(p.surface) > surfaceWidth(existing.rep.surface)) existing.rep = p;
  }
  return [...bySig.values()];
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
  const set = index.get(key) ?? new Set<string>();
  set.add(value);
  index.set(key, set);
}

/**
 * Element paths that changed as SHARED CHROME: hosted on MORE THAN ONE surface
 * base and changed on EVERY base that hosts it. Structural, not a tunable
 * percentage. Widths of one base collapse to the base key. `surfacePaths` maps
 * each captured surface key → the element paths it renders (both sides).
 */
export function chromePaths(
  changedOnSurfaces: Array<{ path: string; surfaces: string[] }>,
  surfacePaths: Map<string, Set<string>>,
  surfaceKeyOf?: (captureKey: string) => string | undefined,
): Set<string> {
  const baseOf = (captureKey: string) => productSurfaceBase(captureKey, surfaceKeyOf?.(captureKey));
  const hosting = new Map<string, Set<string>>();
  for (const [surface, paths] of surfacePaths) for (const p of paths) addTo(hosting, p, baseOf(surface));
  const changed = new Map<string, Set<string>>();
  for (const f of changedOnSurfaces) for (const s of f.surfaces) addTo(changed, f.path, baseOf(s));
  const chrome = new Set<string>();
  for (const [path, changedBases] of changed) {
    const hostingBases = hosting.get(path) ?? new Set([path]);
    if (hostingBases.size > 1 && [...hostingBases].every((b) => changedBases.has(b))) chrome.add(path);
  }
  return chrome;
}

/**
 * Split signature groups into the shared-chrome tier and the rest. A group is
 * promoted only when EVERY affected path is chrome, so a content change is never
 * hidden under a chrome banner.
 */
export function classifyChrome<G extends { surfaces: string[]; findings: Finding[] }>(
  groups: G[],
  surfacePaths: Map<string, Set<string>>,
  surfaceKeyOf?: (captureKey: string) => string | undefined,
): { chrome: G[]; rest: G[]; chromePaths: Set<string> } {
  // Tag findings with their group's surfaces so chromePaths sees every base a path changed on.
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
