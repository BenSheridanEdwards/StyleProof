import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { loadStyleMap, type Rect, type StyleMap } from './capture.js';
import { diffStyleMapDirs, type DiffCounts, type Finding, type PropChange } from './diff.js';

/**
 * Visual diff report: for every surface with findings, crop the before/after
 * full-page screenshots around the changed elements and write a markdown
 * report with side-by-side images plus the exact property changes.
 *
 * Cropping zooms out to the OUTERMOST changed element: changed paths that are
 * descendants of other changed paths are folded into their ancestor, nearby
 * regions are merged, and both sides are cropped at identical dimensions
 * (centered on each side's own coordinates) so the pair stays comparable
 * even when the change moved things around.
 */

export type ReportOptions = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  /** Prefix for image URLs in report.md (default: relative paths). */
  imageBaseUrl?: string;
  /** Padding around the union of changed rects (default 24px). */
  pad?: number;
  /** Minimum crop size, for context around tiny changes (default 320×180). */
  minWidth?: number;
  minHeight?: number;
  /** Crops taller than this are clamped (default 1600px). */
  maxHeight?: number;
  /** Max crop regions per surface before collapsing into one union crop (default 6). */
  maxCrops?: number;
  /**
   * Row count at which a crop's property tables fold under a `<details>` toggle
   * (default 0 = always fold; the essence line and screenshot stay visible). Set
   * to e.g. 5 to keep small changes inline and fold only verbose ones, or
   * `Infinity` to never fold.
   */
  foldDetailsAt?: number;
  /**
   * Include size/position-derived longhands (height, width, transform-origin…)
   * in the report. Off by default: on a reflow they change up the whole ancestor
   * chain and would anchor crops to the entire page. The certification differ
   * (`styleproof-diff`) always keeps them.
   */
  includeLayoutNoise?: boolean;
};

export type ReportResult = {
  changedSurfaces: number;
  totalFindings: number;
  reportMdPath: string;
  reportJsonPath: string;
};

type Box = { x: number; y: number; w: number; h: number };

const rectToBox = (r: Rect): Box => ({ x: r[0], y: r[1], w: r[2], h: r[3] });
const pad = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by });
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const visible = (b: Box | null): b is Box => !!b && b.w > 0 && b.h > 0;

/** Outermost changed paths: drop any path that has a changed strict ancestor. */
function outermost(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(q + ' > ')));
}

type Group = { paths: string[]; before: Box | null; after: Box | null };

function groupRegions(paths: string[], a: StyleMap, b: StyleMap, padBy: number): Group[] {
  const groups: Group[] = paths.map((p) => {
    const ra = a.elements[p]?.rect;
    const rb = b.elements[p]?.rect;
    const before = ra ? pad(rectToBox(ra), padBy) : null;
    const after = rb ? pad(rectToBox(rb), padBy) : null;
    return { paths: [p], before: visible(before) ? before : null, after: visible(after) ? after : null };
  });

  // Merge groups whose regions overlap on either side, to a fixpoint.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const gi = groups[i];
        const gj = groups[j];
        const hit =
          (visible(gi.after) && visible(gj.after) && intersects(gi.after, gj.after)) ||
          (visible(gi.before) && visible(gj.before) && intersects(gi.before, gj.before));
        if (hit) {
          gi.paths.push(...gj.paths);
          gi.before = visible(gi.before) && visible(gj.before) ? union(gi.before, gj.before) : (gi.before ?? gj.before);
          gi.after = visible(gi.after) && visible(gj.after) ? union(gi.after, gj.after) : (gi.after ?? gj.after);
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

function cropPng(src: PNG, box: Box, w: number, h: number): PNG {
  // Center the fixed-size crop on the box, clamped to the image.
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x = Math.max(0, Math.min(Math.round(cx - w / 2), src.width - w));
  const y = Math.max(0, Math.min(Math.round(cy - h / 2), src.height - h));
  const cw = Math.min(w, src.width);
  const ch = Math.min(h, src.height);
  const out = new PNG({ width: cw, height: ch });
  PNG.bitblt(src, out, Math.max(0, x), Math.max(0, y), cw, ch, 0, 0);
  return out;
}

// Lossless but lean: drop the alpha channel (every crop/composite is opaque),
// max deflate, adaptive per-row filtering. ~15% smaller than the default, and
// faithful — these images are eyeballed for intentional change, so no lossy
// artifacts that could masquerade as a real diff. The bigger lever is in the
// action: it commits only the composite, never the separate before/after crops.
const PNG_OPTS = { deflateLevel: 9, filterType: -1, colorType: 2, inputColorType: 6 } as const;
function writePng(file: string, png: PNG): void {
  fs.writeFileSync(file, PNG.sync.write(png, PNG_OPTS));
}

type RGB = [number, number, number];
function fillRect(png: PNG, x: number, y: number, w: number, h: number, [r, g, b]: RGB): void {
  for (let yy = Math.max(0, y); yy < Math.min(png.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(png.width, x + w); xx++) {
      const i = (yy * png.width + xx) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
}

/**
 * One labelled before|after image: the two equal-size crops on a dark canvas,
 * a divider between them, and a top accent bar per side (grey = before,
 * blue = after) as a font-free before/after cue. Left is always before.
 */
function compositePair(before: PNG, after: PNG): PNG {
  const PAD = 20;
  const GAP = 28;
  const BAR = 6; // accent strip height
  const w = Math.max(before.width, after.width);
  const h = Math.max(before.height, after.height);
  const width = PAD + w + GAP + w + PAD;
  const height = PAD + BAR + h + PAD;
  const canvas = new PNG({ width, height });
  fillRect(canvas, 0, 0, width, height, [13, 17, 23]); // GitHub dark
  const leftX = PAD;
  const rightX = PAD + w + GAP;
  const top = PAD + BAR;
  fillRect(canvas, leftX, PAD, w, BAR, [110, 118, 129]); // before: grey
  fillRect(canvas, rightX, PAD, w, BAR, [88, 166, 255]); // after: blue
  PNG.bitblt(before, canvas, 0, 0, before.width, before.height, leftX, top);
  PNG.bitblt(after, canvas, 0, 0, after.width, after.height, rightX, top);
  fillRect(canvas, PAD + w + GAP / 2 - 1, PAD, 2, BAR + h, [48, 54, 61]); // divider
  return canvas;
}

function readPng(file: string): PNG | null {
  if (!fs.existsSync(file)) return null;
  return PNG.sync.read(fs.readFileSync(file));
}

// --- readable findings: dedupe logical longhands, collapse shorthand families,
//     humanize values, label by semantic marker, group identical siblings ------

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
  let s = v.replace(/-?\d+\.\d+/g, (m) => String(Math.round(parseFloat(m) * 10) / 10));
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
      before: `${ow.before} ${os.before} ${oc.before}`,
      after: `${ow.after} ${os.after} ${oc.after}`,
    });
  }
  return [...map.values()]
    .map((p) => ({ prop: p.prop, before: cleanVal(p.before), after: cleanVal(p.after) }))
    .sort((a, b) => orderIdx(a.prop) - orderIdx(b.prop) || a.prop.localeCompare(b.prop));
}

/** `div.who-grid`, `a.nav-cta`, `h3` — the semantic marker class, else the tag. */
export function prettyLabel(p: string, cls: string): string {
  const tag = (p.split('>').pop() ?? '').trim().replace(/:nth-child\(\d+\)/, '') || 'el';
  const first = cls.split(/\s+/)[0] ?? '';
  return /^[a-z][a-z0-9-]*$/.test(first) ? `${tag}.${first}` : tag;
}

const surfaceBase = (s: string): string => s.replace(/@\d+$/, '');
const surfaceWidth = (s: string): number => Number(s.match(/@(\d+)$/)?.[1] ?? 0);

/** "landing @ 1280, 1080, 390 · landing-nav-open @ 1080" from the surface keys. */
function formatSurfaceList(surfaces: string[]): string {
  const byBase = new Map<string, number[]>();
  for (const s of surfaces) {
    const arr = byBase.get(surfaceBase(s)) ?? [];
    arr.push(surfaceWidth(s));
    byBase.set(surfaceBase(s), arr);
  }
  return [...byBase]
    .map(([base, ws]) => {
      const widths = ws.filter((w) => w > 0).sort((a, b) => b - a);
      return widths.length ? `${base} @ ${widths.join(', ')}` : base;
    })
    .join(' · ');
}

/** Canonical signature of a surface's findings: surfaces that changed in the
 *  same way collapse into one section + one image (the rects differ per width;
 *  the change itself does not). */
function signatureOf(findings: Finding[]): string {
  return JSON.stringify(
    findings
      .map((f) => ({
        p: f.path,
        k: f.kind,
        t: f.kind === 'dom' ? f.change : f.kind === 'state' ? f.state : (f.pseudo ?? ''),
        v:
          f.kind === 'dom'
            ? ''
            : summarizeProps(f.props)
                .map((c) => `${c.prop}=${c.before}>${c.after}`)
                .join('|'),
      }))
      .sort((a, b) => `${a.p}|${a.k}|${a.t}`.localeCompare(`${b.p}|${b.k}|${b.t}`)),
  );
}

/** A one-line heading for a change group: "1 element added", "2 elements restyled". */
function groupTitle(findings: Finding[]): string {
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

/**
 * A crop's heading: the element it's anchored on, then what happened inside it —
 * `` `who-grid` · 5 elements restyled ``. Naming the anchor is what ties the
 * table of changes below to the screenshot above it.
 */
function regionHeading(regionPaths: string[], findings: Finding[]): string {
  const anchors = [...regionPaths].sort((a, b) => a.split(' > ').length - b.split(' > ').length);
  const clsFor = (p: string) => findings.find((f) => f.path === p)?.cls ?? '';
  const head = prettyLabel(anchors[0] ?? '', clsFor(anchors[0] ?? ''));
  const label = anchors.length > 1 ? `\`${head}\` + ${anchors.length - 1} more` : `\`${head}\``;
  return `${label} · ${groupTitle(findings)}`;
}

// A diff state row whose value is one of these placeholders means "this state
// has no effect here" — meaningless to show, so render it as an em dash.
const STATE_PLACEHOLDER = new Set(['(state does not change it)', '(state no longer changes it)', '(unset)']);
const cell = (v: string): string => (STATE_PLACEHOLDER.has(v) ? '—' : `\`${v}\``);

function beforeAfterTable(rows: PropChange[]): string[] {
  return [
    '| Property | Before | After |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| \`${r.prop}\` | ${cell(r.before)} | ${cell(r.after)} |`),
  ];
}

/** One element's heading + body lines (no leading blank, no ×N suffix). */
function renderOneElement(group: Finding[]): { head: string; body: string[] } | null {
  const label = prettyLabel(group[0].path, group[0].cls);
  const dom = group.find((f): f is Extract<Finding, { kind: 'dom' }> => f.kind === 'dom');
  const styles = group.filter((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style');
  const states = group.filter((f): f is Extract<Finding, { kind: 'state' }> => f.kind === 'state');

  if (dom?.change === 'removed') return { head: `**Removed** \`${label}\``, body: [] };
  const added = dom?.change === 'added';
  const head = added
    ? `**Added** \`${label}\``
    : dom?.change === 'retagged'
      ? `**Retagged** \`${label}\` ${dom.detail ?? ''}`
      : `**\`${label}\`**`;

  const body: string[] = [];
  for (const s of styles) {
    const rows = summarizeProps(s.props);
    if (rows.length) body.push('', s.pseudo ? `On \`${s.pseudo}\`:` : 'Style:', '', ...beforeAfterTable(rows));
  }
  if (states.length) {
    const rows: string[] = [];
    for (const st of states)
      for (const c of summarizeProps(st.props))
        rows.push(
          added
            ? `| \`:${st.state}\` | \`${c.prop}\` | ${cell(c.after)} |`
            : `| \`:${st.state}\` | \`${c.prop}\` | ${cell(c.before)} → ${cell(c.after)} |`,
        );
    if (rows.length)
      body.push(
        '',
        added ? 'Interactive states:' : 'Interactive-state changes:',
        '',
        added ? '| State | Property | Value |' : '| State | Property | Before → After |',
        '| --- | --- | --- |',
        ...rows,
      );
  }
  // Existing element with nothing left to show (all derived) → skip; an
  // added/removed/retagged element always renders its heading.
  if (!dom && !body.length) return null;
  return { head, body };
}

/**
 * Render each changed element ONCE — its base / pseudo / state findings grouped
 * under a single heading — then collapse identical siblings (same label, same
 * change at the same level) into one block with a `×N` count. A newly-added
 * element shows only the values it takes (a brand-new element has no meaningful
 * "before"); an existing element shows before → after.
 */
function renderElements(findings: Finding[], maxElements = 40): string[] {
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byPath.get(f.path) ?? [];
    arr.push(f);
    byPath.set(f.path, arr);
  }
  type Block = { head: string; body: string[]; count: number };
  const blocks: Block[] = [];
  const bySig = new Map<string, Block>();
  for (const group of byPath.values()) {
    const el = renderOneElement(group);
    if (!el) continue;
    const sig = `${el.head}\n${el.body.join('\n')}`;
    const seen = bySig.get(sig);
    if (seen) seen.count++;
    else {
      const block = { ...el, count: 1 };
      bySig.set(sig, block);
      blocks.push(block);
    }
  }
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i >= maxElements) {
      out.push('', `_…and ${blocks.length - i} more element(s) — see report.json._`);
      break;
    }
    const b = blocks[i];
    out.push('', b.count > 1 ? `${b.head} ×${b.count}` : b.head, ...b.body);
  }
  return out;
}

/**
 * A scannable one-liner of what a crop changed, shown ABOVE the folded tables so a
 * reviewer can judge without expanding: its top property deltas with values, the
 * rest as a count, and a flag when the change reaches into hover/focus/active — the
 * one kind of change a static before|after screenshot can't show.
 */
function changeEssence(findings: Finding[]): string {
  const verbs: string[] = [];
  for (const c of ['added', 'removed', 'retagged'] as const) {
    const k = findings.filter((f) => f.kind === 'dom' && f.change === c).length;
    if (k) verbs.push(`${k} ${c}`);
  }
  const rows = findings.flatMap((f) => (f.kind === 'dom' ? [] : summarizeProps(f.props)));
  const top = rows.slice(0, 3).map((r) => `\`${r.prop}\` ${cell(r.before)} → ${cell(r.after)}`);
  const more = rows.length > top.length ? `+${rows.length - top.length} more` : '';
  const line = [...verbs, ...top, more].filter(Boolean).join(' · ') || '_see changes_';
  return findings.some((f) => f.kind === 'state') ? `${line} _· incl. hover/focus/active_` : line;
}

/** Plain-text `<summary>` affordance — GitHub renders markdown inside `<summary>`
 *  literally, so no backticks or bold here. */
function foldSummary(findings: Finding[]): string {
  const n = findings.flatMap((f) => (f.kind === 'dom' ? [] : summarizeProps(f.props))).length;
  if (!n) return 'Show details';
  return n === 1 ? 'Show the property change' : `Show all ${n} property changes`;
}

/** Render a crop's changes: the essence line, then the property tables — folded
 *  under a toggle once they would be a wall (the screenshot and approval checkbox
 *  above always stay visible). Blank lines around the table block are mandatory or
 *  GitHub prints the tables as literal text. `foldAt` is the row count at which the
 *  tables collapse; ≤ 0 folds always, Infinity never. */
function renderCropChanges(findings: Finding[], foldAt: number): string[] {
  const tables = renderElements(findings);
  if (!tables.length) return [];
  const rows = findings.flatMap((f) => (f.kind === 'dom' ? [] : summarizeProps(f.props))).length;
  // Small enough to read at a glance: the tables speak for themselves, no essence
  // line (it would just echo a one- or two-row table).
  if (rows < foldAt) return tables;
  // Folded: the essence line is the visible stand-in for what the toggle hides.
  return [
    '',
    changeEssence(findings),
    '',
    '<details>',
    `<summary>${foldSummary(findings)}</summary>`,
    ...tables,
    '',
    '</details>',
  ];
}

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
const hasRealChange = (f: Finding): boolean => f.kind === 'dom' || f.props.some((p) => !DERIVED_PROPS.has(p.prop));
const stripDerived = (f: Finding): Finding =>
  f.kind === 'dom' ? f : { ...f, props: f.props.filter((p) => !DERIVED_PROPS.has(p.prop)) };

export function generateStyleMapReport(opts: ReportOptions): ReportResult {
  const {
    beforeDir,
    afterDir,
    outDir,
    imageBaseUrl = '',
    pad: padBy = 24,
    minWidth = 320,
    minHeight = 180,
    maxHeight = 1600,
    maxCrops = 6,
    foldDetailsAt = 0,
  } = opts;

  const includeNoise = opts.includeLayoutNoise ?? false;
  const { surfaces } = diffStyleMapDirs(beforeDir, afterDir);
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });

  // Focus each surface on styling intent: drop reflow-casualty elements (only
  // size/position-derived changes) and strip those props from the rest, unless
  // includeLayoutNoise is set. Surfaces left with no real change are dropped.
  const prepared = surfaces
    .map((sd) => ({
      sd,
      findings: sd.missing || includeNoise ? sd.findings : sd.findings.filter(hasRealChange).map(stripDerived),
    }))
    .filter((p) => p.sd.missing || p.findings.length > 0);

  // Group surfaces that changed in the SAME way (the rects differ per width; the
  // change itself does not) so an identical change shows once, not once per
  // surface — with one representative image (the widest surface in the group).
  const missing = prepared.filter((p) => p.sd.missing);
  type ChangeGroup = { surfaces: string[]; rep: (typeof prepared)[number]; findings: Finding[] };
  const bySig = new Map<string, ChangeGroup>();
  for (const p of prepared) {
    if (p.sd.missing) continue;
    const sig = signatureOf(p.findings);
    const existing = bySig.get(sig);
    if (existing) {
      existing.surfaces.push(p.sd.surface);
      if (surfaceWidth(p.sd.surface) > surfaceWidth(existing.rep.sd.surface)) existing.rep = p;
    } else {
      bySig.set(sig, { surfaces: [p.sd.surface], rep: p, findings: p.findings });
    }
  }
  const changeGroups = [...bySig.values()];

  // Counts reflect the GROUPED view: each distinct change counts once, not once
  // per surface it appears on (after shorthand/dedupe collapsing).
  const shown: DiffCounts = { dom: 0, style: 0, state: 0 };
  for (const cg of changeGroups)
    for (const f of cg.findings) {
      if (f.kind === 'dom') shown.dom++;
      else if (f.kind === 'style') shown.style += summarizeProps(f.props).length;
      else shown.state += summarizeProps(f.props).length;
    }
  const surfaceCount = changeGroups.reduce((acc, g) => acc + g.surfaces.length, 0) + missing.length;

  const md: string[] = [];
  const json: Array<Record<string, unknown>> = [];
  const img = (rel: string) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, '')}/${rel}` : rel);

  md.push('## 🗺️ StyleProof report', '');
  if (changeGroups.length === 0 && missing.length === 0) {
    md.push('✓ All surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches.');
  } else {
    md.push(
      `**${shown.dom} DOM change(s) · ${shown.style} computed-style difference(s) · ${shown.state} state-delta difference(s)** ` +
        `across ${changeGroups.length} distinct change(s) in ${surfaceCount} surface(s).`,
    );
  }

  let totalFindings = 0;
  let cropSeq = 0;
  for (const cg of changeGroups) {
    const { sd, findings: surfaceFindings } = cg.rep;
    totalFindings += surfaceFindings.length;

    const mapA = loadStyleMap(findCapture(beforeDir, sd.surface));
    const mapB = loadStyleMap(findCapture(afterDir, sd.surface));
    const pngA = readPng(path.join(beforeDir, `${sd.surface}.png`));
    const pngB = readPng(path.join(afterDir, `${sd.surface}.png`));

    const changedPaths = outermost([...new Set(surfaceFindings.map((f) => f.path))]);
    let groups = groupRegions(changedPaths, mapA, mapB, padBy);
    if (groups.length > maxCrops) {
      groups = [
        groups.reduce((acc, g) => ({
          paths: [...acc.paths, ...g.paths],
          before: visible(acc.before) && visible(g.before) ? union(acc.before, g.before) : (acc.before ?? g.before),
          after: visible(acc.after) && visible(g.after) ? union(acc.after, g.after) : (acc.after ?? g.after),
        })),
      ];
    }
    // Read top-to-bottom: one section per crop, in page order.
    const topY = (g: Group) => (visible(g.after) ? g.after.y : visible(g.before) ? g.before.y : Infinity);
    groups.sort((a, b) => topY(a) - topY(b));

    const surfaceList =
      cg.surfaces.length > 1
        ? `_Identical across ${cg.surfaces.length} surfaces: ${formatSurfaceList(cg.surfaces)}_`
        : `_${formatSurfaceList(cg.surfaces)}_`;

    const surfaceJson: Record<string, unknown> = {
      surfaces: cg.surfaces,
      representative: sd.surface,
      regions: [] as unknown[],
    };

    for (const g of groups) {
      cropSeq++;
      // Exactly the findings whose element lives inside THIS crop, so the tables
      // sit directly under the screenshot that shows them — never a wall of
      // changes spanning several crops with no way to tell which is which.
      const regionFindings = surfaceFindings.filter((f) =>
        g.paths.some((root) => f.path === root || f.path.startsWith(root + ' > ')),
      );

      md.push('', `### ${regionHeading(g.paths, regionFindings)}`, '', surfaceList);

      const region = visible(g.after) ? g.after : g.before;
      let images: { before?: string; after?: string; composite?: string } = {};
      if (region && pngA && pngB) {
        // Same crop dimensions on both sides so the pair reads as a pair.
        const w = Math.max(minWidth, visible(g.before) ? g.before.w : 0, visible(g.after) ? g.after.w : 0);
        const h = Math.min(
          maxHeight,
          Math.max(minHeight, visible(g.before) ? g.before.h : 0, visible(g.after) ? g.after.h : 0),
        );
        // Path-safe, report-unique stem: `hero@1280` → `hero-1280-3` so relative
        // image links resolve cleanly and two crops never collide on one filename.
        const stem = `crops/${sd.surface.replace(/[^a-z0-9-]/gi, '-')}-${cropSeq}`;
        const before = cropPng(pngA, visible(g.before) ? g.before : region, w, h);
        const after = cropPng(pngB, visible(g.after) ? g.after : region, w, h);
        const composite = compositePair(before, after);
        writePng(path.join(outDir, `${stem}-before.png`), before);
        writePng(path.join(outDir, `${stem}-after.png`), after);
        writePng(path.join(outDir, `${stem}-composite.png`), composite);
        images = { before: `${stem}-before.png`, after: `${stem}-after.png`, composite: `${stem}-composite.png` };
        // One side-by-side image per crop: clean inline render, single upload.
        md.push(
          '',
          `![before ◀ │ ▶ after](${img(images.composite!)})`,
          '',
          `<sub>◀ before  ·  after ▶ — ${sd.surface}</sub>`,
        );
      } else if (!region) {
        md.push('', '_Changed element is not visible in this state (zero-size box) — see the property list._');
      } else {
        md.push(
          '',
          '_No screenshots in these capture sets (run captures with `screenshots: true` for side-by-side crops)._',
        );
      }

      // What this crop changed: a scannable essence line, then the property
      // tables — folded under a toggle once they'd be a wall (foldDetailsAt).
      md.push(...renderCropChanges(regionFindings, foldDetailsAt));
      (surfaceJson.regions as unknown[]).push({ paths: g.paths, before: g.before, after: g.after, images });
    }

    surfaceJson.findings = surfaceFindings;
    json.push(surfaceJson);
  }

  for (const p of missing) {
    md.push(
      '',
      `### \`${p.sd.surface}\``,
      '',
      `⚠️ captured only in the **${p.sd.missing === 'before' ? 'after' : 'before'}** set — re-run both captures.`,
    );
    json.push({ surface: p.sd.surface, missing: p.sd.missing });
  }

  const reportMdPath = path.join(outDir, 'report.md');
  const reportJsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportMdPath, md.join('\n') + '\n');
  fs.writeFileSync(reportJsonPath, JSON.stringify({ counts: shown, surfaces: json }, null, 2));
  return { changedSurfaces: prepared.length, totalFindings, reportMdPath, reportJsonPath };
}

function findCapture(dir: string, surface: string): string {
  for (const ext of ['.json.gz', '.json']) {
    const p = path.join(dir, surface + ext);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no capture for ${surface} in ${dir}`);
}
