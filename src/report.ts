import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { loadStyleMap, type Rect, type StyleMap } from './capture.js';
import { diffStyleMapDirs, type DiffCounts, type Finding, type PropChange } from './diff.js';
import { describeChange, tokenIndex, toHex, trackCount, type ElementChange, type DescribeCtx } from './describe.js';
// Re-export the plain-English summariser so consumers (and tests) reach it
// through the package's report module rather than a deep path.
export { describeChange, colorName, tokenIndex, toHex } from './describe.js';

/**
 * Visual diff report: for every surface with findings, crop the before/after
 * full-page screenshots around the changed elements and write a markdown
 * report with side-by-side images plus the exact property changes.
 *
 * Cropping zooms out to the OUTERMOST changed element: changed paths that are
 * descendants of other changed paths are folded into their ancestor, nearby
 * regions are merged, and both sides are cropped at the SAME page rectangle (the
 * union of where the change sits on each side) so the pair lines up exactly —
 * the reviewer compares like-for-like instead of playing spot-the-difference.
 */

export type ReportOptions = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  /** Prefix for image URLs in report.md (default: relative paths). */
  imageBaseUrl?: string;
  /** Padding around the union of changed rects (default 12px). */
  pad?: number;
  /** Minimum crop size, for context around tiny changes (default 320×180). */
  minWidth?: number;
  minHeight?: number;
  /** Crops taller than this are clamped (default 1600px). */
  maxHeight?: number;
  /** Max crop regions per surface before collapsing into one union crop (default 8). */
  maxCrops?: number;
  /**
   * Row count at which a crop's property tables fold under a `<details>` toggle
   * (default 0 = always fold; the plain-English bullets and screenshot stay
   * visible). Set to e.g. 5 to keep small changes inline and fold only verbose
   * ones, or `Infinity` to never fold.
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
  /** Surfaces carrying a reviewable change (excludes new, one-sided surfaces). */
  changedSurfaces: number;
  /** New surfaces present on only one side, with no baseline to compare. */
  newSurfaces: number;
  totalFindings: number;
  reportMdPath: string;
  reportJsonPath: string;
};

type Box = { x: number; y: number; w: number; h: number };

// Hidden marker appended to a new-surface heading. Invisible in rendered
// markdown; lets the PR-comment layer attach an OPTIONAL "approve" box to a new
// surface (vs the required box on a real change), so new surfaces never gate.
const NEW_SURFACE_MARKER = '<!-- styleproof-new -->';

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

/** Outermost changed paths: drop any path that has a changed strict ancestor.
 *  Used to ANCHOR a crop (zoom to the whole changed region, not a leaf). */
function outermost(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(q + ' > ')));
}

/** Innermost changed paths: drop any path that has a changed strict descendant.
 *  Used to ANNOTATE — box the leaf elements that actually changed (the added
 *  avatars, the restyled cards), not their container, whose box ≈ the whole crop. */
function innermost(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && q.startsWith(p + ' > ')));
}

/** Headline counts with the zeros dropped — `0 state-delta difference(s)` is noise. */
function changeCountLabel(shown: DiffCounts): string {
  const parts: string[] = [];
  if (shown.dom) parts.push(`${shown.dom} DOM change(s)`);
  if (shown.style) parts.push(`${shown.style} computed-style difference(s)`);
  if (shown.state) parts.push(`${shown.state} state-delta difference(s)`);
  return parts.join(' · ');
}

/** Group findings by their element path (one group per changed element). */
function groupByPath(findings: Finding[]): Finding[][] {
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byPath.get(f.path) ?? [];
    arr.push(f);
    byPath.set(f.path, arr);
  }
  return [...byPath.values()];
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

// A crop plus the document-space origin it was taken from, so callers can map an
// element's page coordinates into the crop to annotate it.
type Crop = { png: PNG; ox: number; oy: number };
function cropPng(src: PNG, box: Box, w: number, h: number): Crop {
  // Center the fixed-size crop on the box, clamped to the image.
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ox = Math.max(0, Math.min(Math.round(cx - w / 2), src.width - w));
  const oy = Math.max(0, Math.min(Math.round(cy - h / 2), src.height - h));
  const cw = Math.min(w, src.width);
  const ch = Math.min(h, src.height);
  const out = new PNG({ width: cw, height: ch });
  PNG.bitblt(src, out, Math.max(0, ox), Math.max(0, oy), cw, ch, 0, 0);
  return { png: out, ox, oy };
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

// The annotation hue: a magenta no real UI palette tends to use, so an outline
// reads as a marker, not content. Drawn as a hollow rectangle (never filled) so
// the UI underneath stays visible — and the clean image alongside proves the box
// isn't part of the design.
const HILITE: RGB = [255, 0, 200];
function strokeRect(png: PNG, x: number, y: number, w: number, h: number, t = 2, color: RGB = HILITE): void {
  fillRect(png, x, y, w, t, color); // top
  fillRect(png, x, y + h - t, w, t, color); // bottom
  fillRect(png, x, y, t, h, color); // left
  fillRect(png, x + w - t, y, t, h, color); // right
}

/** Clone a crop and outline each changed element's box (page coords mapped into
 *  the crop via its origin), so the eye lands on exactly what the bullet named. */
function annotateCrop(crop: Crop, rects: Rect[]): PNG {
  const out = new PNG({ width: crop.png.width, height: crop.png.height });
  PNG.bitblt(crop.png, out, 0, 0, crop.png.width, crop.png.height, 0, 0);
  for (const [rx, ry, rw, rh] of rects) {
    if (rw <= 0 || rh <= 0) continue;
    strokeRect(out, rx - crop.ox, ry - crop.oy, rw, rh);
  }
  return out;
}

/**
 * One before|after image: the two equal-size crops on a dark canvas with a
 * neutral divider between them. Left is always before; before/after is labelled
 * by the caption under the image. The divider is identical on both sides, so the
 * ONLY thing that differs across the pair is the actual change — no extra chrome
 * (e.g. a coloured accent strip) that reads as a second diff.
 */
function compositePair(before: PNG, after: PNG): PNG {
  const PAD = 20;
  const GAP = 28;
  const w = Math.max(before.width, after.width);
  const h = Math.max(before.height, after.height);
  const width = PAD + w + GAP + w + PAD;
  const height = PAD + h + PAD;
  const canvas = new PNG({ width, height });
  fillRect(canvas, 0, 0, width, height, [13, 17, 23]); // GitHub dark
  const leftX = PAD;
  const rightX = PAD + w + GAP;
  PNG.bitblt(before, canvas, 0, 0, before.width, before.height, leftX, PAD);
  PNG.bitblt(after, canvas, 0, 0, after.width, after.height, rightX, PAD);
  fillRect(canvas, PAD + w + GAP / 2 - 1, PAD, 2, h, [48, 54, 61]); // divider
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

// "No value here" markers: a forced-state delta that doesn't apply, an unset
// longhand, or a capture artifact where a path didn't line up. A change BETWEEN
// two of these (e.g. `— → (gone)`) is meaningless and must never read as a diff.
const NON_VALUE = new Set(['(state does not change it)', '(state no longer changes it)', '(unset)', '(gone)']);
const isNonValue = (v: string): boolean => NON_VALUE.has(v);
/** Combine longhands into a shorthand value; all-non-value sides collapse to one. */
const combineValues = (vals: string[]): string => (vals.every(isNonValue) ? '(unset)' : vals.join(' '));

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
function signatureOf(findings: Finding[]): string {
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

// A "no value here" marker renders as an em dash; colours render as `#hex` so the
// table cell shows GitHub's live swatch.
const cell = (v: string): string => (isNonValue(v) ? '—' : `\`${toHex(v)}\``);

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
  type Block = { head: string; body: string[]; count: number };
  const blocks: Block[] = [];
  const bySig = new Map<string, Block>();
  for (const group of groupByPath(findings)) {
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

/** Plain-text `<summary>` affordance — GitHub renders markdown inside `<summary>`
 *  literally, so no backticks or bold here. */
function foldSummary(findings: Finding[]): string {
  const n = findings.flatMap((f) => (f.kind === 'dom' ? [] : summarizeProps(f.props))).length;
  if (!n) return 'Show details';
  return n === 1 ? 'Show the property change' : `Show all ${n} property changes`;
}

/** Render a crop's changes: plain-English bullets that tell the reviewer what to
 *  look for, then the exact property tables — folded under a toggle once they would
 *  be a wall (the screenshot and approval checkbox above always stay visible).
 *  Blank lines around the table block are mandatory or GitHub prints the tables as
 *  literal text. `foldAt` is the row count at which the tables collapse; ≤ 0 folds
 *  always, Infinity never. */
function renderCropChanges(findings: Finding[], foldAt: number, ctx: DescribeCtx): string[] {
  const tables = renderElements(findings);
  if (!tables.length) return [];
  const rows = findings.flatMap((f) => (f.kind === 'dom' ? [] : summarizeProps(f.props))).length;
  // Small enough to read at a glance: the tables speak for themselves.
  if (rows < foldAt) return tables;
  // Folded: plain-English bullets are the visible stand-in for what the toggle hides.
  const bullets = describeChange(buildElementChanges(findings), ctx);
  const summary = bullets.length ? bullets.map((b) => `- ${b}`) : ['_see changes_'];
  return ['', ...summary, '', '<details>', `<summary>${foldSummary(findings)}</summary>`, ...tables, '', '</details>'];
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

/**
 * Strip the noise the visual report shouldn't carry, cross-referencing each
 * element's layers so the forced-state layer stops echoing the base:
 *   - base/pseudo styles: drop size/position-derived longhands (reflow casualties);
 *   - forced states: drop derived + grid-track props, drop a delta the BASE
 *     already changed (a `:hover color` that just follows a recoloured base is an
 *     echo, not a dropped variant), and drop non-value↔non-value rows;
 *   - any finding left with no props is removed entirely.
 */
function cleanFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const group of groupByPath(findings)) {
    const base = group.find((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style' && f.pseudo === null);
    const baseChanged = new Set(base?.props.map((p) => p.prop) ?? []);
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
                !STATE_STRIP.has(p.prop) && !baseChanged.has(p.prop) && !(isNonValue(p.before) && isNonValue(p.after)),
            );
      if (props.length) out.push({ ...f, props });
    }
  }
  return out;
}

/** Per-element view for the plain-English summariser: the base deltas (summarised)
 *  plus which interactive states genuinely changed. */
function buildElementChanges(findings: Finding[]): ElementChange[] {
  const els: ElementChange[] = [];
  for (const group of groupByPath(findings)) {
    const dom = group.find((f): f is Extract<Finding, { kind: 'dom' }> => f.kind === 'dom');
    const styleProps = group
      .filter((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style')
      .flatMap((f) => f.props);
    els.push({
      label: prettyLabel(group[0].path, group[0].cls),
      added: dom?.change === 'added',
      removed: dom?.change === 'removed',
      retagged: dom?.change === 'retagged',
      props: summarizeProps(styleProps),
      states: [
        ...new Set(
          group.filter((f) => f.kind === 'state').map((f) => (f as Extract<Finding, { kind: 'state' }>).state),
        ),
      ],
    });
  }
  return els;
}

export function generateStyleMapReport(opts: ReportOptions): ReportResult {
  const {
    beforeDir,
    afterDir,
    outDir,
    imageBaseUrl = '',
    // Tighter than before (was 24) so the change fills the frame — the annotation
    // box keeps enough context legible.
    pad: padBy = 12,
    minWidth = 320,
    minHeight = 180,
    maxHeight = 1600,
    // More, smaller crops before collapsing (was 6), so distinct changes get their
    // own focused frame rather than one wide merged one.
    maxCrops = 8,
    foldDetailsAt = 0,
  } = opts;

  const includeNoise = opts.includeLayoutNoise ?? false;
  const { surfaces, volatile: volatileCount } = diffStyleMapDirs(beforeDir, afterDir);
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });

  // Focus each surface on styling intent: drop reflow-casualty props, suppress
  // forced-state echoes of base changes, and remove non-value noise (see
  // cleanFindings), unless includeLayoutNoise is set. Surfaces left with no real
  // change are dropped.
  const prepared = surfaces
    .map((sd) => ({
      sd,
      findings: sd.missing || includeNoise ? sd.findings : cleanFindings(sd.findings),
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
  // Surfaces carrying a reviewable change — NOT the new (one-sided) ones, which
  // have no baseline to compare and are summarised on their own line below so the
  // headline never reads "0 changes" while warnings sit beneath it.
  const changedSurfaceCount = changeGroups.reduce((acc, g) => acc + g.surfaces.length, 0);

  const md: string[] = [];
  const json: Array<Record<string, unknown>> = [];
  const img = (rel: string) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, '')}/${rel}` : rel);

  md.push('## 🗺️ StyleProof report', '');
  if (changeGroups.length === 0 && missing.length === 0) {
    md.push('✓ All surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches.');
  } else {
    if (changeGroups.length > 0) {
      md.push(
        `**${changeCountLabel(shown)}** across ${changeGroups.length} distinct change(s) in ${changedSurfaceCount} surface(s).`,
      );
    }
    if (missing.length > 0) {
      if (changeGroups.length > 0) md.push('');
      md.push(
        `🆕 **${missing.length} new surface(s)** captured with no baseline to compare — shown below for reference. ` +
          `New surfaces don't block the check.`,
      );
    }
  }
  if (volatileCount > 0) {
    md.push(
      '',
      `_${volatileCount} live region(s) auto-excluded as nondeterministic (a stream, ticker, or late-loading content) — they don't affect the check._`,
    );
  }

  let totalFindings = 0;
  let cropSeq = 0;
  for (const cg of changeGroups) {
    const { sd, findings: surfaceFindings } = cg.rep;
    totalFindings += surfaceFindings.length;

    const mapA = loadStyleMap(findCapture(beforeDir, sd.surface));
    const mapB = loadStyleMap(findCapture(afterDir, sd.surface));
    // Theme-token reverse-indexes so colour changes can name `red-200` per side.
    const describeCtx: DescribeCtx = { tokensBefore: tokenIndex(mapA.tokens), tokensAfter: tokenIndex(mapB.tokens) };
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
      let images: { composite?: string; annotated?: string } = {};
      if (region && pngA && pngB) {
        // Crop the SAME page rectangle from both sides — the union of where the
        // change sits on each side — so the pair lines up exactly and the reviewer
        // compares like-for-like instead of playing spot-the-difference. (Centring
        // each side on its own moved box would shift the background between them.)
        const cropBox = visible(g.before) && visible(g.after) ? union(g.before, g.after) : region;
        const w = Math.max(minWidth, cropBox.w);
        const h = Math.min(maxHeight, Math.max(minHeight, cropBox.h));
        // Path-safe, report-unique stem: `hero@1280` → `hero-1280-3` so relative
        // image links resolve cleanly and two crops never collide on one filename.
        const stem = `crops/${sd.surface.replace(/[^a-z0-9-]/gi, '-')}-${cropSeq}`;
        const before = cropPng(pngA, cropBox, w, h);
        const after = cropPng(pngB, cropBox, w, h);
        const composite = compositePair(before.png, after.png);
        writePng(path.join(outDir, `${stem}-composite.png`), composite);
        // Annotated twin: outline the LEAF changed elements (the added avatars, the
        // restyled cards) on each side — not the merged container the crop anchors
        // on, whose box would just trace the whole frame. An element present on only
        // one side (added/removed) is boxed only there.
        const markPaths = innermost([...new Set(regionFindings.map((f) => f.path))]);
        const rectsA = markPaths.map((p) => mapA.elements[p]?.rect).filter((r): r is Rect => !!r);
        const rectsB = markPaths.map((p) => mapB.elements[p]?.rect).filter((r): r is Rect => !!r);
        const annotated = compositePair(annotateCrop(before, rectsA), annotateCrop(after, rectsB));
        writePng(path.join(outDir, `${stem}-annotated.png`), annotated);
        images = { composite: `${stem}-composite.png`, annotated: `${stem}-annotated.png` };
        // Clean before|after shown by default (the real UI); the annotated twin —
        // boxes marking each change — sits one click away under a toggle. Plain
        // images (no link wrap) so a click opens the full-resolution file.
        md.push(
          '',
          `![before ◀ │ ▶ after](${img(images.composite!)})`,
          '',
          `<sub>◀ before  ·  after ▶ — ${sd.surface}</sub>`,
          '',
          '<details>',
          '<summary>🔍 Highlight what changed</summary>',
          '',
          `![annotated before ◀ │ ▶ after](${img(images.annotated!)})`,
          '',
          `<sub>magenta boxes mark each change — ${sd.surface}</sub>`,
          '',
          '</details>',
        );
      } else if (!region) {
        md.push('', '_Changed element is not visible in this state (zero-size box) — see the property list._');
      } else {
        md.push(
          '',
          '_No screenshots in these capture sets (run captures with `screenshots: true` for side-by-side crops)._',
        );
      }

      // What this crop changed: plain-English bullets, then the property tables —
      // folded under a toggle once they'd be a wall (foldDetailsAt).
      md.push(...renderCropChanges(regionFindings, foldDetailsAt, describeCtx));
      (surfaceJson.regions as unknown[]).push({ paths: g.paths, before: g.before, after: g.after, images });
    }

    surfaceJson.findings = surfaceFindings;
    json.push(surfaceJson);
  }

  // New surfaces: present on only one side, so there's nothing to diff. Show the
  // captured side as a single screenshot for reference and mark the heading so the
  // PR comment can attach an OPTIONAL approval box — these never gate the check.
  for (const p of missing) {
    const side = p.sd.missing === 'before' ? 'after' : 'before';
    const srcDir = side === 'after' ? afterDir : beforeDir;
    const png = readPng(path.join(srcDir, `${p.sd.surface}.png`));
    md.push(
      '',
      `### \`${p.sd.surface}\` · new surface ${NEW_SURFACE_MARKER}`,
      '',
      `_${formatSurfaceList([p.sd.surface])}_`,
    );
    const surfaceJson: Record<string, unknown> = { surface: p.sd.surface, missing: p.sd.missing, isNew: true };
    if (png) {
      cropSeq++;
      const h = Math.min(maxHeight, png.height);
      const crop = cropPng(png, { x: 0, y: 0, w: png.width, h }, png.width, h).png;
      const stem = `crops/${p.sd.surface.replace(/[^a-z0-9-]/gi, '-')}-${cropSeq}-new`;
      writePng(path.join(outDir, `${stem}.png`), crop);
      md.push(
        '',
        `![new surface — ${side}](${img(`${stem}.png`)})`,
        '',
        `<sub>${side} · ${p.sd.surface}${png.height > h ? ' (top of page)' : ''}</sub>`,
      );
      surfaceJson.image = `${stem}.png`;
    } else {
      md.push(
        '',
        `_Captured only in the **${side}** set; no screenshot saved (run captures with \`screenshots: true\`)._`,
      );
    }
    md.push(
      '',
      `_No baseline to compare against — this surface is new, so it doesn't block the check. It becomes part of the baseline once this merges._`,
    );
    json.push(surfaceJson);
  }

  const reportMdPath = path.join(outDir, 'report.md');
  const reportJsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportMdPath, md.join('\n') + '\n');
  fs.writeFileSync(reportJsonPath, JSON.stringify({ counts: shown, surfaces: json }, null, 2));
  return {
    changedSurfaces: prepared.length - missing.length,
    newSurfaces: missing.length,
    totalFindings,
    reportMdPath,
    reportJsonPath,
  };
}

function findCapture(dir: string, surface: string): string {
  for (const ext of ['.json.gz', '.json']) {
    const p = path.join(dir, surface + ext);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no capture for ${surface} in ${dir}`);
}
