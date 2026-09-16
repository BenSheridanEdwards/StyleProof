import type { ElementEntry, StyleMap } from './capture.js';

/**
 * Structural correspondence between base and head captures. Certification keys
 * every element by its structural path, so path churn that leaves an element
 * visually where it was (a sibling inserted, a wrapper added) would read as
 * remove + add — and, structure being advisory, a real restyle on it would
 * vanish. Two conservative passes rewrite the BEFORE map onto the head's paths:
 *
 *   1. content shift — same hashed semantic path pattern, tag, class, own-text
 *      length and component on both sides pair k-th to k-th, only while the group
 *      is the same size on both sides (an nth-child shift, never an add/remove).
 *   2. geometry — one-sided elements pair by tag + rect x/y/width + ownTextLength,
 *      unique on both sides, sharing an ancestor segment or re-nested. For
 *      certification the hashed identities along the path must also match.
 *
 * Ambiguous or incomplete signatures stay unmatched and fail closed as before.
 */

/** A path rewrite: the corresponding head path, or null to drop the entry. */
type PathRemap = (elementPath: string) => string | null;

/** Re-key a record's entries through `remap`, dropping the ones it maps to null. */
function remapKeys<V>(record: Record<string, V>, remap: PathRemap, value: (v: V) => V = (v) => v): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, entry] of Object.entries(record)) {
    const to = remap(key);
    if (to) out[to] = value(entry);
  }
  return out;
}

/** Clone a map with every element, forced-state owner/target, volatile, live-candidate and overlay path rewritten. */
function remapStyleMap(before: StyleMap, remap: PathRemap): StyleMap {
  // Owner and target paths remap independently; an unmatched target keeps its
  // concrete before path and surfaces as a one-sided state inventory.
  type Targets = NonNullable<StyleMap['states']>[string][string];
  const states = remapKeys(before.states ?? {}, remap, (byState) =>
    Object.fromEntries(
      Object.entries(byState).map(([name, targets]) => [name, remapKeys<Targets[string]>(targets, remap)]),
    ),
  );
  const withPath = <T extends { path: string }>(items: T[] | undefined): T[] | undefined =>
    items?.flatMap((item) => {
      const to = remap(item.path);
      return to ? [{ ...item, path: to }] : [];
    });
  return {
    ...before,
    elements: remapKeys(before.elements, remap),
    states,
    volatile: before.volatile?.map(remap).filter((p): p is string => p !== null),
    liveCandidates: withPath(before.liveCandidates),
    overlays: withPath(before.overlays),
  };
}

// ─── pass 1: content shift ─────────────────────────────────────────────────────

const positionAgnostic = (elementPath: string): string => elementPath.replace(/:nth-child\(\d+\)/g, ':nth-child(*)');

/**
 * Privacy-safe identity across an nth-child shift: positional indexes normalized,
 * hashed semantic segments exact (a developer-authored identity replacement stays
 * structural). Empty anonymous elements stay unmatched.
 */
function contentCorrespondenceSignature(elementPath: string, element: ElementEntry): string | null {
  const className = element.cls.trim();
  const componentName = element.component?.name ?? '';
  if (!className && !componentName && element.ownTextLength === undefined) return null;
  return JSON.stringify([
    positionAgnostic(elementPath),
    element.tag,
    className,
    element.ownTextLength ?? null,
    componentName,
  ]);
}

function pathsByContentSignature(map: StyleMap): Map<string, string[]> {
  const pathsBySignature = new Map<string, string[]>();
  for (const [elementPath, element] of Object.entries(map.elements)) {
    const signature = contentCorrespondenceSignature(elementPath, element);
    if (signature) pathsBySignature.set(signature, [...(pathsBySignature.get(signature) ?? []), elementPath]);
  }
  return pathsBySignature;
}

/** base path → head path for elements whose identity is recognisable on both sides but whose path moved. */
function correspondingPathsByContentSignature(before: StyleMap, after: StyleMap): Map<string, string> {
  const bySignatureAfter = pathsByContentSignature(after);
  const beforeToAfter = new Map<string, string>();
  for (const [signature, beforePaths] of pathsByContentSignature(before)) {
    const afterPaths = bySignatureAfter.get(signature) ?? [];
    // A size change means a real add/remove somewhere in the group: stay concrete.
    if (afterPaths.length !== beforePaths.length) continue;
    beforePaths.forEach((beforePath, i) => {
      if (afterPaths[i] !== beforePath) beforeToAfter.set(beforePath, afterPaths[i]!);
    });
  }
  return beforeToAfter;
}

/** Re-key identifiable base elements onto their head paths so an nth-child shift compares the right siblings. */
export function correspondContentShiftedPaths(before: StyleMap, after: StyleMap): StyleMap {
  const beforeToAfter = correspondingPathsByContentSignature(before, after);
  if (beforeToAfter.size === 0) return before;
  // A matched element can move onto a path held by an ambiguous base element; that
  // occupant has no trustworthy head identity and must not overwrite the match.
  const displaced = new Set(
    [...beforeToAfter.values()].filter((afterPath) => afterPath in before.elements && !beforeToAfter.has(afterPath)),
  );
  return remapStyleMap(before, (p) => beforeToAfter.get(p) ?? (displaced.has(p) ? null : p));
}

// ─── pass 2: geometry ──────────────────────────────────────────────────────────

/** Privacy-safe correspondence key, or null when the entry cannot be paired. */
export function correspondenceSignature(entry: ElementEntry | undefined): string | null {
  // Legacy maps without ownTextLength stay unpaired: geometry alone is not enough evidence.
  if (!entry?.rect || entry.ownTextLength === undefined) return null;
  const [x, y, width] = entry.rect;
  return JSON.stringify([entry.tag, x, y, width, entry.ownTextLength]);
}

/** Longest exact leading path-segment prefix (`a > b` style). */
export function sharedPathPrefix(beforePath: string, afterPath: string): string {
  const beforeSegs = beforePath.split(' > ');
  const afterSegs = afterPath.split(' > ');
  const shared: string[] = [];
  const limit = Math.min(beforeSegs.length, afterSegs.length);
  for (let i = 0; i < limit && beforeSegs[i] === afterSegs[i]; i++) shared.push(beforeSegs[i]!);
  return shared.join(' > ');
}

/** A non-empty shared ancestor segment, so unrelated subtrees with the same geometry cannot pair. */
export function hasMeaningfulSharedPrefix(beforePath: string, afterPath: string): boolean {
  return sharedPathPrefix(beforePath, afterPath).length > 0;
}

const positionAgnosticSegments = (elementPath: string): string[] => positionAgnostic(elementPath).split(' > ');

/** True when one path is the other with ancestor segments inserted (a wrapper added/removed around the same leaf). */
export function isReNestedPath(beforePath: string, afterPath: string): boolean {
  const before = positionAgnosticSegments(beforePath);
  const after = positionAgnosticSegments(afterPath);
  if (before.length === after.length) return false;
  const [shorter, longer] = before.length < after.length ? [before, after] : [after, before];
  if (shorter[shorter.length - 1] !== longer[longer.length - 1]) return false;
  let matched = 0;
  for (const segment of longer) if (matched < shorter.length && segment === shorter[matched]) matched++;
  return matched === shorter.length;
}

/** The hashed developer-authored identities along a path (`:sp-key(…)` segments), positional indexes ignored. */
const hashedIdentitySequence = (elementPath: string): string =>
  positionAgnosticSegments(elementPath)
    .filter((segment) => segment.includes(':sp-key('))
    .join(' > ');

export type CorrespondenceOptions = {
  /** Refuse to pair elements whose hashed identity sequence differs: an identity swap is structural. Certification sets this. */
  requireSameHashedIdentity?: boolean;
};

function indexBySignature(map: StyleMap, paths: string[]): Map<string, string[]> {
  const bySig = new Map<string, string[]>();
  for (const elementPath of paths) {
    const sig = correspondenceSignature(map.elements[elementPath]);
    if (sig !== null) bySig.set(sig, [...(bySig.get(sig) ?? []), elementPath]);
  }
  return bySig;
}

/** Conservative before→after path map among one-sided elements only (unique signature on both sides). */
export function correspondElementPaths(
  before: StyleMap,
  after: StyleMap,
  options: CorrespondenceOptions = {},
): Map<string, string> {
  const removed = Object.keys(before.elements).filter((p) => !(p in after.elements));
  const added = Object.keys(after.elements).filter((p) => !(p in before.elements));
  if (removed.length === 0 || added.length === 0) return new Map();
  const addedBySig = indexBySignature(after, added);
  const mapping = new Map<string, string>();
  for (const [sig, beforePaths] of indexBySignature(before, removed)) {
    const afterPaths = addedBySig.get(sig);
    if (beforePaths.length !== 1 || afterPaths?.length !== 1) continue;
    const [beforePath] = beforePaths;
    const [afterPath] = afterPaths;
    if (!hasMeaningfulSharedPrefix(beforePath, afterPath) && !isReNestedPath(beforePath, afterPath)) continue;
    if (options.requireSameHashedIdentity && hashedIdentitySequence(beforePath) !== hashedIdentitySequence(afterPath)) {
      continue;
    }
    mapping.set(beforePath, afterPath);
  }
  return mapping;
}

/** Rewrite an element path, preserving a `::pseudo` suffix when present. */
function remapPath(elementPath: string, beforeToAfter: Map<string, string>): string {
  const pseudoAt = elementPath.indexOf('::');
  if (pseudoAt === -1) return beforeToAfter.get(elementPath) ?? elementPath;
  const base = elementPath.slice(0, pseudoAt);
  return (beforeToAfter.get(base) ?? base) + elementPath.slice(pseudoAt);
}

/** Clone a before map with matched element (and forced-state) paths rewritten; unmatched paths stay put. */
export function remapBeforeStyleMap(before: StyleMap, beforeToAfter: Map<string, string>): StyleMap {
  if (beforeToAfter.size === 0) return before;
  return remapStyleMap(before, (p) => remapPath(p, beforeToAfter));
}

/** Presentation: geometry correspondence only, so a shifted sibling still shows its crops as a one-sided inventory. */
export function presentationBeforeMap(before: StyleMap, after: StyleMap): StyleMap {
  return remapBeforeStyleMap(before, correspondElementPaths(before, after));
}

/** Certification: content shift first, then geometry among whatever is still one-sided. */
export function correspondBeforeMap(before: StyleMap, after: StyleMap): StyleMap {
  const shifted = correspondContentShiftedPaths(before, after);
  return remapBeforeStyleMap(shifted, correspondElementPaths(shifted, after, { requireSameHashedIdentity: true }));
}
