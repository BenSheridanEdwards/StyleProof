import type { PNG } from 'pngjs';
import { captureKeysIn, isUnder, type ElementEntry, type Rect, type StyleMap } from '../capture.js';
import { diffContentMaps, type ContentChange } from '../diff.js';
import { isAgeOnlyDrift, isLiveTextChange } from '../live-text.js';
import { correspondContentShiftedPaths } from '../path-correspondence.js';
import { prettyLabel, safeKey } from '../change-groups.js';
import { containerOf, paddedRect, union, type Box } from './geometry.js';
import { renderCropPair } from './crop-pair.js';
import { clipText } from './markdown.js';
import { screenshotPair, type RenderCtx } from './shared.js';

/** The opt-in ADVISORY content layer: text and structure changes with before/after crops. */

const NO_PIXEL_DIFFERENCE_NOTE =
  "_This element's location renders identically before and after (the change has no visible effect in the captured state), so there is no before/after crop to show._";

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
  if (entry.tag.toLowerCase() === 'body' || !entry.rect) return true;
  const [, , w, h] = entry.rect;
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
  // could union an unrelated shifted sibling, so keep it leaf-centred.
  if (c.kind === 'structure' && c.change !== 'retagged') return leaf;
  return sharedAncestorBox(s, c.path, leaf) ?? leaf;
}

function contentCropLines(s: Sides, surface: string, c: ContentChange, seq: number): string[] {
  const box = contentBox(s, c);
  if (!box) return [];
  const [entryA, entryB] = sidedEntries(c, s.mapA, s.mapB);
  const rects = (entry: ElementEntry | undefined): Rect[] => (entry?.rect ? [entry.rect] : []);
  // Identical pixels on both sides is no evidence; name the absence instead.
  const pair = renderCropPair(s.ctx, {
    surface,
    suffix: `content-${seq}`,
    box,
    pngA: s.pngA,
    pngB: s.pngB,
    rectsA: rects(entryA),
    rectsB: rects(entryB),
    captions: {
      pair: surface,
      annotated: 'magenta boxes mark the changed content',
      zoom: (factor) => `magnified ${factor}×: content change too small to read at 1:1`,
    },
    skipIdentical: true,
  });
  return pair ? pair.md : ['', NO_PIXEL_DIFFERENCE_NOTE];
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

function changeLines(ctx: RenderCtx, c: ContentChange): string[] {
  if (c.kind !== 'text')
    return [`- ${c.change === 'retagged' ? `element retagged: \`${c.detail}\`` : `element ${c.change}`}`];
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
    const cropLines = sides && seq < ctx.maxCrops ? contentCropLines(sides, surface, c, seq + 1) : [];
    if (cropLines.some((line) => line.startsWith('!['))) seq++;
    md.push('', `**\`${prettyLabel(c.path, c.cls)}\`**`, '', ...changeLines(ctx, c), ...cropLines);
  }
  return { md, seq };
}

/** The advisory content section: markdown plus the change count (never feeds the gate). */
export function renderContentSection(ctx: RenderCtx, surfaces: ContentSurface[]): { md: string[]; count: number } {
  const count = surfaces.reduce((sum, s) => sum + s.changes.length, 0);
  if (!count) return { md: [], count: 0 };
  const md: string[] = [
    '',
    '---',
    '',
    '## 📝 Content and structure changes (advisory)',
    '',
    `_${count} content/structure change(s). **Advisory only** — content and DOM structure are not part of the ` +
      `computed-style certification and do not affect the check. Surfaced so copy, element, and reflow changes are ` +
      `visible when content comparison is enabled. Live/age/clock text (relative ages, clocks) is labeled below ` +
      `so it cannot be mistaken for a product style regression._`,
  ];
  let seq = 0;
  for (const surface of surfaces) {
    const out = renderContentSurface(ctx, surface, seq);
    md.push(...out.md);
    seq = out.seq;
  }
  return { md, count };
}
