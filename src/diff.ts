import fs from 'node:fs';
import path from 'node:path';
import { loadStyleMap, isUnder, validateProductStateIdentity, type StyleMap } from './capture.js';
import { type ProductStateComparabilityStatus } from './comparability-status.js';
export {
  isProductStateComparabilityStatus,
  summarizeComparability,
  type ComparabilitySummary,
  type ProductStateComparabilityStatus,
} from './comparability-status.js';
import {
  isMapFile,
  MAP_MANIFEST,
  readMapManifest,
  baselineFailureReceipts,
  surfaceMissingMatchesBaselineFailure,
  type BaselineFailureReceipt,
  type SurfaceCaptureFailure,
} from './map-store.js';
export type { BaselineFailureReceipt } from './map-store.js';
import { styleValuesEqual } from './canonicalize.js';
import { addCounts, countFindings } from './findings-clean.js';
import { correspondBeforeMap, correspondContentShiftedPaths, presentationBeforeMap } from './path-correspondence.js';
import { pixelDiffSurface, type PixelOptions, type PixelSurfaceResult } from './pixel-diff.js';
import {
  auditLiveTextChanges,
  mergeLiveTextAudits,
  resolveLiveTextDeclaration,
  type LiveTextAudit,
} from './live-text.js';

/**
 * Structured diff between two style maps. Custom properties (--*) are ignored:
 * they are inputs, not outcomes — every visual effect lands in a real longhand.
 */

export type PropChange = { prop: string; before: string; after: string };

export type Finding =
  // `component` is advisory passthrough from the capture, carried so the report
  // can name it — never compared, exactly like the content layer's text.
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
      /** Own-text length changed, or could not be compared (a legacy map omitted the signal). */
      contentLengthSignal?: 'changed' | 'unknown';
    }
  | { kind: 'state'; path: string; cls: string; state: string; sub: string; props: PropChange[] };

/** Head-only surfaces split into first adoption (`genuinely-new`) and a failed prior baseline capture (`baseline-repair-debt`). */
export type SurfaceClassification = 'genuinely-new' | 'baseline-repair-debt' | 'removed' | 'changed' | 'unchanged';

export type SurfaceDiff = {
  surface: string;
  /** Set when the surface was captured in only one of the two sets. */
  missing?: 'before' | 'after';
  findings: Finding[];
  classification?: SurfaceClassification;
  /** True for genuinely new surfaces (derived from classification). */
  isNew?: boolean;
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

export type DiffCounts = { dom: number; style: number; state: number };

export type DiffStyleOptions = {
  /**
   * Include DOM additions/removals/retags and style/state inventories for
   * one-sided elements. Defaults to true; certification passes false because
   * structure belongs to the opt-in advisory content layer.
   */
  includeStructure?: boolean;
  /**
   * Also compare the captured screenshots and attribute every changed region to
   * the captured elements under it. Results land in `pixels`, never in `counts`.
   */
  pixels?: boolean | PixelOptions;
};

/** Content and structural changes: an opt-in advisory layer, never part of `Finding`/`DiffCounts`. */
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
    // Compare by CANONICAL value so a browser/build-tool serialization change is
    // not a change; the report still shows the real strings.
    if (!styleValuesEqual(before, after)) changed.push({ prop, before, after });
  }
  return changed;
}

const HORIZONTAL_MARGIN_PAIRS: [string, string][] = [
  ['margin-left', 'margin-right'],
  ['margin-inline-start', 'margin-inline-end'],
];
const LAYOUT_EQUIVALENT_MARGIN_PROPS = new Set(HORIZONTAL_MARGIN_PAIRS.flat());
const SUBPIXEL_ORIGIN_PROPS = new Set(['perspective-origin', 'transform-origin']);
const ORIGIN_EPSILON_PX = 0.05;

function sameRect(a?: [number, number, number, number], b?: [number, number, number, number]): boolean {
  return !!a && !!b && a.every((v, i) => v === b[i]);
}

/** 1–3 px components, else null (a single-value origin jitters like the 2/3-component form). */
function pxParts(value: string): number[] | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 3) return null;
  const values = parts.map((part) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(part);
    return match ? Number(match[1]) : Number.NaN;
  });
  return values.every(Number.isFinite) ? values : null;
}

function marginPxDelta(p: PropChange): number | null {
  const before = pxParts(p.before);
  const after = pxParts(p.after);
  return before?.length === 1 && after?.length === 1 ? after[0]! - before[0]! : null;
}

// One horizontal side moved by a different px amount than its opposite: that
// would shift the box on its own, so an identical rect means a real restyle.
// Non-px / sentinel values are not demonstrable and fall through to the drop path.
function marginChangeHasPxImbalance(props: PropChange[]): boolean {
  const delta = new Map<string, number | null>();
  for (const p of props) {
    if (LAYOUT_EQUIVALENT_MARGIN_PROPS.has(p.prop)) delta.set(p.prop, marginPxDelta(p));
  }
  return HORIZONTAL_MARGIN_PAIRS.some(([start, end]) => {
    const ds = delta.has(start) ? delta.get(start)! : 0;
    const de = delta.has(end) ? delta.get(end)! : 0;
    return ds !== null && de !== null && ds !== de;
  });
}

/** A balanced horizontal margin change with an unchanged rect is layout-equivalent drift. */
function dropLayoutEquivalentMarginProps(
  props: PropChange[],
  a?: StyleMap['elements'][string],
  b?: StyleMap['elements'][string],
): PropChange[] {
  if (!sameRect(a?.rect, b?.rect) || marginChangeHasPxImbalance(props)) return props;
  return props.filter((p) => !LAYOUT_EQUIVALENT_MARGIN_PROPS.has(p.prop));
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
 * CSSOM resolves several layout-dependent values to used pixels, so a sibling
 * change can move an `auto` margin without changing its CSS computed value. When
 * BOTH sides prove the computed value is unchanged, the pixel delta is reflow.
 * Legacy captures have no such proof and remain fail-closed.
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

/** Union of both captures' live-region paths — skipped by every diff layer. */
function volatilePaths(a: StyleMap, b: StyleMap): string[] {
  return [...new Set([...(a.volatile ?? []), ...(b.volatile ?? [])])];
}

/**
 * Head live-region paths the base did NOT also exclude: the base compared that
 * subtree, the head stopped settling it. The union skip above would hide
 * whatever the PR changed there (a new interval toggling a class on a
 * container), so these block certification instead of passing silently.
 */
export function headOnlyVolatilePaths(base: StyleMap, head: StyleMap): string[] {
  const baseVolatile = base.volatile ?? [];
  return (head.volatile ?? []).filter((p) => !isUnder(p, baseVolatile)).sort();
}

/** A head-only volatile subtree on one surface: excluded from the diff, so it cannot certify. */
export type HeadOnlyVolatile = { surface: string; path: string };

const unionKeys = (a: object, b: object): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])];
const sortedUnionKeys = (a: object, b: object): string[] => unionKeys(a, b).sort();

type Element = StyleMap['elements'][string];

/** An element's props for one layer plus the UA defaults it was pruned against
 *  (`tag::pseudo` key, falling back to the tag defaults for older maps). */
function layer(map: StyleMap, e: Element, pseudo: string | null): [Record<string, string>, Record<string, string>] {
  const defs = map.defaults[e.tag] ?? {};
  if (!pseudo) return [e.style, defs];
  return [e.pseudo?.[pseudo] ?? {}, map.defaults[e.tag + pseudo] ?? defs];
}

function contentLengthSignal(ea: Element, eb: Element) {
  if (ea.ownTextLength === undefined || eb.ownTextLength === undefined) return 'unknown' as const;
  return ea.ownTextLength !== eb.ownTextLength ? ('changed' as const) : undefined;
}

/** Structural inventory for an element present on one side only (added: its full style snapshot). */
function oneSidedFindings(p: string, ea: Element | undefined, eb: Element | undefined, b: StyleMap): Finding[] {
  const present = (ea ?? eb)!;
  const findings: Finding[] = [
    {
      kind: 'dom',
      path: p,
      cls: present.cls,
      change: !ea ? 'added' : 'removed',
      ...(!ea && eb?.component ? { component: eb.component } : {}),
    },
  ];
  if (ea || !eb) return findings;
  for (const pseudo of [null, ...Object.keys(eb.pseudo ?? {})]) {
    const [propsB, pdefsB] = layer(b, eb, pseudo);
    const props = diffProps({}, propsB, {}, pdefsB, '(unset)', '(unset)');
    if (props.length) findings.push({ kind: 'style', path: p, cls: eb.cls, pseudo, props });
  }
  return findings;
}

/** Style findings for an element present (same tag) on both sides, one per changed layer. */
function pairedFindings(p: string, a: StyleMap, b: StyleMap, ea: Element, eb: Element): Finding[] {
  const findings: Finding[] = [];
  for (const pseudo of [null, ...unionKeys(ea.pseudo ?? {}, eb.pseudo ?? {})]) {
    const [propsA, pdefsA] = layer(a, ea, pseudo);
    const [propsB, pdefsB] = layer(b, eb, pseudo);
    const rawProps = diffProps(propsA, propsB, pdefsA, pdefsB, '(unset)', '(unset)');
    const restingProps = pseudo
      ? rawProps
      : dropUsedValueOnlyProps(dropLayoutEquivalentMarginProps(rawProps, ea, eb), ea, eb);
    const props = dropSubpixelOriginProps(restingProps);
    if (!props.length) continue;
    const signal = pseudo === null ? contentLengthSignal(ea, eb) : undefined;
    findings.push({
      kind: 'style',
      path: p,
      cls: ea.cls,
      pseudo,
      props,
      ...(signal ? { contentLengthSignal: signal } : {}),
    });
  }
  return findings;
}

type DiffCtx = { a: StyleMap; b: StyleMap; includeStructure: boolean };

const pairedSameTag = ({ a, b }: DiffCtx, p: string): boolean =>
  !!a.elements[p] && !!b.elements[p] && a.elements[p].tag === b.elements[p].tag;

/** One forced state's deltas against every target element it touched. */
function stateTargetFindings(
  ctx: DiffCtx,
  owner: { path: string; cls: string; state: string },
  da: Record<string, Record<string, string>>,
  db: Record<string, Record<string, string>>,
): Finding[] {
  const findings: Finding[] = [];
  for (const sub of unionKeys(da, db)) {
    if (!ctx.includeStructure && !pairedSameTag(ctx, sub)) continue;
    const raw = diffProps(
      da[sub] ?? {},
      db[sub] ?? {},
      {},
      {},
      '(state does not change it)',
      '(state no longer changes it)',
    );
    const props = dropSubpixelOriginProps(
      dropLayoutEquivalentMarginProps(raw, ctx.a.elements[sub], ctx.b.elements[sub]),
    );
    if (props.length) findings.push({ kind: 'state', ...owner, sub, props });
  }
  return findings;
}

/** Forced-state deltas (`:hover`/`:focus`/`:active`) for one owner element. */
function stateFindings(p: string, ctx: DiffCtx): Finding[] {
  const { a, b, includeStructure } = ctx;
  if (!includeStructure && !pairedSameTag(ctx, p)) return [];
  const sa = a.states?.[p] ?? {};
  const sb = b.states?.[p] ?? {};
  const cls = (a.elements[p] ?? b.elements[p])?.cls ?? '';
  return unionKeys(sa, sb).flatMap((state) =>
    stateTargetFindings(ctx, { path: p, cls, state }, sa[state] ?? {}, sb[state] ?? {}),
  );
}

function elementFindings(p: string, { a, b, includeStructure }: DiffCtx): Finding[] {
  const ea = a.elements[p];
  const eb = b.elements[p];
  if (!ea || !eb) return includeStructure ? oneSidedFindings(p, ea, eb, b) : [];
  if (ea.tag === eb.tag) return pairedFindings(p, a, b, ea, eb);
  if (!includeStructure) return [];
  const component = eb.component ? { component: eb.component } : {};
  return [{ kind: 'dom', path: p, cls: ea.cls, change: 'retagged', detail: `<${ea.tag}> → <${eb.tag}>`, ...component }];
}

/** A forced-state layer skipped on exactly one side was not fully compared — flag it rather than letting {} vs {} read as "identical". */
function skippedLayerFindings(a: StyleMap, b: StyleMap): Finding[] {
  if (!!a.statesSkipped === !!b.statesSkipped) return [];
  const captured = (skipped?: boolean) => (skipped ? 'not fully captured' : 'captured');
  return [
    {
      kind: 'state',
      path: '(surface)',
      cls: '',
      state: 'forced-state capture',
      sub: '(surface)',
      props: [
        {
          prop: 'forced :hover/:focus/:active layer',
          before: captured(a.statesSkipped),
          after: captured(b.statesSkipped),
        },
      ],
    },
  ];
}

/** Diff two style maps of the same surface. */
export function diffStyleMaps(a: StyleMap, b: StyleMap, options: DiffStyleOptions = {}): Finding[] {
  const ctx: DiffCtx = { a, b, includeStructure: options.includeStructure ?? true };
  // Live regions flagged nondeterministic on EITHER side never diff, in any layer.
  const volatile = volatilePaths(a, b);
  const live = (p: string) => !volatile.length || !isUnder(p, volatile);
  return [
    ...sortedUnionKeys(a.elements, b.elements)
      .filter(live)
      .flatMap((p) => elementFindings(p, ctx)),
    ...skippedLayerFindings(a, b),
    ...unionKeys(a.states ?? {}, b.states ?? {})
      .filter(live)
      .flatMap((p) => stateFindings(p, ctx)),
  ];
}

function indexDir(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter(isMapFile)
      .map((f) => [f.replace(/\.json(\.gz)?$/, ''), path.join(dir, f)]),
  );
}

/** Surfaces captured in both dirs, sorted. */
function pairedSurfaces(indexA: Record<string, string>, indexB: Record<string, string>): string[] {
  return Object.keys(indexA)
    .filter((s) => s in indexB)
    .sort();
}

/** Presentation findings on a before map whose uniquely corresponded paths are rewritten to the head path. */
export function presentationDiffStyleMaps(
  before: StyleMap,
  after: StyleMap,
  options: DiffStyleOptions = {},
): Finding[] {
  return diffStyleMaps(presentationBeforeMap(before, after), after, options);
}

/**
 * A whole side with zero captures is a missing MAP, not a set of new/removed
 * surfaces: every surface would carry a `missing` marker and the run would read
 * as "all new" (exit 3, approvable). Base side: only when the dir carries a
 * bundle manifest — a BARE base dir is the first-adoption flow (the base commit
 * predates the capture spec) and keeps the exit-3 review path. Head side:
 * unconditional — the head is the commit under test, so zero captures is breakage.
 */
function assertBothSidesCaptured(dirA: string, indexA: Record<string, string>, indexB: Record<string, string>): void {
  if (Object.keys(indexA).length === 0 && fs.existsSync(path.join(dirA, MAP_MANIFEST))) {
    throw new Error(
      'base map missing: restore it from the map store or recapture both sides — refusing to treat every surface as new. ' +
        'Next: run styleproof-map --restore --sha <base>, or let CI recapture both sides.',
    );
  }
  if (Object.keys(indexB).length === 0) {
    throw new Error(
      'head map missing: the head capture produced zero surfaces — recapture the head side; refusing to treat every surface as removed/new. ' +
        'Next: re-run styleproof-map on the head commit, or let CI recapture both sides.',
    );
  }
}

/** Diff every same-named capture between two directories. `volatile` counts live regions auto-excluded across all surfaces. */
export function diffStyleMapDirs(
  dirA: string,
  dirB: string,
  options: DiffStyleOptions = { includeStructure: false },
): {
  surfaces: SurfaceDiff[];
  counts: DiffCounts;
  comparability: SurfaceComparability[];
  volatile: number;
  /** Subtrees volatile on the head but compared on the base: excluded, so they block certification. */
  headOnlyVolatile: HeadOnlyVolatile[];
  statesUncertified: number;
  compared: number;
  /** Bounded baseline capture failures read from the base manifest. */
  baselineFailures: BaselineFailureReceipt[];
  /** One entry per paired surface when `options.pixels` is set; absent otherwise. */
  pixels?: PixelSurfaceResult[];
} {
  const indexA = indexDir(dirA);
  const indexB = indexDir(dirB);
  const baselineManifest = readMapManifest(dirA);
  const baselineSurfaceFailures = baselineManifest?.surfaceCaptureFailures ?? [];
  const baselineFailures = baselineFailureReceipts(baselineSurfaceFailures, baselineManifest?.sha);
  const names = sortedUnionKeys(indexA, indexB);
  if (names.length === 0) throw new Error(`no .json(.gz) captures found in ${dirA} or ${dirB}`);
  assertBothSidesCaptured(dirA, indexA, indexB);

  const surfaces: SurfaceDiff[] = [];
  const comparability: SurfaceComparability[] = [];
  const pixels: PixelSurfaceResult[] = [];
  let counts: DiffCounts = { dom: 0, style: 0, state: 0 };
  const uncompared = { volatile: 0, statesUncertified: 0, headOnlyVolatile: [] as HeadOnlyVolatile[] };
  const pixelOptions = typeof options.pixels === 'object' ? options.pixels : {};
  for (const surface of names) {
    if (!indexA[surface] || !indexB[surface]) {
      const oneSided = oneSidedSurface(surface, indexA[surface] ? 'after' : 'before', baselineSurfaceFailures);
      surfaces.push(oneSided.diff);
      comparability.push(oneSided.comparability);
      continue;
    }
    const pair = diffSurfacePair(surface, indexA[surface], indexB[surface], uncompared, options);
    comparability.push(pair.comparability);
    counts = addCounts(counts, countFindings(pair.findings));
    if (pair.findings.length)
      surfaces.push({ surface, findings: pair.findings, classification: 'changed', isNew: false });
    if (options.pixels) {
      const [mapA, mapB] = [loadStyleMap(indexA[surface]), loadStyleMap(indexB[surface])];
      pixels.push(pixelDiffSurface(dirA, dirB, surface, mapA, mapB, pixelOptions));
    }
  }
  return {
    surfaces,
    counts,
    comparability,
    ...uncompared,
    compared: names.length,
    baselineFailures,
    ...(options.pixels ? { pixels } : {}),
  };
}

/** A surface captured on one side only has no baseline to diff against: NEW/REMOVED, never a change tally. */
function oneSidedSurface(
  surface: string,
  missing: 'before' | 'after',
  baselineFailures: SurfaceCaptureFailure[],
): { diff: SurfaceDiff; comparability: SurfaceComparability } {
  const classification: SurfaceClassification =
    missing === 'after'
      ? 'removed'
      : surfaceMissingMatchesBaselineFailure(surface, baselineFailures)
        ? 'baseline-repair-debt'
        : 'genuinely-new';
  return {
    diff: { surface, missing, findings: [], classification, isNew: classification === 'genuinely-new' },
    comparability: { surface, status: 'not-required', required: false, reason: `missing-${missing}` },
  };
}

type StyleMapWithStateEvidence = StyleMap & {
  /** Explicit false when captureStates was disabled (additive map field owned by capture). */
  statesCaptured?: boolean;
};

function forcedStateEvidenceIncomplete(map: StyleMap): boolean {
  return map.statesSkipped === true || (map as StyleMapWithStateEvidence).statesCaptured === false;
}

/** Diff one paired surface, tallying what was NOT compared (volatile subtrees, head-only ones named; an incomplete forced-state layer on EITHER side). */
function diffSurfacePair(
  surface: string,
  fileA: string,
  fileB: string,
  uncompared: { volatile: number; statesUncertified: number; headOnlyVolatile: HeadOnlyVolatile[] },
  options: DiffStyleOptions,
): { findings: Finding[]; comparability: SurfaceComparability } {
  const mapA = loadStyleMap(fileA);
  const mapB = loadStyleMap(fileB);
  uncompared.volatile += volatilePaths(mapA, mapB).length;
  if (forcedStateEvidenceIncomplete(mapA) || forcedStateEvidenceIncomplete(mapB)) uncompared.statesUncertified++;
  // Certification excludes structure, so a moved element must be paired back onto
  // its head path first or a real restyle on it vanishes with the advisory remove+add.
  const comparableBase = options.includeStructure === false ? correspondBeforeMap(mapA, mapB) : mapA;
  // Against the corresponded base, so a base live region matches the head path it moved to.
  for (const p of headOnlyVolatilePaths(comparableBase, mapB)) uncompared.headOnlyVolatile.push({ surface, path: p });
  return {
    findings: diffStyleMaps(comparableBase, mapB, options),
    comparability: compareProductState(surface, mapA, mapB),
  };
}

/** `[id, revision]` of a valid product-state identity, else null. */
function productStateKey(value: unknown): string | null {
  try {
    const identity = validateProductStateIdentity(value);
    return identity ? JSON.stringify([identity.id, identity.revision]) : null;
  } catch {
    return null;
  }
}

function compareProductState(surface: string, before: StyleMap, after: StyleMap): SurfaceComparability {
  const raw = [before.metadata?.productState, after.metadata?.productState];
  const required = raw.some((v) => v !== undefined);
  const keys = raw.map(productStateKey);
  if (raw.some((v) => !v)) return { surface, status: 'unproven', required, reason: 'state-identity-missing' };
  if (keys.some((key) => key === null)) {
    return { surface, status: 'unproven', required: true, reason: 'state-identity-invalid' };
  }
  if (keys[0] !== keys[1])
    return { surface, status: 'incomparable', required: true, reason: 'explicit-state-mismatch' };
  return { surface, status: 'comparable', required: true, reason: 'explicit-state-match' };
}

function contentChange(p: string, elementA?: Element, elementB?: Element): ContentChange | undefined {
  if (!elementA || !elementB) {
    return { kind: 'structure', path: p, cls: (elementA ?? elementB)!.cls, change: elementA ? 'removed' : 'added' };
  }
  if (elementA.tag !== elementB.tag) {
    const detail = `<${elementA.tag}> → <${elementB.tag}>`;
    return { kind: 'structure', path: p, cls: elementA.cls, change: 'retagged', detail };
  }
  const before = elementA.text ?? '';
  const after = elementB.text ?? '';
  return before === after ? undefined : { kind: 'text', path: p, cls: elementA.cls, before, after };
}

/**
 * Diff the OPT-IN content layer: elements present on BOTH sides whose own
 * rendered text changed (plus add/remove/retag as structure). Content never
 * enters certification or its counts; a no-op unless capture ran with
 * `captureText: true`. Volatile regions are skipped, same as the style diff.
 */
export function diffContentMaps(a: StyleMap, b: StyleMap): ContentChange[] {
  const base = correspondContentShiftedPaths(a, b);
  const volatile = volatilePaths(base, b);
  const out: ContentChange[] = [];
  for (const p of sortedUnionKeys(base.elements, b.elements)) {
    if (isUnder(p, volatile)) continue;
    const change = contentChange(p, base.elements[p], b.elements[p]);
    if (change) out.push(change);
  }
  return out;
}

/** Per-surface content diff across two capture dirs (opt-in, non-gating); one-sided surfaces are skipped. */
export function diffContentDirs(
  dirA: string,
  dirB: string,
): { surfaces: { surface: string; changes: ContentChange[] }[]; count: number } {
  const indexA = indexDir(dirA);
  const indexB = indexDir(dirB);
  const surfaces: { surface: string; changes: ContentChange[] }[] = [];
  let count = 0;
  for (const surface of pairedSurfaces(indexA, indexB)) {
    const changes = diffContentMaps(loadStyleMap(indexA[surface]), loadStyleMap(indexB[surface]));
    if (changes.length) {
      surfaces.push({ surface, changes });
      count += changes.length;
    }
  }
  return { surfaces, count };
}

function mapHasCapturedText(map: StyleMap): boolean {
  return Object.values(map.elements).some((entry) => entry.text !== undefined);
}

/** Audit declared live/age/clock text across a before/after pair of capture dirs. */
export function auditLiveTextDirs(dirA: string, dirB: string): LiveTextAudit {
  const indexA = indexDir(dirA);
  const indexB = indexDir(dirB);
  const audits: LiveTextAudit[] = [];
  for (const surface of pairedSurfaces(indexA, indexB)) {
    const before = loadStyleMap(indexA[surface]);
    const after = loadStyleMap(indexB[surface]);
    const declaration = resolveLiveTextDeclaration(after, before);
    const tags: Record<string, string> = {};
    for (const path of new Set([...Object.keys(before.elements), ...Object.keys(after.elements)])) {
      tags[path] = (after.elements[path] ?? before.elements[path])?.tag ?? '';
    }
    const audit = auditLiveTextChanges(surface, diffContentMaps(before, after), declaration, tags);
    if (declaration?.freeze && !mapHasCapturedText(before) && !mapHasCapturedText(after)) {
      audit.violations.push({ surface, path: '(capture)', before: '', after: '' });
    }
    audits.push(audit);
  }
  return mergeLiveTextAudits(audits);
}

/** Human label: structural path plus a truncated class hint. */
export function findingLabel(path: string, cls: string): string {
  if (!cls) return path;
  const classes = cls.split(' ').filter(Boolean);
  return `${path}  (.${classes.slice(0, 3).join('.')}${classes.length > 3 ? '…' : ''})`;
}
