import type { ElementEntry, StyleMap } from './capture.js';
import { diffStyleMaps, type DiffStyleOptions, type Finding } from './diff.js';

/**
 * Report-only structural correspondence between base and head captures.
 *
 * The low-level differ can still inventory concrete structural paths for
 * settle and variant tooling. Certification excludes structure, while report
 * presentation may remap a one-sided before path onto a uniquely corresponding
 * after path so path churn collapses into real paired property deltas.
 *
 * Matching is intentionally conservative:
 * - candidates are only DOM-removed (before) vs DOM-added (after) paths
 * - signature is privacy-safe: tag + rect x/y/width + ownTextLength (height
 *   omitted so pure size changes still pair)
 * - signature must be unique on both sides
 * - paths must share a meaningful structural prefix
 * - ambiguous or incomplete signatures stay unmatched
 */

/** Privacy-safe correspondence key, or null when the entry cannot be paired. */
export function correspondenceSignature(entry: ElementEntry | undefined): string | null {
  if (!entry?.rect) return null;
  const [x, y, width] = entry.rect;
  // ownTextLength is always safe (length only). Legacy maps without it stay
  // unpaired: geometry alone is not enough evidence to claim correspondence.
  if (entry.ownTextLength === undefined) return null;
  const textLen = entry.ownTextLength;
  return JSON.stringify([entry.tag, x, y, width, textLen]);
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

/**
 * Require a non-empty shared ancestor segment so unrelated subtrees that
 * happen to share geometry cannot pair across the whole document.
 */
export function hasMeaningfulSharedPrefix(beforePath: string, afterPath: string): boolean {
  return sharedPathPrefix(beforePath, afterPath).length > 0;
}

function indexBySignature(map: StyleMap, paths: string[]): Map<string, string[]> {
  const bySig = new Map<string, string[]>();
  for (const elementPath of paths) {
    const sig = correspondenceSignature(map.elements[elementPath]);
    if (sig === null) continue;
    const list = bySig.get(sig);
    if (list) list.push(elementPath);
    else bySig.set(sig, [elementPath]);
  }
  return bySig;
}

/**
 * Conservative before→after path map among one-sided elements only.
 * Values are after (head) paths; keys are before (base) paths.
 */
export function correspondElementPaths(before: StyleMap, after: StyleMap): Map<string, string> {
  const removed = Object.keys(before.elements).filter((p) => !(p in after.elements));
  const added = Object.keys(after.elements).filter((p) => !(p in before.elements));
  if (removed.length === 0 || added.length === 0) return new Map();

  const removedBySig = indexBySignature(before, removed);
  const addedBySig = indexBySignature(after, added);
  const mapping = new Map<string, string>();

  for (const [sig, beforePaths] of removedBySig) {
    if (beforePaths.length !== 1) continue; // ambiguous on before side
    const afterPaths = addedBySig.get(sig);
    if (!afterPaths || afterPaths.length !== 1) continue; // missing or ambiguous on after
    const beforePath = beforePaths[0]!;
    const afterPath = afterPaths[0]!;
    if (!hasMeaningfulSharedPrefix(beforePath, afterPath)) continue;
    mapping.set(beforePath, afterPath);
  }

  return mapping;
}

/** Rewrite an element path, preserving a `::pseudo` suffix when present. */
export function remapPath(elementPath: string, beforeToAfter: Map<string, string>): string {
  const pseudoAt = elementPath.indexOf('::');
  if (pseudoAt === -1) return beforeToAfter.get(elementPath) ?? elementPath;
  const base = elementPath.slice(0, pseudoAt);
  const pseudo = elementPath.slice(pseudoAt);
  return (beforeToAfter.get(base) ?? base) + pseudo;
}

/**
 * Clone a before map with matched element (and safe forced-state) paths rewritten
 * onto their corresponding after paths. Unmatched paths stay put.
 */
export function remapBeforeStyleMap(before: StyleMap, beforeToAfter: Map<string, string>): StyleMap {
  if (beforeToAfter.size === 0) return before;

  const elements: StyleMap['elements'] = {};
  for (const [elementPath, entry] of Object.entries(before.elements)) {
    elements[remapPath(elementPath, beforeToAfter)] = entry;
  }

  const states: NonNullable<StyleMap['states']> = {};
  for (const [ownerPath, byState] of Object.entries(before.states ?? {})) {
    const newOwner = remapPath(ownerPath, beforeToAfter);
    const mappedByState: (typeof states)[string] = {};
    for (const [stateName, targets] of Object.entries(byState)) {
      const mappedTargets: typeof targets = {};
      for (const [targetPath, props] of Object.entries(targets)) {
        // Owner and target paths remap independently when each end corresponded;
        // a target that did not correspond keeps its concrete before path and
        // will surface as a one-sided state inventory against the real after map
        // — safer than inventing a head path.
        mappedTargets[remapPath(targetPath, beforeToAfter)] = props;
      }
      mappedByState[stateName] = mappedTargets;
    }
    states[newOwner] = mappedByState;
  }

  return {
    ...before,
    elements,
    states,
    volatile: before.volatile?.map((p) => remapPath(p, beforeToAfter)),
    liveCandidates: before.liveCandidates?.map((c) => ({ ...c, path: remapPath(c.path, beforeToAfter) })),
    overlays: before.overlays?.map((o) => ({ ...o, path: remapPath(o.path, beforeToAfter) })),
  };
}

/** Before map rewritten for presentation lookup/diff against the real after map. */
export function presentationBeforeMap(before: StyleMap, after: StyleMap): StyleMap {
  return remapBeforeStyleMap(before, correspondElementPaths(before, after));
}

/**
 * Presentation findings on a before map whose uniquely corresponded paths have
 * been rewritten to the head path. Callers choose whether low-level structural
 * inventory is included; production certification always passes false.
 */
export function presentationDiffStyleMaps(
  before: StyleMap,
  after: StyleMap,
  options: DiffStyleOptions = {},
): Finding[] {
  return diffStyleMaps(presentationBeforeMap(before, after), after, options);
}
