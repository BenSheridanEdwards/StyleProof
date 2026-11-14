import type { PNG } from 'pngjs';
import type { RenderCtx } from './shared.js';
import { hasExposedChangedEntry, screenshotPair, formatSurfaceWithContext } from './shared.js';
import { renderCropPair, cropNote, type CropImages, type PairSize } from './crop-pair.js';
import { sectionLine } from './change-line.js';
import { writeWhereMap, whereReceipt, whereMapLine, type WhereMap } from './where-map.js';
import { paddedRect, unionVisibleBoxes, type Box } from './geometry.js';
import { codeValue } from '../code-span.js';
import { STATE_LAYER_NAMES, type ElementEntry, type StyleMap } from '../capture.js';
import type { Finding, PropChange } from '../diff.js';
import { prettyLabel, summarizeProps, summarizePropsWithFollowOns } from '../change-groups.js';
import { sectionTitle } from './section-title.js';
import { screenshotRectOf } from './geometry.js';

export type PairState = 'rest' | (typeof STATE_LAYER_NAMES)[number];

export type ChangeSection = {
  title: string;
  selector: string;
  /** The changed elements (state targets, not their owners), top-to-bottom, left-to-right. */
  paths: string[];
  /** Elements on the captured page with the same selector label. */
  sameSelectorCount: number;
  /** Every shown finding about these elements. */
  findings: Finding[];
  /** Pairs to show: resting first when anything changed at rest, then each forced state. */
  states: PairState[];
};

/**
 * One clause of a section's change line: a forced-state change and the owner path(s) that made it,
 * as the capture records them (#1299), in main's own per-owner wording (the CPO's round-18
 * fallback): one clause per owner path; owners of one selector that stated the same changes are one
 * clause, as main collapses identical blocks to ×N ("when `input.opt` ×3 is checked"); the
 * element's own state is always its own clause. Nothing is counted across owners.
 */
export type StateSource = {
  state: Exclude<PairState, 'rest'>;
  /** The element's own state made this change. */
  own: boolean;
  /** The owner paths that made it (none for the element's own state). */
  owners: string[];
  /** The changes (the first owner's; every owner of a ×N clause stated the same). */
  changes: StateFinding[];
};

type StateFinding = Extract<Finding, { kind: 'state' }>;
const isStateFinding = (f: Finding): f is StateFinding => f.kind === 'state';
const ownState = (f: StateFinding): boolean => f.path === subjectPath(f);
const ownerLabel = (f: StateFinding): string => prettyLabel(f.path, f.cls ?? '');
/** One change: its state, target pseudo-element and props, byte for byte. */
const changeKey = (f: StateFinding): string =>
  JSON.stringify([f.state, pseudoOf(f) ?? '', f.props.map((p) => [p.prop, p.before, p.after])]);

/** One owner's changes as the line states them, for telling identical owner blocks apart. */
type StatedKey = (changes: StateFinding[]) => string;

/**
 * One element's clauses, in state order: one per owner path (its several changes together), the
 * element's own state on its own, and owners of one selector that stated the same changes as one ×N
 * clause, as main collapses identical blocks.
 */
function elementSources(findings: StateFinding[], keyOf: StatedKey): StateSource[] {
  return STATE_LAYER_NAMES.flatMap((state) => {
    const byOwner = new Map<string, StateFinding[]>();
    for (const f of findings.filter((finding) => finding.state === state)) {
      const owner = ownState(f) ? '' : f.path;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), f]);
    }
    const out: Array<StateSource & { key?: string }> = [];
    for (const [owner, changes] of byOwner) {
      if (!owner) {
        out.push({ state, own: true, owners: [], changes });
        continue;
      }
      const key = JSON.stringify([ownerLabel(changes[0]), keyOf(changes)]);
      const seen = out.find((source) => source.key === key);
      if (seen) seen.owners.push(owner);
      else out.push({ state, own: false, owners: [owner], changes, key });
    }
    // The element's own state comes first in its state, whatever order the capture recorded.
    return [...out.filter((source) => source.own), ...out.filter((source) => !source.own)].map(
      ({ state: at, own, owners, changes }) => ({ state: at, own, owners, changes }),
    );
  });
}

/** What a clause looks like without its owner paths: elements group only when these match. */
const sourceShape = (source: StateSource, findings: StateFinding[]): string =>
  JSON.stringify([
    source.state,
    source.own,
    source.owners.map((p) => ownerLabel(findings.find((f) => f.path === p)!)).sort(),
    source.changes.map(changeKey).sort(),
  ]);

/** The element a finding changes: a state finding's target, otherwise its own path. */
export const subjectPath = (f: Finding): string => (f.kind === 'state' ? f.sub.replace(/::[\w-]+$/, '') : f.path);

const pseudoOf = (f: Finding): string | undefined =>
  f.kind === 'style' ? (f.pseudo ?? undefined) : f.kind === 'state' ? /::[\w-]+$/.exec(f.sub)?.[0] : undefined;

const propsOf = (f: Finding): PropChange[] => (f.kind === 'dom' ? [] : summarizeProps(f.props));

/** What changed on one element, without its path: equal for elements that changed the same way. */
function changeSignature(findings: Finding[]): string {
  return JSON.stringify(
    findings
      .map((f) => [
        f.kind,
        f.kind === 'dom' ? f.change : f.kind === 'state' ? f.state : '',
        pseudoOf(f) ?? '',
        f.kind === 'state' && subjectPath(f) !== f.path ? 'driven' : '',
        propsOf(f).map((p) => [p.prop, p.before, p.after]),
      ])
      .map((row) => JSON.stringify(row))
      .sort(),
  );
}

const entryOf = (maps: [StyleMap, StyleMap], p: string): ElementEntry | undefined =>
  maps[1].elements[p] ?? maps[0].elements[p];

/** Page order: top, then left; elements without a box keep the findings' (document) order. */
function byPosition(maps: [StyleMap, StyleMap], order: string[]): (l: string, r: string) => number {
  const at = (p: string) => screenshotRectOf(entryOf(maps, p)) ?? [Infinity, Infinity, 0, 0];
  return (l, r) => at(l)[1] - at(r)[1] || at(l)[0] - at(r)[0] || order.indexOf(l) - order.indexOf(r);
}

/**
 * Owner paths are a fact the line states: either every grouped element is restyled by the same
 * owner(s) ("when the opt is checked"), or each by its own ("when the matching opt is checked").
 * A group that is neither is split, so the line never generalises past the capture.
 */
function byOwnerSharing(paths: string[], bySubject: Map<string, Finding[]>): string[][] {
  const ownersOf = (p: string) =>
    elementSources(bySubject.get(p)!.filter(isStateFinding), (changes) =>
      JSON.stringify(changes.map(changeKey).sort()),
    ).map((source) => source.owners.join('\0'));
  const tuples = paths.map(ownersOf);
  const shared = tuples.every((t) => JSON.stringify(t) === JSON.stringify(tuples[0]));
  const distinct = tuples[0].every((_, i) => new Set(tuples.map((t) => t[i])).size === tuples.length || !tuples[0][i]);
  if (shared || distinct) return [paths];
  const split = new Map<string, string[]>();
  paths.forEach((p, i) => split.set(JSON.stringify(tuples[i]), [...(split.get(JSON.stringify(tuples[i])) ?? []), p]));
  return [...split.values()];
}

/** Group a change group's shown findings into change sections, in page order. */
export function buildChangeSections(findings: Finding[], maps: [StyleMap, StyleMap]): ChangeSection[] {
  const bySubject = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = subjectPath(f);
    bySubject.set(key, [...(bySubject.get(key) ?? []), f]);
  }
  const order = byPosition(maps, [...bySubject.keys()]);
  const groups = new Map<string, string[]>();
  for (const p of [...bySubject.keys()].sort(order)) {
    const entry = entryOf(maps, p);
    // Elements group only when their state sources have the same shape (own or owner label, owner
    // count, props), so a line drawn from the first element is true of every element.
    const states = bySubject.get(p)!.filter(isStateFinding);
    const shapes = elementSources(states, (changes) => JSON.stringify(changes.map(changeKey).sort()))
      .map((source) => sourceShape(source, states))
      .sort();
    const key = JSON.stringify([prettyLabel(p, entry?.cls ?? ''), shapes, changeSignature(bySubject.get(p)!)]);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()]
    .flatMap((paths) => byOwnerSharing(paths, bySubject))
    .map((paths) => {
      const entry = entryOf(maps, paths[0]);
      const selector = prettyLabel(paths[0], entry?.cls ?? '');
      const own = paths.flatMap((p) => bySubject.get(p)!);
      const page = maps[1].elements[paths[0]] ? maps[1] : maps[0];
      const sameSelectorCount = Object.entries(page.elements).filter(
        ([p, e]) => prettyLabel(p, e.cls) === selector,
      ).length;
      const subject = {
        tag: entry?.tag ?? '',
        cls: entry?.cls ?? '',
        path: paths[0],
        texts: paths.map((p) => entryOf(maps, p)?.text ?? ''),
        count: paths.length,
        sameSelectorCount: Math.max(sameSelectorCount, paths.length),
      };
      const states = STATE_LAYER_NAMES.filter((state) => own.some((f) => f.kind === 'state' && f.state === state));
      return {
        title: sectionTitle(subject),
        selector,
        paths,
        sameSelectorCount: subject.sameSelectorCount,
        findings: own,
        states: [...(own.some((f) => f.kind !== 'state') ? (['rest'] as const) : []), ...states],
      };
    });
}

/** "(8 longhands)" when a shorthand row folds several captured longhands that moved alike. */
function longhandNote(row: PropChange, raw: PropChange[]): string {
  if (raw.some((p) => p.prop === row.prop)) return '';
  const suffix = /-(color|width|style|radius)$/.exec(row.prop)?.[1];
  const stem = suffix ? row.prop.slice(0, -suffix.length - 1) : row.prop;
  const pattern = suffix ? new RegExp(`^${stem}-.+-${suffix}$`) : new RegExp(`^${stem}-`);
  const n = raw.filter((p) => pattern.test(p.prop)).length;
  return n > 1 ? ` (${n} longhands)` : '';
}

/** `color` leads the rows that moved exactly like it (a `border-color` echo), as a reviewer reads the change. */
function colorFirst<T extends PropChange>(rows: T[]): T[] {
  const color = rows.find((r) => r.prop === 'color');
  if (!color) return rows;
  const echoes = (r: T) => r !== color && r.before === color.before && r.after === color.after;
  const at = rows.findIndex((r) => r === color || echoes(r));
  return [...rows.slice(0, at), color, ...rows.slice(at).filter((r) => r !== color)];
}

/**
 * The resting CSS table rows for one element's findings: rest, then pseudo-elements; followers last.
 * Forced states are not rows here: they render as main's one block per owner path (cssDetailLines).
 */
export function cssRows(findings: Finding[]): string[][] {
  return propertyRows([
    ...findings.filter((f) => f.kind === 'style' && !f.pseudo),
    ...findings.filter((f) => f.kind === 'style' && f.pseudo),
  ]);
}

/**
 * The preview's property rows: `prefix prop` | before | after, colour-led, folded longhands noted,
 * followers last as "(follows `color`)". A state row's prefix is its state (`:hover`), then any
 * pseudo-element (`:checked ::before`); report.html adds a swatch to each single colour value.
 */
function propertyRows(findings: Finding[]): string[][] {
  const rows: string[][] = [];
  const followers: string[][] = [];
  for (const f of findings) {
    if (f.kind === 'dom') continue;
    const prefix = [f.kind === 'state' ? `:${f.state}` : '', pseudoOf(f) ?? ''].filter(Boolean).join(' ');
    const label = (prop: string) => codeValue(prefix ? `${prefix} ${prop}` : prop);
    for (const row of colorFirst(summarizePropsWithFollowOns(f.props))) {
      rows.push([`${label(row.prop)}${longhandNote(row, f.props)}`, codeValue(row.before), codeValue(row.after)]);
      for (const follower of row.followOns ?? []) {
        followers.push([
          `${label(follower.prop)} (follows ${codeValue('color')})`,
          codeValue(follower.before),
          codeValue(follower.after),
        ]);
      }
    }
  }
  return [...rows, ...followers];
}

/** Resting properties available for review beneath the crop. */
export function cssDetailLines(findings: Finding[]): string[] {
  const rows = cssRows(findings);
  return rows.length
    ? [
        '',
        '<details>',
        '<summary>Show the CSS</summary>',
        '',
        '| Property | Before | After |',
        '| --- | --- | --- |',
        ...rows.map((row) => `| ${row.join(' | ')} |`),
        '',
        '</details>',
      ]
    : [];
}

type SectionInput = {
  section: ChangeSection;
  surface: string;
  maps: [StyleMap, StyleMap];
  pngs: [PNG | null, PNG | null];
  seq: { crop: number };
  box: Box | null;
  details: string[];
  alsoInView?: string;
};
function registerSection(): null {
  return null;
}
function statePair(ctx: RenderCtx, input: SectionInput, state: PairState) {
  const pngs = state === 'rest' ? input.pngs : screenshotPair(ctx, input.surface, `.${state}`);
  const { section, maps, box } = input;
  if (state !== 'rest' && (!pngs[0] || !pngs[1])) {
    return {
      md: ['', `_No :${state} screenshot in these capture sets (re-capture to compare both sides in :${state})._`],
      images: {} as CropImages,
    };
  }
  if (!box || !pngs[0] || !pngs[1] || !hasExposedChangedEntry(maps[0], maps[1], section.paths, pngs)) {
    return { md: ['', cropNote(box, pngs[0], pngs[1]) ?? ''], images: {} as CropImages };
  }
  return renderCropPair(ctx, {
    surface: input.surface,
    suffix: String(++input.seq.crop),
    box,
    pngA: pngs[0],
    pngB: pngs[1],
    rectsA: [],
    rectsB: [],
    what: `${section.title}${state === 'rest' ? '' : ` in :${state}`}`,
    captions: { annotated: '', zoom: (factor) => `magnified ${factor}×` },
    alsoInView: input.alsoInView,
  })!;
}
type SectionPairs = {
  md: string[];
  images: CropImages;
  stateImages: Record<string, CropImages>;
  omitted: boolean;
  size?: PairSize;
};

/** Fill the resting or state image slots from one pair. */
function applyPairImages(out: SectionPairs, state: PairState, pair: { images: CropImages; size?: PairSize }) {
  if (state === 'rest') {
    out.images = pair.images;
    if ('size' in pair) out.size = pair.size;
    return;
  }
  if (pair.images.after || pair.images.before) {
    out.stateImages[state] = pair.images;
    if (!out.size && 'size' in pair) out.size = pair.size;
  }
}

/** A state-only section still publishes the first state's pair as `images`. */
function restingImages(images: CropImages, stateImages: Record<string, CropImages>): CropImages {
  return images.before || images.after
    ? images
    : (Object.values(stateImages).find((p) => p.after || p.before) ?? images);
}

function sectionPairs(ctx: RenderCtx, input: SectionInput) {
  const out: SectionPairs = { md: [], images: {}, stateImages: {}, omitted: false };
  for (const state of input.section.states) {
    const pair = statePair(ctx, input, state);
    for (const line of pair.md) out.md.push(line);
    if ('omitted' in pair && pair.omitted) out.omitted = true;
    applyPairImages(out, state, pair);
  }
  out.images = restingImages(out.images, out.stateImages);
  return out;
}
function sectionWhereMaps(ctx: RenderCtx, input: SectionInput): WhereMap[] {
  return ([0, 1] as const).flatMap((side) => {
    const page = input.pngs[side];
    if (!page) return [];
    const rects = input.section.paths
      .filter((p) => side === 1 || !input.maps[1].elements[p])
      .map((p) => screenshotRectOf(input.maps[side].elements[p]))
      .filter((r): r is NonNullable<typeof r> => !!r);
    const map = writeWhereMap(ctx, {
      surface: input.surface,
      suffix: `${input.seq.crop}-${side}`,
      page,
      side: side ? 'after' : 'before',
      rects,
    });
    return map ? [map] : [];
  });
}
export function renderChangeSection(ctx: RenderCtx, input: SectionInput) {
  const { section, maps } = input;
  const pairs = sectionPairs(ctx, input);
  const shown = Boolean(pairs.images.after || Object.values(pairs.stateImages).some((p) => p.after));
  const where = shown ? sectionWhereMaps(ctx, input) : [];
  registerSection();
  const boxes = (side: 0 | 1) =>
    section.paths.reduce<Box | null>(
      (box, p) => unionVisibleBoxes(box, paddedRect(maps[side].elements[p], ctx.padBy)),
      null,
    );
  return {
    md: [
      '',
      `### ${section.title}`,
      '',
      sectionLine(section, maps),
      ...where.flatMap((map) => [
        '',
        whereMapLine(ctx, map, section.title, formatSurfaceWithContext(input.surface, maps[0], maps[1])),
      ]),
      ...pairs.md,
      ...cssDetailLines(section.findings),
      ...input.details,
    ],
    region: {
      paths: section.paths,
      before: boxes(0),
      after: boxes(1),
      images: pairs.images,
      ...(pairs.size ? { size: pairs.size } : {}),
      ...(Object.keys(pairs.stateImages).length ? { stateImages: pairs.stateImages } : {}),
      ...(where.length ? { where: where.map(whereReceipt) } : {}),
      ...(pairs.omitted ? { cropOmitted: 'budget' } : {}),
    },
  };
}
