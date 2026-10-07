import type { PNG } from 'pngjs';
import { captureKeysIn, isUnder, type ElementEntry, type Rect, type StyleMap } from '../capture.js';
import { diffContentMaps, type ContentChange } from '../diff.js';
import { isAgeOnlyDrift, isLiveTextChange } from '../live-text.js';
import { correspondContentShiftedPaths } from '../path-correspondence.js';
import { countCapturedSurfaceBases, formatSurfaceList, prettyLabel, safeKey, surfaceWidth } from '../change-groups.js';
import { chromeHosted } from '../change-chrome.js';
import { containerOf, paddedRect, screenshotRectOf, union, type Box } from './geometry.js';
import { renderCropPair } from './crop-pair.js';
import { clipText, codeValue } from './markdown.js';
import { screenshotPair, type RenderCtx } from './shared.js';

/** The opt-in ADVISORY content layer: text and structure changes with before/after crops. */

const NO_PIXEL_DIFFERENCE_NOTE =
  "_This element's location renders identically before and after (the change has no visible effect in the captured state), so there is no before/after crop to show._";

/** One-sided structure: identical crop pixels mean missing evidence, not "no visible effect". */
function noStructureCropNote(change: 'added' | 'removed'): string {
  return (
    `_No distinct before/after crop for this element ${change} (the cropped region matches on both ` +
    `screenshots). The element itself was ${change} — this is not a claim that the change has no visible effect._`
  );
}

type StructureChange = Extract<ContentChange, { kind: 'structure' }>;

/** The side an element exists on: an added element has no before entry, a removed one no after entry. */
function sidedEntries(
  c: ContentChange,
  mapA: StyleMap,
  mapB: StyleMap,
): [ElementEntry | undefined, ElementEntry | undefined] {
  const oneSided = c.kind === 'structure' ? c.change : null;
  return [
    oneSided === 'added' ? undefined : mapA.elements[c.path],
    oneSided === 'removed' ? undefined : mapB.elements[c.path],
  ];
}

const sameContentIdentity = (a: ElementEntry, b: ElementEntry): boolean =>
  a.tag === b.tag &&
  a.cls === b.cls &&
  (a.component?.name ?? '') === (b.component?.name ?? '') &&
  a.ownTextLength === b.ownTextLength;

function isFullPageShell(entry: ElementEntry, png: PNG): boolean {
  const rect = screenshotRectOf(entry);
  if (entry.tag.toLowerCase() === 'body' || !rect) return true;
  const [, , w, h] = rect;
  return w >= png.width * 0.9 && h >= png.height * 0.9;
}

/** One surface's crop inputs: both maps and both screenshots. */
type Sides = { ctx: RenderCtx; mapA: StyleMap; mapB: StyleMap; pngA: PNG; pngB: PNG };

type AncestorDecision = { kind: 'skip' } | { kind: 'fallback' } | { kind: 'use'; box: Box };

function ancestorDecision(s: Sides, ancestorPath: string, leaf: Box): AncestorDecision {
  const a = s.mapA.elements[ancestorPath];
  const b = s.mapB.elements[ancestorPath];
  if (!a?.rect || !b?.rect || !sameContentIdentity(a, b)) return { kind: 'skip' };
  if (isFullPageShell(a, s.pngA) || isFullPageShell(b, s.pngB)) return { kind: 'fallback' };
  const boxA = paddedRect(a, s.ctx.padBy);
  const boxB = paddedRect(b, s.ctx.padBy);
  if (!boxA || !boxB) return { kind: 'skip' };
  const candidate = union(boxA, boxB);
  if (candidate.h > s.ctx.maxHeight || candidate.w > Math.min(s.pngA.width, s.pngB.width)) return { kind: 'fallback' };
  return candidate.w > leaf.w || candidate.h > leaf.h ? { kind: 'use', box: candidate } : { kind: 'skip' };
}

/** Nearest useful shared visible ancestor box, or null to keep the leaf-centred crop. */
function sharedAncestorBox(s: Sides, pathKey: string, leaf: Box): Box | null {
  for (let p = containerOf(pathKey); p; p = containerOf(p)) {
    const decision = ancestorDecision(s, p, leaf);
    if (decision.kind === 'fallback') return null;
    if (decision.kind === 'use') return decision.box;
  }
  return null;
}

function contentBox(s: Sides, c: ContentChange): Box | null {
  const [entryA, entryB] = sidedEntries(c, s.mapA, s.mapB);
  const ba = paddedRect(entryA, s.ctx.padBy);
  const bb = paddedRect(entryB, s.ctx.padBy);
  const leaf = ba && bb ? union(ba, bb) : (bb ?? ba);
  if (!leaf) return null;
  // One-sided structure has no opposite-side correspondence: an ancestor expansion
  // could union an unrelated shifted sibling, so keep it leaf-centred by default.
  if (c.kind === 'structure' && c.change !== 'retagged') return leaf;
  return sharedAncestorBox(s, c.path, leaf) ?? leaf;
}

/** Shared parent box for one-sided structure when a leaf crop is pixel-identical. */
function parentStructureBox(s: Sides, pathKey: string, leaf: Box): Box | null {
  const parent = containerOf(pathKey);
  if (!parent) return null;
  const a = s.mapA.elements[parent];
  const b = s.mapB.elements[parent];
  if (!a?.rect || !b?.rect || isFullPageShell(a, s.pngA) || isFullPageShell(b, s.pngB)) return null;
  const pa = paddedRect(a, s.ctx.padBy);
  const pb = paddedRect(b, s.ctx.padBy);
  if (!pa || !pb) return null;
  const parentBox = union(pa, pb);
  if (parentBox.h > s.ctx.maxHeight || parentBox.w > Math.min(s.pngA.width, s.pngB.width)) return null;
  if (!(parentBox.w > leaf.w || parentBox.h > leaf.h)) return null;
  return parentBox;
}

function contentCropLines(s: Sides, surface: string, c: ContentChange, suffix: string): string[] {
  const box = contentBox(s, c);
  if (!box) return [];
  const [entryA, entryB] = sidedEntries(c, s.mapA, s.mapB);
  const rects = (entry: ElementEntry | undefined): Rect[] => {
    const rect = screenshotRectOf(entry);
    return rect ? [rect] : [];
  };
  const captions = {
    pair: surface,
    annotated: 'magenta boxes mark the changed content',
    zoom: (factor: number) => `magnified ${factor}×: content change too small to read at 1:1`,
  };
  // Identical pixels on both sides is no evidence; name the absence instead.
  let pair = renderCropPair(s.ctx, {
    surface,
    suffix,
    box,
    pngA: s.pngA,
    pngB: s.pngB,
    rectsA: rects(entryA),
    rectsB: rects(entryB),
    captions,
    skipIdentical: true,
  });
  // One-sided add/remove: if the leaf crop matches on both screenshots, try a shared
  // parent crop so presence vs absence can still show before/after evidence.
  if (!pair && c.kind === 'structure' && (c.change === 'added' || c.change === 'removed')) {
    const parentBox = parentStructureBox(s, c.path, box);
    if (parentBox) {
      pair = renderCropPair(s.ctx, {
        surface,
        suffix,
        box: parentBox,
        pngA: s.pngA,
        pngB: s.pngB,
        rectsA: rects(entryA),
        rectsB: rects(entryB),
        captions,
        skipIdentical: true,
      });
    }
    if (pair) return pair.md;
    return ['', noStructureCropNote(c.change)];
  }
  if (pair) return pair.md;
  return ['', NO_PIXEL_DIFFERENCE_NOTE];
}

function withoutRedundantStructuralDescendants(changes: ContentChange[]): ContentChange[] {
  const structural = changes.filter((c): c is StructureChange => c.kind === 'structure' && c.change !== 'retagged');
  return changes.filter(
    (c) =>
      c.kind !== 'structure' ||
      c.change === 'retagged' ||
      !structural.some((a) => a !== c && a.change === c.change && isUnder(c.path, [a.path])),
  );
}

/** A one-sided structure change whose element has exactly one same-geometry twin on the
 *  other side at a different, occupied path is a shift collision, not a real add/remove. */
function isShiftCollision(c: ContentChange, mapA: StyleMap, mapB: StyleMap): boolean {
  if (c.kind !== 'structure' || c.change === 'retagged') return false;
  const [source, opposite] = c.change === 'added' ? [mapB, mapA] : [mapA, mapB];
  const entry = source.elements[c.path];
  if (!entry?.rect) return false;
  const sameRect = (r: Rect | undefined): boolean => !!r && r.every((v, i) => v === entry.rect![i]);
  const matches = Object.entries(opposite.elements).filter(([p, candidate]) => {
    if (p === c.path || !candidate.rect) return false;
    const occupant = source.elements[p];
    if (!occupant?.rect || sameRect(occupant.rect)) return false;
    return sameContentIdentity(candidate, entry) && sameRect(candidate.rect);
  });
  return matches.length === 1;
}

function contentChanges(mapA: StyleMap, mapB: StyleMap): ContentChange[] {
  const retained = new Set(Object.values(correspondContentShiftedPaths(mapA, mapB).elements));
  const volatile = [...new Set([...(mapA.volatile ?? []), ...(mapB.volatile ?? [])])];
  const displacedRemovals: ContentChange[] = Object.entries(mapA.elements)
    .filter(([p, entry]) => !retained.has(entry) && !isUnder(p, volatile))
    .map(([p, entry]) => ({ kind: 'structure', change: 'removed', path: p, cls: entry.cls }));
  const concrete = [...displacedRemovals, ...diffContentMaps(mapA, mapB)].filter(
    (c) => !isShiftCollision(c, mapA, mapB),
  );
  return withoutRedundantStructuralDescendants(concrete).sort((l, r) => l.path.localeCompare(r.path));
}

export type ContentSurface = { surface: string; changes: ContentChange[] };

/** Every surface captured on both sides that has content/structure changes. */
export function contentSurfaces(ctx: RenderCtx): ContentSurface[] {
  const before = new Set(captureKeysIn(ctx.beforeDir));
  return captureKeysIn(ctx.afterDir)
    .filter((surface) => before.has(surface))
    .sort()
    .map((surface) => ({
      surface,
      changes: contentChanges(ctx.load(ctx.beforeDir, surface), ctx.load(ctx.afterDir, surface)),
    }))
    .filter(({ changes }) => changes.length > 0);
}

/** A one-sided element change drawn the same way on every surface base that renders its container. */
export type ChromeStructureChange = { change: StructureChange; surfaces: string[]; bases: number };

type OneSidedIndexEntry = { change: StructureChange; surfaces: string[]; host: string };

const oneSidedIdentity = (c: StructureChange): string => `${c.change}\0${c.path}\0${c.cls}`;

/** Every added/removed element across the run, keyed by change + path + class, with the surfaces it hit. */
function indexOneSided(surfaces: ContentSurface[]): OneSidedIndexEntry[] {
  const byIdentity = new Map<string, OneSidedIndexEntry>();
  for (const { surface, changes } of surfaces) {
    for (const c of changes) {
      if (c.kind !== 'structure' || c.change === 'retagged') continue;
      const entry = byIdentity.get(oneSidedIdentity(c)) ?? { change: c, surfaces: [], host: containerOf(c.path) };
      entry.surfaces.push(surface);
      byIdentity.set(oneSidedIdentity(c), entry);
    }
  }
  return [...byIdentity.values()];
}

/**
 * Hosting universe for content-layer chrome (#767 / #754 residual): only surfaces
 * present on BOTH sides (content-comparable). Unpaired head/base-only captures can
 * co-host the same container but never appear in contentSurfaces, so counting them
 * as hosts makes `every(hostingBase ∈ changedBases)` fail and skips Global chrome.
 */
export function contentHostingSurfacePaths(
  beforeDir: string,
  afterDir: string,
  surfacePaths: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const before = new Set(captureKeysIn(beforeDir));
  const paired = new Set(captureKeysIn(afterDir).filter((k) => before.has(k)));
  return new Map([...surfacePaths].filter(([surface]) => paired.has(surface)));
}

/**
 * Split out one-sided element changes that are shared chrome (#754): the same element
 * added (or removed) at the same path on every *content-comparable* surface base that
 * renders its container, a persistent nav, header, or footer. Each is listed ONCE under
 * Global chrome instead of once per surface; everything else stays in the advisory list.
 * Callers must pass a hosting universe limited to paired surfaces (`contentHostingSurfacePaths`);
 * unpaired co-hosts must not expand the must-hit set (#767).
 */
export function splitChromeStructure(
  surfaces: ContentSurface[],
  surfacePaths: Map<string, Set<string>>,
  surfaceKeyOf?: (captureKey: string) => string | undefined,
): { chrome: ChromeStructureChange[]; rest: ContentSurface[] } {
  const chrome = chromeHosted(indexOneSided(surfaces), surfacePaths, surfaceKeyOf);
  const promoted = new Set(chrome.map((entry) => oneSidedIdentity(entry.change)));
  const rest = surfaces
    .map(({ surface, changes }) => ({
      surface,
      changes: changes.filter((c) => c.kind !== 'structure' || !promoted.has(oneSidedIdentity(c))),
    }))
    .filter(({ changes }) => changes.length > 0);
  return {
    chrome: chrome.map(({ change, surfaces: hit }) => ({
      change,
      surfaces: hit,
      bases: countCapturedSurfaceBases(hit, surfaceKeyOf),
    })),
    rest,
  };
}

/** One Global chrome entry: the element, where it changed, and a crop from the widest capture. */
function chromeStructureLines(ctx: RenderCtx, entry: ChromeStructureChange, seq: number): string[] {
  const { change: c, surfaces, bases } = entry;
  const surface = surfaces.reduce((wide, s) => (surfaceWidth(s) > surfaceWidth(wide) ? s : wide));
  const [pngA, pngB] = screenshotPair(ctx, surface);
  // One-sided structure crops against the raw maps, as the per-surface advisory entries do.
  const sides =
    pngA && pngB
      ? { ctx, mapA: ctx.load(ctx.beforeDir, surface), mapB: ctx.load(ctx.afterDir, surface), pngA, pngB }
      : null;
  const crop = sides && seq < ctx.maxCrops ? contentCropLines(sides, surface, c, `chrome-${seq + 1}`) : [];
  return [
    '',
    `**\`${prettyLabel(c.path, c.cls)}\`** — element ${c.change} on all ${bases} surface base${bases === 1 ? '' : 's'} ` +
      `that render its container (${surfaces.length} capture${surfaces.length === 1 ? '' : 's'})`,
    '',
    `<sub>${formatSurfaceList(surfaces)}</sub>`,
    ...crop,
  ];
}

/** The Global chrome section for shared one-sided element changes (visible, never advisory-scattered). */
export function renderChromeStructureSection(
  ctx: RenderCtx,
  chrome: ChromeStructureChange[],
  opts: { elevatedNavigableAdds?: number; elevatedVisibleStructure?: number } = {},
): string[] {
  if (chrome.length === 0) return [];
  const n = chrome.length;
  const elevated = opts.elevatedNavigableAdds ?? 0;
  const visibleElevated = opts.elevatedVisibleStructure ?? 0;
  const verdictBlurb =
    elevated > 0 || visibleElevated > 0
      ? `Visible element additions/removals are reviewable and gate the check (STYLE_REVIEW_REQUIRED); Approve clears them with other reviewable changes. Navigable Global chrome additions (${elevated}) elevate via #766; other invisible/zero-size chrome structure stays advisory.`
      : `DOM structure is outside the computed-style certification, so this does not change the check's verdict.`;
  return [
    '',
    '---',
    '',
    `## 🧱 Global chrome — ${n} element ${n === 1 ? 'change' : 'changes'} on every surface base that renders its container`,
    '',
    `_Each element below was added or removed identically on every captured surface base that renders its ` +
      `container (a persistent nav, header, or footer), so it is listed once here instead of once per surface. ` +
      `It is a visible change to the frame every view draws — review it once. ${verdictBlurb}_`,
    ...chrome.flatMap((entry, seq) => chromeStructureLines(ctx, entry, seq)),
  ];
}

function changeLines(ctx: RenderCtx, c: ContentChange): string[] {
  if (c.kind !== 'text')
    return [`- ${c.change === 'retagged' ? `element retagged: ${codeValue(c.detail ?? '')}` : `element ${c.change}`}`];
  const live =
    isAgeOnlyDrift(c.before, c.after) ||
    isLiveTextChange(c, { freeze: false, selectors: ctx.liveText.selectors ?? [] });
  return [
    ...(live ? ['- **live/age/clock text** (advisory — clock or relative-age data, not a stylesheet edit)'] : []),
    `- before: \`${clipText(c.before) || '(empty)'}\``,
    `- after: \`${clipText(c.after) || '(empty)'}\``,
  ];
}

function renderContentSurface(ctx: RenderCtx, { surface, changes }: ContentSurface, seq: number) {
  const rawMapA = ctx.load(ctx.beforeDir, surface);
  const mapB = ctx.load(ctx.afterDir, surface);
  // Shifted text is reported at the head path: render text changes against the
  // remapped base geometry, structural inventory against the raw base map.
  const comparableMapA = correspondContentShiftedPaths(rawMapA, mapB);
  const [pngA, pngB] = screenshotPair(ctx, surface);
  const md: string[] = ['', `### \`${safeKey(surface)}\` · ${changes.length} content/structure change(s)`];
  for (const c of changes) {
    const mapA = c.kind === 'text' ? comparableMapA : rawMapA;
    const sides = pngA && pngB ? { ctx, mapA, mapB, pngA, pngB } : null;
    const cropLines = sides && seq < ctx.maxCrops ? contentCropLines(sides, surface, c, `content-${seq + 1}`) : [];
    if (cropLines.some((line) => line.startsWith('!['))) seq++;
    md.push('', `**\`${prettyLabel(c.path, c.cls)}\`**`, '', ...changeLines(ctx, c), ...cropLines);
  }
  return { md, seq };
}

/** Content/structure section: visible add/remove elevate to the gate; text/invisible/retags stay advisory. */
export function renderContentSection(
  ctx: RenderCtx,
  surfaces: ContentSurface[],
  opts: { elevatedVisibleStructure?: number } = {},
): { md: string[]; count: number } {
  const count = surfaces.reduce((sum, s) => sum + s.changes.length, 0);
  if (!count) return { md: [], count: 0 };
  const elevated = opts.elevatedVisibleStructure ?? 0;
  const heading =
    elevated > 0 ? '## 📝 Content and structure changes' : '## 📝 Content and structure changes (advisory)';
  const blurb =
    elevated > 0
      ? `_${count} content/structure change(s). **Visible element additions/removals (${elevated}) are reviewable** and ` +
        `gate the check (STYLE_REVIEW_REQUIRED); Approve clears them with other reviewable changes. Pure text, ` +
        `invisible/zero-size DOM churn, retags, and live/age/clock text stay advisory and do not alone change the verdict._`
      : `_${count} content/structure change(s). **Advisory only** — content and DOM structure are not part of the ` +
        `computed-style certification and do not affect the check. Surfaced so copy, element, and reflow changes are ` +
        `visible when content comparison is enabled. Live/age/clock text (relative ages, clocks) is labeled below ` +
        `so it cannot be mistaken for a product style regression._`;
  const md: string[] = ['', '---', '', heading, '', blurb];
  let seq = 0;
  for (const surface of surfaces) {
    const out = renderContentSurface(ctx, surface, seq);
    md.push(...out.md);
    seq = out.seq;
  }
  return { md, count };
}
