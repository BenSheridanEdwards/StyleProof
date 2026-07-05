import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  loadStyleMap,
  readInventories,
  type ElementEntry,
  type LiveRegionCandidate,
  type Rect,
  type StyleMap,
} from './capture.js';
import { isMapFile } from './map-store.js';
import { fillRect, type RGB } from './png-util.js';
import {
  diffStyleMapDirs,
  diffContentDirs,
  type ContentChange,
  type DiffCounts,
  type Finding,
  type PropChange,
  type SurfaceDiff,
} from './diff.js';
import { describeChange, tokenIndex, toHex, trackCount, type ElementChange, type DescribeCtx } from './describe.js';
import {
  auditCoverage,
  auditDeterminism,
  COVERAGE_LEDGER,
  type CoverageLedger,
  type CoverageVerdict,
  type DeterminismVerdict,
} from './coverage.js';
import { auditRunInventory, readAckFile } from './inventory.js';
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
  /**
   * Changed-element footprint (max of its width/height, in px) at or below which a
   * magnified zoom crop is added so a sub-pixel change is visible by default
   * (default 64). Set to 0 to disable zoom crops.
   */
  zoomBelow?: number;
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
  /**
   * Render the opt-in content layer (default OFF): a separate, ADVISORY section
   * listing elements whose own text changed, each with a before/after crop.
   * Requires captures taken with `captureText: true`; otherwise there's no text
   * to diff and the section is empty. Never affects `changedSurfaces`,
   * `totalFindings`, or the exit code — StyleProof stays computed-styles-first;
   * this only surfaces copy changes (and any silent overflow/clipping they
   * cause) for the reviewer's eye.
   */
  includeContent?: boolean;
};

export type ReportResult = {
  /** Surfaces carrying a reviewable change (excludes new, one-sided surfaces). */
  changedSurfaces: number;
  /** New surfaces present on only one side, with no baseline to compare. */
  newSurfaces: number;
  totalFindings: number;
  /** Advisory content-layer changes rendered (0 unless includeContent + captured text). Never gates. */
  contentChanges: number;
  reportMdPath: string;
  reportJsonPath: string;
};

type Box = { x: number; y: number; w: number; h: number };

// Hidden marker appended to a new-surface heading. Invisible in rendered
// markdown; lets the PR-comment layer recognize one-sided surfaces.
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

/** Bounding box that encloses every rect (the changed-element footprint). */
function unionRects(rects: Rect[]): Box | null {
  const boxes = rects.map(rectToBox).filter(visible);
  if (!boxes.length) return null;
  return boxes.reduce(union);
}

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

// Integer nearest-neighbor upscale. Nearest-neighbor (not smoothing) so the
// zoom invents no colours that weren't captured — a magnified crop is still a
// faithful pixel-for-pixel view, just bigger.
function scalePng(src: PNG, s: number): PNG {
  if (s <= 1) return src;
  const out = new PNG({ width: src.width * s, height: src.height * s });
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / s);
    for (let x = 0; x < out.width; x++) {
      const si = (sy * src.width + Math.floor(x / s)) << 2;
      const oi = (y * out.width + x) << 2;
      out.data[oi] = src.data[si];
      out.data[oi + 1] = src.data[si + 1];
      out.data[oi + 2] = src.data[si + 2];
      out.data[oi + 3] = src.data[si + 3];
    }
  }
  return out;
}

// A magnified crop centered on the changed box, for changes too small to see at
// 1:1 (e.g. a 2px font bump on a caret). Crops the tight context box, upscales by
// an integer factor, then outlines the changes (stroke scaled to stay visible).
function zoomCrop(src: PNG, box: Box, rects: Rect[], factor: number): PNG {
  const crop = cropPng(src, box, box.w, box.h);
  const scaled = scalePng(crop.png, factor);
  const t = Math.max(2, factor);
  for (const [rx, ry, rw, rh] of rects) {
    strokeRect(scaled, (rx - crop.ox) * factor, (ry - crop.oy) * factor, rw * factor, rh * factor, t);
  }
  return scaled;
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

function pushSurfaceWidth(byBase: Map<string, number[]>, base: string, surface: string): void {
  const arr = byBase.get(base) ?? [];
  arr.push(surfaceWidth(surface));
  byBase.set(base, arr);
}

function renderSurfaceGroups(byBase: Map<string, number[]>): string {
  return [...byBase]
    .map(([base, ws]) => {
      const widths = ws.filter((w) => w > 0).sort((a, b) => b - a);
      return widths.length ? `${base} @ ${widths.join(', ')}` : base;
    })
    .join(' · ');
}

/** "landing @ 1280, 1080, 390 · landing-nav-open @ 1080" from the surface keys. */
function formatSurfaceList(surfaces: string[]): string {
  const byBase = new Map<string, number[]>();
  for (const s of surfaces) pushSurfaceWidth(byBase, surfaceBase(s), s);
  return renderSurfaceGroups(byBase);
}

function surfaceContext(...maps: Array<StyleMap | undefined>): string {
  const metadata = maps.find((m) => m?.metadata)?.metadata;
  if (!metadata?.variantKey) return '';
  if (metadata.variantKind === 'live-state') return `live state \`${metadata.variantKey}\``;
  if (metadata.variantKind === 'popup') return `popup \`${metadata.variantKey}\``;
  return `variant \`${metadata.variantKey}\``;
}

function formatSurfaceWithContext(surface: string, ...maps: Array<StyleMap | undefined>): string {
  const context = surfaceContext(...maps);
  return context ? `${formatSurfaceList([surface])} · ${context}` : formatSurfaceList([surface]);
}

function formatSurfaceListWithContext(surfaces: string[], beforeDir: string): string {
  const byBase = new Map<string, number[]>();
  for (const surface of surfaces) {
    const map = loadStyleMap(findCapture(beforeDir, surface));
    const context = surfaceContext(map);
    const base = context ? `${surfaceBase(surface)} · ${context}` : surfaceBase(surface);
    pushSurfaceWidth(byBase, base, surface);
  }
  return renderSurfaceGroups(byBase);
}

function liveCandidateLabel(candidate: LiveRegionCandidate): string {
  const label = candidate.cls ? `${candidate.tag}.${candidate.cls.split(/\s+/)[0]}` : candidate.tag;
  return `${label} (${candidate.reason})`;
}

function captureFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(isMapFile) : [];
}

function collectLiveCandidateLabels(beforeDir: string, afterDir: string): string[] {
  const seen = new Set<string>();
  for (const dir of [beforeDir, afterDir]) {
    for (const file of captureFiles(dir)) {
      const map = loadStyleMap(path.join(dir, file));
      for (const candidate of map.liveCandidates ?? []) seen.add(liveCandidateLabel(candidate));
    }
  }
  return [...seen].sort();
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

// Long values (gradients, data URIs) would swamp the table, but truncating each
// side independently can show two IDENTICAL cells for a real diff: both
// sides of a gradient rendered as the same rgba while the actual change — a
// dropped `0px` stop — was elsewhere in the string. Instead, trim the shared
// prefix/suffix and show each side's differing substring with a little context.
const EXCERPT_AT = 64; // both sides at or under this → show whole values
const EXCERPT_CTX = 12; // chars of shared context kept around the diff
const EXCERPT_MAX = 96; // hard cap per excerpt; the diff itself may be huge
export function excerptPair(before: string, after: string): [string, string] {
  if (before.length <= EXCERPT_AT && after.length <= EXCERPT_AT) return [before, after];
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  const maxS = Math.min(before.length, after.length) - p;
  while (s < maxS && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const cut = (v: string): string => {
    const start = Math.max(0, p - EXCERPT_CTX);
    let end = Math.min(v.length, v.length - s + EXCERPT_CTX);
    if (end - start > EXCERPT_MAX) end = start + EXCERPT_MAX;
    return (start > 0 ? '…' : '') + v.slice(start, end) + (end < v.length ? '…' : '');
  };
  return [cut(before), cut(after)];
}

/** Before/After cells as a pair, so long values excerpt around their actual diff. */
function cellPair(before: string, after: string): [string, string] {
  if (isNonValue(before) || isNonValue(after)) return [cell(before), cell(after)];
  const [b, a] = excerptPair(before, after);
  return [`\`${toHex(b)}\``, `\`${toHex(a)}\``];
}

function beforeAfterTable(rows: PropChange[]): string[] {
  return [
    '| Property | Before | After |',
    '| --- | --- | --- |',
    ...rows.map((r) => {
      const [b, a] = cellPair(r.before, r.after);
      return `| \`${r.prop}\` | ${b} | ${a} |`;
    }),
  ];
}

// A brand-new element has no meaningful "before", so its resting style renders
// value-only (the After column), mirroring the added-element interaction-states table.
function valueTable(rows: PropChange[]): string[] {
  return ['| Property | Value |', '| --- | --- |', ...rows.map((r) => `| \`${r.prop}\` | ${cell(r.after)} |`)];
}

/** `Button (variant=primary, size=sm)` — the React component + sanitized props
 *  the element captured (advisory; present only with captureComponent). */
function renderComponent(c: { name: string; props?: Record<string, string> }): string {
  const entries = Object.entries(c.props ?? {});
  const props = entries.length ? ` (${entries.map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  return `\`${c.name}\`${props}`;
}

/** One element's heading + body lines (no leading blank, no ×N suffix). */
// Base/pseudo style rows. Added elements render value-only (no meaningful before).
function styleSection(styles: Extract<Finding, { kind: 'style' }>[], added: boolean): string[] {
  const out: string[] = [];
  for (const s of styles) {
    const rows = summarizeProps(s.props);
    if (rows.length)
      out.push(
        '',
        s.pseudo ? `On \`${s.pseudo}\`:` : 'Style:',
        '',
        ...(added ? valueTable(rows) : beforeAfterTable(rows)),
      );
  }
  return out;
}

// Forced :hover/:focus/:active rows. Added: value-only; changed: before → after.
function statesSection(states: Extract<Finding, { kind: 'state' }>[], added: boolean): string[] {
  const rows: string[] = [];
  for (const st of states)
    for (const c of summarizeProps(st.props)) {
      const [b, a] = cellPair(c.before, c.after);
      rows.push(
        added
          ? `| \`:${st.state}\` | \`${c.prop}\` | ${cell(c.after)} |`
          : `| \`:${st.state}\` | \`${c.prop}\` | ${b} → ${a} |`,
      );
    }
  if (!rows.length) return [];
  return [
    '',
    added ? 'Interactive states:' : 'Interactive-state changes:',
    '',
    added ? '| State | Property | Value |' : '| State | Property | Before → After |',
    '| --- | --- | --- |',
    ...rows,
  ];
}

function renderOneElement(group: Finding[]): { head: string; body: string[] } | null {
  const label = prettyLabel(group[0].path, group[0].cls);
  const dom = group.find((f): f is Extract<Finding, { kind: 'dom' }> => f.kind === 'dom');
  if (dom?.change === 'removed') return { head: `**Removed** \`${label}\``, body: [] };
  const added = dom?.change === 'added';
  const head = added
    ? `**Added** \`${label}\``
    : dom?.change === 'retagged'
      ? `**Retagged** \`${label}\` ${dom.detail ?? ''}`
      : `**\`${label}\`**`;

  const body: string[] = [];
  // React component that rendered the element (added/retagged carry it on the dom
  // finding) — surfaced first so a reviewer sees `Button (variant=primary)`.
  if (dom?.component) body.push('', `React component: ${renderComponent(dom.component)}`);
  body.push(
    ...styleSection(
      group.filter((f): f is Extract<Finding, { kind: 'style' }> => f.kind === 'style'),
      added,
    ),
  );
  body.push(
    ...statesSection(
      group.filter((f): f is Extract<Finding, { kind: 'state' }> => f.kind === 'state'),
      added,
    ),
  );
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

/** One-line, backtick-safe display text, clipped so the report stays scannable. */
function clipText(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Shared inputs for the opt-in content layer, bundled so each helper stays small.
type ContentCtx = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  img: (rel: string) => string;
  padBy: number;
  minWidth: number;
  minHeight: number;
  maxHeight: number;
};

/** An element's padded box on one side, or null when it has no visible rect. */
function paddedRect(entry: ElementEntry | undefined, padBy: number): Box | null {
  if (!entry?.rect) return null;
  const b = pad(rectToBox(entry.rect), padBy);
  return visible(b) ? b : null;
}

/** Crop box for a content change: the union of where the element sits on each
 *  side (so the pair lines up), or null if it's not visible anywhere. */
function contentBox(mapA: StyleMap, mapB: StyleMap, p: string, padBy: number): Box | null {
  const ba = paddedRect(mapA.elements[p], padBy);
  const bb = paddedRect(mapB.elements[p], padBy);
  if (ba && bb) return union(ba, bb);
  return bb ?? ba;
}

/** before|after crop lines for one content change, or [] when there's no box or
 *  no screenshots. Writes the composite PNG as a side effect. */
function contentCropLines(
  ctx: ContentCtx,
  surface: string,
  c: ContentChange,
  mapA: StyleMap,
  mapB: StyleMap,
  pngA: PNG | null,
  pngB: PNG | null,
  seq: number,
): string[] {
  const box = contentBox(mapA, mapB, c.path, ctx.padBy);
  if (!box || !pngA || !pngB) return [];
  const w = Math.max(ctx.minWidth, box.w);
  const h = Math.min(ctx.maxHeight, Math.max(ctx.minHeight, box.h));
  const composite = compositePair(cropPng(pngA, box, w, h).png, cropPng(pngB, box, w, h).png);
  const stem = `crops/${surface.replace(/[^a-z0-9-]/gi, '-')}-content-${seq}`;
  writePng(path.join(ctx.outDir, `${stem}-composite.png`), composite);
  return [
    '',
    `![before ◀ │ ▶ after](${ctx.img(`${stem}-composite.png`)})`,
    '',
    `<sub>◀ before  ·  after ▶ — ${surface}</sub>`,
  ];
}

/** One surface's content block: heading, then per change the before/after text
 *  and its crop. Returns the markdown plus the advanced crop counter. */
function renderContentSurface(
  ctx: ContentCtx,
  surface: string,
  changes: ContentChange[],
  seq: number,
): { md: string[]; seq: number } {
  const mapA = loadStyleMap(findCapture(ctx.beforeDir, surface));
  const mapB = loadStyleMap(findCapture(ctx.afterDir, surface));
  const pngA = readPng(path.join(ctx.beforeDir, `${surface}.png`));
  const pngB = readPng(path.join(ctx.afterDir, `${surface}.png`));
  const md: string[] = ['', `### \`${surface}\` · ${changes.length} content change(s)`];
  for (const c of changes) {
    seq++;
    md.push(
      '',
      `**\`${prettyLabel(c.path, c.cls)}\`**`,
      '',
      `- before: \`${clipText(c.before) || '(empty)'}\``,
      `- after: \`${clipText(c.after) || '(empty)'}\``,
      ...contentCropLines(ctx, surface, c, mapA, mapB, pngA, pngB, seq),
    );
  }
  return { md, seq };
}

/**
 * The opt-in content layer, rendered as its own ADVISORY section. Reuses the
 * style report's crop/composite machinery so every copy change gets a
 * before/after screenshot — the whole point being to make a silent text change,
 * and any overflow or clipping it triggers, visible in review. Returns the
 * markdown plus a count; the caller keeps both out of the gate (counts/exit live
 * on the computed-style path).
 */
function renderContentSection(ctx: ContentCtx): { md: string[]; count: number } {
  const { surfaces, count } = diffContentDirs(ctx.beforeDir, ctx.afterDir);
  if (!count) return { md: [], count: 0 };
  const md: string[] = [
    '',
    '---',
    '',
    '## 📝 Content changes (advisory)',
    '',
    `_${count} element(s) changed their own text. **Advisory only** — content is not part of the computed-style ` +
      `certification and does not affect the check. Surfaced so a copy change the style diff can't see (and any ` +
      `overflow or clipping it causes) is visible in review._`,
  ];
  let seq = 0;
  for (const { surface, changes } of surfaces) {
    const out = renderContentSurface(ctx, surface, changes, seq);
    md.push(...out.md);
    seq = out.seq;
  }
  return { md, count };
}

// Pre-existing, grandfathered in the health baseline; the content layer is
// rendered by extracted helpers, this only gained a call + headline branch.
// fallow-ignore-next-line complexity
function readLedgerFile(dir: string): CoverageLedger | null {
  const p = path.join(dir, COVERAGE_LEDGER);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CoverageLedger;
  } catch {
    return null;
  }
}

function surfaceKeysIn(dir: string): string[] {
  return [
    ...new Set(
      fs
        .readdirSync(dir)
        .filter(isMapFile)
        .map((f) => f.replace(/@\d+\.json(\.gz)?$/, '')),
    ),
  ];
}

// ── Certification renderers ──────────────────────────────────────────────────────
// Each maps one source-of-truth verdict to its report line. Kept as separate one-
// verdict functions so certificationLines stays a thin orchestrator (and each stays
// well under the complexity gate).

function coverageLine(cov: CoverageVerdict): string {
  if (cov.basis === 'complete')
    return `- **Coverage** — ✓ complete (all ${cov.registrySize} registered surface(s) captured)`;
  if (cov.basis === 'incomplete')
    return `- **Coverage** — ✗ INCOMPLETE (${cov.uncovered.length} registered surface(s) not captured: ${cov.uncovered.join(', ')})`;
  return '- **Coverage** — ⚠ not asserted (no `expected` registry; certifies only the captured surfaces)';
}

function determinismLine(det: DeterminismVerdict): string {
  if (det.status === 'proven') return `- **Determinism** — ✓ proven (base ${det.base}, head ${det.head})`;
  if (det.status === 'unproven')
    return `- **Determinism** — ✗ NOT proven (base ${det.base}, head ${det.head}) — a clean diff could be two nondeterministic reads`;
  return '- **Determinism** — ⚠ unknown (a capture predates the determinism ledger)';
}

function inventoryLine(inv: ReturnType<typeof auditRunInventory>): string {
  if (inv.unexplained.length > 0) {
    const keys = inv.unexplained.map((i) => i.key);
    return `- **Inventory** — ⚠ ${inv.unexplained.length} navigable affordance(s) removed, unacknowledged: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}`;
  }
  if (inv.delta.removed.length > 0)
    return `- **Inventory** — ✓ ${inv.delta.removed.length} removal(s), all acknowledged`;
  return '- **Inventory** — ✓ navigable set unchanged';
}

// Acknowledged removals for the report — lenient: a missing OR malformed ack file
// just means no acknowledgements. (The diff CLI fails loud on malformed instead,
// because in CI an unreadable ack file must not silently un-acknowledge a real loss;
// the report is advisory, so it degrades quietly.)
function readAcknowledgedRemovals(): Record<string, string> {
  try {
    return readAckFile();
  } catch {
    return {};
  }
}

/**
 * The certification block a reviewer reads FIRST — the source-of-truth gates (coverage
 * complete? determinism proven? did the navigable set shrink?), not just the pixel diff.
 * Empty when the bundle carries no certification metadata (an old capture).
 */
function certificationLines(beforeDir: string, afterDir: string): string[] {
  const baseLedger = readLedgerFile(beforeDir);
  const headLedger = readLedgerFile(afterDir);
  const inv = auditRunInventory(readInventories(beforeDir), readInventories(afterDir), readAcknowledgedRemovals());

  const hasLedger = baseLedger !== null || headLedger !== null;
  const hasInvChange = inv.delta.removed.length > 0 || inv.delta.added.length > 0;
  if (!hasLedger && !hasInvChange) return [];

  return [
    '**Certification**',
    coverageLine(auditCoverage(surfaceKeysIn(afterDir), headLedger)),
    determinismLine(auditDeterminism(baseLedger, headLedger)),
    inventoryLine(inv),
    '',
  ];
}

// A prepared surface: its diff plus the findings kept after noise-cleaning.
type PreparedSurface = { sd: SurfaceDiff; findings: Finding[] };
// Surfaces that changed the SAME way, collapsed to one group with a representative.
type ChangeGroup = { surfaces: string[]; rep: PreparedSurface; findings: Finding[] };
// The dirs/dimensions threaded through the per-surface render helpers, so each takes
// one ctx instead of a dozen positional args.
type RenderCtx = {
  beforeDir: string;
  afterDir: string;
  outDir: string;
  img: (rel: string) => string;
  padBy: number;
  minWidth: number;
  minHeight: number;
  maxHeight: number;
  zoomBelow: number;
  foldDetailsAt: number;
};

// Group surfaces that changed in the SAME way (the rects differ per width; the change
// itself does not) so an identical change shows once, not once per surface — keeping
// the widest surface as the representative image.
function groupBySignature(prepared: PreparedSurface[]): ChangeGroup[] {
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
  return [...bySig.values()];
}

// Counts reflect the GROUPED view: each distinct change counts once, not once per
// surface it appears on (after shorthand/dedupe collapsing).
function countShownChanges(changeGroups: ChangeGroup[]): DiffCounts {
  const shown: DiffCounts = { dom: 0, style: 0, state: 0 };
  for (const cg of changeGroups)
    for (const f of cg.findings) {
      if (f.kind === 'dom') shown.dom++;
      else if (f.kind === 'style') shown.style += summarizeProps(f.props).length;
      else shown.state += summarizeProps(f.props).length;
    }
  return shown;
}

// The identical / changed / new-surface summary line(s). Split out (with an early
// return for the all-identical case) so reportHeadline stays flat.
function summaryLines(args: {
  changeGroups: ChangeGroup[];
  missing: PreparedSurface[];
  shown: DiffCounts;
  changedSurfaceCount: number;
  contentCount: number;
}): string[] {
  const { changeGroups, missing, shown, changedSurfaceCount, contentCount } = args;
  if (changeGroups.length === 0 && missing.length === 0) {
    return [
      contentCount > 0
        ? '✓ Computed styles identical: every longhand, pseudo-element, and hover/focus/active state matches. See the advisory content changes below.'
        : '✓ All surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches.',
    ];
  }
  const md: string[] = [];
  if (changeGroups.length > 0) {
    md.push(
      `**${changeCountLabel(shown)}** across ${changeGroups.length} distinct change(s) in ${changedSurfaceCount} surface(s).`,
    );
  }
  if (missing.length > 0) {
    if (changeGroups.length > 0) md.push('');
    md.push(
      `🆕 **${missing.length} new surface(s)** captured with no baseline to compare — shown below for review. ` +
        `Approve them before they become the baseline.`,
    );
  }
  return md;
}

// The headline summary lines between the certification block and the per-surface
// detail: identical-vs-changed, new-surface count, live-region note, advisory-content
// note. Extracted so generateStyleMapReport stays orchestration, not prose.
function reportHeadline(args: {
  changeGroups: ChangeGroup[];
  missing: PreparedSurface[];
  shown: DiffCounts;
  changedSurfaceCount: number;
  volatileCount: number;
  liveCandidateLabels: string[];
  contentCount: number;
}): string[] {
  const { changeGroups, missing, shown, changedSurfaceCount, volatileCount, liveCandidateLabels, contentCount } = args;
  const md: string[] = summaryLines({ changeGroups, missing, shown, changedSurfaceCount, contentCount });
  if (volatileCount > 0) {
    const candidates = liveCandidateLabels.length
      ? ` Auto-detected live-state candidate(s): ${liveCandidateLabels.slice(0, 5).join('; ')}.`
      : '';
    md.push(
      '',
      `_${volatileCount} live region(s) auto-excluded as nondeterministic (a stream, ticker, or late-loading content) — they don't affect the check.${candidates}_`,
    );
  }
  if (contentCount > 0 && (changeGroups.length > 0 || missing.length > 0)) {
    md.push('', `📝 _${contentCount} advisory content change(s) below — they don't affect the check._`);
  }
  return md;
}

// Collapse many crops into one merged frame when a change scatters across more regions
// than maxCrops would show — the union of all their boxes on each side.
function collapseGroups(groups: Group[]): Group[] {
  return [
    groups.reduce((acc, g) => ({
      paths: [...acc.paths, ...g.paths],
      before: visible(acc.before) && visible(g.before) ? union(acc.before, g.before) : (acc.before ?? g.before),
      after: visible(acc.after) && visible(g.after) ? union(acc.after, g.after) : (acc.after ?? g.after),
    })),
  ];
}

// Crop, composite, annotate and (for small changes) zoom the before/after pair for one
// region, writing the PNGs and returning the image markdown + the images sidecar. The
// dense pixel work, isolated from renderRegion's prose.
function buildRegionImages(args: {
  g: Group;
  region: Box;
  regionFindings: Finding[];
  sd: SurfaceDiff;
  mapA: StyleMap;
  mapB: StyleMap;
  pngA: PNG;
  pngB: PNG;
  ctx: RenderCtx;
  cropSeq: number;
}): { md: string[]; images: { composite?: string; annotated?: string; zoom?: string } } {
  const { g, region, regionFindings, sd, mapA, mapB, pngA, pngB, ctx, cropSeq } = args;
  const { img, outDir, minWidth, minHeight, maxHeight, zoomBelow } = ctx;
  // Crop the SAME page rectangle from both sides — the union of where the change sits
  // on each side — so the pair lines up exactly and the reviewer compares like-for-like
  // instead of playing spot-the-difference. (Centring each side on its own moved box
  // would shift the background between them.)
  const cropBox = visible(g.before) && visible(g.after) ? union(g.before, g.after) : region;
  const w = Math.max(minWidth, cropBox.w);
  const h = Math.min(maxHeight, Math.max(minHeight, cropBox.h));
  // Path-safe, report-unique stem: `hero@1280` → `hero-1280-3` so relative image links
  // resolve cleanly and two crops never collide on one filename.
  const stem = `crops/${sd.surface.replace(/[^a-z0-9-]/gi, '-')}-${cropSeq}`;
  const before = cropPng(pngA, cropBox, w, h);
  const after = cropPng(pngB, cropBox, w, h);
  const composite = compositePair(before.png, after.png);
  writePng(path.join(outDir, `${stem}-composite.png`), composite);
  // Annotated twin: outline the LEAF changed elements (the added avatars, the restyled
  // cards) on each side — not the merged container the crop anchors on, whose box would
  // just trace the whole frame. An element present on only one side (added/removed) is
  // boxed only there.
  const markPaths = innermost([...new Set(regionFindings.map((f) => f.path))]);
  const rectsA = markPaths.map((p) => mapA.elements[p]?.rect).filter((r): r is Rect => !!r);
  const rectsB = markPaths.map((p) => mapB.elements[p]?.rect).filter((r): r is Rect => !!r);
  const annotated = compositePair(annotateCrop(before, rectsA), annotateCrop(after, rectsB));
  writePng(path.join(outDir, `${stem}-annotated.png`), annotated);
  const images: { composite?: string; annotated?: string; zoom?: string } = {
    composite: `${stem}-composite.png`,
    annotated: `${stem}-annotated.png`,
  };

  // Name the changed element(s) so the reviewer knows where to look without expanding
  // anything (e.g. `changed: span.caret`).
  const changedNames = [
    ...new Set(
      markPaths
        .map((p) => mapA.elements[p] ?? mapB.elements[p])
        .filter((e): e is ElementEntry => !!e)
        .map((e) => (e.cls ? `${e.tag}.${e.cls.split(/\s+/)[0]}` : e.tag)),
    ),
  ].slice(0, 3);
  const changedLabel = changedNames.length ? ` — changed: \`${changedNames.join('`, `')}\`` : '';
  const ctxLabel = formatSurfaceWithContext(sd.surface, mapA, mapB);

  // A sub-pixel change (e.g. a 2px font bump on a caret) is invisible at 1:1, so when
  // the changed-element footprint is small, add a magnified crop that makes it obvious
  // without the reviewer hunting. Anchored on the leaf rects.
  const changed = unionRects([...rectsA, ...rectsB]);
  const maxDim = changed ? Math.max(changed.w, changed.h) : 0;
  let zoomFactor = 0;
  if (zoomBelow > 0 && changed && maxDim > 0 && maxDim <= zoomBelow) {
    const zBox = pad(changed, Math.max(maxDim, 16)); // ~3× the change for context
    zoomFactor = Math.min(8, Math.max(2, Math.round(240 / Math.max(zBox.w, zBox.h))));
    const zoom = compositePair(zoomCrop(pngA, zBox, rectsA, zoomFactor), zoomCrop(pngB, zBox, rectsB, zoomFactor));
    writePng(path.join(outDir, `${stem}-zoom.png`), zoom);
    images.zoom = `${stem}-zoom.png`;
  }

  // Both views shown by default: the clean before|after (the real UI) and the
  // highlighted twin (magenta boxes on each change) so a reviewer sees WHAT changed and
  // WHERE without expanding anything. Plain images (no link wrap) so a click opens the
  // full-resolution file.
  const md = [
    '',
    `![before ◀ │ ▶ after](${img(images.composite!)})`,
    '',
    `<sub>◀ before  ·  after ▶ — ${ctxLabel}</sub>`,
    '',
    `![highlighted before ◀ │ ▶ after](${img(images.annotated!)})`,
    '',
    `<sub>🔍 magenta boxes mark each change${changedLabel}</sub>`,
  ];
  if (images.zoom) {
    md.push(
      '',
      `![zoomed before ◀ │ ▶ after](${img(images.zoom)})`,
      '',
      `<sub>🔬 magnified ${zoomFactor}× — change too small to see at 1:1${changedLabel}</sub>`,
    );
  }
  return { md, images };
}

// Render one crop region: its heading, the surface list, the before/after imagery (or a
// note when there's nothing to show), and the per-crop change tables.
function renderRegion(args: {
  g: Group;
  cg: ChangeGroup;
  mapA: StyleMap;
  mapB: StyleMap;
  pngA: PNG | null;
  pngB: PNG | null;
  describeCtx: DescribeCtx;
  ctx: RenderCtx;
  cropSeq: number;
}): { md: string[]; regionJson: Record<string, unknown> } {
  const { g, cg, mapA, mapB, pngA, pngB, describeCtx, ctx, cropSeq } = args;
  const { sd } = cg.rep;
  // Exactly the findings whose element lives inside THIS crop, so the tables sit
  // directly under the screenshot that shows them — never a wall of changes spanning
  // several crops with no way to tell which is which.
  const regionFindings = cg.rep.findings.filter((f) =>
    g.paths.some((root) => f.path === root || f.path.startsWith(root + ' > ')),
  );

  const surfaceList =
    cg.surfaces.length > 1
      ? `_Identical across ${cg.surfaces.length} surfaces: ${formatSurfaceListWithContext(cg.surfaces, ctx.beforeDir)}_`
      : `_${formatSurfaceWithContext(sd.surface, mapA, mapB)}_`;

  const md: string[] = ['', `### ${regionHeading(g.paths, regionFindings)}`, '', surfaceList];

  const region = visible(g.after) ? g.after : g.before;
  let images: { composite?: string; annotated?: string; zoom?: string } = {};
  if (region && pngA && pngB) {
    const built = buildRegionImages({ g, region, regionFindings, sd, mapA, mapB, pngA, pngB, ctx, cropSeq });
    md.push(...built.md);
    images = built.images;
  } else if (!region) {
    md.push('', '_Changed element is not visible in this state (zero-size box) — see the property list._');
  } else {
    md.push(
      '',
      '_No screenshots in these capture sets (run captures with `screenshots: true` for side-by-side crops)._',
    );
  }

  // What this crop changed: plain-English bullets, then the property tables — folded
  // under a toggle once they'd be a wall (foldDetailsAt).
  md.push(...renderCropChanges(regionFindings, ctx.foldDetailsAt, describeCtx));
  return { md, regionJson: { paths: g.paths, before: g.before, after: g.after, images } };
}

// Render one change group: load its representative maps/screenshots, split it into
// crop regions (collapsing past maxCrops), and render each region top-to-bottom.
function renderChangeGroup(
  cg: ChangeGroup,
  ctx: RenderCtx,
  maxCrops: number,
  cropSeq: number,
): { md: string[]; json: Record<string, unknown>; findingCount: number; cropSeq: number } {
  const { sd, findings: surfaceFindings } = cg.rep;
  const mapA = loadStyleMap(findCapture(ctx.beforeDir, sd.surface));
  const mapB = loadStyleMap(findCapture(ctx.afterDir, sd.surface));
  // Theme-token reverse-indexes so colour changes can name `red-200` per side.
  const describeCtx: DescribeCtx = { tokensBefore: tokenIndex(mapA.tokens), tokensAfter: tokenIndex(mapB.tokens) };
  const pngA = readPng(path.join(ctx.beforeDir, `${sd.surface}.png`));
  const pngB = readPng(path.join(ctx.afterDir, `${sd.surface}.png`));

  const changedPaths = outermost([...new Set(surfaceFindings.map((f) => f.path))]);
  let groups = groupRegions(changedPaths, mapA, mapB, ctx.padBy);
  if (groups.length > maxCrops) groups = collapseGroups(groups);
  // Read top-to-bottom: one section per crop, in page order.
  const topY = (g: Group) => (visible(g.after) ? g.after.y : visible(g.before) ? g.before.y : Infinity);
  groups.sort((a, b) => topY(a) - topY(b));

  const md: string[] = [];
  const regions: unknown[] = [];
  for (const g of groups) {
    cropSeq++;
    const r = renderRegion({ g, cg, mapA, mapB, pngA, pngB, describeCtx, ctx, cropSeq });
    md.push(...r.md);
    regions.push(r.regionJson);
  }
  const json: Record<string, unknown> = {
    surfaces: cg.surfaces,
    representative: sd.surface,
    regions,
    findings: surfaceFindings,
  };
  return { md, json, findingCount: surfaceFindings.length, cropSeq };
}

// Render a new surface: present on only one side, so there's nothing to diff. Show the
// captured side as a single screenshot and mark the heading for the PR comment.
function renderNewSurface(
  p: PreparedSurface,
  ctx: RenderCtx,
  cropSeq: number,
): { md: string[]; json: Record<string, unknown>; cropSeq: number } {
  const { img, outDir, maxHeight } = ctx;
  const side = p.sd.missing === 'before' ? 'after' : 'before';
  const srcDir = side === 'after' ? ctx.afterDir : ctx.beforeDir;
  const map = loadStyleMap(findCapture(srcDir, p.sd.surface));
  const png = readPng(path.join(srcDir, `${p.sd.surface}.png`));
  const md: string[] = [
    '',
    `### \`${p.sd.surface}\` · new surface ${NEW_SURFACE_MARKER}`,
    '',
    `_${formatSurfaceWithContext(p.sd.surface, map)}_`,
  ];
  const json: Record<string, unknown> = { surface: p.sd.surface, missing: p.sd.missing, isNew: true };
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
      `<sub>${side} · ${formatSurfaceWithContext(p.sd.surface, map)}${png.height > h ? ' (top of page)' : ''}</sub>`,
    );
    json.image = `${stem}.png`;
  } else {
    md.push(
      '',
      `_Captured only in the **${side}** set; no screenshot saved (run captures with \`screenshots: true\`)._`,
    );
  }
  md.push(
    '',
    `_No baseline to compare against — this surface is new. Review and approve it before it becomes part of the baseline._`,
  );
  return { md, json, cropSeq };
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
    zoomBelow = 64,
    // More, smaller crops before collapsing (was 6), so distinct changes get their
    // own focused frame rather than one wide merged one.
    maxCrops = 8,
    foldDetailsAt = 0,
  } = opts;

  const includeNoise = opts.includeLayoutNoise ?? false;
  const includeContent = opts.includeContent ?? false;
  const { surfaces, volatile: volatileCount } = diffStyleMapDirs(beforeDir, afterDir);
  const liveCandidateLabels = volatileCount > 0 ? collectLiveCandidateLabels(beforeDir, afterDir) : [];
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });

  // Focus each surface on styling intent: drop reflow-casualty props, suppress
  // forced-state echoes of base changes, and remove non-value noise (see
  // cleanFindings), unless includeLayoutNoise is set. Surfaces left with no real
  // change are dropped.
  const prepared: PreparedSurface[] = surfaces
    .map((sd) => ({
      sd,
      findings: sd.missing || includeNoise ? sd.findings : cleanFindings(sd.findings),
    }))
    .filter((p) => p.sd.missing || p.findings.length > 0);

  const missing = prepared.filter((p) => p.sd.missing);
  const changeGroups = groupBySignature(prepared);
  const shown = countShownChanges(changeGroups);
  // Surfaces carrying a reviewable change — NOT the new (one-sided) ones, which
  // have no baseline to compare and are summarised on their own line below so the
  // headline never reads "0 changes" while warnings sit beneath it.
  const changedSurfaceCount = changeGroups.reduce((acc, g) => acc + g.surfaces.length, 0);

  const md: string[] = [];
  const json: Array<Record<string, unknown>> = [];
  const img = (rel: string) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, '')}/${rel}` : rel);
  const ctx: RenderCtx = {
    beforeDir,
    afterDir,
    outDir,
    img,
    padBy,
    minWidth,
    minHeight,
    maxHeight,
    zoomBelow,
    foldDetailsAt,
  };

  // Opt-in, advisory: computed here so its count can colour the headline, but its
  // markdown is appended at the very end and it NEVER feeds the gate below.
  const contentSection = includeContent
    ? renderContentSection({ beforeDir, afterDir, outDir, img, padBy, minWidth, minHeight, maxHeight })
    : { md: [], count: 0 };

  md.push('## 🗺️ StyleProof report', '');
  // Lead with the source-of-truth gates (coverage / determinism / inventory) so a
  // reviewer reads "is this green trustworthy?" before the pixel details.
  md.push(...certificationLines(beforeDir, afterDir));
  md.push(
    ...reportHeadline({
      changeGroups,
      missing,
      shown,
      changedSurfaceCount,
      volatileCount,
      liveCandidateLabels,
      contentCount: contentSection.count,
    }),
  );

  let totalFindings = 0;
  let cropSeq = 0;
  for (const cg of changeGroups) {
    const r = renderChangeGroup(cg, ctx, maxCrops, cropSeq);
    md.push(...r.md);
    json.push(r.json);
    totalFindings += r.findingCount;
    cropSeq = r.cropSeq;
  }
  for (const p of missing) {
    const r = renderNewSurface(p, ctx, cropSeq);
    md.push(...r.md);
    json.push(r.json);
    cropSeq = r.cropSeq;
  }

  md.push(...contentSection.md);

  const reportMdPath = path.join(outDir, 'report.md');
  const reportJsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportMdPath, md.join('\n') + '\n');
  fs.writeFileSync(reportJsonPath, JSON.stringify({ counts: shown, surfaces: json }, null, 2));
  return {
    changedSurfaces: prepared.length - missing.length,
    newSurfaces: missing.length,
    totalFindings,
    contentChanges: contentSection.count,
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
