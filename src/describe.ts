import { parseColor } from './canonicalize.js';
import type { PropChange } from './diff.js';

/**
 * Deterministic, offline plain-English summariser for a crop's changes: curated
 * rules over the already-summarised property changes, so the same input always
 * yields the same words ("Grid: 2 → 3 columns", "Accent recoloured cyan → red").
 */

/** One changed element, with its property deltas already run through summarizeProps. */
export type ElementChange = {
  label: string;
  added?: boolean;
  removed?: boolean;
  retagged?: boolean;
  /** Base/computed-style deltas (not interactive-state ones). */
  props: PropChange[];
  /** Interactive states this element gained/changed/dropped, by name. */
  states?: string[];
};

// Colour naming: nearest of a small, legible palette.
const PALETTE: [string, [number, number, number]][] = [
  ['black', [0, 0, 0]],
  ['white', [255, 255, 255]],
  ['gray', [128, 128, 128]],
  ['red', [229, 57, 53]],
  ['orange', [245, 124, 0]],
  ['amber', [255, 179, 0]],
  ['yellow', [253, 216, 53]],
  ['lime', [124, 179, 66]],
  ['green', [56, 142, 60]],
  ['teal', [0, 150, 136]],
  ['cyan', [38, 198, 218]],
  ['blue', [33, 110, 233]],
  ['indigo', [57, 73, 171]],
  ['purple', [142, 68, 173]],
  ['magenta', [216, 27, 170]],
  ['pink', [236, 64, 122]],
];

/** Nearest palette word to an rgb point, by squared distance. */
function nearest(r: number, g: number, b: number): string {
  let best = PALETTE[0][0];
  let bestD = Infinity;
  for (const [name, [pr, pg, pb]] of PALETTE) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) [bestD, best] = [d, name];
  }
  return best;
}

/** A short colour word for an rgb/rgba value: "cyan", "dark blue", "transparent". */
export function colorName(v: string): string | null {
  if (v === 'transparent') return 'transparent';
  const c = parseColor(v);
  if (!c) return null;
  const { r, g, b, a } = c;
  if (a === 0) return 'transparent';
  const best = nearest(r, g, b);
  // Light/dark qualifier for the chromatic colours, where it reads naturally.
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const chromatic = best !== 'black' && best !== 'white' && best !== 'gray';
  const qual = chromatic ? (lum > 200 ? 'light ' : lum < 70 ? 'dark ' : '') : '';
  return `${qual}${best}`;
}

/** rgb/rgba → `#rrggbb` (opaque) or the rgba string (translucent); non-colours pass through. */
export function toHex(v: string): string {
  const c = parseColor(v);
  if (!c) return v;
  const { r, g, b, a } = c;
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a})`;
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Canonical key for matching a colour value against the token index. */
function colorKey(v: string): string | null {
  const c = parseColor(v);
  return c ? `${c.r},${c.g},${c.b},${c.a}` : null;
}

/** Reverse-index a token map (`--red-200` → `rgb(...)`) to value → token name,
 *  preferring a scale step (`red-200`) over an alias, then the shorter name. */
export function tokenIndex(tokens?: Record<string, string>): Map<string, string> {
  const idx = new Map<string, string>();
  if (!tokens) return idx;
  const isScale = (n: string): boolean => /-\d+$/.test(n);
  for (const [rawName, value] of Object.entries(tokens)) {
    const key = colorKey(value);
    if (!key) continue;
    const name = rawName.replace(/^--/, '');
    const cur = idx.get(key);
    if (!cur) {
      idx.set(key, name);
    } else if ((isScale(name) && !isScale(cur)) || (isScale(name) === isScale(cur) && name.length < cur.length)) {
      idx.set(key, name);
    }
  }
  return idx;
}

type ColorParts = { token: string | null; word: string | null; full: string; hex: string };
/** Resolve one colour value to its token (if any), colour word, and `#hex`. */
function describeColor(value: string, idx?: Map<string, string>): ColorParts {
  if (value === 'transparent') return { token: null, word: 'transparent', full: 'transparent', hex: 'transparent' };
  const key = colorKey(value);
  if (!key) return { token: null, word: null, full: value, hex: value }; // not a colour
  const token = idx?.get(key) ?? null;
  const hex = toHex(value);
  const word = colorName(value);
  const full = token ? `\`${token}\` (\`${hex}\`)` : `${word} (\`${hex}\`)`;
  return { token, word, full, hex };
}

// One side's rendering: hex-only when it's a word-level no-op, else token/word + hex.
const sidePart = (c: ColorParts, noop: boolean): string => (noop && c.hex !== 'transparent' ? `\`${c.hex}\`` : c.full);

/** `red-100 (#fee2e2) → red-200 (#fecaca)`. When neither side has a token and the
 *  colour WORD is unchanged (two near-whites), show just the hex so a subtle change
 *  doesn't read as a no-op. */
const shift = (before: string, after: string, idxB?: Map<string, string>, idxA?: Map<string, string>): string => {
  const b = describeColor(before, idxB);
  const a = describeColor(after, idxA);
  if (b.word === null && a.word === null) return `${before} → ${after}`; // neither is a colour
  const noop = !b.token && !a.token && b.word !== null && b.word === a.word;
  return `${sidePart(b, noop)} → ${sidePart(a, noop)}`;
};

/** Count grid tracks in a `grid-template-*` value, honouring the `Npx ×K` form. */
export function trackCount(v: string): number {
  if (v === 'none' || !v) return 0;
  const rep = v.match(/×(\d+)/); // summarizeProps collapses "8px 8px 8px" → "8px ×3"
  if (rep) return Number(rep[1]);
  return v.split(/\s+/).filter((t) => t && t !== '0px' && t !== '0').length;
}

// Per-element phrase building: one small rule per visual category.
type Vals = Map<string, PropChange>;
/** Token reverse-indexes for each side, so colour rules can name `red-200`. */
export type DescribeCtx = { tokensBefore?: Map<string, string>; tokensAfter?: Map<string, string> };
/** A rule reads the element's props, marks the ones it consumed, returns phrases. */
type Rule = (m: Vals, mark: (...p: string[]) => void, ctx: DescribeCtx) => string[];
const round = (v: string): boolean => /50%|9999|999px/.test(v);

/** A rule keyed on one prop: consume it (plus `also`), emit one phrase. */
const single =
  (prop: string, phrase: (c: PropChange, m: Vals) => string, also: string[] = []): Rule =>
  (m, mark) => {
    const c = m.get(prop);
    if (!c) return [];
    mark(prop, ...also);
    return [phrase(c, m)];
  };

const flexPhrase = (m: Vals, before: string): string => {
  const col = m.get('flex-direction')?.after?.startsWith('column') ? 'vertical ' : '';
  const centered = m.get('justify-content')?.after === 'center' || m.get('align-items')?.after === 'center';
  return `becomes a${centered ? ' centered' : ''} ${col}flex layout (was ${before})`;
};
const layoutRule = single(
  'display',
  (d, m) => {
    if (d.after === 'none') return '**hidden**';
    if (d.before === 'none') return '**shown**';
    if (/flex/.test(d.after)) return flexPhrase(m, d.before);
    if (/grid/.test(d.after)) return `becomes a grid (was ${d.before})`;
    return `display ${d.before} → ${d.after}`;
  },
  ['justify-content', 'align-items', 'flex-direction'],
);

const gridRule: Rule = (m, mark) => {
  const out: string[] = [];
  for (const [prop, word] of [
    ['grid-template-columns', 'columns'],
    ['grid-template-rows', 'rows'],
  ] as const) {
    const g = m.get(prop);
    if (!g) continue;
    mark(prop);
    const [b, a] = [trackCount(g.before), trackCount(g.after)];
    // A 0-track side alongside a display change is the grid becoming (or leaving)
    // a grid, which the layout rule already names; only emit a real track-count change.
    if (b !== a && (b > 0 || a > 0) && !(m.has('display') && (b === 0 || a === 0))) {
      out.push(`**${word}: ${b} → ${a}**`);
    }
  }
  return out;
};

// Every side zero: `0.5px` is a hairline and `0px 1px` keeps its side borders.
const noBorder = (v: string): boolean =>
  v === '(unset)' || v.split(/\s+/).every((side) => /^0(?:\.0*)?(?:px)?$/.test(side));
const borderWidthRule = single(
  'border-width',
  ({ before, after }) => {
    const [wasZero, isZero] = [noBorder(before), noBorder(after)];
    if (wasZero && !isZero) return `gains a ${after} border`;
    return !wasZero && isZero ? 'loses its border' : `border ${before} → ${after}`;
  },
  ['border-style', 'border-color'],
);

const borderRadiusRule = single('border-radius', ({ before, after }) => {
  if (round(before) && !round(after)) return `corners squared off (${before} → ${after})`;
  return !round(before) && round(after) ? 'corners fully rounded' : `corner radius ${before} → ${after}`;
});

const colorRule: Rule = (m, mark, ctx) => {
  const fields: [string, string][] = [
    ['color', 'text'],
    ['background-color', 'background'],
    ['border-color', 'border colour'],
  ];
  const sh = (c: PropChange) => shift(c.before, c.after, ctx.tokensBefore, ctx.tokensAfter);
  // Collapse a role word that just repeats the token name: `text \`text\`` → `\`text\``.
  const deRole = (s: string) => s.replace(/([\w-]+) (`\1`)/g, '$2');
  const present = fields.map(([p, w]) => [m.get(p), w] as const).filter(([c]) => c) as [PropChange, string][];
  if (!present.length) return [];
  const [first] = present;
  const same = present.length > 1 && present.every(([c]) => c.before === first[0].before && c.after === first[0].after);
  fields.forEach(([p]) => m.has(p) && mark(p));
  if (same) return [deRole(`recoloured ${sh(first[0])}`)];
  return present.map(([c, w]) => deRole(`${w} ${sh(c)}`));
};

const fillKind = (v: string) =>
  /gradient/.test(v) ? 'a gradient' : /url\(/.test(v) ? 'an image' : v === 'none' ? 'no fill' : v;
const fillRule = single(
  'background-image',
  ({ before, after }) => `fill → ${fillKind(after)} (was ${fillKind(before)})`,
);
const shadowRule = single('box-shadow', ({ before, after }) =>
  before === 'none' ? 'gains a shadow' : after === 'none' ? 'loses its shadow' : 'shadow changes',
);
const opacityRule = single('opacity', ({ before, after }) => `opacity ${before} → ${after}`);
const fontSizeRule = single('font-size', ({ before, after }) => `text size ${before} → ${after}`);
const weight = (v: string): number => Number(v) || (v === 'bold' ? 700 : v === 'normal' ? 400 : NaN);
const fontWeightRule = single('font-weight', ({ before, after }) => {
  const d = weight(after) - weight(before);
  return Number.isNaN(d) ? `weight ${before} → ${after}` : d > 0 ? 'bolder text' : 'lighter text';
});

const spacingRule: Rule = (m, mark) => {
  const spacing = ['padding', 'margin', 'gap'].filter((p) => m.has(p));
  spacing.forEach((p) => mark(p));
  return spacing.length ? [`${spacing.join(' & ')} adjusted`] : [];
};

const RULES: Rule[] = [
  layoutRule,
  gridRule,
  borderWidthRule,
  borderRadiusRule,
  colorRule,
  fillRule,
  shadowRule,
  opacityRule,
  fontSizeRule,
  fontWeightRule,
  spacingRule,
];

// Props that rarely matter to a visual reviewer — excluded from the "+N more"
// tail (they're still in the table) so a bullet stays signal, not noise.
const LOW_SIGNAL = new Set(
  `font-family letter-spacing word-spacing flex-grow flex-shrink flex-basis object-fit white-space text-rendering
   -webkit-font-smoothing -webkit-box-orient text-overflow word-break overflow-wrap`.split(/\s+/),
);

/** Build the English phrases for ONE element's deltas, capped so a bullet stays a
 *  glance: the top `cap` rule phrases (rules are priority-ordered), then a single
 *  "+N more" counting the rest (low-signal props excluded — they're in the table). */
function phrasesFor(props: PropChange[], ctx: DescribeCtx, cap = 4): string[] {
  const m: Vals = new Map(props.map((p) => [p.prop, p]));
  const used = new Set<string>();
  const mark = (...ps: string[]) => ps.forEach((p) => used.add(p));
  const phrases = RULES.flatMap((rule) => rule(m, mark, ctx));
  const rest = [...m.keys()].filter((p) => !used.has(p) && !LOW_SIGNAL.has(p)).length;
  const shown = phrases.slice(0, cap);
  const overflow = phrases.length - shown.length + rest;
  if (overflow > 0) shown.push(`+${overflow} more`);
  return shown;
}

/** Tally added/removed/retagged elements into "3 added" style lines. */
function domVerbLines(els: ElementChange[]): string[] {
  const verbs: Record<string, number> = {};
  for (const el of els) {
    const v = el.added ? 'added' : el.removed ? 'removed' : el.retagged ? 'retagged' : null;
    if (v) verbs[v] = (verbs[v] ?? 0) + 1;
  }
  return Object.entries(verbs).map(([verb, n]) => `**${n}** element${n === 1 ? '' : 's'} ${verb}`);
}

const sig = (phrases: string[]): string => phrases.join(', ');
/** One line for a same-label group. Identical members → their line. Otherwise the
 *  phrases shared by ALL (`details vary`); and if they share none, the most common
 *  phrases (`e.g. … vary`) so the line still tells you what to look for. */
function foldedLine(group: ElementChange[], ctx: DescribeCtx): string {
  const lists = group.map((el) => phrasesFor(el.props, ctx));
  if (lists.every((l) => sig(l) === sig(lists[0]))) return sig(lists[0]);
  const common = lists[0].filter((p) => lists.every((l) => l.includes(p)));
  if (common.length) return `${common.join(', ')} _(details vary)_`;
  // Rank the most common REAL changes — the `+N more` overflow marker isn't a
  // change and shouldn't be named.
  const freq = new Map<string, number>();
  for (const l of lists) for (const p of new Set(l)) if (!/^\+\d+ more$/.test(p)) freq.set(p, (freq.get(p) ?? 0) + 1);
  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p]) => p);
  return top.length ? `e.g. ${top.join(', ')} _(vary)_` : 'restyled _(vary)_';
}

/** Restyle phrases, folded by element label (so two near-identical `span.led`s
 *  become one `×2` line with their shared changes), then deduped across labels (so
 *  the same line on different labels collapses to `… (×N)`). */
function restyleLines(els: ElementChange[], ctx: DescribeCtx): string[] {
  const byLabel = new Map<string, ElementChange[]>();
  for (const el of els) {
    if (el.added || el.removed) continue; // values, not deltas — heading covers them
    if (!phrasesFor(el.props, ctx).length) continue;
    const arr = byLabel.get(el.label) ?? [];
    arr.push(el);
    byLabel.set(el.label, arr);
  }
  const byLine = new Map<string, { count: number; labels: Set<string> }>();
  const order: string[] = [];
  for (const [label, group] of byLabel) {
    const line = foldedLine(group, ctx);
    if (!byLine.has(line)) {
      byLine.set(line, { count: 0, labels: new Set() });
      order.push(line);
    }
    const e = byLine.get(line)!;
    e.count += group.length;
    e.labels.add(label);
  }
  return order.map((line) => {
    const { count, labels } = byLine.get(line)!;
    if (labels.size > 1) return `${line} _(×${count})_`;
    const label = [...labels][0];
    return `**\`${label}\`**${count > 1 ? ` ×${count}` : ''} — ${line}`;
  });
}

/**
 * Plain-English bullets for a crop's changes — DOM verbs, then labelled restyle
 * phrases, then a flag for interaction-state changes a static screenshot can't
 * show. Capped so the summary stays a glance (the exact tables live in the fold).
 */
export function describeChange(els: ElementChange[], ctx: DescribeCtx = {}, maxBullets = 6): string[] {
  const lines = [...domVerbLines(els), ...restyleLines(els, ctx)];
  // Interaction-state *changes* only on matched-path elements. Added/removed nodes
  // carry head- or base-side state inventory (no baseline pair) — the DOM verb covers them.
  const states = [...new Set(els.filter((e) => !e.added && !e.removed).flatMap((e) => e.states ?? []))];
  if (states.length) lines.push(`interaction states changed: ${states.map((s) => `\`:${s}\``).join(', ')}`);
  if (lines.length <= maxBullets) return lines;
  return [...lines.slice(0, maxBullets - 1), `…and ${lines.length - (maxBullets - 1)} more change(s)`];
}
