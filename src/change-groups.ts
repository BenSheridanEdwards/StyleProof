import { type Finding, type PropChange } from './diff.js';
import { trackCount } from './describe.js';

/**
 * Pure grouping / classification of diff findings — the report's dedup brain,
 * lifted out of the crop-and-PNG machinery so BOTH the visual report
 * (`report.ts`, which renders screenshots on top) and the terminal differ
 * (`bin/styleproof-diff.mjs`, a leaf that must not pull Playwright-adjacent
 * modules) share ONE implementation. No `fs`, no `pngjs`, no `capture.js`: this
 * is a leaf so a bin can import it directly (#186 — bins import leaves, not the
 * barrel).
 *
 * What lives here: collapse logical→physical longhands and shorthand families
 * (`summarizeProps`), strip reflow-casualty/derived longhands (`cleanFindings`),
 * a canonical per-surface signature so surfaces that changed the SAME way group
 * once (`signatureOf` / `groupBySignature`), and the shared-chrome tier that
 * promotes a change spanning every hosting surface to a single callout
 * (`classifyChrome`).
 */

// ── property summarisation: dedupe logical longhands, collapse shorthand
//    families, humanize values ────────────────────────────────────────────────

// Logical longhand → its physical equivalent (LTR, horizontal-tb). Dropped when
// the physical one changed identically, so each change appears once.
const LOGICAL_TO_PHYSICAL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  const sides: Record<string, string> = {
    'block-start': 'top',
    'block-end': 'bottom',
    'inline-start': 'left',
    'inline-end': 'right',
  };
  for (const [l, p] of Object.entries(sides)) {
    for (const k of ['color', 'width', 'style']) m[`border-${l}-${k}`] = `border-${p}-${k}`;
    m[`margin-${l}`] = `margin-${p}`;
    m[`padding-${l}`] = `padding-${p}`;
    m[`inset-${l}`] = p;
  }
  const radius: Record<string, string> = {
    'start-start': 'top-left',
    'start-end': 'top-right',
    'end-start': 'bottom-left',
    'end-end': 'bottom-right',
  };
  for (const [l, p] of Object.entries(radius)) m[`border-${l}-radius`] = `border-${p}-radius`;
  return m;
})();

// Length-valued 4-side families → CSS 1–4-value shorthand whenever all four
// sides changed (e.g. `padding: 26px 24px → 28px`).
const BOX4: { short: string; parts: string[] }[] = [
  { short: 'margin', parts: ['top', 'right', 'bottom', 'left'].map((s) => `margin-${s}`) },
  { short: 'padding', parts: ['top', 'right', 'bottom', 'left'].map((s) => `padding-${s}`) },
  { short: 'border-width', parts: ['top', 'right', 'bottom', 'left'].map((s) => `border-${s}-width`) },
  {
    short: 'border-radius',
    parts: ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((s) => `border-${s}-radius`),
  },
];
// Colour/keyword families → one row only when all four sides match (else
// per-side, which keeps each colour swatchable).
const UNIFORM: { short: string; parts: string[] }[] = [
  { short: 'border-color', parts: ['top', 'right', 'bottom', 'left'].map((s) => `border-${s}-color`) },
  { short: 'border-style', parts: ['top', 'right', 'bottom', 'left'].map((s) => `border-${s}-style`) },
];
const boxShorthand = ([t, r, b, l]: string[]): string =>
  t === r && r === b && b === l
    ? t
    : t === b && r === l
      ? `${t} ${r}`
      : r === l
        ? `${t} ${r} ${b}`
        : `${t} ${r} ${b} ${l}`;

const PROP_ORDER = [
  'display',
  'position',
  'grid-template-columns',
  'grid-template-rows',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'margin',
  'padding',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  'outline',
  'background-color',
  'background-image',
  'color',
  'box-shadow',
  'opacity',
  'transform',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-align',
];
const orderIdx = (p: string): number => {
  const i = PROP_ORDER.indexOf(p);
  return i === -1 ? PROP_ORDER.length : i;
};

function cleanVal(v: string): string {
  // Verbatim by design: no rounding. Rounding once showed alpha 0.18 as 0.2 —
  // and could erase a real 0.18→0.2 diff entirely via the no-op filter below.
  let s = v;
  if (!s.includes('(')) {
    const toks = s.split(' ');
    if (toks.length > 1 && new Set(toks).size === 1) s = `${toks[0]} ×${toks.length}`;
  }
  return s.replace(/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/g, 'transparent');
}

// These default to `currentColor`, so a `color` change drags them all along —
// pure echoes, dropped when they match the `color` change.
const CURRENTCOLOR_FOLLOWERS = [
  'caret-color',
  'outline-color',
  'column-rule-color',
  'text-decoration-color',
  'text-emphasis-color',
  '-webkit-text-fill-color',
  '-webkit-text-stroke-color',
];

// "No value here" markers: a forced-state delta that doesn't apply, an unset
// longhand, or a capture artifact where a path didn't line up. A change BETWEEN
// two of these (e.g. `— → (gone)`) is meaningless and must never read as a diff.
const NON_VALUE = new Set(['(state does not change it)', '(state no longer changes it)', '(unset)', '(gone)']);
export const isNonValue = (v: string): boolean => NON_VALUE.has(v);
/** Combine longhands into a shorthand value; all-non-value sides collapse to one. */
const combineValues = (vals: string[]): string => (vals.every(isNonValue) ? '(unset)' : vals.join(' '));

// A flat sequence of independent shorthand/longhand collapse rules — each `if` is
// one family, not nested logic. Pre-existing (moved verbatim from report.ts, where
// it was already in the health baseline); splitting it per-family would scatter one
// cohesive pass across a dozen tiny functions for no readability gain.
// fallow-ignore-next-line complexity
export function summarizeProps(props: PropChange[]): PropChange[] {
  const map = new Map(props.map((p) => [p.prop, { ...p }]));
  for (const [logical, physical] of Object.entries(LOGICAL_TO_PHYSICAL)) {
    const lo = map.get(logical);
    const ph = map.get(physical);
    if (lo && ph && lo.before === ph.before && lo.after === ph.after) map.delete(logical);
  }
  const color = map.get('color');
  if (color)
    for (const f of CURRENTCOLOR_FOLLOWERS) {
      const m = map.get(f);
      if (m && m.before === color.before && m.after === color.after) map.delete(f);
    }
  for (const fam of BOX4) {
    const members = fam.parts.map((p) => map.get(p));
    if (members.every((m): m is PropChange => !!m)) {
      fam.parts.forEach((p) => map.delete(p));
      map.set(fam.short, {
        prop: fam.short,
        before: boxShorthand(members.map((m) => m.before)),
        after: boxShorthand(members.map((m) => m.after)),
      });
    }
  }
  const rg = map.get('row-gap');
  const cg = map.get('column-gap');
  if (rg && cg) {
    map.delete('row-gap');
    map.delete('column-gap');
    map.set('gap', {
      prop: 'gap',
      before: rg.before === cg.before ? rg.before : `${rg.before} ${cg.before}`,
      after: rg.after === cg.after ? rg.after : `${rg.after} ${cg.after}`,
    });
  }
  for (const fam of UNIFORM) {
    const members = fam.parts.map((p) => map.get(p)).filter((m): m is PropChange => !!m);
    if (
      members.length === fam.parts.length &&
      members.every((m) => m.before === members[0].before && m.after === members[0].after)
    ) {
      fam.parts.forEach((p) => map.delete(p));
      map.set(fam.short, { prop: fam.short, before: members[0].before, after: members[0].after });
    }
  }
  // outline-width/-style/-color → one `outline` row (offset stays separate).
  const ow = map.get('outline-width');
  const os = map.get('outline-style');
  const oc = map.get('outline-color');
  if (ow && os && oc) {
    map.delete('outline-width');
    map.delete('outline-style');
    map.delete('outline-color');
    map.set('outline', {
      prop: 'outline',
      before: combineValues([ow.before, os.before, oc.before]),
      after: combineValues([ow.after, os.after, oc.after]),
    });
  }
  return (
    [...map.values()]
      .map((p) => ({ prop: p.prop, before: cleanVal(p.before), after: cleanVal(p.after) }))
      // Drop no-ops: a value that didn't actually change, or a change between two
      // "no value here" markers (`— → (gone)`), which carries no information.
      .filter((p) => p.before !== p.after && !(isNonValue(p.before) && isNonValue(p.after)))
      .sort((a, b) => orderIdx(a.prop) - orderIdx(b.prop) || a.prop.localeCompare(b.prop))
  );
}

/** `div.who-grid`, `a.nav-cta`, `h3` — the semantic marker class, else the tag. */
export function prettyLabel(p: string, cls: string): string {
  const tag = (p.split('>').pop() ?? '').trim().replace(/:nth-child\(\d+\)/, '') || 'el';
  const first = cls.split(/\s+/)[0] ?? '';
  return /^[a-z][a-z0-9-]*$/.test(first) ? `${tag}.${first}` : tag;
}

// ── surface-key helpers (pure — no map reads) ────────────────────────────────

// Surface keys originate from artifact filenames — attacker-controlled in the
// fork capture/report split, and they flow into the PRIVILEGED PR-comment summary
// (the Action slices report.md above the first `### `). Strip the Markdown/HTML
// control characters (`` ` ``, [ ] ( ), < >, |) that could inject a link, image,
// or table into that bot comment. Escaping at the render boundary — the keys stay
// legible; only the injection surface is removed. (Crop FILENAMES are separately
// restricted to [a-z0-9-]; this is the display-side equivalent.)
export const safeKey = (s: string): string => s.replace(/[`[\]()<>|]/g, '-');

export const surfaceBase = (s: string): string => s.replace(/@\d+$/, '');
export const surfaceWidth = (s: string): number => Number(s.match(/@(\d+)$/)?.[1] ?? 0);

export function pushSurfaceWidth(byBase: Map<string, number[]>, base: string, surface: string): void {
  const arr = byBase.get(base) ?? [];
  arr.push(surfaceWidth(surface));
  byBase.set(base, arr);
}

export function renderSurfaceGroups(byBase: Map<string, number[]>): string {
  return [...byBase]
    .map(([base, ws]) => {
      const widths = ws.filter((w) => w > 0).sort((a, b) => b - a);
      return widths.length ? `${safeKey(base)} @ ${widths.join(', ')}` : safeKey(base);
    })
    .join(' · ');
}

/** "landing @ 1280, 1080, 390 · landing-nav-open @ 1080" from the surface keys. */
export function formatSurfaceList(surfaces: string[]): string {
  const byBase = new Map<string, number[]>();
  for (const s of surfaces) pushSurfaceWidth(byBase, surfaceBase(s), s);
  return renderSurfaceGroups(byBase);
}

// ── signature + grouping ─────────────────────────────────────────────────────

/** Group findings by their element path (one group per changed element). */
export function groupByPath(findings: Finding[]): Finding[][] {
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byPath.get(f.path) ?? [];
    arr.push(f);
    byPath.set(f.path, arr);
  }
  return [...byPath.values()];
}

// Grid-track longhands compute to width-dependent pixels (`282px ×2` at one width,
// `282px 228px` at another), so the SAME responsive change would otherwise get a
// different signature per width. Key them by track COUNT — what actually
// identifies the change — so responsive variants group into one section.
function sigValue(c: PropChange): string {
  if (c.prop === 'grid-template-columns' || c.prop === 'grid-template-rows') {
    return `${c.prop}=${trackCount(c.before)}t>${trackCount(c.after)}t`;
  }
  return `${c.prop}=${c.before}>${c.after}`;
}

/** Canonical signature of a surface's findings: surfaces that changed in the
 *  same way collapse into one section + one image (the rects differ per width;
 *  the change itself does not). */
export function signatureOf(findings: Finding[]): string {
  return JSON.stringify(
    findings
      .map((f) => ({
        p: f.path,
        k: f.kind,
        t: f.kind === 'dom' ? f.change : f.kind === 'state' ? f.state : (f.pseudo ?? ''),
        v: f.kind === 'dom' ? '' : summarizeProps(f.props).map(sigValue).join('|'),
      }))
      .sort((a, b) => `${a.p}|${a.k}|${a.t}`.localeCompare(`${b.p}|${b.k}|${b.t}`)),
  );
}

/** A one-line heading for a change group: "1 element added", "2 elements restyled". */
export function groupTitle(findings: Finding[]): string {
  const added = new Set(findings.filter((f) => f.kind === 'dom' && f.change === 'added').map((f) => f.path));
  const removed = new Set(findings.filter((f) => f.kind === 'dom' && f.change === 'removed').map((f) => f.path));
  const retagged = new Set(findings.filter((f) => f.kind === 'dom' && f.change === 'retagged').map((f) => f.path));
  const restyled = new Set(
    findings.filter((f) => f.kind !== 'dom' && !added.has(f.path) && !removed.has(f.path)).map((f) => f.path),
  );
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (added.size) parts.push(`${n(added.size, 'element')} added`);
  if (removed.size) parts.push(`${n(removed.size, 'element')} removed`);
  if (retagged.size) parts.push(`${n(retagged.size, 'element')} retagged`);
  if (restyled.size) parts.push(`${n(restyled.size, 'element')} restyled`);
  return parts.join(', ') || `${n(new Set(findings.map((f) => f.path)).size, 'element')} changed`;
}

// ── noise cleaning ───────────────────────────────────────────────────────────

// Computed values that follow from an element's box size or position rather than
// its styling. On any reflow they change all the way up the ancestor chain
// (body, main, section…), so an element whose ONLY changes are these is a reflow
// casualty: it must not anchor a crop region (that would zoom to the whole page)
// nor clutter the findings. The certification differ keeps them — a reflow IS a
// change to certify — but the visual report focuses on styling intent.
const DERIVED_PROPS = new Set([
  'width',
  'height',
  'block-size',
  'inline-size',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'perspective-origin',
  'transform-origin',
  // position offsets shift with the document on any reflow
  'top',
  'right',
  'bottom',
  'left',
  'inset-block-start',
  'inset-block-end',
  'inset-inline-start',
  'inset-inline-end',
]);
// Props stripped from forced :hover/:focus/:active deltas specifically. Layout
// and grid-track values that shift when a state forces a relayout are capture
// noise, not interaction feedback — a state finding is meant to catch a changed
// hover/focus/active *style* (colour, outline, shadow), not a reflow.
const STATE_STRIP = new Set([
  ...DERIVED_PROPS,
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-columns',
  'grid-auto-rows',
  'grid-auto-flow',
]);

/** How many of a surface's summarised props are derived/box longhands — the count
 *  the CLI folds behind `(+N derived longhands)`. Counts on the RAW finding props
 *  (before cleaning) so the CLI can advertise exactly what it suppressed. */
export function derivedLonghandCount(findings: Finding[]): number {
  let n = 0;
  for (const f of findings) {
    if (f.kind === 'dom') continue;
    const strip = f.kind === 'state' ? STATE_STRIP : DERIVED_PROPS;
    for (const p of summarizeProps(f.props)) if (strip.has(p.prop)) n++;
  }
  return n;
}

/**
 * Strip the noise the visual report shouldn't carry, cross-referencing each
 * element's layers so the forced-state layer stops echoing the base:
 *   - base/pseudo styles: drop size/position-derived longhands (reflow casualties);
 *   - forced states: drop derived + grid-track props, drop a delta the BASE
 *     already changed (a `:hover color` that just follows a recoloured base is an
 *     echo, not a dropped variant), and drop non-value↔non-value rows;
 *   - any finding left with no props is removed entirely.
 */
export function cleanFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const group of groupByPath(findings)) {
    const base = group.find((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style' && f.pseudo === null);
    const baseChanged = new Set(base?.props.map((p) => p.prop) ?? []);
    // For an ADDED element the base style is a full (unset)→value snapshot, not a
    // delta — so a forced-state value is never an "echo" of a base *change*; keep
    // every state row (suppressing them would drop a real :hover/:focus value).
    const isAdded = group.some((f) => f.kind === 'dom' && f.change === 'added');
    for (const f of group) {
      if (f.kind === 'dom') {
        out.push(f);
        continue;
      }
      const props =
        f.kind === 'style'
          ? f.props.filter((p) => !DERIVED_PROPS.has(p.prop))
          : f.props.filter(
              (p) =>
                !STATE_STRIP.has(p.prop) &&
                (isAdded || !baseChanged.has(p.prop)) &&
                !(isNonValue(p.before) && isNonValue(p.after)),
            );
      if (props.length) out.push({ ...f, props });
    }
  }
  return out;
}

// ── shared-chrome tier (#193) ────────────────────────────────────────────────

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
): Set<string> {
  const hosting = new Map<string, Set<string>>();
  for (const [surface, paths] of surfacePaths) {
    const base = surfaceBase(surface);
    for (const p of paths) {
      const set = hosting.get(p) ?? new Set<string>();
      set.add(base);
      hosting.set(p, set);
    }
  }
  const changed = new Map<string, Set<string>>();
  for (const f of changedOnSurfaces) {
    const set = changed.get(f.path) ?? new Set<string>();
    for (const s of f.surfaces) set.add(surfaceBase(s));
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
): { chrome: G[]; rest: G[]; chromePaths: Set<string> } {
  // Findings tagged with the surfaces the group spans, so chromePaths sees which
  // bases each path changed on across ALL groups (a path bundled with content on
  // one view still counts as changed there).
  const tagged = groups.flatMap((g) => g.findings.map((f) => ({ path: f.path, surfaces: g.surfaces })));
  const paths = chromePaths(tagged, surfacePaths);

  const chrome: G[] = [];
  const rest: G[] = [];
  for (const g of groups) {
    const affected = new Set(g.findings.map((f) => f.path));
    const isChrome = affected.size > 0 && [...affected].every((p) => paths.has(p));
    (isChrome ? chrome : rest).push(g);
  }
  return { chrome, rest, chromePaths: paths };
}
