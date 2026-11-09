import type { DiffCounts } from '../diff.js';
import { tokenIndex, type DescribeCtx } from '../describe.js';
import { presentationBeforeMap } from '../path-correspondence.js';
import {
  groupBySignature as groupByWidth,
  safeKey,
  summarizeProps,
  surfaceBase,
  surfaceWidth,
} from '../change-groups.js';
import { codeValue } from '../code-span.js';
import { buildChangeSections, renderChangeSection } from './change-sections.js';
import { claimSpacing, siblingSpacingChanges, spacingLines, type SiblingSpacingChange } from './sibling-spacing.js';
import { isSameOrDescendant } from './geometry.js';
import { MISLEADING_CROP_REASON } from './crop-pair.js';
import { oneSidedDomPaths, regionHeading, renderCropChanges } from './markdown.js';
import {
  formatSurfaceListWithContext,
  formatSurfaceWithContext,
  hasActiveModal,
  hasExposedChangedEntry,
  presentationMaps,
  screenshotPair,
  type ChangeGroup,
  type PreparedSurface,
  type RenderCtx,
} from './shared.js';

/** A change group's change sections, rendered in page order. */

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

const spacingJson = (spacing: SiblingSpacingChange[]) => (spacing.length ? { spacing } : {});

export type RenderedGroup = { md: string[]; json: Record<string, unknown>; findingCount: number };

/** One change group: its representative's change sections, in page order. */
export function renderChangeGroup(ctx: RenderCtx, cg: ChangeGroup, seq: { crop: number }): RenderedGroup {
  const { sd, findings } = cg.rep;
  // Same correspondence rewrite as prepareReportSurfaces, so sections resolve corresponded head paths.
  const maps = presentationMaps(ctx, sd.surface);
  const describeCtx: DescribeCtx = {
    tokensBefore: tokenIndex(maps[0].tokens),
    tokensAfter: tokenIndex(maps[1].tokens),
  };
  const folded = cg.rep.folded ?? [];
  const json = { surfaces: cg.surfaces, representative: sd.surface, regions: [] as unknown[], findings };
  const findingCount = findings.length;
  // The raw base: a geometry correspondence can move part of a run and split it.
  const spacing = siblingSpacingChanges(ctx.load(ctx.beforeDir, sd.surface), maps[1]);
  const surfaceList =
    cg.surfaces.length > 1
      ? `_Identical across ${cg.surfaces.length} surfaces: ${formatSurfaceListWithContext(ctx, cg.surfaces)}_`
      : `_${formatSurfaceWithContext(sd.surface, ...maps)}_`;
  const pngs = screenshotPair(ctx, sd.surface);

  if (!findings.length && folded.length) {
    const label = regionHeading([...new Set(folded.map((f) => f.path))], folded, true);
    const md = ['', `### ${label}`, '', surfaceList, ...renderCropChanges([], ctx.foldDetailsAt, describeCtx, folded)];

    return { md, json, findingCount };
  }
  const sections = buildChangeSections(findings, maps);
  const claimed = new Set<SiblingSpacingChange>();
  const within = (paths: string[]) => (f: { path: string }) => paths.some((root) => isSameOrDescendant(f.path, root));
  const rendered = sections.map((section, index) =>
    renderChangeSection(ctx, {
      section,
      surface: sd.surface,
      surfaces: cg.surfaces.length > 1 ? formatSurfaceListWithContext(ctx, cg.surfaces) : undefined,
      maps,
      pngs,
      seq,
      spacing: claimSpacing(spacing, section.paths, claimed),
      folded: folded.filter(within(section.paths)),
      describe: describeCtx,
      cropsAllowed: index < ctx.maxCrops,
    }),
  );
  // Reflow rows on elements no section shows stay listed once, outside the sections.
  const outside = folded.filter((f) => !sections.some((section) => within(section.paths)(f)));
  const outsideMd = outside.length
    ? [
        '',
        '### Folded size/position rows outside the crops',
        '',
        surfaceList,
        ...renderCropChanges([], ctx.foldDetailsAt, describeCtx, outside),
      ]
    : [];
  // A changed run no section shows is still named, once, under the group.
  const unclaimed = spacing.filter((change) => !claimed.has(change));
  const notRendered = !rendered.some((r) => r.shown) && pngs[0] && pngs[1];
  return {
    md: [...rendered.flatMap((r) => r.md), ...outsideMd, ...spacingLines(unclaimed)],
    json: {
      ...json,
      regions: rendered.map((r) => r.region),
      ...(notRendered ? { visualEvidence: 'not-rendered', reason: MISLEADING_CROP_REASON } : {}),
      ...spacingJson(unclaimed),
      classification: sd.classification,
    },
    findingCount,
  };
}

const andList = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');

/** " on `index` at 1280px wide: 9 elements, 4 changed CSS rules." */
function scopeText(keys: string[], base: (key: string) => string, elements: number, changedRules?: number): string {
  const bases = [...new Set(keys.map(base))].sort();
  const widths = [...new Set(keys.map(surfaceWidth))].filter(Boolean).sort((a, b) => a - b);
  const where = bases.length <= 3 ? andList(bases.map((base) => codeValue(safeKey(base)))) : `${bases.length} pages`;
  const wide =
    widths.length === 0
      ? ''
      : widths.length <= 4
        ? ` at ${andList(widths.map(String))}px wide`
        : ` at ${widths.length} widths`;
  const rules = changedRules === undefined ? '' : `, ${changedRules} changed CSS rule${changedRules === 1 ? '' : 's'}`;
  return ` on ${where}${wide}: ${elements} element${elements === 1 ? '' : 's'}${rules}.`;
}

/** How many change sections the report shows, and the summary's scope phrase for them. */
export function sectionSummary(
  ctx: RenderCtx,
  groups: ChangeGroup[],
  changedRules?: number,
  surfaceKeyOf: (captureKey: string) => string | undefined = () => undefined,
): { sectionCount: number; scope: string } {
  let sectionCount = 0;
  let elements = 0;
  for (const cg of groups) {
    // A group with only folded size/position rows renders one block.
    const sections = cg.rep.findings.length
      ? buildChangeSections(cg.rep.findings, presentationMaps(ctx, cg.rep.sd.surface))
      : [];
    sectionCount += Math.max(1, sections.length);
    elements += sections.reduce((n, section) => n + section.paths.length, 0);
  }
  return {
    sectionCount,
    scope: groups.length
      ? scopeText(
          groups.flatMap((g) => g.surfaces),
          (key) => surfaceKeyOf(key) ?? surfaceBase(key),
          elements,
          changedRules,
        )
      : '',
  };
}
