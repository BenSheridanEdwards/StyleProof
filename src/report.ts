import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { loadStyleMap, type Rect, type StyleMap } from './capture.js';
import { diffStyleMapDirs, type DiffCounts, type Finding, type PropChange, type SurfaceDiff } from './diff.js';

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
   * Include size/position-derived longhands (height, width, transform-origin…)
   * in the report. Off by default: on a reflow they change up the whole ancestor
   * chain and would anchor crops to the entire page. The certification differ
   * (`stylemap-diff`) always keeps them.
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
  t === r && r === b && b === l ? t : t === b && r === l ? `${t} ${r}` : r === l ? `${t} ${r} ${b}` : `${t} ${r} ${b} ${l}`;

const PROP_ORDER = [
  'display', 'position', 'grid-template-columns', 'grid-template-rows', 'flex-direction', 'justify-content',
  'align-items', 'gap', 'margin', 'padding', 'border-width', 'border-style', 'border-color', 'border-radius',
  'outline', 'background-color', 'background-image', 'color', 'box-shadow', 'opacity', 'transform',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align',
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

function summarizeProps(props: PropChange[]): PropChange[] {
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
  return [...map.values()]
    .map((p) => ({ prop: p.prop, before: cleanVal(p.before), after: cleanVal(p.after) }))
    .sort((a, b) => orderIdx(a.prop) - orderIdx(b.prop) || a.prop.localeCompare(b.prop));
}

/** `div.who-grid`, `a.nav-cta`, `h3` — the semantic marker class, else the tag. */
function prettyLabel(p: string, cls: string): string {
  const tag = (p.split('>').pop() ?? '').trim().replace(/:nth-child\(\d+\)/, '') || 'el';
  const first = cls.split(/\s+/)[0] ?? '';
  return /^[a-z][a-z0-9-]*$/.test(first) ? `${tag}.${first}` : tag;
}

// Group findings (identical siblings collapse to one ×N block) and render each
// as a 3-column table; colours land in their own cell so GitHub adds swatches.
function renderFindings(findings: Finding[], maxRows = 60): string[] {
  type Group = { label: string; note: string; rows: PropChange[]; count: number };
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const f of findings) {
    const label = prettyLabel(f.path, f.cls);
    const note = f.kind === 'state' ? `:${f.state}` : f.kind === 'style' ? (f.pseudo ?? '') : '';
    const rows = f.kind === 'dom' ? [] : summarizeProps(f.props);
    const headOnly = f.kind === 'dom' ? `DOM ${f.change}${f.detail ? ` ${f.detail}` : ''}` : '';
    if (f.kind !== 'dom' && rows.length === 0) continue;
    const key = `${label}|${note}|${headOnly}|${JSON.stringify(rows)}`;
    const g = byKey.get(key);
    if (g) g.count++;
    else {
      const ng: Group = { label, note: headOnly || note, rows, count: 1 };
      byKey.set(key, ng);
      groups.push(ng);
    }
  }
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < groups.length; i++) {
    if (used >= maxRows) {
      out.push('', `_…and ${groups.length - i} more element(s) — see report.json._`);
      break;
    }
    const g = groups[i];
    const head = `**\`${g.label}\`**${g.count > 1 ? ` ×${g.count}` : ''}${g.note ? `  ${g.note}` : ''}`;
    if (!g.rows.length) {
      out.push('', head);
      used += 1;
      continue;
    }
    out.push(
      '',
      head,
      '',
      '| Property | Before | After |',
      '| --- | --- | --- |',
      ...g.rows.map((r) => `| \`${r.prop}\` | \`${r.before}\` | \`${r.after}\` |`),
    );
    used += 2 + g.rows.length;
  }
  return out;
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
const hasRealChange = (f: Finding): boolean =>
  f.kind === 'dom' || f.props.some((p) => !DERIVED_PROPS.has(p.prop));
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

  // Count what the report actually shows (after shorthand/dedupe collapsing),
  // not the raw longhand explosion.
  const shown: DiffCounts = { dom: 0, style: 0, state: 0 };
  for (const { findings } of prepared)
    for (const f of findings) {
      if (f.kind === 'dom') shown.dom++;
      else if (f.kind === 'style') shown.style += summarizeProps(f.props).length;
      else shown.state += summarizeProps(f.props).length;
    }

  const md: string[] = [];
  const json: Array<Record<string, unknown>> = [];
  const img = (rel: string) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, '')}/${rel}` : rel);

  md.push('## 🗺️ stylemap report');
  md.push('');
  if (prepared.length === 0) {
    md.push('✓ All surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches.');
  } else {
    md.push(
      `**${shown.dom} DOM change(s) · ${shown.style} computed-style difference(s) · ${shown.state} state-delta difference(s)** across ${prepared.length} changed surface(s).`,
    );
  }

  let totalFindings = 0;
  for (const { sd, findings: surfaceFindings } of prepared) {
    md.push('', `### \`${sd.surface}\``);
    if (sd.missing) {
      md.push('', `⚠️ captured only in the **${sd.missing === 'before' ? 'after' : 'before'}** set — re-run both captures.`);
      json.push({ surface: sd.surface, missing: sd.missing });
      continue;
    }
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

    const surfaceJson: Record<string, unknown> = { surface: sd.surface, regions: [] as unknown[] };
    let n = 0;
    for (const g of groups) {
      n++;
      const findings = surfaceFindings.filter((f) => g.paths.some((p) => f.path === p || f.path.startsWith(p + ' > ')));
      const lines = renderFindings(findings);

      const region = visible(g.after) ? g.after : g.before;
      let images: { before?: string; after?: string; composite?: string } = {};
      if (region && pngA && pngB) {
        // Same crop dimensions on both sides so the pair reads as a pair.
        const w = Math.max(minWidth, visible(g.before) ? g.before.w : 0, visible(g.after) ? g.after.w : 0);
        const h = Math.min(maxHeight, Math.max(minHeight, visible(g.before) ? g.before.h : 0, visible(g.after) ? g.after.h : 0));
        // Path-safe stem: a surface key like `hero@1280` becomes `hero-1280`
        // so relative image links resolve cleanly in any markdown host.
        const stem = `crops/${sd.surface.replace(/[^a-z0-9-]/gi, '-')}-${n}`;
        const before = cropPng(pngA, visible(g.before) ? g.before : region, w, h);
        const after = cropPng(pngB, visible(g.after) ? g.after : region, w, h);
        const composite = compositePair(before, after);
        writePng(path.join(outDir, `${stem}-before.png`), before);
        writePng(path.join(outDir, `${stem}-after.png`), after);
        writePng(path.join(outDir, `${stem}-composite.png`), composite);
        images = { before: `${stem}-before.png`, after: `${stem}-after.png`, composite: `${stem}-composite.png` };
        // One side-by-side image per change: clean inline render, single upload.
        md.push(
          '',
          `![before ◀ │ ▶ after](${img(images.composite!)})`,
          '',
          '<sub>◀ before  ·  after ▶</sub>',
        );
      } else if (!region) {
        md.push('', '_Changed element is not visible in this state (zero-size box) — see the property list._');
      } else {
        md.push('', '_No screenshots in these capture sets (run captures with `screenshots: true` for side-by-side crops)._');
      }

      md.push(...lines);
      (surfaceJson.regions as unknown[]).push({
        paths: g.paths,
        before: g.before,
        after: g.after,
        images,
        findings,
      });
    }
    json.push(surfaceJson);
  }

  if (surfaces.length) {
    md.push(
      '',
      '---',
      '_To accept these changes, regenerate the committed baseline from this build and commit it with your diff._',
    );
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
