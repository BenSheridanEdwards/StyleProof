import type { PNG } from 'pngjs';
import { STATE_LAYER_NAMES, type ElementEntry, type Rect, type StyleMap } from '../capture.js';
import type { DiffCounts, Finding } from '../diff.js';
import { exactSignatureOf, groupByElementChange } from '../findings-clean.js';
import { tokenIndex, type DescribeCtx } from '../describe.js';
import { presentationBeforeMap } from '../path-correspondence.js';
import { groupBySignature as groupByWidth, summarizeProps, surfaceWidth } from '../change-groups.js';
import { annotationPaths } from './annotation-paths.js';
import { claimSpacing, siblingSpacingChanges, spacingLines, type SiblingSpacingChange } from './sibling-spacing.js';
import {
  intersects,
  outermost,
  paddedRect,
  screenshotRectOf,
  unionVisibleBoxes,
  visible,
  isSameOrDescendant,
  type Box,
} from './geometry.js';
import { cropFits, cropNote, MISLEADING_CROP_REASON, renderCropPair, type CropImages } from './crop-pair.js';
import { codeValue } from '../code-span.js';
import {
  elementPathTails,
  oneSidedDomPaths,
  propertyGlanceLine,
  regionHeading,
  renderCropChanges,
} from './markdown.js';
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

type Group = { paths: string[]; before: Box | null; after: Box | null; identical?: boolean };

function groupForPath(pathKey: string, a: StyleMap, b: StyleMap, padBy: number): Group {
  return {
    paths: [pathKey],
    before: paddedRect(a.elements[pathKey], padBy),
    after: paddedRect(b.elements[pathKey], padBy),
  };
}

function mergeInto(left: Group, right: Group): void {
  left.paths.push(...right.paths);
  left.before = unionVisibleBoxes(left.before, right.before);
  left.after = unionVisibleBoxes(left.after, right.after);
}

/** Merge every member box into one section frame. */
function collapseGroups(groups: Group[]): Group[] {
  const [first, ...rest] = groups;
  const acc: Group = { paths: [...first.paths], before: first.before, after: first.after };
  for (const g of rest) mergeInto(acc, g);
  return [acc];
}

/** Main's overlap geometry, shared by legacy region anchors and the displayed sections. */
function groupRegions(paths: string[], beforeMap: StyleMap, afterMap: StyleMap, padBy: number): Group[] {
  const regions = paths.map((elementPath) => groupForPath(elementPath, beforeMap, afterMap, padBy));
  const overlaps = (left: Box | null, right: Box | null) => visible(left) && visible(right) && intersects(left, right);
  for (let left = 0; left < regions.length; left++) {
    const right = regions.findIndex(
      (region, index) =>
        index > left && (overlaps(regions[left].before, region.before) || overlaps(regions[left].after, region.after)),
    );
    if (right === -1) continue;
    mergeInto(regions[left], regions[right]);
    regions.splice(right, 1);
    left = -1;
  }
  return regions;
}

/** Preserve main's mixed overlap regions; combine only regions sharing one complete change. */
function sectionGroups(
  paths: string[],
  findings: Finding[],
  beforeMap: StyleMap,
  afterMap: StyleMap,
  padBy: number,
): Group[] {
  const signatures = new Map<string, number>();
  groupByElementChange(findings).forEach((members, index) => {
    for (const member of members) signatures.set(member.path, index);
  });
  const regions = groupRegions(paths, beforeMap, afterMap, padBy);
  const identical = new Map<number, Group[]>();
  const mixed: Group[] = [];
  for (const region of regions) {
    const keys = new Set(region.paths.map((elementPath) => signatures.get(elementPath)!));
    if (keys.size !== 1) {
      mixed.push(region);
      continue;
    }
    const key = [...keys][0];
    identical.set(key, [...(identical.get(key) ?? []), region]);
  }
  return [...mixed, ...[...identical.values()].map((members) => ({ ...collapseGroups(members)[0], identical: true }))];
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

  const byFolded = new Map<string, PreparedSurface[]>();
  for (const candidate of prepared) {
    const key = exactSignatureOf(candidate.folded ?? []);
    byFolded.set(key, [...(byFolded.get(key) ?? []), candidate]);
  }
  const signatures = [...byFolded.values()].flatMap((members) =>
    groupByWidth(members.map((p) => ({ surface: p.sd.surface, findings: p.findings, folded: p.folded }))),
  );

  return signatures.map((g) => {
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
  /** Sibling spacing changes whose run this region shows (#755). */
  spacing: SiblingSpacingChange[];
  changes: (findings: Finding[], elementPaths?: string[]) => string[];
};

type CropPack = {
  md: string[];
  images: CropImages;
  omitted?: boolean;
  visualEvidence?: 'not-rendered';
  reason?: string;
  cropFallback?: 'top-most';
};

const topY = (g: Group) => (visible(g.after) ? g.after.y : visible(g.before) ? g.before.y : Infinity);

function sectionHeading(group: Group, findings: Finding[]): string {
  return regionHeading(group.identical ? [group.paths[0]] : outermost(group.paths), findings);
}

function elementList(group: Group): string[] {
  const { paths } = group;
  if (!group.identical || paths.length < 2) return [];
  const tails = elementPathTails(paths);
  return [
    '',
    '<details>',
    `<summary>${paths.length} elements</summary>`,
    '',
    ...paths.slice(0, 10).map((elementPath) => `- ${codeValue(tails.get(elementPath)!)}`),
    ...(paths.length > 10 ? [`- … and ${paths.length - 10} more`] : []),
    '',
    '</details>',
  ];
}

type CropFrame = { box: Box; fallback: boolean; exposed: number; outside: number; unexposed: number };

function outsideScreenshot(map: StyleMap, elementPath: string, png: PNG): boolean {
  const rect = screenshotRectOf(map.elements[elementPath]);
  if (!rect) return true;
  const [x, y, width, height] = rect;
  const left = map.viewport?.scrollX ?? 0;
  return x + width <= left || x >= left + png.width || y + height <= 0 || y >= png.height;
}

/** Union only exposed members; missing capture coverage is distinct from an unreadable union. */
function cropFrame(regionArguments: RegionArgs, beforeScreenshot: PNG, afterScreenshot: PNG): CropFrame {
  const frames = regionArguments.g.paths.map((elementPath) =>
    groupForPath(elementPath, regionArguments.mapA, regionArguments.mapB, regionArguments.ctx.padBy),
  );
  const exposed = frames.filter((frame) =>
    hasExposedChangedEntry(regionArguments.mapA, regionArguments.mapB, frame.paths, [
      beforeScreenshot,
      afterScreenshot,
    ]),
  );
  const excluded = frames.filter((frame) => !exposed.includes(frame));
  const outside = excluded.filter(
    (frame) =>
      outsideScreenshot(regionArguments.mapA, frame.paths[0], beforeScreenshot) &&
      outsideScreenshot(regionArguments.mapB, frame.paths[0], afterScreenshot),
  ).length;
  const merged = collapseGroups(exposed)[0];
  const box = unionVisibleBoxes(merged.before, merged.after)!;
  const viewportHeight = Math.min(
    regionArguments.mapA.viewport?.height ?? beforeScreenshot.height,
    regionArguments.mapB.viewport?.height ?? afterScreenshot.height,
  );
  const ordered = exposed.sort((left, right) => topY(left) - topY(right));
  const separated = ordered.some((frame, index) => {
    const previous = ordered[index - 1];
    const previousBox = previous && unionVisibleBoxes(previous.before, previous.after);
    return previousBox && topY(frame) - (previousBox.y + previousBox.h) > viewportHeight;
  });
  const fallback =
    !!regionArguments.g.identical &&
    exposed.length > 1 &&
    (box.h > viewportHeight * 2.5 || separated || !cropFits(regionArguments.ctx, box));
  return {
    box: fallback ? unionVisibleBoxes(ordered[0].before, ordered[0].after)! : box,
    fallback,
    exposed: exposed.length,
    outside,
    unexposed: excluded.length - outside,
  };
}

/** Mark every member of an identical section, including nested members. */
function regionAnnotations(regionArguments: RegionArgs, findings: Finding[], screenshots: Pngs) {
  const { g: group, mapA: beforeMap, mapB: afterMap } = regionArguments;
  const annotations =
    group.identical && group.paths.length > 1
      ? findings.map((finding) => annotationPaths([finding], beforeMap, afterMap))
      : [annotationPaths(findings, beforeMap, afterMap)];
  const marked = {
    before: [...new Set(annotations.flatMap((paths) => paths.before))].filter((elementPath) =>
      hasExposedChangedEntry(beforeMap, afterMap, [elementPath], screenshots),
    ),
    after: [...new Set(annotations.flatMap((paths) => paths.after))].filter((elementPath) =>
      hasExposedChangedEntry(beforeMap, afterMap, [elementPath], screenshots),
    ),
  };
  const rectanglesOf = (paths: string[], map: StyleMap): Rect[] =>
    paths
      .map((elementPath) => screenshotRectOf(map.elements[elementPath]))
      .filter((rectangle): rectangle is Rect => !!rectangle);
  const entries = [
    ...marked.before.map((elementPath) => beforeMap.elements[elementPath]),
    ...marked.after.map((elementPath) => afterMap.elements[elementPath]),
  ];
  const changedNames = [
    ...new Set(entries.filter((entry): entry is ElementEntry => !!entry).map(shortElementName)),
  ].slice(0, 3);
  const changedLabel = changedNames.length ? ` — changed: ${changedNames.map(codeValue).join(', ')}` : '';
  return {
    rectsA: rectanglesOf(marked.before, beforeMap),
    rectsB: rectanglesOf(marked.after, afterMap),
    changedLabel,
    marked,
  };
}

/** Count primary changed elements outlined on either saved side, once per element. */
function countMarkedElements(
  regionArguments: RegionArgs,
  marked: { before: string[]; after: string[] },
  before: Box,
  after: Box,
): number {
  const onSide = (elementPath: string, map: StyleMap, paths: string[], bounds: Box): boolean => {
    const box = paddedRect(map.elements[elementPath], 0);
    return paths.includes(elementPath) && visible(box) && intersects(box, bounds);
  };
  return regionArguments.g.paths.filter(
    (elementPath) =>
      onSide(elementPath, regionArguments.mapA, marked.before, before) ||
      onSide(elementPath, regionArguments.mapB, marked.after, after),
  ).length;
}

function markedElementsCaption(elementCount: number, frame: CropFrame, markedCount: number): string {
  const missing = frame.outside + frame.unexposed;
  if (frame.fallback)
    return `The top-most crop marks ${markedCount} of ${frame.exposed} ${missing ? 'exposed ' : ''}changed elements; the combined crop would be unreadable.`;
  if (!missing) return `All ${elementCount} changed elements are marked.`;
  return frame.exposed === 1
    ? 'The exposed changed element is marked.'
    : `All ${frame.exposed} exposed changed elements are marked.`;
}

function combinedCropCaption(elementCount: number, frame: CropFrame, combined: boolean, markedCount: number): string {
  const parts = combined && elementCount > 1 ? [markedElementsCaption(elementCount, frame, markedCount)] : [];
  if (frame.outside)
    parts.push(
      `${frame.outside} of ${elementCount} elements ${frame.outside === 1 ? 'is' : 'are'} outside the captured screenshot.`,
    );
  if (frame.unexposed)
    parts.push(
      `${frame.unexposed} of ${elementCount} elements ${frame.unexposed === 1 ? 'is' : 'are'} not exposed in the captured page.`,
    );
  return parts.join(' ');
}

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
  const { rectsA, rectsB, changedLabel, marked } = regionAnnotations(a, findings, [pngA, pngB]);
  const frame = cropFrame(a, pngA, pngB);
  const caption = (before: Box, after: Box) =>
    combinedCropCaption(g.paths.length, frame, !!g.identical, countMarkedElements(a, marked, before, after));
  const packed = renderCropPair(a.ctx, {
    surface: cg.rep.sd.surface,
    suffix: String(a.seq.crop),
    // The SAME page rectangle on both sides, so the reviewer compares like-for-like.
    box: frame.box,
    pngA,
    pngB,
    rectsA,
    rectsB,
    labels: state ? { left: `base :${state}`, right: `head :${state}` } : undefined,
    captions: {
      pair: (before, after) => {
        const marking = caption(before, after);
        return `${state ? `both sides are :${state}` : formatSurfaceWithContext(cg.rep.sd.surface, mapA, mapB)}${marking ? ` — ${marking}` : ''}`;
      },
      annotated: (before, after) => caption(before, after) || `magenta boxes mark each change${changedLabel}`,
      zoom: (factor) => `magnified ${factor}× — change too small to see at 1:1${changedLabel}`,
    },
  })!;
  return { ...packed, ...(frame.fallback ? { cropFallback: 'top-most' as const } : {}) };
}

function combinedStateHeading(regionArguments: RegionArgs, findings: Finding[]): string[] {
  if (!findings.length) return [];
  const states = STATE_LAYER_NAMES.filter((state) =>
    findings.some((finding) => finding.kind === 'state' && finding.state === state),
  );
  const shown = findings.filter((finding) => regionArguments.cg.rep.findings.includes(finding));
  const heading = sectionHeading(regionArguments.g, shown).replace(/ elements restyled$/, ' elements');
  const markdown = [
    '',
    `### ${heading} · ${states.map((state) => codeValue(`:${state}`)).join(', ')}`,
    '',
    regionArguments.surfaceList,
  ];
  const glance = propertyGlanceLine(findings);
  if (glance) markdown.push('', glance);
  return markdown;
}

function stateLayerCrop(regionArguments: RegionArgs, findings: Finding[], state: string): CropPack {
  const layers = screenshotPair(regionArguments.ctx, regionArguments.cg.rep.sd.surface, `.${state}`);
  if (layers[0] && layers[1]) return regionCrop(regionArguments, findings, layers, state);
  return {
    md: ['', `_No :${state} screenshot in these capture sets (re-capture to compare both sides in :${state})._`],
    images: {},
  };
}

function singleStateHeading(
  regionArguments: RegionArgs,
  regionFindings: Finding[],
  stateFindings: Finding[],
  state: string,
  firstHeadingUsesAll: boolean,
  first: boolean,
): string[] {
  const headingFindings = firstHeadingUsesAll && first ? regionFindings : stateFindings;
  const heading = headingFindings.filter((finding) => regionArguments.cg.rep.findings.includes(finding));
  const markdown = [
    '',
    `### ${regionHeading(outermost(regionArguments.g.paths), heading)} ${codeValue(`:${state}`)}`,
    '',
    regionArguments.surfaceList,
    '',
    `_Both sides are :${state}. Left is the old :${state}. Right is the new :${state}._`,
  ];
  const glance = propertyGlanceLine(stateFindings);
  if (glance) markdown.push('', glance);
  return markdown;
}

function combinedStateDetails(regionArguments: RegionArgs, findings: Finding[], showElementList: boolean): string[] {
  if (!regionArguments.g.identical || regionArguments.g.paths.length < 2 || !findings.length) return [];
  const members = showElementList ? elementList(regionArguments.g) : [];
  return [...members, ...regionArguments.changes(findings, regionArguments.g.paths)];
}

function stateSections(a: RegionArgs, regionFindings: Finding[], stateOnly: boolean) {
  const md: string[] = [];
  const stateImages: Record<string, CropImages> = {};
  const combined = a.g.identical && a.g.paths.length > 1;
  const findings = regionFindings.filter((finding) => finding.kind === 'state');
  let cropFallback: 'top-most' | undefined;
  if (combined) md.push(...combinedStateHeading(a, findings));
  for (const state of STATE_LAYER_NAMES) {
    const sf = findings.filter((finding) => finding.state === state);
    if (!sf.length) continue;
    if (!combined) md.push(...singleStateHeading(a, regionFindings, sf, state, stateOnly, md.length === 0));
    if (combined) md.push('', `_Both sides are :${state}. Left is the old :${state}. Right is the new :${state}._`);
    const packed = stateLayerCrop(a, sf, state);
    md.push(...packed.md);
    if (packed.images.composite) stateImages[state] = packed.images;
    cropFallback ??= packed.cropFallback;

    if (!combined) md.push(...a.changes(sf, a.g.paths));
  }
  md.push(...combinedStateDetails(a, findings, stateOnly));
  return { md, stateImages, cropFallback };
}

const spacingJson = (spacing: SiblingSpacingChange[]) => (spacing.length ? { spacing } : {});

type RestingSection = { md: string[]; pack: CropPack; trailing: string[] };

/**
 * The resting section: heading, glance line, spacing lines, crop, then the property
 * changes. A region without one still names its spacing, once, at its end (`trailing`).
 */
function restingSection(a: RegionArgs, cropFindings: Finding[], shown: boolean): RestingSection {
  if (!shown) return { md: [], pack: { md: [], images: {} }, trailing: spacingLines(a.spacing) };
  const heading = cropFindings.filter((f) => a.cg.rep.findings.includes(f));
  const md = ['', `### ${sectionHeading(a.g, heading)}`, '', a.surfaceList];
  const glance = propertyGlanceLine(cropFindings);
  if (glance) md.push('', glance);
  md.push(...spacingLines(a.spacing));
  const pack = regionCrop(a, cropFindings, a.pngs);
  md.push(...pack.md, ...elementList(a.g), ...a.changes(cropFindings, a.g.paths));
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

function findingsInRegion(group: Group, changeGroup: ChangeGroup): Finding[] {
  return [...changeGroup.rep.findings, ...(changeGroup.rep.folded ?? [])].filter(
    (finding) =>
      group.paths.includes(finding.path) ||
      (!changeGroup.rep.findings.includes(finding) &&
        group.paths.some((root) => isSameOrDescendant(finding.path, root))) ||
      group.paths.some(
        (root) =>
          changeGroup.rep.findings.some((finding) => finding.kind === 'dom' && finding.path === root) &&
          isSameOrDescendant(finding.path, root),
      ),
  );
}

/** One crop region: heading, resting crop, then each forced-state crop. */
function renderRegion(a: RegionArgs) {
  const { g, cg, surfaceList, region, pngs } = a;

  const regionFindings = findingsInRegion(g, cg);

  const { rest, shownRest, hasDom, stateOnly } = regionVisibility(cg, regionFindings);
  const md: string[] = [];
  const cropFindings = hasDom ? regionFindings : rest;
  const section = restingSection(a, cropFindings, !stateOnly && shownRest.length > 0);
  const resting = section.pack;
  md.push(...section.md);
  const states = hasDom
    ? { md: [], stateImages: {}, cropFallback: undefined }
    : stateSections(a, regionFindings, stateOnly);
  md.push(...states.md);

  if (stateOnly && rest.length) md.push(...a.changes(rest, a.g.paths));

  if (!md.length) {
    md.push('', `### ${regionHeading(outermost(g.paths), regionFindings)}`, '', surfaceList);
    const note = cropNote(region, ...pngs);
    if (note) md.push('', note);
    md.push(...a.changes(regionFindings, a.g.paths));
  }
  md.push(...section.trailing);
  return { md, regionJson: regionSidecar(a, resting, states, stateOnly) };
}

type RegionSidecar = {
  paths: string[];
  before: Box | null;
  after: Box | null;
  images: CropImages;
  elements?: { path: string }[];
  cropFallback?: 'top-most';
  stateImages?: Record<string, CropImages>;
  visualEvidence?: 'not-rendered';
  reason?: string;
  spacing?: SiblingSpacingChange[];
  cropOmitted?: 'budget';
};
type SectionSidecar = RegionSidecar & { regionIndexes: number[] };

function regionSidecar(
  regionArguments: RegionArgs,
  resting: CropPack,
  states: ReturnType<typeof stateSections>,
  stateOnly: boolean,
): RegionSidecar {
  const { g: group } = regionArguments;
  const { visualEvidence, reason } = resting;
  const images = stateOnly && !resting.images.composite ? (Object.values(states.stateImages)[0] ?? {}) : resting.images;
  const regionJson: RegionSidecar = {
    paths: [...new Set(findingsInRegion(group, regionArguments.cg).map((finding) => finding.path))],
    before: group.before,
    after: group.after,
    images,
    ...(group.identical && group.paths.length > 1
      ? { elements: group.paths.map((elementPath) => ({ path: elementPath })) }
      : {}),
    ...(resting.cropFallback || states.cropFallback ? { cropFallback: 'top-most' } : {}),
    ...(Object.keys(states.stateImages).length ? { stateImages: states.stateImages } : {}),
    ...(visualEvidence ? { visualEvidence, reason } : {}),
    ...spacingJson(regionArguments.spacing),
  };
  if (resting.omitted) Object.assign(regionJson, { cropOmitted: 'budget' });
  return regionJson;
}

/** Sections describe the shown crops; indices link them to main's unchanged geometry. */
function sectionSidecars(rendered: ReturnType<typeof renderRegion>[], originalGroups: Group[]): SectionSidecar[] {
  return rendered.map((section) => ({
    ...section.regionJson,
    regionIndexes: originalGroups.flatMap((group, index) =>
      group.paths.some((root) =>
        section.regionJson.paths.some(
          (elementPath) => isSameOrDescendant(elementPath, root) || isSameOrDescendant(root, elementPath),
        ),
      )
        ? [index]
        : [],
    ),
  }));
}

/** Reuse visible section evidence without rendering legacy crops or spending their budget again. */
function sectionEvidence(sections: SectionSidecar[]) {
  const shown = sections.find((section) => section.images.composite) ?? sections[0];
  const stateImages = Object.fromEntries(sections.flatMap((section) => Object.entries(section.stateImages ?? {})));
  return {
    images: shown?.images ?? {},
    ...(Object.keys(stateImages).length ? { stateImages } : {}),
    ...(shown?.cropOmitted ? { cropOmitted: shown.cropOmitted } : {}),
    ...(shown?.visualEvidence ? { visualEvidence: shown.visualEvidence, reason: shown.reason } : {}),
  };
}

function originalRegionSidecars(
  groups: Group[],
  sections: SectionSidecar[],
  spacing: SiblingSpacingChange[],
): RegionSidecar[] {
  const claimed = new Set<SiblingSpacingChange>();
  return groups.map((group, index) => ({
    paths: group.paths,
    before: group.before,
    after: group.after,
    ...sectionEvidence(sections.filter((section) => section.regionIndexes.includes(index))),
    ...spacingJson(claimSpacing(spacing, group.paths, claimed)),
  }));
}

/** Avoid duplicating unchanged mixed layouts under the JSON byte budget. */
function sectionLayoutChanged(groups: Group[], originalGroups: Group[], sections: SectionSidecar[]): boolean {
  return (
    groups.some((group) => group.identical && group.paths.length > 1) ||
    sections.length !== originalGroups.length ||
    sections.some(
      (section, index) =>
        JSON.stringify([section.paths, section.before, section.after]) !==
        JSON.stringify([originalGroups[index].paths, originalGroups[index].before, originalGroups[index].after]),
    )
  );
}

type CropContext = Pick<RegionArgs, 'ctx' | 'cg' | 'mapA' | 'mapB' | 'pngs'>;

/** Match main's surface-level visibility decision for the supplied anchor paths. */
function hasExposedFindings(regionArguments: CropContext, paths: string[]): boolean {
  if (hasExposedChangedEntry(regionArguments.mapA, regionArguments.mapB, paths, regionArguments.pngs)) return true;
  return STATE_LAYER_NAMES.some((state) => {
    const statePaths = regionArguments.cg.rep.findings
      .filter((finding) => finding.kind === 'state' && finding.state === state)
      .map((finding) => finding.path);
    return (
      statePaths.length > 0 &&
      hasExposedChangedEntry(
        regionArguments.mapA,
        regionArguments.mapB,
        statePaths,
        screenshotPair(regionArguments.ctx, regionArguments.cg.rep.sd.surface, `.${state}`),
      )
    );
  });
}

/** Only sections with an actual exposed screenshot pair use a crop slot. */
function groupHasCrop(group: Group, regionArguments: CropContext): boolean {
  const findings = findingsInRegion(group, regionArguments.cg);
  const { stateOnly, shownRest, hasDom } = regionVisibility(regionArguments.cg, findings);
  const hasPair = (paths: string[], screenshots: Pngs) =>
    !!screenshots[0] &&
    !!screenshots[1] &&
    hasExposedChangedEntry(regionArguments.mapA, regionArguments.mapB, paths, screenshots);
  if (!stateOnly && shownRest.length && hasPair(group.paths, regionArguments.pngs)) return true;
  if (hasDom) return false;
  return STATE_LAYER_NAMES.some((state) => {
    const paths = findings
      .filter((finding) => finding.kind === 'state' && finding.state === state)
      .map((finding) => finding.path);
    return (
      paths.length > 0 &&
      hasPair(paths, screenshotPair(regionArguments.ctx, regionArguments.cg.rep.sd.surface, `.${state}`))
    );
  });
}

/** Main's cap is a union-collapse threshold, including maxCrops: 0, rather than an image omission. */
function limitCropGroups(groups: Group[], regionArguments: CropContext): Group[] {
  const exposed = groups.filter((group) => groupHasCrop(group, regionArguments));
  if (exposed.length <= Math.max(1, regionArguments.ctx.maxCrops)) return groups;
  const merged = collapseGroups(exposed)[0];
  merged.paths.sort(
    (left, right) =>
      topY(groupForPath(left, regionArguments.mapA, regionArguments.mapB, regionArguments.ctx.padBy)) -
      topY(groupForPath(right, regionArguments.mapA, regionArguments.mapB, regionArguments.ctx.padBy)),
  );
  return [...groups.filter((group) => !exposed.includes(group)), merged];
}

export type RenderedGroup = { md: string[]; json: Record<string, unknown>; findingCount: number };

/** One change group: identical element sections, top-to-bottom, within the crop budget. */
export function renderChangeGroup(ctx: RenderCtx, cg: ChangeGroup, seq: { crop: number }): RenderedGroup {
  const { sd, findings } = cg.rep;
  // Same correspondence rewrite as prepareReportSurfaces, so crops resolve corresponded head paths.
  const [mapA, mapB] = presentationMaps(ctx, sd.surface);
  const describeCtx: DescribeCtx = { tokensBefore: tokenIndex(mapA.tokens), tokensAfter: tokenIndex(mapB.tokens) };
  const folded = cg.rep.folded ?? [];

  const shownSet = new Set(findings);
  const foldedSet = new Set(folded);

  const changes = (shown: Finding[], elementPaths?: string[]): string[] =>
    renderCropChanges(
      shown.filter((f) => shownSet.has(f)),
      ctx.foldDetailsAt,
      describeCtx,
      shown.filter((f) => foldedSet.has(f)),
      elementPaths,
    );
  const json = { surfaces: cg.surfaces, representative: sd.surface, regions: [] as unknown[], findings };
  const domRoots = findings.filter((finding) => finding.kind === 'dom').map((finding) => finding.path);
  const changedPaths = [...new Set(findings.map((finding) => finding.path))].filter(
    (elementPath) => !domRoots.some((root) => root !== elementPath && isSameOrDescendant(elementPath, root)),
  );
  const findingCount = findings.length;
  // The raw base: a geometry correspondence can move part of a run and split it.
  const spacing = siblingSpacingChanges(ctx.load(ctx.beforeDir, sd.surface), mapB);
  const surfaceList =
    cg.surfaces.length > 1
      ? `_Identical across ${cg.surfaces.length} surfaces: ${formatSurfaceListWithContext(ctx, cg.surfaces)}_`
      : `_${formatSurfaceWithContext(sd.surface, mapA, mapB)}_`;
  const pngs = screenshotPair(ctx, sd.surface);
  const cropContext = { ctx, cg, mapA, mapB, pngs };

  if (!findings.length && folded.length) {
    const label = regionHeading([...new Set(folded.map((f) => f.path))], folded, true);
    const md = ['', `### ${label}`, '', surfaceList, ...changes(folded)];

    return { md, json, findingCount };
  }
  if (!hasExposedFindings(cropContext, changedPaths)) {
    const reason = MISLEADING_CROP_REASON;
    return {
      md: [
        // The heading also ends the Action's PR comment summary (#952).
        '',
        `### ${regionHeading(outermost(changedPaths), findings)}`,
        '',
        surfaceList,
        '',
        `_${reason}_`,
        ...spacingLines(spacing),
        '',
        ...changes([...findings, ...folded]),
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
  const originalPaths = outermost(changedPaths);
  let originalGroups = hasExposedFindings(cropContext, originalPaths)
    ? groupRegions(originalPaths, mapA, mapB, ctx.padBy)
    : [];
  if (originalGroups.length > ctx.maxCrops) originalGroups = collapseGroups(originalGroups);
  originalGroups.sort((left, right) => topY(left) - topY(right));
  let groups = sectionGroups(changedPaths, findings, mapA, mapB, ctx.padBy);
  for (const group of groups)
    group.paths.sort(
      (left, right) =>
        topY(groupForPath(left, mapA, mapB, ctx.padBy)) - topY(groupForPath(right, mapA, mapB, ctx.padBy)),
    );
  groups = limitCropGroups(groups, cropContext);
  groups.sort((l, r) => topY(l) - topY(r));
  const claimed = new Set<SiblingSpacingChange>();
  const rendered = groups.map((g) => {
    const region = visible(g.after) ? g.after : g.before;
    const own = claimSpacing(spacing, g.paths, claimed);

    return renderRegion({ ctx, g, cg, mapA, mapB, describeCtx, surfaceList, region, pngs, seq, spacing: own, changes });
  });
  const sections = sectionSidecars(rendered, originalGroups);
  const regions = originalRegionSidecars(originalGroups, sections, spacing);
  // Keep reflow ancestors in one capped table outside the crop budget.
  const outside = folded.filter((f) => !groups.some((g) => g.paths.some((root) => isSameOrDescendant(f.path, root))));

  const outsideMd = outside.length
    ? ['', '### Folded size/position rows outside the crops', '', surfaceList, ...changes(outside)]
    : [];

  // A changed run no crop region shows is still named, once, under the group.
  const unclaimed = spacing.filter((change) => !claimed.has(change));
  return {
    md: [...rendered.flatMap((r) => r.md), ...outsideMd, ...spacingLines(unclaimed)],
    json: {
      ...json,
      regions,
      ...(sectionLayoutChanged(groups, originalGroups, sections) ? { sections } : {}),
      ...spacingJson(unclaimed),
      classification: sd.classification,
    },
    findingCount,
  };
}
