import fs from 'node:fs';
import path from 'node:path';
import { loadStyleMap, isUnder, type StyleMap } from './capture.js';
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

export type DiffCounts = { dom: number; style: number; state: number };

/** A change to an element's own rendered text (opt-in content layer). Kept out
 *  of `Finding`/`DiffCounts` on purpose: content is advisory, never part of the
 *  computed-style certification or its blocking counts. */
export type ContentChange = { path: string; cls: string; before: string; after: string };

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

/** Union of both captures' live-region paths — skipped by every diff layer so a
 *  region volatile on either side never reads as a change. */
function volatilePaths(a: StyleMap, b: StyleMap): string[] {
  return [...new Set([...(a.volatile ?? []), ...(b.volatile ?? [])])];
}

/** Diff two style maps of the same surface. */
// Pre-existing, grandfathered in the health baseline; the content layer only
// extracted volatilePaths out of this, it is not newly complex.
// fallow-ignore-next-line complexity
export function diffStyleMaps(a: StyleMap, b: StyleMap): Finding[] {
  const findings: Finding[] = [];

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
      const present = (ea ?? eb)!;
      findings.push({
        kind: 'dom',
        path: p,
        cls: present.cls,
        change: !ea ? 'added' : 'removed',
        ...(!ea && eb.component ? { component: eb.component } : {}),
      });
      // An added element has no "before", so the style loop below is skipped —
      // surface its full resting computed style (+ pseudos) as (unset)→value so a
      // new element's styling is reviewable, not just its interaction-state
      // deltas. Removed elements get none (there is no "after" to show).
      if (!ea && eb) {
        const defsB = b.defaults[eb.tag] ?? {};
        for (const pseudo of [null, ...Object.keys(eb.pseudo ?? {})]) {
          const propsB = pseudo ? (eb.pseudo?.[pseudo] ?? {}) : eb.style;
          const pdefsB = pseudo ? (b.defaults[eb.tag + pseudo] ?? defsB) : defsB;
          const props = diffProps({}, propsB, {}, pdefsB, '(unset)', '(unset)');
          if (props.length) findings.push({ kind: 'style', path: p, cls: eb.cls, pseudo, props });
        }
      }
      continue;
    }
    if (ea.tag !== eb.tag) {
      findings.push({
        kind: 'dom',
        path: p,
        cls: ea.cls,
        change: 'retagged',
        detail: `<${ea.tag}> → <${eb.tag}>`,
        ...(eb.component ? { component: eb.component } : {}),
      });
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
      const props = dropSubpixelOriginProps(pseudo ? rawProps : dropLayoutEquivalentMarginProps(rawProps, ea, eb));
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
    const sa = a.states?.[p] ?? {};
    const sb = b.states?.[p] ?? {};
    const cls = (a.elements[p] ?? b.elements[p])?.cls ?? '';
    for (const state of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const da = sa[state] ?? {};
      const db = sb[state] ?? {};
      for (const sub of new Set([...Object.keys(da), ...Object.keys(db)])) {
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

/** Diff every same-named capture between two directories. `volatile` is the
 *  count of live regions auto-excluded across all surfaces (union per surface). */
export function diffStyleMapDirs(
  dirA: string,
  dirB: string,
): { surfaces: SurfaceDiff[]; counts: DiffCounts; volatile: number; statesUncertified: number; compared: number } {
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
  const counts: DiffCounts = { dom: 0, style: 0, state: 0 };
  const uncompared = { volatile: 0, statesUncertified: 0 };
  for (const surface of names) {
    if (!indexA[surface] || !indexB[surface]) {
      // A surface present on only one side has no baseline to diff against — it's
      // a NEW surface, not a style change. It does NOT count toward the change
      // tallies (those drive the review gate); the consumer flags it separately
      // off the `missing` marker and shows it for reference without blocking.
      surfaces.push({ surface, missing: indexA[surface] ? 'after' : 'before', findings: [] });
      continue;
    }
    const findings = diffSurfacePair(indexA[surface], indexB[surface], uncompared);
    tallyCounts(findings, counts);
    if (findings.length) surfaces.push({ surface, findings });
  }
  return { surfaces, counts, ...uncompared, compared: names.length };
}

/** Diff one paired surface, tallying what was NOT compared (volatile subtrees;
 *  a forced-state layer skipped on BOTH sides — {} vs {} certifies nothing). */
function diffSurfacePair(
  fileA: string,
  fileB: string,
  uncompared: { volatile: number; statesUncertified: number },
): Finding[] {
  const mapA = loadStyleMap(fileA);
  const mapB = loadStyleMap(fileB);
  uncompared.volatile += new Set([...(mapA.volatile ?? []), ...(mapB.volatile ?? [])]).size;
  if (mapA.statesSkipped && mapB.statesSkipped) uncompared.statesUncertified++;
  return diffStyleMaps(mapA, mapB);
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
  const volatile = volatilePaths(a, b);
  // Only paths present in BOTH captures: an add/remove is a DOM change the style
  // diff already owns, so iterating the intersection both skips them and keeps
  // this loop branch-light. Equal text (incl. both absent → '' === '') drops out.
  const common = Object.keys(a.elements)
    .filter((p) => p in b.elements)
    .sort();
  const out: ContentChange[] = [];
  for (const p of common) {
    if (isUnder(p, volatile)) continue;
    const before = ownText(a.elements[p].text);
    const after = ownText(b.elements[p].text);
    if (before !== after) out.push({ path: p, cls: a.elements[p].cls, before, after });
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
