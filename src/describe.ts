import type { PropChange } from './diff.js';

/**
 * Deterministic, offline plain-English summariser for a crop's changes. Turns a
 * wall of computed-style deltas into a few bullets that tell a reviewer WHAT to
 * look for ("Grid: 2 → 3 columns", "Accent recoloured cyan → red") instead of
 * leaving them to spot the difference. No LLM — just curated rules over the
 * already-summarised property changes, so the same input always yields the same
 * words and it runs with no network.
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

// --- colour naming: nearest of a small, legible palette -----------------------
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

function parseColor(v: string): [number, number, number, number] | null {
  const m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,/\s]+([\d.]+))?\s*\)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

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
  const [r, g, b, a] = c;
  if (a === 0) return 'transparent';
  const best = nearest(r, g, b);
  // Light/dark qualifier for the chromatic colours, where it reads naturally.
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const chromatic = best !== 'black' && best !== 'white' && best !== 'gray';
  const qual = chromatic ? (lum > 200 ? 'light ' : lum < 70 ? 'dark ' : '') : '';
  return `${qual}${best}`;
}

const shift = (before: string, after: string): string => {
  const cb = colorName(before);
  const ca = colorName(after);
  return cb && ca ? `${cb} → ${ca}` : `${before} → ${after}`;
};

// --- track counting for grid columns/rows ------------------------------------
/** Count grid tracks in a `grid-template-*` value, honouring the `Npx ×K` form. */
function trackCount(v: string): number {
  if (v === 'none' || !v) return 0;
  const rep = v.match(/×(\d+)/); // summarizeProps collapses "8px 8px 8px" → "8px ×3"
  if (rep) return Number(rep[1]);
  return v.split(/\s+/).filter((t) => t && t !== '0px' && t !== '0').length;
}

// --- per-element phrase building: one small rule per visual category ----------
type Vals = Map<string, PropChange>;
/** A rule reads the element's props, marks the ones it consumed, returns phrases. */
type Rule = (m: Vals, mark: (...p: string[]) => void) => string[];
const round = (v: string): boolean => /50%|9999|999px/.test(v);

const flexPhrase = (m: Vals, before: string): string => {
  const col = m.get('flex-direction')?.after?.startsWith('column') ? 'vertical ' : '';
  const centered = m.get('justify-content')?.after === 'center' || m.get('align-items')?.after === 'center';
  return `becomes a${centered ? ' centered' : ''} ${col}flex layout (was ${before})`;
};
const layoutRule: Rule = (m, mark) => {
  const d = m.get('display');
  if (!d) return [];
  mark('display', 'justify-content', 'align-items', 'flex-direction');
  if (d.after === 'none') return ['**hidden**'];
  if (d.before === 'none') return ['**shown**'];
  if (/flex/.test(d.after)) return [flexPhrase(m, d.before)];
  if (/grid/.test(d.after)) return [`becomes a grid (was ${d.before})`];
  return [`display ${d.before} → ${d.after}`];
};

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
    if (b !== a && (b > 0 || a > 0)) out.push(`**${word}: ${b} → ${a}**`);
  }
  return out;
};

const borderWidthRule: Rule = (m, mark) => {
  const bw = m.get('border-width');
  if (!bw) return [];
  mark('border-width', 'border-style', 'border-color');
  const wasZero = /^0/.test(bw.before);
  const isZero = /^0/.test(bw.after);
  if (wasZero && !isZero) return [`gains a ${bw.after} border`];
  if (!wasZero && isZero) return ['loses its border'];
  return [`border ${bw.before} → ${bw.after}`];
};

const borderRadiusRule: Rule = (m, mark) => {
  const r = m.get('border-radius');
  if (!r) return [];
  mark('border-radius');
  if (round(r.before) && !round(r.after)) return [`corners squared off (${r.before} → ${r.after})`];
  if (!round(r.before) && round(r.after)) return ['corners fully rounded'];
  return [`corner radius ${r.before} → ${r.after}`];
};

const colorRule: Rule = (m, mark) => {
  const fields: [string, string][] = [
    ['color', 'text'],
    ['background-color', 'background'],
    ['border-color', 'border colour'],
  ];
  const present = fields.map(([p, w]) => [m.get(p), w] as const).filter(([c]) => c) as [PropChange, string][];
  if (!present.length) return [];
  const [first] = present;
  const same = present.length > 1 && present.every(([c]) => c.before === first[0].before && c.after === first[0].after);
  fields.forEach(([p]) => m.has(p) && mark(p));
  if (same) return [`recoloured ${shift(first[0].before, first[0].after)}`];
  return present.map(([c, w]) => `${w} ${shift(c.before, c.after)}`);
};

const fillRule: Rule = (m, mark) => {
  const bgi = m.get('background-image');
  if (!bgi) return [];
  mark('background-image');
  const kind = (v: string) =>
    /gradient/.test(v) ? 'a gradient' : /url\(/.test(v) ? 'an image' : v === 'none' ? 'no fill' : v;
  return [`fill → ${kind(bgi.after)} (was ${kind(bgi.before)})`];
};

const effectsRule: Rule = (m, mark) => {
  const out: string[] = [];
  const sh = m.get('box-shadow');
  if (sh) {
    mark('box-shadow');
    out.push(sh.before === 'none' ? 'gains a shadow' : sh.after === 'none' ? 'loses its shadow' : 'shadow changes');
  }
  const op = m.get('opacity');
  if (op) {
    mark('opacity');
    out.push(`opacity ${op.before} → ${op.after}`);
  }
  return out;
};

const weight = (v: string): number => Number(v) || (v === 'bold' ? 700 : v === 'normal' ? 400 : NaN);
const typographyRule: Rule = (m, mark) => {
  const out: string[] = [];
  const fs = m.get('font-size');
  if (fs) {
    mark('font-size');
    out.push(`text size ${fs.before} → ${fs.after}`);
  }
  const fw = m.get('font-weight');
  if (fw) {
    mark('font-weight');
    const d = weight(fw.after) - weight(fw.before);
    out.push(Number.isNaN(d) ? `weight ${fw.before} → ${fw.after}` : d > 0 ? 'bolder text' : 'lighter text');
  }
  return out;
};

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
  effectsRule,
  typographyRule,
  spacingRule,
];

/** Build the English phrases for ONE element's property deltas. */
function phrasesFor(props: PropChange[]): string[] {
  const m: Vals = new Map(props.map((p) => [p.prop, p]));
  const used = new Set<string>();
  const mark = (...ps: string[]) => ps.forEach((p) => used.add(p));
  const out = RULES.flatMap((rule) => rule(m, mark));
  // Anything no rule named: a quiet tail so nothing is silently lost.
  const rest = [...m.keys()].filter((p) => !used.has(p));
  if (rest.length) out.push(`+${rest.length} more (${rest.slice(0, 3).join(', ')}${rest.length > 3 ? '…' : ''})`);
  return out;
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

/** Restyle phrases per element, deduped: a phrase on ONE element is labelled with
 *  it; the same phrase across many collapses to `×N` (naming one of fourteen would
 *  mislead). */
function restyleLines(els: ElementChange[]): string[] {
  const byLine = new Map<string, { count: number; label: string }>();
  const order: string[] = [];
  for (const el of els) {
    if (el.added || el.removed) continue; // values, not deltas — heading covers them
    const line = phrasesFor(el.props).join(', ');
    if (!line) continue;
    if (!byLine.has(line)) {
      byLine.set(line, { count: 0, label: el.label });
      order.push(line);
    }
    byLine.get(line)!.count++;
  }
  return order.map((line) => {
    const { count, label } = byLine.get(line)!;
    return count > 1 ? `${line} _(×${count})_` : `**\`${label}\`** — ${line}`;
  });
}

/**
 * Plain-English bullets for a crop's changes — DOM verbs, then labelled restyle
 * phrases, then a flag for interaction-state changes a static screenshot can't
 * show. Capped so the summary stays a glance (the exact tables live in the fold).
 */
export function describeChange(els: ElementChange[], maxBullets = 6): string[] {
  const lines = [...domVerbLines(els), ...restyleLines(els)];
  const states = [...new Set(els.flatMap((e) => e.states ?? []))];
  if (states.length) lines.push(`interaction states changed: ${states.map((s) => `\`:${s}\``).join(', ')}`);
  if (lines.length <= maxBullets) return lines;
  return [...lines.slice(0, maxBullets - 1), `…and ${lines.length - (maxBullets - 1)} more change(s)`];
}
