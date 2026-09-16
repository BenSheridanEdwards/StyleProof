import type { ElementEntry, StyleMap } from '../capture.js';
import type { Finding } from '../diff.js';
import { containerOf, innermost } from './geometry.js';

/**
 * Which element paths to outline on each side of a crop. A same-identity element
 * that provably MOVED (a sibling insertion displaced it) is not boxed on either
 * side; everything else is boxed where it exists.
 */

type PathMatches = { beforeToAfter: Map<string, string>; afterToBefore: Map<string, string> };

const byName = (left: string, right: string): number => left.localeCompare(right, 'en');
const byPath = (left: string, right: string): number => left.localeCompare(right, 'en', { numeric: true });
const sortedProperties = (props: Record<string, string>): [string, string][] =>
  Object.entries(props).sort(([l], [r]) => byName(l, r));

function restingIdentity(entry: ElementEntry | undefined): unknown {
  if (!entry) return null;
  const pseudo = Object.fromEntries(
    Object.entries(entry.pseudo ?? {})
      .sort(([l], [r]) => byName(l, r))
      .map(([name, props]) => [name, sortedProperties(props)]),
  );
  return [
    entry.tag,
    entry.cls,
    entry.rect?.[2] ?? null,
    entry.rect?.[3] ?? null,
    sortedProperties(entry.style),
    pseudo,
  ];
}

const normalizeStructuralPath = (p: string): string =>
  p.replace(/:nth-(?:child|of-type)\(\d+\)/g, (s) => s.replace(/\d+/, '*'));

const annotationScope = (p: string): string => normalizeStructuralPath(containerOf(p));

function relativeStateTarget(ownerPath: string, targetPath: string): string {
  if (targetPath === ownerPath) return '';
  if (targetPath.startsWith(`${ownerPath}::`)) return targetPath.slice(ownerPath.length);
  const prefix = `${ownerPath} > `;
  return normalizeStructuralPath(targetPath.startsWith(prefix) ? targetPath.slice(prefix.length) : targetPath);
}

function identityOf(map: StyleMap, elementPath: string, entry: ElementEntry): string {
  const states = Object.entries(map.states?.[elementPath] ?? {})
    .sort(([l], [r]) => byName(l, r))
    .map(([stateName, deltas]) => [
      stateName,
      Object.entries(deltas)
        .map(([target, props]) => [
          relativeStateTarget(elementPath, target),
          restingIdentity(map.elements[target]),
          sortedProperties(props),
        ])
        .sort((l, r) => byName(JSON.stringify(l), JSON.stringify(r))),
    ]);
  return JSON.stringify([restingIdentity(entry), states]);
}

function groupPaths(paths: Iterable<string>, keyOf: (p: string) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = keyOf(p);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) group.sort(byPath);
  return groups;
}

function childCounts(map: StyleMap): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of Object.keys(map.elements)) counts.set(containerOf(p), (counts.get(containerOf(p)) ?? 0) + 1);
  return counts;
}

/** The container where two paths diverge (never the leaf itself). */
function divergenceContainer(beforePath: string, afterPath: string): string {
  const a = beforePath.split(' > ');
  const b = afterPath.split(' > ');
  const shared: string[] = [];
  for (let i = 0; i < Math.min(a.length, b.length) - 1 && a[i] === b[i]; i++) shared.push(a[i]);
  return shared.join(' > ');
}

type Reconciler = {
  before: StyleMap;
  after: StyleMap;
  beforeCounts: Map<string, number>;
  afterCounts: Map<string, number>;
  matches: PathMatches;
};

/** A cross-path match is a MOVE claim and must be provable: the divergence container
 *  gained/lost captured children, or a same-container slide into a vacated slot. */
function isProvableMove(r: Reconciler, beforePath: string, afterPath: string): boolean {
  const divergence = divergenceContainer(beforePath, afterPath);
  if ((r.beforeCounts.get(divergence) ?? 0) !== (r.afterCounts.get(divergence) ?? 0)) return true;
  if (containerOf(beforePath) !== containerOf(afterPath)) return false;
  return !r.before.elements[afterPath] && !r.after.elements[beforePath];
}

function reconcileIdentity(r: Reconciler, beforePaths: string[], afterPaths: string[]): void {
  const remainingBefore = new Set(beforePaths);
  const remainingAfter = new Set(afterPaths);
  const match = (b: string, a: string): void => {
    r.matches.beforeToAfter.set(b, a);
    r.matches.afterToBefore.set(a, b);
    remainingBefore.delete(b);
    remainingAfter.delete(a);
  };
  // Stable paths first, so duplicate occurrences stay deterministic.
  for (const p of beforePaths) if (remainingAfter.has(p)) match(p, p);
  const afterByScope = groupPaths(remainingAfter, annotationScope);
  // Reconcile only within the same normalized structural neighbourhood.
  for (const beforePath of [...remainingBefore].sort(byPath)) {
    const candidates = afterByScope.get(annotationScope(beforePath)) ?? [];
    const afterPath = candidates.find((c) => remainingAfter.has(c) && isProvableMove(r, beforePath, c));
    if (afterPath) match(beforePath, afterPath);
  }
}

function reconcilePaths(before: StyleMap, after: StyleMap): PathMatches {
  const index = (map: StyleMap) => groupPaths(Object.keys(map.elements), (p) => identityOf(map, p, map.elements[p]));
  const beforeIndex = index(before);
  const afterIndex = index(after);
  const r: Reconciler = {
    before,
    after,
    beforeCounts: childCounts(before),
    afterCounts: childCounts(after),
    matches: { beforeToAfter: new Map(), afterToBefore: new Map() },
  };
  for (const identity of new Set([...beforeIndex.keys(), ...afterIndex.keys()])) {
    reconcileIdentity(r, beforeIndex.get(identity) ?? [], afterIndex.get(identity) ?? []);
  }
  return r.matches;
}

/** Leaf paths to outline on each side for the given findings. */
export function annotationPaths(
  findings: Finding[],
  before: StyleMap,
  after: StyleMap,
): { before: string[]; after: string[] } {
  const matches = reconcilePaths(before, after);
  const beforePaths = new Set<string>();
  const afterPaths = new Set<string>();
  for (const f of findings) {
    const movedBefore = (matches.beforeToAfter.get(f.path) ?? f.path) !== f.path;
    const movedAfter = (matches.afterToBefore.get(f.path) ?? f.path) !== f.path;
    const dom = f.kind === 'dom' ? f.change : null;
    if (dom !== 'added' && (dom === 'retagged' || !movedBefore)) beforePaths.add(f.path);
    if (dom !== 'removed' && (dom === 'retagged' || !movedAfter)) afterPaths.add(f.path);
  }
  return { before: innermost([...beforePaths]), after: innermost([...afterPaths]) };
}
