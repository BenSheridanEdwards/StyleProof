import type { ElementEntry, StyleMap } from './capture.js';

/**
 * Structural correspondence between base and head captures.
 *
 * Certification keys every element by its structural path, so path churn that
 * leaves an element visually where it was — a sibling inserted before it, a
 * wrapper added around it — would otherwise read as remove + add. Structure is
 * advisory and never gates, so a real restyle on such a re-keyed element would
 * then vanish from the certification diff entirely (issue #472). Two conservative
 * passes rewrite the BEFORE map onto the head's paths so real property deltas
 * pair up. Certification (`diffStyleMapDirs`) runs both ({@link correspondBeforeMap});
 * report presentation runs the geometry pass only ({@link presentationBeforeMap}) so
 * a shifted sibling still shows its crops as a one-sided inventory.
 *
 *   1. content shift — an element whose hashed semantic path pattern, tag,
 *      class, own-text length and component match on both sides pairs k-th to
 *      k-th in document order, but only while the group is the same size on
 *      both sides (an nth-child shift, never a real add/remove).
 *   2. geometry — one-sided elements pair by tag + rect x/y/width + ownTextLength
 *      (height omitted so pure size changes still pair). The signature must be
 *      unique on both sides, and the paths must either share an ancestor
 *      segment or be a re-nesting of each other (one path is the other with
 *      segments inserted, same leaf). For certification the hashed identities
 *      along the path must also match: an element whose own or ancestor `id` /
 *      `data-testid` / `data-style` identity was replaced stays structural, and
 *      so do its descendants, exactly as in pass 1.
 *
 * Ambiguous or incomplete signatures stay unmatched, and therefore fail closed
 * exactly as before.
 */

// ─── pass 1: content shift ─────────────────────────────────────────────────────

/**
 * Privacy-safe identity for correspondence across an nth-child shift. Positional
 * indexes are normalized, while hashed semantic path segments remain exact: a
 * sibling insertion can move the same element, but a developer-authored identity
 * replacement must stay structural instead of being paired back into a restyle.
 * A class is capture metadata already present in every map; own-text length and
 * React component name disambiguate repeated semantic classes without storing
 * copy. Empty anonymous elements stay unmatched rather than receiving invented
 * provenance.
 */
function contentCorrespondenceSignature(elementPath: string, element: StyleMap['elements'][string]): string | null {
  const className = element.cls.trim();
  const componentName = element.component?.name ?? '';
  if (!className && !componentName && element.ownTextLength === undefined) return null;
  const semanticPathPattern = elementPath.replace(/:nth-child\(\d+\)/g, ':nth-child(*)');
  return JSON.stringify([semanticPathPattern, element.tag, className, element.ownTextLength ?? null, componentName]);
}

function pathsByContentSignature(map: StyleMap): Map<string, string[]> {
  const pathsBySignature = new Map<string, string[]>();
  for (const [elementPath, element] of Object.entries(map.elements)) {
    const signature = contentCorrespondenceSignature(elementPath, element);
    if (!signature) continue;
    pathsBySignature.set(signature, [...(pathsBySignature.get(signature) ?? []), elementPath]);
  }
  return pathsBySignature;
}

/**
 * base path -> head path for every element whose identity is recognisable on both
 * sides but whose concrete path moved. A signature shared by several elements
 * (repeated same-shaped rows) pairs k-th to k-th in document order — map
 * insertion order is capture's DOM walk — but only while the group's size is
 * identical on both sides: pairing a count-preserving group can at worst re-label
 * a visually-equivalent remove+add as a matched pair, whereas a size change means
 * a real add/remove somewhere in the group, so those groups stay concrete and
 * therefore fail closed.
 */
function correspondingPathsByContentSignature(before: StyleMap, after: StyleMap): Map<string, string> {
  const bySignatureAfter = pathsByContentSignature(after);
  const beforeToAfter = new Map<string, string>();
  for (const [signature, beforePaths] of pathsByContentSignature(before)) {
    const afterPaths = bySignatureAfter.get(signature) ?? [];
    if (afterPaths.length !== beforePaths.length) continue;
    beforePaths.forEach((beforePath, groupIndex) => {
      const afterPath = afterPaths[groupIndex]!;
      if (afterPath !== beforePath) beforeToAfter.set(beforePath, afterPath);
    });
  }
  return beforeToAfter;
}

/**
 * Re-key identifiable base elements onto their head paths before a
 * content-disabled comparison. This prevents a sibling insertion or removal from
 * making unchanged elements at shifted nth-child paths compare against the wrong
 * siblings.
 */
export function correspondContentShiftedPaths(before: StyleMap, after: StyleMap): StyleMap {
  const beforeToAfter = correspondingPathsByContentSignature(before, after);
  if (beforeToAfter.size === 0) return before;

  // A matched element can move onto a path occupied by an ambiguous element in
  // the base capture. That occupant has no trustworthy head identity, so it
  // must not overwrite the matched evidence when the object is re-keyed.
  const displacedUnmatchedPaths = new Set(
    [...beforeToAfter.values()].filter((afterPath) => afterPath in before.elements && !beforeToAfter.has(afterPath)),
  );
  const remapShifted = (elementPath: string): string | null => {
    const correspondingPath = beforeToAfter.get(elementPath);
    if (correspondingPath) return correspondingPath;
    return displacedUnmatchedPaths.has(elementPath) ? null : elementPath;
  };
  const elements: StyleMap['elements'] = {};
  for (const [elementPath, element] of Object.entries(before.elements)) {
    const correspondingPath = remapShifted(elementPath);
    if (correspondingPath) elements[correspondingPath] = element;
  }

  const states: StyleMap['states'] = {};
  for (const [ownerPath, statesByName] of Object.entries(before.states ?? {})) {
    const correspondingOwnerPath = remapShifted(ownerPath);
    if (!correspondingOwnerPath) continue;
    const remappedStates: (typeof states)[string] = {};
    for (const [stateName, targets] of Object.entries(statesByName)) {
      remappedStates[stateName] = Object.fromEntries(
        Object.entries(targets)
          .map(([targetPath, properties]) => [remapShifted(targetPath), properties] as const)
          .filter((entry): entry is [string, (typeof entry)[1]] => entry[0] !== null),
      );
    }
    states[correspondingOwnerPath] = remappedStates;
  }

  const remapKnownPaths = (elementPaths: string[] | undefined): string[] | undefined =>
    elementPaths?.map(remapShifted).filter((elementPath): elementPath is string => elementPath !== null);

  return {
    ...before,
    elements,
    states,
    volatile: remapKnownPaths(before.volatile),
    liveCandidates: before.liveCandidates?.flatMap((candidate) => {
      const correspondingPath = remapShifted(candidate.path);
      return correspondingPath ? [{ ...candidate, path: correspondingPath }] : [];
    }),
    overlays: before.overlays?.flatMap((overlay) => {
      const correspondingPath = remapShifted(overlay.path);
      return correspondingPath ? [{ ...overlay, path: correspondingPath }] : [];
    }),
  };
}

// ─── pass 2: geometry ──────────────────────────────────────────────────────────

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

const positionAgnosticSegments = (elementPath: string): string[] =>
  elementPath.split(' > ').map((segment) => segment.replace(/:nth-child\(\d+\)/g, ':nth-child(*)'));

/**
 * True when one path is the other with ancestor segments inserted — a wrapper
 * added around, or removed from around, the same leaf element. Positional
 * indexes are ignored (the wrapped element's own index may change) while hashed
 * semantic segments must still match exactly. Same-length paths are never a
 * re-nesting; the shared-prefix rule covers those.
 */
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

/** The hashed developer-authored identities along a path (`tr:sp-key(…)` segments),
 *  positional indexes ignored. Empty for a purely positional path. */
const hashedIdentitySequence = (elementPath: string): string =>
  positionAgnosticSegments(elementPath)
    .filter((segment) => segment.includes(':sp-key('))
    .join(' > ');

export type CorrespondenceOptions = {
  /**
   * Refuse to pair two elements whose hashed identity sequence differs — an
   * element (or one of its ancestors) that gained, lost, or swapped its `id` /
   * `data-testid` / `data-style` identity. A developer-authored identity
   * replacement is a structural change, never a restyle to pair back — the same
   * rule the content-shift pass applies to every hashed segment. Certification
   * sets this; presentation stays geometry-only.
   */
  requireSameHashedIdentity?: boolean;
};

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
export function correspondElementPaths(
  before: StyleMap,
  after: StyleMap,
  options: CorrespondenceOptions = {},
): Map<string, string> {
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
    if (!hasMeaningfulSharedPrefix(beforePath, afterPath) && !isReNestedPath(beforePath, afterPath)) continue;
    if (options.requireSameHashedIdentity && hashedIdentitySequence(beforePath) !== hashedIdentitySequence(afterPath)) {
      continue;
    }
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

/**
 * Before map rewritten for report presentation: geometry correspondence only.
 * Presentation deliberately keeps a shifted sibling one-sided so a reviewer still
 * sees its crops as an inventory; certification runs {@link correspondBeforeMap}.
 */
export function presentationBeforeMap(before: StyleMap, after: StyleMap): StyleMap {
  return remapBeforeStyleMap(before, correspondElementPaths(before, after));
}

// ─── composite (certification) ─────────────────────────────────────────────────

/**
 * The before map rewritten onto the head's paths for certification: content shift
 * first, then geometry among whatever is still one-sided. `diffStyleMapDirs`
 * runs this whenever structure is excluded, so a restyle on a re-nested element
 * is gated instead of vanishing with the advisory remove+add.
 */
export function correspondBeforeMap(before: StyleMap, after: StyleMap): StyleMap {
  const shifted = correspondContentShiftedPaths(before, after);
  return remapBeforeStyleMap(shifted, correspondElementPaths(shifted, after, { requireSameHashedIdentity: true }));
}
