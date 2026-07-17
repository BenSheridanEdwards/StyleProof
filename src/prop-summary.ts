import { type PropChange } from './diff.js';

/**
 * Collapse logical→physical longhands and shorthand families, and humanize
 * values. Shared by the visual report and the terminal differ so one collapse
 * pass drives both.
 */

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

function boxShorthand([t, r, b, l]: string[]): string {
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

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

function dropRedundantLogicals(map: Map<string, PropChange>): void {
  for (const [logical, physical] of Object.entries(LOGICAL_TO_PHYSICAL)) {
    const lo = map.get(logical);
    const ph = map.get(physical);
    if (lo && ph && lo.before === ph.before && lo.after === ph.after) map.delete(logical);
  }
}

function dropCurrentColorFollowers(map: Map<string, PropChange>): void {
  const color = map.get('color');
  if (!color) return;
  for (const f of CURRENTCOLOR_FOLLOWERS) {
    const m = map.get(f);
    if (m && m.before === color.before && m.after === color.after) map.delete(f);
  }
}

function foldBoxFamilies(map: Map<string, PropChange>): void {
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
}

function foldGap(map: Map<string, PropChange>): void {
  const rg = map.get('row-gap');
  const cg = map.get('column-gap');
  if (!rg || !cg) return;
  map.delete('row-gap');
  map.delete('column-gap');
  map.set('gap', {
    prop: 'gap',
    before: rg.before === cg.before ? rg.before : `${rg.before} ${cg.before}`,
    after: rg.after === cg.after ? rg.after : `${rg.after} ${cg.after}`,
  });
}

function foldUniformFamilies(map: Map<string, PropChange>): void {
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
}

function foldOutline(map: Map<string, PropChange>): void {
  const ow = map.get('outline-width');
  const os = map.get('outline-style');
  const oc = map.get('outline-color');
  if (!ow || !os || !oc) return;
  map.delete('outline-width');
  map.delete('outline-style');
  map.delete('outline-color');
  map.set('outline', {
    prop: 'outline',
    before: combineValues([ow.before, os.before, oc.before]),
    after: combineValues([ow.after, os.after, oc.after]),
  });
}

/** Collapse longhands into reviewable shorthand rows and drop no-op deltas. */
export function summarizeProps(props: PropChange[]): PropChange[] {
  const map = new Map(props.map((p) => [p.prop, { ...p }]));
  dropRedundantLogicals(map);
  dropCurrentColorFollowers(map);
  foldBoxFamilies(map);
  foldGap(map);
  foldUniformFamilies(map);
  foldOutline(map);
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
  const tag =
    (p.split('>').pop() ?? '')
      .trim()
      .replace(/:nth-child\(\d+\)/, '')
      .replace(/:sp-key\([a-z0-9]+\)/, '') || 'el';
  const first = cls.split(/\s+/)[0] ?? '';
  return /^[a-z][a-z0-9-]*$/.test(first) ? `${tag}.${first}` : tag;
}
