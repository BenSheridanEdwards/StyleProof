import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { loadStyleMap, type Rect, type StyleMap } from './capture.js';
import { diffStyleMapDirs, findingLabel, type Finding, type SurfaceDiff } from './diff.js';

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

function formatProps(f: Finding): string[] {
  if (f.kind === 'dom') return [`DOM ${f.change}${f.detail ? `: ${f.detail}` : ''}`];
  const prefix = f.kind === 'state' ? `[:${f.state}] ` : (f.pseudo ?? '');
  return f.props.map((p) => `${prefix}\`${p.prop}: ${p.before} → ${p.after}\``);
}

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

  const { surfaces, counts } = diffStyleMapDirs(beforeDir, afterDir);
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });

  const md: string[] = [];
  const json: Array<Record<string, unknown>> = [];
  const img = (rel: string) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, '')}/${rel}` : rel);

  md.push('## 🗺️ stylemap report');
  md.push('');
  if (surfaces.length === 0) {
    md.push('✓ All surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches.');
  } else {
    md.push(
      `**${counts.dom} DOM change(s) · ${counts.style} computed-style difference(s) · ${counts.state} state-delta difference(s)** across ${surfaces.length} changed surface(s).`,
    );
  }

  let totalFindings = 0;
  for (const sd of surfaces) {
    md.push('', `### \`${sd.surface}\``);
    if (sd.missing) {
      md.push('', `⚠️ captured only in the **${sd.missing === 'before' ? 'after' : 'before'}** set — re-run both captures.`);
      json.push({ surface: sd.surface, missing: sd.missing });
      continue;
    }
    totalFindings += sd.findings.length;

    const mapA = loadStyleMap(findCapture(beforeDir, sd.surface));
    const mapB = loadStyleMap(findCapture(afterDir, sd.surface));
    const pngA = readPng(path.join(beforeDir, `${sd.surface}.png`));
    const pngB = readPng(path.join(afterDir, `${sd.surface}.png`));

    const changedPaths = outermost([...new Set(sd.findings.map((f) => f.path))]);
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
      const findings = sd.findings.filter((f) => g.paths.some((p) => f.path === p || f.path.startsWith(p + ' > ')));
      const lines = findings.flatMap((f) => [
        `- ${findingLabel(f.path, f.cls)}${f.kind === 'style' && f.pseudo ? f.pseudo : ''}`,
        ...formatProps(f).map((s) => `  - ${s}`),
      ]);

      const region = visible(g.after) ? g.after : g.before;
      let images: { before?: string; after?: string; composite?: string } = {};
      if (region && pngA && pngB) {
        // Same crop dimensions on both sides so the pair reads as a pair.
        const w = Math.max(minWidth, visible(g.before) ? g.before.w : 0, visible(g.after) ? g.after.w : 0);
        const h = Math.min(maxHeight, Math.max(minHeight, visible(g.before) ? g.before.h : 0, visible(g.after) ? g.after.h : 0));
        const stem = `crops/${sd.surface.replace(/[^a-z0-9@-]/gi, '_')}-${n}`;
        const before = cropPng(pngA, visible(g.before) ? g.before : region, w, h);
        const after = cropPng(pngB, visible(g.after) ? g.after : region, w, h);
        const composite = compositePair(before, after);
        fs.writeFileSync(path.join(outDir, `${stem}-before.png`), PNG.sync.write(before));
        fs.writeFileSync(path.join(outDir, `${stem}-after.png`), PNG.sync.write(after));
        fs.writeFileSync(path.join(outDir, `${stem}-composite.png`), PNG.sync.write(composite));
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

      md.push('', ...lines.slice(0, 40));
      if (lines.length > 40) md.push(`  - …and ${lines.length - 40} more (see report.json)`);
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
  fs.writeFileSync(reportJsonPath, JSON.stringify({ counts, surfaces: json }, null, 2));
  return { changedSurfaces: surfaces.length, totalFindings, reportMdPath, reportJsonPath };
}

function findCapture(dir: string, surface: string): string {
  for (const ext of ['.json.gz', '.json']) {
    const p = path.join(dir, surface + ext);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no capture for ${surface} in ${dir}`);
}
