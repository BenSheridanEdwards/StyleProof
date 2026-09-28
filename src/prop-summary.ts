import { type PropChange } from './diff.js';

/**
 * Collapse logical→physical longhands and shorthand families, and humanize
 * values. Shared by the visual report and the terminal differ.
 */

// Logical longhand → its physical equivalent (LTR, horizontal-tb). Dropped when
// the physical one changed identically, so each change appears once.
const LOGICAL_SIDES: [string, string][] = [
  ['block-start', 'top'],
  ['block-end', 'bottom'],
  ['inline-start', 'left'],
  ['inline-end', 'right'],
];
const LOGICAL_TO_PHYSICAL: Record<string, string> = Object.fromEntries([
  ...LOGICAL_SIDES.flatMap(([logical, physical]) => [
    ...['color', 'width', 'style'].map((part) => [`border-${logical}-${part}`, `border-${physical}-${part}`]),
    [`margin-${logical}`, `margin-${physical}`],
    [`padding-${logical}`, `padding-${physical}`],
    [`inset-${logical}`, physical],
  ]),
  ['border-start-start-radius', 'border-top-left-radius'],
  ['border-start-end-radius', 'border-top-right-radius'],
  ['border-end-start-radius', 'border-bottom-left-radius'],
  ['border-end-end-radius', 'border-bottom-right-radius'],
]);

function boxShorthand([t, r, b, l]: string[]): string {
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

// "No value here" markers: a forced-state delta that doesn't apply, an unset
// longhand, or a capture artifact. A change BETWEEN two of these is meaningless.
const NON_VALUE = new Set(['(state does not change it)', '(state no longer changes it)', '(unset)', '(gone)']);
export const isNonValue = (v: string): boolean => NON_VALUE.has(v);
const combineValues = (vals: string[]): string => (vals.every(isNonValue) ? '(unset)' : vals.join(' '));

const sides = (name: (side: string) => string) => ['top', 'right', 'bottom', 'left'].map(name);

/** A longhand family folded into one shorthand row when every member changed. `uniform` also requires identical values. */
type Fold = { short: string; parts: string[]; combine: (vals: string[]) => string; uniform?: boolean };
const FOLDS: Fold[] = [
  { short: 'margin', parts: sides((s) => `margin-${s}`), combine: boxShorthand },
  { short: 'padding', parts: sides((s) => `padding-${s}`), combine: boxShorthand },
  { short: 'border-width', parts: sides((s) => `border-${s}-width`), combine: boxShorthand },
  {
    short: 'border-radius',
    parts: ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((s) => `border-${s}-radius`),
    combine: boxShorthand,
  },
  { short: 'gap', parts: ['row-gap', 'column-gap'], combine: ([r, c]) => (r === c ? r : `${r} ${c}`) },
  // Colour/keyword families stay per-side unless all four match (keeps each colour swatchable).
  { short: 'border-color', parts: sides((s) => `border-${s}-color`), combine: ([t]) => t, uniform: true },
  { short: 'border-style', parts: sides((s) => `border-${s}-style`), combine: ([t]) => t, uniform: true },
  { short: 'outline', parts: ['outline-width', 'outline-style', 'outline-color'], combine: combineValues },
];

const PROP_ORDER = `display position grid-template-columns grid-template-rows flex-direction justify-content
  align-items gap margin padding border-width border-style border-color border-radius outline background-color
  background-image color box-shadow opacity transform font-family font-size font-weight line-height letter-spacing
  text-transform text-align`.split(/\s+/);
const orderIdx = (p: string): number => {
  const i = PROP_ORDER.indexOf(p);
  return i === -1 ? PROP_ORDER.length : i;
};

// Verbatim by design: no rounding (0.18 shown as 0.2 once erased a real diff).
function cleanVal(v: string): string {
  let s = v;
  if (!s.includes('(')) {
    const toks = s.split(' ');
    if (toks.length > 1 && new Set(toks).size === 1) s = `${toks[0]} ×${toks.length}`;
  }
  return s.replace(/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/g, 'transparent');
}

// These default to `currentColor`, so a `color` change drags them all along.
const CURRENTCOLOR_FOLLOWERS = `caret-color outline-color column-rule-color row-rule-color text-decoration-color
  text-emphasis-color -webkit-text-fill-color -webkit-text-stroke-color`.split(/\s+/);

const sameChange = (a: PropChange, b: PropChange) => a.before === b.before && a.after === b.after;

/** Delete `follower` when it changed exactly like `leader`. */
function dropEcho(map: Map<string, PropChange>, follower: string, leader: string): void {
  const f = map.get(follower);
  const l = map.get(leader);
  if (f && l && sameChange(f, l)) map.delete(follower);
}

function fold(map: Map<string, PropChange>, { short, parts, combine, uniform }: Fold): void {
  const members = parts.map((p) => map.get(p));
  if (!members.every((m): m is PropChange => !!m)) return;
  if (uniform && !members.every((m) => sameChange(m, members[0]))) return;
  parts.forEach((p) => map.delete(p));
  map.set(short, {
    prop: short,
    before: combine(members.map((m) => m.before)),
    after: combine(members.map((m) => m.after)),
  });
}

/** A summarized property that may carry nested currentColor follow-ons. */
export type SummarizedProp = PropChange & { followOns?: PropChange[] };

function cleanedProp(p: PropChange): PropChange {
  return { prop: p.prop, before: cleanVal(p.before), after: cleanVal(p.after) };
}

function isMeaningful(p: PropChange): boolean {
  return p.before !== p.after && !(isNonValue(p.before) && isNonValue(p.after));
}

/** Peel currentColor followers off `color` into nested followOns (report display). */
function nestCurrentColorFollowOns(map: Map<string, PropChange>): SummarizedProp[] {
  const color = map.get('color');
  const followOns: PropChange[] = [];
  if (color) {
    for (const follower of CURRENTCOLOR_FOLLOWERS) {
      const f = map.get(follower);
      if (f && sameChange(f, color)) {
        followOns.push(cleanedProp(f));
        map.delete(follower);
      }
    }
  }
  const rows: SummarizedProp[] = [...map.values()]
    .map(cleanedProp)
    .filter(isMeaningful)
    .sort((a, b) => orderIdx(a.prop) - orderIdx(b.prop) || a.prop.localeCompare(b.prop));
  if (color && followOns.length) {
    const idx = rows.findIndex((r) => r.prop === 'color');
    if (idx >= 0) rows[idx] = { ...rows[idx], followOns };
  }
  return rows;
}

/** Collapse longhands into reviewable shorthand rows and drop no-op deltas. */
export function summarizeProps(props: PropChange[]): PropChange[] {
  // Counts/signatures drop currentColor echoes so they never inflate peer diffs.
  return summarizePropsWithFollowOns(props).map(({ prop, before, after }) => ({ prop, before, after }));
}

/**
 * Same collapse as `summarizeProps`, but currentColor followers that track `color`
 * nest under it (`followOns`) instead of disappearing — one primary property card,
 * not peer diffs for caret/outline/text-decoration echoes.
 */
export function summarizePropsWithFollowOns(props: PropChange[]): SummarizedProp[] {
  const map = new Map(props.map((p) => [p.prop, { ...p }]));
  for (const [logical, physical] of Object.entries(LOGICAL_TO_PHYSICAL)) dropEcho(map, logical, physical);
  for (const family of FOLDS) fold(map, family);
  return nestCurrentColorFollowOns(map);
}

/** Leaf tag from a path: `html > body > div.fleet-title:nth-child(2)` → `div`. */
function pathTag(p: string): string {
  return (
    (p.split('>').pop() ?? '')
      .trim()
      .replace(/:nth-child\(\d+\)/, '')
      .replace(/:sp-key\([a-z0-9]+\)/, '')
      // Paths never carry classes, but tolerate a mistaken `tag.class` leaf.
      .replace(/\.[a-z][a-z0-9_-]*/gi, '') || 'el'
  );
}

/** `div.who-grid`, `a.nav-cta`, `h3` — the semantic marker class, else the tag. */
export function prettyLabel(p: string, cls: string): string {
  const tag = pathTag(p);
  const first = cls.split(/\s+/)[0] ?? '';
  return /^[a-z][a-z0-9-]*$/.test(first) ? `${tag}.${first}` : tag;
}

/** Human label before the selector: `fleet-title` → `Fleet title`; else the tag. */
export function humanLabel(p: string, cls: string): string {
  const first = (cls.split(/\s+/)[0] ?? '').trim();
  if (/^[a-z][a-z0-9-]*$/.test(first)) {
    // Sentence case: "fleet-title" → "Fleet title" (human label before the selector).
    return first
      .split('-')
      .filter(Boolean)
      .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
      .join(' ');
  }
  return pathTag(p);
}
