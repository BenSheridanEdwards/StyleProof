import { isUnder, type ElementEntry, type Rect, type StyleMap } from '../capture.js';
import { containerOf, isSameOrDescendant } from './geometry.js';
import { codeValue } from './markdown.js';
import { shortElementName } from './shared.js';

/**
 * Sibling spacing read from the rendered boxes (#755). The spacing a run of siblings
 * gets from its container (a flex/grid `gap`, or the container they left) is not a
 * property of the siblings, so a computed-style diff of them cannot see it vanish.
 * The rects the maps already carry can: the distance from one sibling's box end to
 * the next one's start. Report explanation only: never counted, never gating.
 */

export type SpacingGap = { before: number; after: number };

export type SiblingSpacingChange = {
  /** Head-side container path of the sibling run. */
  parent: string;
  /** `tag.firstClass` of the siblings on either side of a changed gap. */
  siblings: string[];
  /** Head-side paths of those siblings, in run order. */
  paths: string[];
  /** Distinct before → after gaps in px, in run order. */
  gaps: SpacingGap[];
};

/** Rects are rounded to whole px, so a 1px move is the smallest real change. */
const EPSILON_PX = 1;

type Sibling = { path: string; entry: ElementEntry; rect: Rect };
type Runs = Map<string, Sibling[]>;
type Gap = { axis: 2 | 3; px: number };

/** In the flow and painted: an absolutely positioned or empty box has no spacing to its neighbours. */
function measurable(entry: ElementEntry): Rect | null {
  const { rect, style } = entry;
  if (!rect || rect[2] <= 0 || rect[3] <= 0) return null;
  return style.position === 'absolute' || style.position === 'fixed' ? null : rect;
}

/** Measurable children of every container, in document order (the map's key order). */
function siblingRuns(map: StyleMap, volatile: string[]): Runs {
  const runs: Runs = new Map();
  for (const [path, entry] of Object.entries(map.elements)) {
    const parent = containerOf(path);
    const rect = measurable(entry);
    if (!parent || !rect || isUnder(path, volatile)) continue;
    const run = runs.get(parent);
    if (run) run.push({ path, entry, rect });
    else runs.set(parent, [{ path, entry, rect }]);
  }
  for (const [parent, siblings] of runs) if (siblings.length < 2) runs.delete(parent);
  return runs;
}

/** Empty space between two boxes: stacked (block, size index 3) first, else side by side (inline, 2). */
function gapBetween([ax, ay, aw, ah]: Rect, [bx, by, bw, bh]: Rect): Gap | null {
  const block = Math.max(by - (ay + ah), ay - (by + bh));
  if (block >= 0) return { axis: 3, px: block };
  const inline = Math.max(bx - (ax + aw), ax - (bx + bw));
  return inline >= 0 ? { axis: 2, px: inline } : null;
}

/** The pair's gap when it changed while both siblings kept their size along it; a resized sibling can move a distributed gap by itself. */
function changedGap(before: [Sibling, Sibling], after: [Sibling, Sibling]): SpacingGap | null {
  const was = gapBetween(before[0].rect, before[1].rect);
  const now = gapBetween(after[0].rect, after[1].rect);
  if (!was || !now || was.axis !== now.axis || Math.abs(now.px - was.px) < EPSILON_PX) return null;
  const resized = before.some((s, i) => Math.abs(s.rect[was.axis] - after[i]!.rect[was.axis]) >= EPSILON_PX);
  return resized ? null : { before: was.px, after: now.px };
}

const pathKey = (run: Sibling[]): string => run.map((s) => s.path).join('\n');

/** Tag + class sequence; null for anonymous runs, too generic to pair across containers. */
function signature(run: Sibling[]): string | null {
  if (!run.some((s) => s.entry.cls.trim())) return null;
  return JSON.stringify(run.map((s) => [s.entry.tag, s.entry.cls.trim()]));
}

/** Unpaired runs keyed by signature, keeping only signatures unique on this side. */
function uniqueBySignature(runs: Sibling[][]): Map<string, Sibling[]> {
  const bySignature = new Map<string, Sibling[] | null>();
  for (const run of runs) {
    const key = signature(run);
    if (key) bySignature.set(key, bySignature.has(key) ? null : run);
  }
  return new Map([...bySignature].filter((entry): entry is [string, Sibling[]] => entry[1] !== null));
}

/**
 * Pair base and head runs: the same container holding the same sibling paths, else
 * (a run moved to a new container) the same tag + class sequence, unique on both sides.
 */
function pairRuns(before: Runs, after: Runs): [Sibling[], Sibling[]][] {
  const pairs: [Sibling[], Sibling[]][] = [];
  const unpairedAfter: Sibling[][] = [];
  const pairedBefore = new Set<Sibling[]>();
  for (const [parent, run] of after) {
    const base = before.get(parent);
    if (base && pathKey(base) === pathKey(run)) {
      pairs.push([base, run]);
      pairedBefore.add(base);
    } else unpairedAfter.push(run);
  }
  const baseBySignature = uniqueBySignature([...before.values()].filter((run) => !pairedBefore.has(run)));
  for (const [key, run] of uniqueBySignature(unpairedAfter)) {
    const base = baseBySignature.get(key);
    if (base) pairs.push([base, run]);
  }
  return pairs;
}

function runChange(before: Sibling[], after: Sibling[]): SiblingSpacingChange | null {
  const gaps = new Map<string, SpacingGap>();
  const paths = new Set<string>();
  for (let i = 0; i + 1 < after.length; i++) {
    const gap = changedGap([before[i]!, before[i + 1]!], [after[i]!, after[i + 1]!]);
    if (!gap) continue;
    gaps.set(`${gap.before}>${gap.after}`, gap);
    paths.add(after[i]!.path).add(after[i + 1]!.path);
  }
  if (!gaps.size) return null;
  const changed = after.filter((s) => paths.has(s.path));
  return {
    parent: containerOf(after[0]!.path),
    siblings: [...new Set(changed.map((s) => shortElementName(s.entry)))],
    paths: changed.map((s) => s.path),
    gaps: [...gaps.values()],
  };
}

/** Sibling runs whose spacing changed between two captures of one surface, in head order. */
export function siblingSpacingChanges(before: StyleMap, after: StyleMap): SiblingSpacingChange[] {
  const volatile = [...(before.volatile ?? []), ...(after.volatile ?? [])];
  return pairRuns(siblingRuns(before, volatile), siblingRuns(after, volatile)).flatMap(([base, head]) => {
    const change = runChange(base, head);
    return change ? [change] : [];
  });
}

/** Rendered lines per region before the rest fold into a pointer at report.json. */
const SPACING_LINES_MAX = 5;

/** "Spacing between `section.group` siblings `14px` → `0px`" lines, stacked like the glance line. */
export function spacingLines(changes: SiblingSpacingChange[]): string[] {
  if (!changes.length) return [];
  const lines = changes.slice(0, SPACING_LINES_MAX).map((change) => {
    const gaps = change.gaps.map((g) => `${codeValue(`${g.before}px`)} → ${codeValue(`${g.after}px`)}`);
    return `Spacing between ${change.siblings.map(codeValue).join(', ')} siblings ${gaps.join(', ')} _(measured between their rendered boxes)_`;
  });
  const more = changes.length - SPACING_LINES_MAX;
  if (more > 0) lines.push(`_…and ${more} more spacing change(s) — see report.json._`);
  return ['', lines.join('<br>\n')];
}

/** The not-yet-claimed changes a crop region shows: a sibling inside or around a root, or the whole run inside one. */
export function claimSpacing(
  changes: SiblingSpacingChange[],
  roots: string[],
  claimed: Set<SiblingSpacingChange>,
): SiblingSpacingChange[] {
  const inside = (p: string) => roots.some((root) => isSameOrDescendant(p, root));
  const around = (p: string) => roots.some((root) => isSameOrDescendant(root, p));
  const shows = (change: SiblingSpacingChange) =>
    inside(change.parent) || change.paths.some((p) => inside(p) || around(p));
  const own = changes.filter((change) => !claimed.has(change) && shows(change));
  for (const change of own) claimed.add(change);
  return own;
}
