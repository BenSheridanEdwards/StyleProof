import { sectionLine } from './change-line.js';
import type { PNG } from 'pngjs';
import { STATE_LAYER_NAMES, type ElementEntry, type Rect, type StyleMap } from '../capture.js';
import type { DiffCounts, Finding } from '../diff.js';
import { tokenIndex, type DescribeCtx } from '../describe.js';
import { presentationBeforeMap } from '../path-correspondence.js';
import { groupBySignature as groupByWidth, summarizeProps, surfaceWidth } from '../change-groups.js';
import { buildChangeSections } from './change-sections.js';
import { annotationPaths } from './annotation-paths.js';
import { claimSpacing, siblingSpacingChanges, spacingLines, type SiblingSpacingChange } from './sibling-spacing.js';
import {
  containerOf,
  intersects,
  outermost,
  paddedRect,
  screenshotRectOf,
  union,
  unionVisibleBoxes,
  visible,
  isSameOrDescendant,
  type Box,
} from './geometry.js';
import { cropWindow, cropNote, MISLEADING_CROP_REASON, renderCropPair, type CropImages } from './crop-pair.js';
import { codeValue } from '../code-span.js';
import { cropChangeParts, oneSidedDomPaths, regionHeading, type CropChanges } from './markdown.js';
import {
  formatSurfaceListWithContext,
  formatSurfaceWithContext,
  hasActiveModal,
  hasExposedChangedEntry,
  presentationMaps,
  screenshotPair,
  shortElementName,
  type ChangeGroup,
  type PreparedSurface,
  type RenderCtx,
} from './shared.js';

/** Crop regions for one change group, rendered top-to-bottom with their crops. */

type Group = { title?: string; findings?: Finding[]; paths: string[]; before: Box | null; after: Box | null };

function groupForPath(pathKey: string, a: StyleMap, b: StyleMap, padBy: number): Group {
  return {
    paths: [pathKey],
    before: paddedRect(a.elements[pathKey], padBy),
    after: paddedRect(b.elements[pathKey], padBy),
  };
}

/** The crop box for one element: its padded box on both sides, so size changes read directly. */
function elementBox(ctx: RenderCtx, maps: [StyleMap, StyleMap], p: string): Box | null {
  const a = paddedRect(maps[0].elements[p], ctx.padBy);
  const b = paddedRect(maps[1].elements[p], ctx.padBy);
  return visible(a) && visible(b) ? union(a, b) : visible(b) ? b : visible(a) ? a : null;
}

/** A crop frame larger than this is not "the element's card": keep the element's own frame. */
const MAX_FRAME = { w: 640, h: 480 };

/**
 * The crop frame for a changed element. When the element alone is smaller than the crop
 * window, the window would cut through whatever surrounds it, so frame the largest
 * enclosing box (a card or component) that still fits a crop; otherwise the element.
 */
function frameBox(ctx: RenderCtx, maps: [StyleMap, StyleMap], p: string): Box | null {
  const own = elementBox(ctx, maps, p);
  if (!own || (own.w >= ctx.minWidth && own.h >= ctx.minHeight)) return own;
  let frame = own;
  for (let ancestor = containerOf(p); ancestor; ancestor = containerOf(ancestor)) {
    const box = elementBox(ctx, maps, ancestor);
    if (!box) continue;
    // An ancestor painted elsewhere (the element sits in an inner scroller) cannot frame it.
    if (
      !encloses(box, own) ||
      box.w > Math.max(MAX_FRAME.w, ctx.minWidth) ||
      box.h > Math.max(MAX_FRAME.h, ctx.minHeight)
    ) {
      break;
    }
    frame = box;
  }
  return frame;
}

function encloses(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

const boxesOverlap = (l: Box | null, r: Box | null): boolean => visible(l) && visible(r) && intersects(l, r);

function mergeInto(left: Group, right: Group): void {
  right.paths.forEach((appended) => left.paths.push(appended));
  if (right.findings) left.findings = [...(left.findings ?? []), ...right.findings];
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
  const acc: Group = { ...first, title: undefined, paths: [...first.paths], before: first.before, after: first.after };
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

  const signatures = prepared.map((p) => ({ surface: p.sd.surface, findings: p.findings, folded: p.folded }));

  return groupByWidth(signatures).map((g) => {
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
const flat = (changes: CropChanges): string[] => [...changes.summary, ...changes.details];
type RegionArgs = {
  ctx: RenderCtx;
  g: Group;
  groups: Group[];
  cg: ChangeGroup;
  mapA: StyleMap;
  mapB: StyleMap;
  describeCtx: DescribeCtx;
  surfaceList: string;
  region: Box | null;
  pngs: Pngs;
  seq: { crop: number };
  /** Sibling spacing changes whose run this region shows (#755). */
  spacing: SiblingSpacingChange[];
  changes: (findings: Finding[]) => CropChanges;
};

type CropPack = {
  md: string[];
  images: CropImages;
  size?: import('./crop-pair.js').PairSize;
  omitted?: boolean;
  visualEvidence?: 'not-rendered';
  reason?: string;
};

/** Crop one region's pair (or explain why there is none). */
function regionCrop(a: RegionArgs, findings: Finding[], [pngA, pngB]: Pngs, state?: string): CropPack {
  const { g, region, mapA, mapB, cg } = a;
  if (!region || !pngA || !pngB || !hasExposedChangedEntry(mapA, mapB, g.paths, [pngA, pngB])) {
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
    paths.map((p) => screenshotRectOf(map.elements[p])).filter((r): r is Rect => !!r);
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
    alsoInView: a.ctx.layout === 'visual-first' ? foreignChangeCaption(a, pngA, pngB) : undefined,
    captions: {
      annotated: `magenta boxes mark each change${changedLabel}`,
      zoom: (factor) => `magnified ${factor}× — change too small to see at 1:1${changedLabel}`,
    },
  })!;
}

/** Name other sections whose changed pixels share this crop window. */
function foreignChangeCaption(a: RegionArgs, pngA: PNG, pngB: PNG): string | undefined {
  const box = visible(a.g.before) && visible(a.g.after) ? union(a.g.before, a.g.after) : a.region;
  if (!box) return undefined;
  const { aligned } = cropWindow(a.ctx, box, pngA, pngB);
  const names = a.groups
    .filter((other) => other !== a.g)
    .flatMap((other) =>
      (other.findings ?? []).flatMap((finding) => {
        const changed = elementBox(a.ctx, [a.mapA, a.mapB], finding.path);
        const entry = a.mapB.elements[finding.path] ?? a.mapA.elements[finding.path];
        if (!changed || !entry || !intersects(aligned, changed)) return [];
        return [`${codeValue(shortElementName(entry))} (${other.title ?? 'another section'})`];
      }),
    );
  return names.length ? `Also in view: ${names.join(', ')}` : undefined;
}

function stateSections(a: RegionArgs, regionFindings: Finding[], firstHeadingUsesAll: boolean) {
  const md: string[] = [];
  const stateImages: Record<string, CropImages> = {};
  for (const state of STATE_LAYER_NAMES) {
    const sf = regionFindings.filter((f) => f.kind === 'state' && f.state === state);
    if (!sf.length) continue;
    const headingFindings = firstHeadingUsesAll && md.length === 0 ? regionFindings : sf;
    const heading = headingFindings.filter((f) => a.cg.rep.findings.includes(f));
    md.push('', `### ${a.g.title ?? regionHeading(a.g.paths, heading)} \`:${state}\``, '', a.surfaceList);
    const changes = a.changes(sf);
    changes.summary.forEach((appended) => md.push(appended));
    const layers = screenshotPair(a.ctx, a.cg.rep.sd.surface, `.${state}`);
    if (layers[0] && layers[1]) {
      const packed = regionCrop(a, sf, layers, state);
      packed.md.forEach((appended) => md.push(appended));
      if (packed.images.composite ?? packed.images.before) stateImages[state] = packed.images;
    } else {
      md.push('', `_No :${state} screenshot in these capture sets (re-capture to compare both sides in :${state})._`);
    }

    changes.details.forEach((appended) => md.push(appended));
  }
  return { md, stateImages };
}

const spacingJson = (spacing: SiblingSpacingChange[]) => (spacing.length ? { spacing } : {});

type RestingSection = { md: string[]; pack: CropPack; trailing: string[] };

/**
 * The resting section: heading, plain-English summary, spacing lines, crop, then the
 * folded property tables. A region without one still names its spacing, once, at its end (`trailing`).
 */
function restingSection(a: RegionArgs, cropFindings: Finding[], shown: boolean): RestingSection {
  if (!shown) return { md: [], pack: { md: [], images: {} }, trailing: spacingLines(a.spacing) };
  const heading = cropFindings.filter((f) => a.cg.rep.findings.includes(f));
  const md = ['', `### ${a.g.title ?? regionHeading(a.g.paths, heading)}`, '', a.surfaceList];
  if (a.g.title) {
    for (const section of buildChangeSections(a.g.findings ?? cropFindings, [a.mapA, a.mapB])) {
      const line = sectionLine(section, [a.mapA, a.mapB]);
      if (line) md.push('', line);
    }
  }
  const changes = a.changes(cropFindings);
  changes.summary.forEach((appended) => md.push(appended));
  spacingLines(a.spacing).forEach((appended) => md.push(appended));
  const pack = regionCrop(a, cropFindings, a.pngs);
  pack.md.forEach((appended) => md.push(appended));
  changes.details.forEach((appended) => md.push(appended));
  return { md, pack, trailing: [] };
}

function regionVisibility(cg: ChangeGroup, regionFindings: Finding[]) {
  const shown = new Set(cg.rep.findings);
  const rest = regionFindings.filter((f) => f.kind !== 'state');
  const shownRest = rest.filter((f) => shown.has(f));
  const hasDom = regionFindings.some((f) => f.kind === 'dom');
  const stateOnly = !hasDom && shownRest.length === 0 && regionFindings.some((f) => f.kind === 'state');

  return { rest, shownRest, hasDom, stateOnly };
}

function regionImages(stateOnly: boolean, resting: CropImages, states: Record<string, CropImages>): CropImages {
  return stateOnly && !(resting.composite ?? resting.before) ? (Object.values(states)[0] ?? {}) : resting;
}

/** One crop region: heading, resting crop, then each forced-state crop. */
function renderRegion(a: RegionArgs) {
  const { g, cg, surfaceList, region, pngs } = a;

  const regionFindings = g.findings
    ? [
        ...g.findings,
        ...(cg.rep.folded ?? []).filter((f) =>
          g.paths.some(
            (root) =>
              isSameOrDescendant(f.path, root) &&
              !a.groups.some((other) =>
                other.paths.some(
                  (candidate) =>
                    candidate !== root && isSameOrDescendant(candidate, root) && isSameOrDescendant(f.path, candidate),
                ),
              ),
          ),
        ),
      ]
    : [...cg.rep.findings, ...(cg.rep.folded ?? [])].filter((f) =>
        g.paths.some((root) => isSameOrDescendant(f.path, root)),
      );

  const { rest, shownRest, hasDom, stateOnly } = regionVisibility(cg, regionFindings);
  const md: string[] = [];
  const cropFindings = hasDom ? regionFindings : rest;
  const section = restingSection(a, cropFindings, !stateOnly && shownRest.length > 0);
  const resting = section.pack;
  section.md.forEach((appended) => md.push(appended));
  const states = hasDom ? { md: [], stateImages: {} } : stateSections(a, regionFindings, stateOnly);
  states.md.forEach((appended) => md.push(appended));

  if (stateOnly && rest.length) {
    flat(a.changes(rest)).forEach((appended) => md.push(appended));
  }
  const images = regionImages(stateOnly, resting.images, states.stateImages);
  if (!md.length) {
    md.push('', `### ${regionHeading(g.paths, regionFindings)}`, '', surfaceList);
    const note = cropNote(region, ...pngs);
    if (note) md.push('', note);
    flat(a.changes(regionFindings)).forEach((appended) => md.push(appended));
  }
  section.trailing.forEach((appended) => md.push(appended));
  const { visualEvidence, reason } = resting;

  const rendered = {
    md,
    regionJson: {
      paths: g.paths,
      before: g.before,
      after: g.after,
      images,
      ...(resting.size ? { size: resting.size } : {}),
      ...(Object.keys(states.stateImages).length ? { stateImages: states.stateImages } : {}),
      ...(visualEvidence ? { visualEvidence, reason } : {}),
      ...spacingJson(a.spacing),
    },
  };

  if (resting.omitted) Object.assign(rendered.regionJson, { cropOmitted: 'budget' });

  return rendered;
}

export type RenderedGroup = { md: string[]; json: Record<string, unknown>; findingCount: number };

/** One change group: its representative's crop regions (collapsed past maxCrops), top-to-bottom. */
export function renderChangeGroup(ctx: RenderCtx, cg: ChangeGroup, seq: { crop: number }): RenderedGroup {
  const { sd, findings } = cg.rep;
  // Same correspondence rewrite as prepareReportSurfaces, so crops resolve corresponded head paths.
  const [mapA, mapB] = presentationMaps(ctx, sd.surface);
  const describeCtx: DescribeCtx = { tokensBefore: tokenIndex(mapA.tokens), tokensAfter: tokenIndex(mapB.tokens) };
  const folded = cg.rep.folded ?? [];

  const shownSet = new Set(findings);
  const foldedSet = new Set(folded);

  const changes = (shown: Finding[]): CropChanges =>
    cropChangeParts(
      shown.filter((f) => shownSet.has(f)),
      ctx.foldDetailsAt,
      describeCtx,
      shown.filter((f) => foldedSet.has(f)),
    );
  const json = { surfaces: cg.surfaces, representative: sd.surface, regions: [] as unknown[], findings };
  const changedPaths = outermost([...new Set(findings.map((f) => f.path))]);
  const findingCount = findings.length;
  // The raw base: a geometry correspondence can move part of a run and split it.
  const spacing = siblingSpacingChanges(ctx.load(ctx.beforeDir, sd.surface), mapB);
  const surfaceList =
    cg.surfaces.length > 1
      ? `_Identical across ${cg.surfaces.length} surfaces: ${formatSurfaceListWithContext(ctx, cg.surfaces)}_`
      : `_${formatSurfaceWithContext(sd.surface, mapA, mapB)}_`;
  const pngs = screenshotPair(ctx, sd.surface);

  if (!findings.length && folded.length) {
    const label = regionHeading([...new Set(folded.map((f) => f.path))], folded, true);
    const md = ['', `### ${label}`, '', surfaceList, ...flat(changes(folded))];

    return { md, json, findingCount };
  }
  if (
    !hasExposedChangedEntry(mapA, mapB, changedPaths, pngs) &&
    !STATE_LAYER_NAMES.some((state) => {
      const statePaths = findings.filter((f) => f.kind === 'state' && f.state === state).map((f) => f.path);
      return (
        statePaths.length > 0 &&
        hasExposedChangedEntry(mapA, mapB, statePaths, screenshotPair(ctx, sd.surface, `.${state}`))
      );
    })
  ) {
    const reason = MISLEADING_CROP_REASON;
    return {
      md: [
        // The heading also ends the Action's PR comment summary (#952).
        '',
        `### ${regionHeading(changedPaths, findings)}`,
        '',
        surfaceList,
        '',
        `_${reason}_`,
        ...spacingLines(spacing),
        '',
        ...flat(changes([...findings, ...folded])),
      ],
      json: {
        ...json,
        visualEvidence: 'not-rendered',
        reason,
        ...spacingJson(spacing),
        classification: sd.classification,
      },
      findingCount,
    };
  }
  let groups =
    ctx.layout === 'visual-first'
      ? buildChangeSections(findings, [mapA, mapB]).map((section) => ({
          ...collapseGroups(
            section.paths.map((p) => ({
              paths: [p],
              before: frameBox(ctx, [mapA, mapA], p),
              after: frameBox(ctx, [mapB, mapB], p),
            })),
          )[0],
          findings: section.findings,
          title: section.title,
        }))
      : groupRegions(changedPaths, mapA, mapB, ctx.padBy);
  if (groups.length > ctx.maxCrops) groups = collapseGroups(groups);
  const topY = (g: Group) => (visible(g.after) ? g.after.y : visible(g.before) ? g.before.y : Infinity);
  groups.sort((l, r) => topY(l) - topY(r));
  const claimed = new Set<SiblingSpacingChange>();
  const rendered = groups.map((g) => {
    const region = visible(g.after) ? g.after : g.before;
    const own = claimSpacing(spacing, g.paths, claimed);

    return renderRegion({
      ctx,
      g,
      groups,
      cg,
      mapA,
      mapB,
      describeCtx,
      surfaceList,
      region,
      pngs,
      seq,
      spacing: own,
      changes,
    });
  });
  const regions = rendered.map((r) => r.regionJson);
  // Keep reflow ancestors in one capped table outside the crop budget.
  const outside = folded.filter((f) => !groups.some((g) => g.paths.some((root) => isSameOrDescendant(f.path, root))));

  const outsideMd = outside.length
    ? ['', '### Folded size/position rows outside the crops', '', surfaceList, ...flat(changes(outside))]
    : [];

  // A changed run no crop region shows is still named, once, under the group.
  const unclaimed = spacing.filter((change) => !claimed.has(change));
  return {
    md: [...rendered.flatMap((r) => r.md), ...outsideMd, ...spacingLines(unclaimed)],
    json: { ...json, regions, ...spacingJson(unclaimed), classification: sd.classification },
    findingCount,
  };
}
