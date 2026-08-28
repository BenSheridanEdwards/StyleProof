import fs from 'node:fs';
import path from 'node:path';
import { loadStyleMap, isUnder, validateProductStateIdentity, type StyleMap } from './capture.js';
import { isProductStateComparabilityStatus, type ProductStateComparabilityStatus } from './comparability-status.js';
export { isProductStateComparabilityStatus, type ProductStateComparabilityStatus } from './comparability-status.js';
import { isMapFile, MAP_MANIFEST } from './map-store.js';
import { styleValuesEqual } from './canonicalize.js';

/**
 * Structured diff between two style maps. Custom properties (--*) are
 * ignored: they are inputs, not outcomes — every visual effect of a variable
 * lands in a real longhand which is compared in full.
 */

export type PropChange = { prop: string; before: string; after: string };

/**
 * The before dir carries a bundle MANIFEST but ZERO captures while the after dir
 * held some — a restore or capture that claims success yet delivered no maps (a
 * corrupt bundle, a wrong --base-dir pointed at a manifest-only dir). Without
 * this guard every after surface diffs as `missing: 'before'` (exit 3, "only new
 * surfaces") and a whole app of regressions becomes one approvable "🆕 all new"
 * report. The CLIs map this to exit 2 — a hard error, never the rubber-stampable
 * exit 3. A truly BARE base dir (no manifest, no maps) is different: it means
 * "never captured — no baseline exists yet", the first-adoption flow where the
 * base commit predates the capture spec, and it keeps the exit-3 review path.
 * (Both dirs empty stays the plain "no captures found" throw.)
 */
export class MissingBaseMapError extends Error {
  constructor() {
    super(
      'base map missing: restore it from the map store or recapture both sides — refusing to treat every surface as new. ' +
        'Next: run styleproof-map --restore --sha <base>, or let CI recapture both sides.',
    );
    this.name = 'MissingBaseMapError';
  }
}

/**
 * The mirror case: the AFTER (head) dir held ZERO captures while the before dir
 * held some — a head capture or restore that produced nothing. Without this
 * guard every base surface marks `missing: 'after'`, the CLI's new-surface count
 * (which tallies BOTH directions) exits 3, and a head that rendered nothing
 * becomes an approvable "all new surfaces" report — and, once approved, the
 * next base. Same exit-2 path via the CLIs' existing catch.
 */
export class MissingHeadMapError extends Error {
  constructor() {
    super(
      'head map missing: the head capture produced zero surfaces — recapture the head side; refusing to treat every surface as removed/new. ' +
        'Next: re-run styleproof-map on the head commit, or let CI recapture both sides.',
    );
    this.name = 'MissingHeadMapError';
  }
}

export type Finding =
  // `component` is advisory passthrough from the capture (the React component
  // that rendered the element), carried so the report can name it — it is never
  // compared, exactly like the content layer's text.
  | {
      kind: 'dom';
      path: string;
      cls: string;
      change: 'added' | 'removed' | 'retagged';
      detail?: string;
      component?: { name: string; props?: Record<string, string> };
    }
  | {
      kind: 'style';
      path: string;
      cls: string;
      pseudo: string | null;
      props: PropChange[];
      /**
       * Whether normalized own-text length changed, or could not be compared
       * because at least one legacy map omitted the signal.
       */
      contentLengthSignal?: 'changed' | 'unknown';
    }
  | { kind: 'state'; path: string; cls: string; state: string; sub: string; props: PropChange[] };

export type SurfaceDiff = {
  surface: string;
  /** Set when the surface was captured in only one of the two sets. */
  missing?: 'before' | 'after';
  findings: Finding[];
};

export type SurfaceComparability = {
  surface: string;
  status: ProductStateComparabilityStatus;
  /** True when either side opted into explicit product-state identity. */
  required: boolean;
  reason:
    | 'explicit-state-match'
    | 'explicit-state-mismatch'
    | 'state-identity-missing'
    | 'state-identity-invalid'
    | 'missing-before'
    | 'missing-after';
};

export type ComparabilitySummary = {
  status: ProductStateComparabilityStatus;
  requireStateIdentity: boolean;
  blocksCertification: boolean;
  counts: {
    comparable: number;
    incomparable: number;
    unproven: number;
    notRequired: number;
    requiredUnproven: number;
    globalRequiredUnproven: number;
  };
};

/** Aggregate bounded receipts without promoting absent legacy identity to proof. */
export function summarizeComparability(
  receipts: SurfaceComparability[],
  requireStateIdentity = false,
): ComparabilitySummary {
  const normalized = receipts.map((entry) =>
    isProductStateComparabilityStatus(entry.status)
      ? entry
      : { ...entry, status: 'unproven' as const, required: true, reason: 'state-identity-invalid' as const },
  );
  const counts = {
    comparable: normalized.filter((entry) => entry.status === 'comparable').length,
    incomparable: normalized.filter((entry) => entry.status === 'incomparable').length,
    unproven: normalized.filter((entry) => entry.status === 'unproven').length,
    notRequired: normalized.filter((entry) => entry.status === 'not-required').length,
    requiredUnproven: normalized.filter((entry) => entry.status === 'unproven' && entry.required).length,
    globalRequiredUnproven: requireStateIdentity
      ? normalized.filter((entry) => entry.status === 'unproven' && !entry.required).length
      : 0,
  };
  const status: ProductStateComparabilityStatus =
    counts.incomparable > 0
      ? 'incomparable'
      : counts.unproven > 0
        ? 'unproven'
        : counts.comparable > 0
          ? 'comparable'
          : 'not-required';
  return {
    status,
    requireStateIdentity,
    blocksCertification: counts.incomparable > 0 || counts.requiredUnproven > 0 || counts.globalRequiredUnproven > 0,
    counts,
  };
}

export type DiffCounts = { dom: number; style: number; state: number };

export type DiffStyleOptions = {
  /**
   * Include DOM additions/removals/retags and style/state inventories for
   * one-sided elements. Defaults to true for low-level callers such as settle
   * detection and variant discovery. Certification passes false because
   * structure belongs to the opt-in advisory content layer.
   */
  includeStructure?: boolean;
};

/** Content and structural changes are an opt-in advisory layer. Kept out of
 *  `Finding`/`DiffCounts` on purpose: neither affects style certification or
 *  blocking counts when content comparison is disabled. */
export type ContentChange =
  | { kind: 'text'; path: string; cls: string; before: string; after: string }
  | {
      kind: 'structure';
      path: string;
      cls: string;
      change: 'added' | 'removed' | 'retagged';
      detail?: string;
    };

function diffProps(
  propsA: Record<string, string>,
  propsB: Record<string, string>,
  fallbackA: Record<string, string>,
  fallbackB: Record<string, string>,
  unsetA: string,
  unsetB: string,
): PropChange[] {
  const changed: PropChange[] = [];
  for (const prop of new Set([...Object.keys(propsA), ...Object.keys(propsB)])) {
    if (prop.startsWith('--')) continue;
    const before = propsA[prop] ?? fallbackA[prop] ?? unsetA;
    const after = propsB[prop] ?? fallbackB[prop] ?? unsetB;
    // Compare by CANONICAL value, so an identical value serialized differently by a
    // browser/build-tool version (`rgba(8, 18, 32, 0.62)` vs `#0812209e`, comma-spacing in
    // a font list) is not reported as a change. The report still shows the real strings.
    if (!styleValuesEqual(before, after)) changed.push({ prop, before, after });
  }
  return changed;
}

const LAYOUT_EQUIVALENT_MARGIN_PROPS = new Set([
  'margin-left',
  'margin-right',
  'margin-inline-start',
  'margin-inline-end',
]);
const SUBPIXEL_ORIGIN_PROPS = new Set(['perspective-origin', 'transform-origin']);
const ORIGIN_EPSILON_PX = 0.05;

function sameRect(a?: [number, number, number, number], b?: [number, number, number, number]): boolean {
  return !!a && !!b && a.every((v, i) => v === b[i]);
}

const HORIZONTAL_MARGIN_PAIRS: [string, string][] = [
  ['margin-left', 'margin-right'],
  ['margin-inline-start', 'margin-inline-end'],
];

function marginPxDelta(p: PropChange): number | null {
  const before = pxParts(p.before);
  const after = pxParts(p.after);
  return before?.length === 1 && after?.length === 1 ? after[0]! - before[0]! : null;
}

// True when one horizontal side moved by a different px amount than its
// opposite. Such a change would shift the box on its own, so an *identical*
// rect means something else compensated — a real restyle, not layout-equivalent
// drift. Non-px or state-sentinel values (`(state no longer changes it)`) aren't
// demonstrable, so they fall through to the balanced (drop) path unchanged.
function marginChangeHasPxImbalance(props: PropChange[]): boolean {
  const delta = new Map<string, number | null>();
  for (const p of props) {
    if (LAYOUT_EQUIVALENT_MARGIN_PROPS.has(p.prop)) delta.set(p.prop, marginPxDelta(p));
  }
  for (const [start, end] of HORIZONTAL_MARGIN_PAIRS) {
    const ds = delta.has(start) ? delta.get(start)! : 0;
    const de = delta.has(end) ? delta.get(end)! : 0;
    if (ds !== null && de !== null && ds !== de) return true;
  }
  return false;
}

function dropLayoutEquivalentMarginProps(
  props: PropChange[],
  a?: StyleMap['elements'][string],
  b?: StyleMap['elements'][string],
): PropChange[] {
  if (!sameRect(a?.rect, b?.rect)) return props;
  // ponytail: a balanced margin change with an unchanged rect is treated as
  // layout-equivalent from computed style alone. That still drops the rare case
  // where a *balanced* change was held in place by external compensation — a
  // consciously-deferred, low-reach soundness corner; closing it needs
  // cross-element layout reasoning. The common one-sided case is caught here.
  if (marginChangeHasPxImbalance(props)) return props;
  return props.filter((p) => !LAYOUT_EQUIVALENT_MARGIN_PROPS.has(p.prop));
}

function pxParts(value: string): number[] | null {
  const parts = value.trim().split(/\s+/);
  // 1–3 components: a single-value origin (`50px`) jitters the same way as the
  // 2/3-component form and must be suppressed identically.
  if (parts.length < 1 || parts.length > 3) return null;
  const values = parts.map((part) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(part);
    return match ? Number(match[1]) : Number.NaN;
  });
  return values.every(Number.isFinite) ? values : null;
}

function sameSubpixelOrigin(before: string, after: string): boolean {
  const a = pxParts(before);
  const b = pxParts(after);
  return !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= ORIGIN_EPSILON_PX);
}

function dropSubpixelOriginProps(props: PropChange[]): PropChange[] {
  return props.filter((p) => !SUBPIXEL_ORIGIN_PROPS.has(p.prop) || !sameSubpixelOrigin(p.before, p.after));
}

/**
 * CSSOM resolves several layout-dependent computed values to used pixels. A
 * sibling/content change can therefore move an `auto` margin or resize a `20%`
 * box without changing its CSS computed value. Current captures retain the CSS
 * Typed OM computed value only when it differs from that used value. When BOTH
 * sides prove the computed value is unchanged, the pixel delta is reflow, not a
 * style change. Legacy captures have no such proof and remain fail-closed.
 */
function dropUsedValueOnlyProps(
  props: PropChange[],
  elementA: StyleMap['elements'][string],
  elementB: StyleMap['elements'][string],
): PropChange[] {
  return props.filter((propertyChange) => {
    const computedBefore = elementA.computedValueStyle?.[propertyChange.prop];
    const computedAfter = elementB.computedValueStyle?.[propertyChange.prop];
    return !computedBefore || !computedAfter || !styleValuesEqual(computedBefore, computedAfter);
  });
}

/** Union of both captures' live-region paths — skipped by every diff layer so a
 *  region volatile on either side never reads as a change. */
function volatilePaths(a: StyleMap, b: StyleMap): string[] {
  return [...new Set([...(a.volatile ?? []), ...(b.volatile ?? [])])];
}

/** Diff two style maps of the same surface. */
// Pre-existing, grandfathered in the health baseline; the content layer only
// extracted volatilePaths out of this, it is not newly complex.
// fallow-ignore-next-line complexity
export function diffStyleMaps(a: StyleMap, b: StyleMap, options: DiffStyleOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const includeStructure = options.includeStructure ?? true;

  // Live regions either capture flagged as nondeterministic (a stream, ticker,
  // late-loading content): never diff them — their values move with no code
  // change. Union both sides so a region volatile on only one capture is still
  // skipped, in every layer (element, pseudo, forced-state).
  const volatile = volatilePaths(a, b);

  for (const p of [...new Set([...Object.keys(a.elements), ...Object.keys(b.elements)])].sort()) {
    if (volatile.length && isUnder(p, volatile)) continue;
    const ea = a.elements[p];
    const eb = b.elements[p];
    if (!ea || !eb) {
      if (includeStructure) {
        const present = (ea ?? eb)!;
        findings.push({
          kind: 'dom',
          path: p,
          cls: present.cls,
          change: !ea ? 'added' : 'removed',
          ...(!ea && eb.component ? { component: eb.component } : {}),
        });
        if (!ea && eb) {
          const defsB = b.defaults[eb.tag] ?? {};
          for (const pseudo of [null, ...Object.keys(eb.pseudo ?? {})]) {
            const propsB = pseudo ? (eb.pseudo?.[pseudo] ?? {}) : eb.style;
            const pdefsB = pseudo ? (b.defaults[eb.tag + pseudo] ?? defsB) : defsB;
            const props = diffProps({}, propsB, {}, pdefsB, '(unset)', '(unset)');
            if (props.length) findings.push({ kind: 'style', path: p, cls: eb.cls, pseudo, props });
          }
        }
      }
      continue;
    }
    if (ea.tag !== eb.tag) {
      if (includeStructure) {
        findings.push({
          kind: 'dom',
          path: p,
          cls: ea.cls,
          change: 'retagged',
          detail: `<${ea.tag}> → <${eb.tag}>`,
          ...(eb.component ? { component: eb.component } : {}),
        });
      }
      continue;
    }
    const defsA = a.defaults[ea.tag] ?? {};
    const defsB = b.defaults[eb.tag] ?? {};
    for (const pseudo of [null, ...new Set([...Object.keys(ea.pseudo ?? {}), ...Object.keys(eb.pseudo ?? {})])]) {
      const propsA = pseudo ? (ea.pseudo?.[pseudo] ?? {}) : ea.style;
      const propsB = pseudo ? (eb.pseudo?.[pseudo] ?? {}) : eb.style;
      // A pseudo-element is pruned against its own UA defaults (capture stores
      // them under a composite `tag::pseudo` key); fall back to the element's
      // tag defaults for maps written before that fix.
      const pdefsA = pseudo ? (a.defaults[ea.tag + pseudo] ?? defsA) : defsA;
      const pdefsB = pseudo ? (b.defaults[eb.tag + pseudo] ?? defsB) : defsB;
      const rawProps = diffProps(propsA, propsB, pdefsA, pdefsB, '(unset)', '(unset)');
      const restingProps = pseudo
        ? rawProps
        : dropUsedValueOnlyProps(dropLayoutEquivalentMarginProps(rawProps, ea, eb), ea, eb);
      const props = dropSubpixelOriginProps(restingProps);
      if (props.length) {
        const contentLengthSignal =
          pseudo !== null
            ? undefined
            : ea.ownTextLength === undefined || eb.ownTextLength === undefined
              ? 'unknown'
              : ea.ownTextLength !== eb.ownTextLength
                ? 'changed'
                : undefined;
        findings.push({
          kind: 'style',
          path: p,
          cls: ea.cls,
          pseudo,
          props,
          ...(contentLengthSignal ? { contentLengthSignal } : {}),
        });
      }
    }
  }

  // If the forced-state layer was skipped on exactly one side (CDP skew during
  // capture, or truncation past maxInteractive), the :hover/:focus/:active layer
  // was not fully compared — flag it loudly rather than letting {} vs {} read as
  // "identical".
  if (!!a.statesSkipped !== !!b.statesSkipped) {
    findings.push({
      kind: 'state',
      path: '(surface)',
      cls: '',
      state: 'forced-state capture',
      sub: '(surface)',
      props: [
        {
          prop: 'forced :hover/:focus/:active layer',
          before: a.statesSkipped ? 'not fully captured' : 'captured',
          after: b.statesSkipped ? 'not fully captured' : 'captured',
        },
      ],
    });
  }

  for (const p of new Set([...Object.keys(a.states ?? {}), ...Object.keys(b.states ?? {})])) {
    if (volatile.length && isUnder(p, volatile)) continue;
    if (!includeStructure && (!a.elements[p] || !b.elements[p] || a.elements[p].tag !== b.elements[p].tag)) continue;
    const sa = a.states?.[p] ?? {};
    const sb = b.states?.[p] ?? {};
    const cls = (a.elements[p] ?? b.elements[p])?.cls ?? '';
    for (const state of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const da = sa[state] ?? {};
      const db = sb[state] ?? {};
      for (const sub of new Set([...Object.keys(da), ...Object.keys(db)])) {
        if (!includeStructure && (!a.elements[sub] || !b.elements[sub] || a.elements[sub].tag !== b.elements[sub].tag))
          continue;
        const props = diffProps(
          da[sub] ?? {},
          db[sub] ?? {},
          {},
          {},
          '(state does not change it)',
          '(state no longer changes it)',
        );
        const filtered = dropSubpixelOriginProps(
          dropLayoutEquivalentMarginProps(props, a.elements[sub], b.elements[sub]),
        );
        if (filtered.length) findings.push({ kind: 'state', path: p, cls, state, sub, props: filtered });
      }
    }
  }

  return findings;
}

/** Add a surface's findings to the running totals (one DOM/style/state tally). */
function tallyCounts(findings: Finding[], counts: DiffCounts): void {
  for (const f of findings) {
    if (f.kind === 'dom') counts.dom++;
    else if (f.kind === 'style') counts.style += f.props.length;
    else counts.state += f.props.length;
  }
}

function indexDir(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter(isMapFile)
      .map((f) => [f.replace(/\.json(\.gz)?$/, ''), path.join(dir, f)]),
  );
}

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
function correspondContentShiftedPaths(before: StyleMap, after: StyleMap): StyleMap {
  const beforeToAfter = correspondingPathsByContentSignature(before, after);
  if (beforeToAfter.size === 0) return before;

  // A matched element can move onto a path occupied by an ambiguous element in
  // the base capture. That occupant has no trustworthy head identity, so it
  // must not overwrite the matched evidence when the object is re-keyed.
  const displacedUnmatchedPaths = new Set(
    [...beforeToAfter.values()].filter((afterPath) => afterPath in before.elements && !beforeToAfter.has(afterPath)),
  );
  const remapPath = (elementPath: string): string | null => {
    const correspondingPath = beforeToAfter.get(elementPath);
    if (correspondingPath) return correspondingPath;
    return displacedUnmatchedPaths.has(elementPath) ? null : elementPath;
  };
  const elements: StyleMap['elements'] = {};
  for (const [elementPath, element] of Object.entries(before.elements)) {
    const correspondingPath = remapPath(elementPath);
    if (correspondingPath) elements[correspondingPath] = element;
  }

  const states: StyleMap['states'] = {};
  for (const [ownerPath, statesByName] of Object.entries(before.states ?? {})) {
    const correspondingOwnerPath = remapPath(ownerPath);
    if (!correspondingOwnerPath) continue;
    const remappedStates: (typeof states)[string] = {};
    for (const [stateName, targets] of Object.entries(statesByName)) {
      remappedStates[stateName] = Object.fromEntries(
        Object.entries(targets)
          .map(([targetPath, properties]) => [remapPath(targetPath), properties] as const)
          .filter((entry): entry is [string, (typeof entry)[1]] => entry[0] !== null),
      );
    }
    states[correspondingOwnerPath] = remappedStates;
  }

  const remapKnownPaths = (elementPaths: string[] | undefined): string[] | undefined =>
    elementPaths?.map(remapPath).filter((elementPath): elementPath is string => elementPath !== null);

  return {
    ...before,
    elements,
    states,
    volatile: remapKnownPaths(before.volatile),
    liveCandidates: before.liveCandidates?.flatMap((candidate) => {
      const correspondingPath = remapPath(candidate.path);
      return correspondingPath ? [{ ...candidate, path: correspondingPath }] : [];
    }),
    overlays: before.overlays?.flatMap((overlay) => {
      const correspondingPath = remapPath(overlay.path);
      return correspondingPath ? [{ ...overlay, path: correspondingPath }] : [];
    }),
  };
}

/** Diff every same-named capture between two directories. `volatile` is the
 *  count of live regions auto-excluded across all surfaces (union per surface). */
export function diffStyleMapDirs(
  dirA: string,
  dirB: string,
  options: DiffStyleOptions = { includeStructure: false },
): {
  surfaces: SurfaceDiff[];
  counts: DiffCounts;
  comparability: SurfaceComparability[];
  volatile: number;
  statesUncertified: number;
  compared: number;
} {
  const indexA = indexDir(dirA);
  const indexB = indexDir(dirB);
  const names = [...new Set([...Object.keys(indexA), ...Object.keys(indexB)])].sort();
  if (names.length === 0) throw new Error(`no .json(.gz) captures found in ${dirA} or ${dirB}`);
  // A whole side with zero captures is a missing MAP, not a set of genuinely
  // new/removed surfaces — either way every surface would carry a `missing`
  // marker and the run would read as "all new" (exit 3, approvable). Refuse
  // each direction loudly with its own named cause — with one exception:
  //
  // Base side: only when the dir carries a bundle manifest. Manifest + zero maps
  // means a restore/capture that claims success yet delivered nothing (a corrupt
  // bundle) — breakage. A BARE dir (no manifest either) means no baseline was
  // ever captured — the first-adoption flow, where the recapture fallback checks
  // out a base commit that predates the capture spec. That legitimately yields
  // zero surfaces and must keep the exit-3 "new surfaces, review before
  // baselining" onboarding path, so it falls through.
  if (Object.keys(indexA).length === 0 && fs.existsSync(path.join(dirA, MAP_MANIFEST))) throw new MissingBaseMapError();
  // Head side: UNCONDITIONAL (bare or manifest-present). The onboarding
  // asymmetry only exists on the base side — the head is the commit under test,
  // so a head that produced zero captures is always breakage, never a review flow.
  if (Object.keys(indexB).length === 0) throw new MissingHeadMapError();

  const surfaces: SurfaceDiff[] = [];
  const comparability: SurfaceComparability[] = [];
  const counts: DiffCounts = { dom: 0, style: 0, state: 0 };
  const uncompared = { volatile: 0, statesUncertified: 0 };
  for (const surface of names) {
    if (!indexA[surface] || !indexB[surface]) {
      // A surface present on only one side has no baseline to diff against — it's
      // a NEW surface, not a style change. It does NOT count toward the change
      // tallies (those drive the review gate); the consumer flags it separately
      // off the `missing` marker and shows it for reference without blocking.
      surfaces.push({ surface, missing: indexA[surface] ? 'after' : 'before', findings: [] });
      comparability.push({
        surface,
        status: 'not-required',
        required: false,
        reason: indexA[surface] ? 'missing-after' : 'missing-before',
      });
      continue;
    }
    const pair = diffSurfacePair(surface, indexA[surface], indexB[surface], uncompared, options);
    comparability.push(pair.comparability);
    tallyCounts(pair.findings, counts);
    if (pair.findings.length) surfaces.push({ surface, findings: pair.findings });
  }
  return { surfaces, counts, comparability, ...uncompared, compared: names.length };
}

/** Diff one paired surface, tallying what was NOT compared (volatile subtrees;
 *  a forced-state layer skipped on BOTH sides — {} vs {} certifies nothing). */
function diffSurfacePair(
  surface: string,
  fileA: string,
  fileB: string,
  uncompared: { volatile: number; statesUncertified: number },
  options: DiffStyleOptions,
): { findings: Finding[]; comparability: SurfaceComparability } {
  const mapA = loadStyleMap(fileA);
  const mapB = loadStyleMap(fileB);
  uncompared.volatile += new Set([...(mapA.volatile ?? []), ...(mapB.volatile ?? [])]).size;
  if (mapA.statesSkipped && mapB.statesSkipped) uncompared.statesUncertified++;
  const comparableBase = options.includeStructure === false ? correspondContentShiftedPaths(mapA, mapB) : mapA;
  return {
    findings: diffStyleMaps(comparableBase, mapB, options),
    comparability: compareProductState(surface, mapA, mapB),
  };
}

function validProductState(value: unknown): value is { id: string; revision: string } {
  try {
    return validateProductStateIdentity(value) !== undefined;
  } catch {
    return false;
  }
}

function compareProductState(surface: string, before: StyleMap, after: StyleMap): SurfaceComparability {
  const beforeRaw = before.metadata?.productState;
  const afterRaw = after.metadata?.productState;
  const required = beforeRaw !== undefined || afterRaw !== undefined;
  if (!beforeRaw || !afterRaw) {
    return { surface, status: 'unproven', required, reason: 'state-identity-missing' };
  }
  if (!validProductState(beforeRaw) || !validProductState(afterRaw)) {
    return { surface, status: 'unproven', required: true, reason: 'state-identity-invalid' };
  }
  if (beforeRaw.id !== afterRaw.id || beforeRaw.revision !== afterRaw.revision) {
    return { surface, status: 'incomparable', required: true, reason: 'explicit-state-mismatch' };
  }
  return { surface, status: 'comparable', required: true, reason: 'explicit-state-match' };
}

/**
 * Diff the OPT-IN content layer: elements whose own rendered text changed.
 * Separate from {@link diffStyleMaps} by design — content never enters the
 * certification or its counts. Yields nothing unless capture ran with
 * `captureText: true` (no `text` on either side → nothing to compare), so it's a
 * no-op for anyone who hasn't opted in. Add/remove of an element is left to the
 * style diff (it surfaces there as a DOM change); this reports text that changed
 * on an element present in BOTH captures. Volatile (live) regions are skipped,
 * same as the style diff.
 */
/** Normalise captured text (absent → empty) so undefined and '' compare equal. */
const ownText = (t?: string): string => t ?? '';

export function diffContentMaps(a: StyleMap, b: StyleMap): ContentChange[] {
  const comparableBase = correspondContentShiftedPaths(a, b);
  const volatile = volatilePaths(comparableBase, b);
  const out: ContentChange[] = [];
  for (const p of [...new Set([...Object.keys(comparableBase.elements), ...Object.keys(b.elements)])].sort()) {
    if (isUnder(p, volatile)) continue;
    const elementA = comparableBase.elements[p];
    const elementB = b.elements[p];
    if (!elementA || !elementB) {
      const presentElement = (elementA ?? elementB)!;
      out.push({
        kind: 'structure',
        path: p,
        cls: presentElement.cls,
        change: elementA ? 'removed' : 'added',
      });
      continue;
    }
    if (elementA.tag !== elementB.tag) {
      out.push({
        kind: 'structure',
        path: p,
        cls: elementA.cls,
        change: 'retagged',
        detail: `<${elementA.tag}> → <${elementB.tag}>`,
      });
      continue;
    }
    const before = ownText(elementA.text);
    const after = ownText(elementB.text);
    if (before !== after) out.push({ kind: 'text', path: p, cls: elementA.cls, before, after });
  }
  return out;
}

/** Per-surface content diff across two capture dirs (opt-in layer). Mirrors
 *  {@link diffStyleMapDirs} but content-only and non-gating; surfaces present on
 *  just one side have no baseline and are skipped (the style diff reports those
 *  as new surfaces). */
export function diffContentDirs(
  dirA: string,
  dirB: string,
): { surfaces: { surface: string; changes: ContentChange[] }[]; count: number } {
  const indexA = indexDir(dirA);
  const indexB = indexDir(dirB);
  const both = Object.keys(indexA)
    .filter((s) => s in indexB)
    .sort();
  const surfaces: { surface: string; changes: ContentChange[] }[] = [];
  let count = 0;
  for (const surface of both) {
    const changes = diffContentMaps(loadStyleMap(indexA[surface]), loadStyleMap(indexB[surface]));
    if (changes.length) {
      surfaces.push({ surface, changes });
      count += changes.length;
    }
  }
  return { surfaces, count };
}

/** Human label: structural path plus a truncated class hint. */
export function findingLabel(path: string, cls: string): string {
  if (!cls) return path;
  const classes = cls.split(' ').filter(Boolean);
  return `${path}  (.${classes.slice(0, 3).join('.')}${classes.length > 3 ? '…' : ''})`;
}
