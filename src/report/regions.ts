import type { PNG } from 'pngjs';
import { STATE_LAYER_NAMES, type ElementEntry, type Rect, type StyleMap } from '../capture.js';
import type { DiffCounts, Finding } from '../diff.js';
import { tokenIndex, type DescribeCtx } from '../describe.js';
import { presentationBeforeMap } from '../path-correspondence.js';
import { groupBySignature as groupByWidth, summarizeProps, surfaceWidth } from '../change-groups.js';
import { annotationPaths } from './annotation-paths.js';
import {
  intersects,
  outermost,
  paddedRect,
  union,
  unionVisibleBoxes,
  visible,
  isSameOrDescendant,
  type Box,
} from './geometry.js';
import { cropNote, MISLEADING_CROP_REASON, renderCropPair, type CropImages } from './crop-pair.js';
import { codeValue, oneSidedDomPaths, propertyGlanceLine, regionHeading, renderCropChanges } from './markdown.js';
import {
  formatSurfaceListWithContext,
  formatSurfaceWithContext,
  hasActiveModal,
  hasExposedChangedEntry,
  screenshotPair,
  shortElementName,
  type ChangeGroup,
  type PreparedSurface,
  type RenderCtx,
} from './shared.js';

/** Crop regions for one change group, rendered top-to-bottom with their crops. */

type Group = { paths: string[]; before: Box | null; after: Box | null };

function groupForPath(pathKey: string, a: StyleMap, b: StyleMap, padBy: number): Group {
  return {
    paths: [pathKey],
    before: paddedRect(a.elements[pathKey], padBy),
    after: paddedRect(b.elements[pathKey], padBy),
  };
}

const boxesOverlap = (l: Box | null, r: Box | null): boolean => visible(l) && visible(r) && intersects(l, r);

function mergeInto(left: Group, right: Group): void {
  left.paths.push(...right.paths);
  left.before = unionVisibleBoxes(left.before, right.before);
  left.after = unionVisibleBoxes(left.after, right.after);
}

const groupsOverlap = (l: Group, r: Group): boolean =>
  boxesOverlap(l.after, r.after) || boxesOverlap(l.before, r.before);

/** Merge the first overlapping pair and restart until no pair overlaps on either side. */
function groupRegions(paths: string[], a: StyleMap, b: StyleMap, padBy: number): Group[] {
  const groups = paths.map((p) => groupForPath(p, a, b, padBy));
  for (let l = 0; l < groups.length; l++) {
    const r = groups.findIndex((g, i) => i > l && groupsOverlap(groups[l], g));
    if (r === -1) continue;
    mergeInto(groups[l], groups[r]);
    groups.splice(r, 1);
    l = -1;
  }
  return groups;
}

/** Collapse every group into one merged frame (past maxCrops). */
function collapseGroups(groups: Group[]): Group[] {
  const [first, ...rest] = groups;
  const acc: Group = { paths: [...first.paths], before: first.before, after: first.after };
  for (const g of rest) mergeInto(acc, g);
  return [acc];
}

type RepresentativeScore = { hasExposedChange: boolean; hasActiveModal: boolean; isPopup: boolean; width: number };

/** Prefer proof a reviewer can see: an exposed change, then no modal, then not a popup, then the widest. */
function representativeScore(ctx: RenderCtx, candidate: PreparedSurface): RepresentativeScore {
  const afterMap = ctx.load(ctx.afterDir, candidate.sd.surface);
  const beforeMap = presentationBeforeMap(ctx.load(ctx.beforeDir, candidate.sd.surface), afterMap);
  const changedPaths = [...new Set(candidate.findings.map((f) => f.path))];
  return {
    hasExposedChange: hasExposedChangedEntry(beforeMap, afterMap, changedPaths),
    hasActiveModal: hasActiveModal(beforeMap, afterMap),
    isPopup: beforeMap.metadata?.variantKind === 'popup' || afterMap.metadata?.variantKind === 'popup',
    width: surfaceWidth(candidate.sd.surface),
  };
}

function isBetterRepresentative(candidate: RepresentativeScore, current: RepresentativeScore): boolean {
  if (candidate.hasExposedChange !== current.hasExposedChange) return candidate.hasExposedChange;
  if (candidate.hasActiveModal !== current.hasActiveModal) return !candidate.hasActiveModal;
  if (candidate.isPopup !== current.isPopup) return !candidate.isPopup;
  return candidate.width > current.width;
}

/** Surfaces that changed the SAME way collapse to one group; the representative is the
 *  first surface (in capture order) with the best visible proof. */
export function groupBySignature(ctx: RenderCtx, prepared: PreparedSurface[]): ChangeGroup[] {
  const bySurface = new Map(prepared.map((p) => [p.sd.surface, p]));
  const scores = new Map<string, RepresentativeScore>();
  const score = (p: PreparedSurface): RepresentativeScore => {
    let s = scores.get(p.sd.surface);
    if (!s) scores.set(p.sd.surface, (s = representativeScore(ctx, p)));
    return s;
  };
  return groupByWidth(prepared.map((p) => ({ surface: p.sd.surface, findings: p.findings }))).map((g) => {
    const members = g.surfaces.map((s) => bySurface.get(s)!);
    const rep = members.reduce((best, p) => (isBetterRepresentative(score(p), score(best)) ? p : best));
    return { surfaces: g.surfaces, rep, findings: g.findings };
  });
}

/** Counts for the GROUPED view. Props on one-sided added/removed paths are inventories
 *  already billed under DOM, never "computed-style difference(s)". */
export function countShownChanges(changeGroups: ChangeGroup[]): DiffCounts {
  const shown: DiffCounts = { dom: 0, style: 0, state: 0 };
  for (const cg of changeGroups) {
    const oneSided = oneSidedDomPaths(cg.findings);
    for (const f of cg.findings) {
      if (f.kind === 'dom') shown.dom++;
      else if (!oneSided.has(f.path)) shown[f.kind] += summarizeProps(f.props).length;
    }
  }
  return shown;
}

type Pngs = [PNG | null, PNG | null];
type RegionArgs = {
  ctx: RenderCtx;
  g: Group;
  cg: ChangeGroup;
  mapA: StyleMap;
  mapB: StyleMap;
  describeCtx: DescribeCtx;
  surfaceList: string;
  region: Box | null;
  pngs: Pngs;
  seq: { crop: number };
};

type CropPack = { md: string[]; images: CropImages; visualEvidence?: 'not-rendered'; reason?: string };

/** Crop one region's pair (or explain why there is none). */
function regionCrop(a: RegionArgs, findings: Finding[], [pngA, pngB]: Pngs, state?: string): CropPack {
  const { g, region, mapA, mapB, cg } = a;
  if (!region || !pngA || !pngB || !hasExposedChangedEntry(mapA, mapB, g.paths)) {
    const note = cropNote(region, pngA, pngB);
    return {
      md: note ? ['', note] : [],
      images: {},
      ...(pngA && pngB && region ? { visualEvidence: 'not-rendered' as const, reason: MISLEADING_CROP_REASON } : {}),
    };
  }
  a.seq.crop++;
  // Outline the LEAF changed elements on each side, not the merged anchor container.
  const marked = annotationPaths(findings, mapA, mapB);
  const rectsOf = (paths: string[], map: StyleMap): Rect[] =>
    paths.map((p) => map.elements[p]?.rect).filter((r): r is Rect => !!r);
  const entries = [...marked.before.map((p) => mapA.elements[p]), ...marked.after.map((p) => mapB.elements[p])];
  const changedNames = [...new Set(entries.filter((e): e is ElementEntry => !!e).map(shortElementName))].slice(0, 3);
  const changedLabel = changedNames.length ? ` — changed: ${changedNames.map(codeValue).join(', ')}` : '';
  return renderCropPair(a.ctx, {
    surface: cg.rep.sd.surface,
    suffix: String(a.seq.crop),
    // The SAME page rectangle on both sides, so the reviewer compares like-for-like.
    box: visible(g.before) && visible(g.after) ? union(g.before, g.after) : region,
    pngA,
    pngB,
    rectsA: rectsOf(marked.before, mapA),
    rectsB: rectsOf(marked.after, mapB),
    labels: state ? { left: `base :${state}`, right: `head :${state}` } : undefined,
    captions: {
      pair: state ? `both sides are :${state}` : formatSurfaceWithContext(cg.rep.sd.surface, mapA, mapB),
      annotated: `magenta boxes mark each change${changedLabel}`,
      zoom: (factor) => `magnified ${factor}× — change too small to see at 1:1${changedLabel}`,
    },
  })!;
}

function stateSections(a: RegionArgs, regionFindings: Finding[], firstHeadingUsesAll: boolean) {
  const md: string[] = [];
  const stateImages: Record<string, CropImages> = {};
  for (const state of STATE_LAYER_NAMES) {
    const sf = regionFindings.filter((f) => f.kind === 'state' && f.state === state);
    if (!sf.length) continue;
    const headingFindings = firstHeadingUsesAll && md.length === 0 ? regionFindings : sf;
    md.push('', `### ${regionHeading(a.g.paths, headingFindings)} \`:${state}\``, '', a.surfaceList);
    md.push('', `_Both sides are :${state}. Left is the old :${state}. Right is the new :${state}._`);
    const glance = propertyGlanceLine(sf);
    if (glance) md.push('', glance);
    const layers = screenshotPair(a.ctx, a.cg.rep.sd.surface, `.${state}`);
    if (layers[0] && layers[1]) {
      const packed = regionCrop(a, sf, layers, state);
      md.push(...packed.md);
      if (packed.images.composite) stateImages[state] = packed.images;
    } else {
      md.push('', `_No :${state} screenshot in these capture sets (re-capture to compare both sides in :${state})._`);
    }
    md.push(...renderCropChanges(sf, a.ctx.foldDetailsAt, a.describeCtx));
  }
  return { md, stateImages };
}

/** One crop region: heading, resting crop, then each forced-state crop. */
function renderRegion(a: RegionArgs): { md: string[]; regionJson: Record<string, unknown> } {
  const { g, cg, ctx, describeCtx, surfaceList, region, pngs } = a;
  const regionFindings = cg.rep.findings.filter((f) => g.paths.some((root) => isSameOrDescendant(f.path, root)));
  const rest = regionFindings.filter((f) => f.kind !== 'state');
  const hasDom = regionFindings.some((f) => f.kind === 'dom');
  const stateOnly = !hasDom && rest.length === 0 && regionFindings.some((f) => f.kind === 'state');
  const md: string[] = [];
  const cropFindings = hasDom ? regionFindings : rest;
  let resting: CropPack = { md: [], images: {} };
  if (!stateOnly && cropFindings.length) {
    md.push('', `### ${regionHeading(g.paths, cropFindings)}`, '', surfaceList);
    const glance = propertyGlanceLine(cropFindings);
    if (glance) md.push('', glance);
    resting = regionCrop(a, cropFindings, pngs);
    md.push(...resting.md, ...renderCropChanges(cropFindings, ctx.foldDetailsAt, describeCtx));
  }
  const states = hasDom ? { md: [], stateImages: {} } : stateSections(a, regionFindings, stateOnly);
  md.push(...states.md);
  const images = stateOnly && !resting.images.composite ? (Object.values(states.stateImages)[0] ?? {}) : resting.images;
  if (!md.length) {
    md.push('', `### ${regionHeading(g.paths, regionFindings)}`, '', surfaceList);
    const note = cropNote(region, ...pngs);
    if (note) md.push('', note);
    md.push(...renderCropChanges(regionFindings, ctx.foldDetailsAt, describeCtx));
  }
  const { visualEvidence, reason } = resting;
  return {
    md,
    regionJson: {
      paths: g.paths,
      before: g.before,
      after: g.after,
      images,
      ...(Object.keys(states.stateImages).length ? { stateImages: states.stateImages } : {}),
      ...(visualEvidence ? { visualEvidence, reason } : {}),
    },
  };
}

export type RenderedGroup = { md: string[]; json: Record<string, unknown>; findingCount: number };

/** One change group: its representative's crop regions (collapsed past maxCrops), top-to-bottom. */
export function renderChangeGroup(ctx: RenderCtx, cg: ChangeGroup, seq: { crop: number }): RenderedGroup {
  const { sd, findings } = cg.rep;
  const mapB = ctx.load(ctx.afterDir, sd.surface);
  // Same correspondence rewrite as prepareReportSurfaces, so crops resolve corresponded head paths.
  const mapA = presentationBeforeMap(ctx.load(ctx.beforeDir, sd.surface), mapB);
  const describeCtx: DescribeCtx = { tokensBefore: tokenIndex(mapA.tokens), tokensAfter: tokenIndex(mapB.tokens) };
  const json = { surfaces: cg.surfaces, representative: sd.surface, regions: [] as unknown[], findings };
  const changedPaths = outermost([...new Set(findings.map((f) => f.path))]);
  const findingCount = findings.length;
  if (!hasExposedChangedEntry(mapA, mapB, changedPaths)) {
    const reason = MISLEADING_CROP_REASON;
    return {
      md: ['', `_${reason}_`, '', ...renderCropChanges(findings, ctx.foldDetailsAt, describeCtx)],
      json: { ...json, visualEvidence: 'not-rendered', reason, classification: sd.classification },
      findingCount,
    };
  }
  const pngs = screenshotPair(ctx, sd.surface);
  let groups = groupRegions(changedPaths, mapA, mapB, ctx.padBy);
  if (groups.length > ctx.maxCrops) groups = collapseGroups(groups);
  const topY = (g: Group) => (visible(g.after) ? g.after.y : visible(g.before) ? g.before.y : Infinity);
  groups.sort((l, r) => topY(l) - topY(r));
  const surfaceList =
    cg.surfaces.length > 1
      ? `_Identical across ${cg.surfaces.length} surfaces: ${formatSurfaceListWithContext(ctx, cg.surfaces)}_`
      : `_${formatSurfaceWithContext(sd.surface, mapA, mapB)}_`;
  const rendered = groups.map((g) => {
    const region = visible(g.after) ? g.after : g.before;
    return renderRegion({ ctx, g, cg, mapA, mapB, describeCtx, surfaceList, region, pngs, seq });
  });
  const regions = rendered.map((r) => r.regionJson);
  return {
    md: rendered.flatMap((r) => r.md),
    json: { ...json, regions, classification: sd.classification },
    findingCount,
  };
}
