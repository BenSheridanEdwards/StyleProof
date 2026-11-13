import type { PNG } from 'pngjs';
import { STATE_LAYER_NAMES, type ElementEntry, type Rect, type StyleMap } from '../capture.js';
import type { Finding, PropChange } from '../diff.js';
import { humanLabel, prettyLabel, summarizeProps, summarizePropsWithFollowOns } from '../change-groups.js';
import { isGeometryOnlyGroup } from '../findings-clean.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
import {
  changeLine,
  counted,
  plural,
  sectionNoun,
  sectionTitle,
  type SectionSubject,
  type StateChange,
  type StateDriver,
  type StateProp,
  withoutColorEchoes,
} from './change-line.js';
import {
  cropNote,
  MISLEADING_CROP_REASON,
  renderCropPair,
  stateLabel,
  type CropImages,
  type PairSize,
} from './crop-pair.js';
import { containerOf, paddedRect, screenshotRectOf, union, unionVisibleBoxes, visible, type Box } from './geometry.js';
import { cellPair, renderCropChanges } from './markdown.js';
import { formatSurfaceWithContext, hasExposedChangedEntry, screenshotPair, type RenderCtx } from './shared.js';
import { spacingLines, type SiblingSpacingChange } from './sibling-spacing.js';
import { whereMapLine, whereReceipt, writeWhereMap, type WhereMap } from './where-map.js';
import { cropGapReason, writeBudgetedPair } from './crop-budget.js';
import { cropStem } from './png.js';
import type { ReportMarkdown } from './sections.js';
import {
  encodeSectionMeta,
  SECTION_END,
  sectionRef,
  sectionRefIndex,
  type SectionMeta,
  type SectionMetaPage,
  type SectionMetaPair,
  type SectionRegistry,
} from './section-meta.js';

/**
 * Change sections: the elements in one change group that share a selector label and
 * changed the same way. Each section is one reviewable change: a name, one plain line,
 * a Where map, one clean before/after pair per changed state, and the CSS on demand.
 */

/** The resting state, or a forced state layer. */
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

/** An element's owner changes as its line states them (drawn colours kept, echoes pruned). */
const statedKeyIn =
  (maps: [StyleMap, StyleMap], target: string): StatedKey =>
  (changes) =>
    JSON.stringify(
      withoutColorEchoes(statedProps(maps, target, changes)).map((p) => [p.prop, p.pseudo ?? '', p.before, p.after]),
    );

/** The section's first element's clauses: what its change line says, one each. */
export function stateSources(section: ChangeSection, maps: [StyleMap, StyleMap]): StateSource[] {
  const target = section.paths[0];
  return elementSources(
    section.findings.filter(isStateFinding).filter((f) => subjectPath(f) === target),
    statedKeyIn(maps, target),
  );
}

/** What a clause looks like without its owner paths: elements group only when these match. */
const sourceShape = (source: StateSource, findings: StateFinding[]): string =>
  JSON.stringify([
    source.state,
    source.own,
    source.owners.map((p) => ownerLabel(findings.find((f) => f.path === p)!)).sort(),
    source.changes.map(changeKey).sort(),
  ]);

/** What the diff writes for the side of a state change the state leaves alone, per side. */
const GEOMETRY_HINT =
  '_Only size/position values moved. This is often content-length drift; check the rendered text before suspecting CSS._';

const STATE_ADDS = ['(state does not change it)', '(state no longer changes it)'] as const;

/** The diff's surface-level finding: a forced-state layer captured on one side only. */
export const SURFACE_SUBJECT = '(surface)';

const layerName = (prop: string): string => codeValue(`:${prop.replace(/^forced :/, '').replace(/ layer$/, '')}`);
const layerProps = (findings: Finding[]): PropChange[] => findings.flatMap((f) => (f.kind === 'state' ? f.props : []));

/** "The forced `:checked` state was captured on head only, so it was not compared." */
function stateLayerLine(findings: Finding[]): string {
  const layers = layerProps(findings).map((p) => ({
    name: layerName(p.prop),
    side: p.before === 'captured' ? 'base' : p.after === 'captured' ? 'head' : 'one side',
  }));
  if (layers.length === 1) {
    return `The forced ${layers[0].name} state was captured on ${layers[0].side} only, so it was not compared.`;
  }
  const list = layers.map((l) => `${l.name} (${l.side} only)`).join(', ');
  return `The forced states ${list} were captured on one side only, so they were not compared.`;
}

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
function byOwnerSharing(paths: string[], bySubject: Map<string, Finding[]>, maps: [StyleMap, StyleMap]): string[][] {
  const ownersOf = (p: string) =>
    elementSources(bySubject.get(p)!.filter(isStateFinding), statedKeyIn(maps, p)).map((source) =>
      source.owners.join('\0'),
    );
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
    const shapes = elementSources(states, statedKeyIn(maps, p))
      .map((source) => sourceShape(source, states))
      .sort();
    const key = JSON.stringify([prettyLabel(p, entry?.cls ?? ''), shapes, changeSignature(bySubject.get(p)!)]);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()]
    .flatMap((paths) => byOwnerSharing(paths, bySubject, maps))
    .map((paths) => {
      const entry = entryOf(maps, paths[0]);
      const selector = prettyLabel(paths[0], entry?.cls ?? '');
      const own = paths.flatMap((p) => bySubject.get(p)!);
      const page = maps[1].elements[paths[0]] ? maps[1] : maps[0];
      const sameSelectorCount = Object.entries(page.elements).filter(
        ([p, e]) => prettyLabel(p, e.cls) === selector,
      ).length;
      const subject: SectionSubject = {
        tag: entry?.tag ?? '',
        cls: entry?.cls ?? '',
        path: paths[0],
        texts: paths.map((p) => entryOf(maps, p)?.text ?? ''),
        count: paths.length,
        sameSelectorCount: Math.max(sameSelectorCount, paths.length),
      };
      const states = STATE_LAYER_NAMES.filter((state) => own.some((f) => f.kind === 'state' && f.state === state));
      return {
        title: paths[0] === SURFACE_SUBJECT ? 'Interaction states not compared' : sectionTitle(subject),
        selector,
        paths,
        sameSelectorCount: subject.sameSelectorCount,
        findings: own,
        states: [...(own.some((f) => f.kind !== 'state') ? (['rest'] as const) : []), ...states],
      };
    });
}

/** The section's subject as the change line sees it. */
function subjectOf(section: ChangeSection, maps: [StyleMap, StyleMap]): SectionSubject {
  const entry = entryOf(maps, section.paths[0]);
  return {
    tag: entry?.tag ?? '',
    cls: entry?.cls ?? '',
    path: section.paths[0],
    texts: section.paths.map((p) => entryOf(maps, p)?.text ?? ''),
    count: section.paths.length,
    sameSelectorCount: section.sameSelectorCount,
  };
}

/** Every element's box grew or shrank by the same amount: the visible consequence of the change. */
function sharedSizeChange(section: ChangeSection, maps: [StyleMap, StyleMap]): { dw: number; dh: number } | undefined {
  const deltas = section.paths.map((p) => {
    const a = screenshotRectOf(maps[0].elements[p]);
    const b = screenshotRectOf(maps[1].elements[p]);
    return a && b ? { dw: Math.round(b[2] - a[2]), dh: Math.round(b[3] - a[3]) } : null;
  });
  const [first] = deltas;
  if (!first || deltas.some((d) => !d || d.dw !== first.dw || d.dh !== first.dh)) return undefined;
  return first.dw || first.dh ? first : undefined;
}

/** Properties that size the element's own box; only these may explain a size change in its line. */
const SIZING =
  /^(padding|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-width|border-width|font-size|line-height|letter-spacing|width|height|(min|max)-(width|height)|inline-size|block-size|box-sizing|display|flex(-.*)?|grid(-.*)?|aspect-ratio|font-family|font-weight)/;

/**
 * "The matching opt": every grouped element has this source from its own owner path(s), a fact read
 * from paths (byOwnerSharing guarantees the elements share them all or none).
 */
function eachHasOwn(section: ChangeSection, source: StateSource, maps: [StyleMap, StyleMap]): boolean {
  if (section.paths.length < 2 || source.owners.length !== 1) return false;
  const statesOf = (p: string) => section.findings.filter(isStateFinding).filter((f) => subjectPath(f) === p);
  const shape = sourceShape(source, statesOf(section.paths[0]));
  const ownersFor = (p: string) =>
    elementSources(statesOf(p), statedKeyIn(maps, p))
      .find((other) => sourceShape(other, statesOf(p)) === shape)
      ?.owners.join('\0');
  return new Set(section.paths.map(ownersFor)).size === section.paths.length;
}

/** A control's subject for its noun: its captured entry, or its path and class when it has none (QA14-04). */
function ownerSubject(maps: [StyleMap, StyleMap], finding: StateFinding): SectionSubject {
  const entry = entryOf(maps, finding.path);
  const tag = (finding.path.split('>').pop() ?? '').trim().replace(/[:.[].*$/, '') || 'element';
  return {
    tag: entry?.tag ?? tag,
    cls: entry?.cls ?? finding.cls ?? '',
    path: finding.path,
    texts: [entry?.text ?? ''],
    count: 1,
    sameSelectorCount: 1,
  };
}

/**
 * Single owners whose clauses would read alike (one noun, different selectors: `input.pickr` and
 * `select.pickr`) are named by their selector labels (QA13-02); so are owners of one selector,
 * as main heads them.
 */
function ownerNames(sources: StateSource[], findings: StateFinding[], maps: [StyleMap, StyleMap]): Set<StateSource> {
  // Every owner's noun counts, a ×N clause's owners included: a lone owner never reads "the opt"
  // beside "`input.opt` ×2" (RV18-01, QA18-01); main heads all of them "**Opt** `input.opt`".
  const nounOf = (owner: string) =>
    sectionNoun(
      ownerSubject(
        maps,
        findings.find((f) => f.path === owner)!,
      ),
    );
  const byNoun = new Map<string, Set<string>>();
  for (const owner of sources.flatMap((source) => source.owners))
    byNoun.set(nounOf(owner), new Set([...(byNoun.get(nounOf(owner)) ?? []), owner]));
  return new Set(
    sources.filter((source) => source.owners.length === 1 && byNoun.get(nounOf(source.owners[0]))!.size > 1),
  );
}

/** Colour properties that follow `color` when unset; drawn ones are kept apart before summarising. */
const DRAWN_FOLLOWERS = new Set(['outline-color', 'column-rule-color', '-webkit-text-stroke-color']);

/**
 * Whether the element (or its pseudo-element) draws `prop`'s colour: a border, outline, column rule
 * or text stroke with a style and a width. Its colour shows in the crop even when it moves like the
 * text colour, so it is stated, never pruned as an echo (QA16-01, QA17-03).
 */
function drawsColor(maps: [StyleMap, StyleMap], target: string, pseudo: string | undefined, prop: string): boolean {
  const drawn = (style: Record<string, string>, part: string) =>
    !['none', 'hidden', undefined].includes(style[`${part}-style`]) && style[`${part}-width`] !== '0px';
  return maps.some((map) => {
    const entry = map.elements[target];
    const style = (pseudo ? entry?.pseudo?.[pseudo] : entry?.style) ?? {};
    if (/^border(?:-(?:top|right|bottom|left))?-color$/.test(prop))
      return ['top', 'right', 'bottom', 'left'].some((side) => drawn(style, `border-${side}`));
    if (prop === 'outline-color') return drawn(style, 'outline');
    if (prop === 'column-rule-color') return drawn(style, 'column-rule');
    if (prop === '-webkit-text-stroke-color') return !['0px', undefined].includes(style['-webkit-text-stroke-width']);
    return false;
  });
}

/**
 * One finding's props as a change line says them: summarised (longhands folded), with a drawn
 * outline, column rule or text stroke taken out before the summary nests it under `color` as a
 * follower (QA17-03), and every drawn colour marked `painted` so echo pruning keeps it.
 */
function statedProps(
  maps: [StyleMap, StyleMap],
  target: string,
  changes: Array<{ props: PropChange[]; pseudo?: string }>,
): StateProp[] {
  return changes.flatMap(({ props, pseudo }) => {
    const draws = (prop: string) => drawsColor(maps, target, pseudo, prop);
    const drawn = props.filter((p) => DRAWN_FOLLOWERS.has(p.prop) && draws(p.prop));
    return [...summarizeProps(props.filter((p) => !drawn.includes(p))), ...drawn].map((p) => ({
      ...p,
      ...(pseudo ? { pseudo } : {}),
      ...(draws(p.prop) ? { painted: true as const } : {}),
    }));
  });
}

/** The owner(s) a clause names, or none for the element's own state, as the capture records them. */
function sourceDriver(
  section: ChangeSection,
  maps: [StyleMap, StyleMap],
  source: StateSource,
  { firstStates, named }: { firstStates: StateFinding[]; named: Set<StateSource> },
): StateDriver | undefined {
  if (!source.owners.length) return undefined;
  const ownerOf = (path: string) => firstStates.find((f) => f.path === path)!;
  return {
    subject: ownerSubject(maps, ownerOf(source.owners[0])),
    owners: source.owners.length,
    ...(eachHasOwn(section, source, maps) ? { matching: true as const } : {}),
    // Named by selector, as main heads it: when another single owner's noun reads the same, when the
    // capture has no entry for the owner (QA14-04), and for a ×N clause.
    ...(named.has(source) || source.owners.length > 1 || !entryOf(maps, source.owners[0])
      ? { name: 'label' as const }
      : {}),
  };
}

/** The section's plain-English line, from its first element's findings (all elements changed alike). */
export function sectionLine(section: ChangeSection, maps: [StyleMap, StyleMap], folded: Finding[] = []): string {
  if (section.paths[0] === SURFACE_SUBJECT) return stateLayerLine(section.findings);
  const first = section.findings.filter((f) => subjectPath(f) === section.paths[0]);
  const dom = first.find((f): f is Extract<Finding, { kind: 'dom' }> => f.kind === 'dom');
  const target = section.paths[0];
  const rest = statedProps(
    maps,
    target,
    first.flatMap((f) => (f.kind === 'style' ? [{ props: f.props, ...(f.pseudo ? { pseudo: f.pseudo } : {}) }] : [])),
  );
  // A side the state leaves alone renders the resting value: say that value, not "none". A change on
  // `::before`/`::after` rests at the pseudo-element's own value, not the element's (RV15-02).
  const resting = (side: 0 | 1, prop: string, value: string, pseudo?: string): string => {
    if (value !== STATE_ADDS[side]) return value;
    const entry = maps[side].elements[target];
    return (pseudo ? entry?.pseudo?.[pseudo]?.[prop] : entry?.style?.[prop]) ?? value;
  };
  // One clause per owner path (#1299, the CPO's round-18 fallback). Resolve on the longhands, before
  // they fold into a shorthand (four border sides → one colour); a pseudo-element keeps its pseudo.
  const sources = stateSources(section, maps);
  const firstStates = first.filter(isStateFinding);
  const named = ownerNames(sources, firstStates, maps);
  const states: StateChange[] = sources.flatMap((source) => {
    const props = statedProps(
      maps,
      target,
      source.changes.map((f) => ({
        props: f.props.map((p) => ({
          ...p,
          before: resting(0, p.prop, p.before, pseudoOf(f)),
          after: resting(1, p.prop, p.after, pseudoOf(f)),
        })),
        ...(pseudoOf(f) ? { pseudo: pseudoOf(f) } : {}),
      })),
    );
    const driver = sourceDriver(section, maps, source, { firstStates, named });
    return props.length ? [{ state: source.state, props, ...(driver ? { driver } : {}) }] : [];
  });
  return changeLine({
    subject: subjectOf(section, maps),
    ...(isGeometryOnlyGroup(first) ? { geometryOnly: true } : {}),
    ...(folded.some((f) => f.kind !== 'state') ? { restFolded: true } : {}),
    rest,
    states,
    ...(dom ? { dom: dom.change } : {}),
    ...(rest.some((p) => SIZING.test(p.prop)) && !dom ? { size: sharedSizeChange(section, maps) } : {}),
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
      rows.push([`${label(row.prop)}${longhandNote(row, f.props)}`, ...cellPair(row.before, row.after)]);
      for (const follower of row.followOns ?? []) {
        followers.push([
          `${label(follower.prop)} (follows ${codeValue('color')})`,
          ...cellPair(follower.before, follower.after),
        ]);
      }
    }
  }
  return [...rows, ...followers];
}

/**
 * Forced-state changes in "Show the CSS": one block per owner path as main groups them (headed by
 * that owner; the element itself for its own state), identical blocks collapsed to ×N, each block
 * the preview's property table (QA14-02: swatches and "(follows `color`)" followers kept).
 */
function stateBlocks(findings: StateFinding[]): string[] {
  const byOwner = new Map<string, StateFinding[]>();
  for (const f of findings) byOwner.set(f.path, [...(byOwner.get(f.path) ?? []), f]);
  const blocks = new Map<string, { head: string; body: string[]; count: number }>();
  for (const group of byOwner.values()) {
    // Known states in their order, then any other state the capture recorded: the fold drops none.
    const known = new Set<string>(STATE_LAYER_NAMES);
    const ordered = [
      ...STATE_LAYER_NAMES.flatMap((state) => group.filter((f) => f.state === state)),
      ...group.filter((f) => !known.has(f.state)),
    ];
    const rows = propertyRows(ordered);
    if (!rows.length) continue;
    const selector = prettyLabel(group[0].path, group[0].cls ?? '');
    const human = humanLabel(group[0].path, group[0].cls ?? '');
    const head =
      human && human.toLowerCase() !== selector.toLowerCase()
        ? `**${escapeInlineMarkdown(human)}** ${codeValue(selector)}`
        : `**${codeValue(selector)}**`;
    const body = ['| Property | Before | After |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`)];
    const key = `${head}\n${body.join('\n')}`;
    const seen = blocks.get(key);
    if (seen) seen.count++;
    else blocks.set(key, { head, body, count: 1 });
  }
  return [...blocks.values()].flatMap((b) => ['', `${b.head}${b.count > 1 ? ` ×${b.count}` : ''}`, '', ...b.body]);
}

/** Forced-state pseudo-classes a captured state proves; any other pseudo-class cannot be attributed. */
const STATE_PSEUDO: Record<string, string> = {
  hover: 'hover',
  focus: 'focus',
  'focus-visible': 'focus',
  'focus-within': 'focus',
  active: 'active',
  checked: 'checked',
  disabled: 'disabled',
  'placeholder-shown': 'placeholder-shown',
};

const COMPOUND = /^([a-z][a-z0-9-]*|\*)?((?:\.[\w-]+|::?[\w-]+)*)$/i;

/**
 * Whether a simple compound selector (tag, classes, state pseudo-classes, pseudo-elements; no
 * combinators, ids or attributes) provably matches this element in one of the section's states.
 */
function compoundMatches(selector: string, entry: ElementEntry, states: Set<string>): boolean {
  const match = COMPOUND.exec(selector.trim());
  if (!match || (!match[1] && !match[2])) return false;
  const tag = match[1];
  if (tag && tag !== '*' && tag.toLowerCase() !== entry.tag.toLowerCase()) return false;
  const own = new Set(entry.cls.split(/\s+/).filter(Boolean));
  const classes = [...match[2].matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (!classes.every((c) => own.has(c))) return false;
  const pseudos = [...match[2].matchAll(/(?<!:):([\w-]+)/g)].map((m) => m[1]);
  return (tag !== undefined || classes.length > 0) && pseudos.every((p) => states.has(STATE_PSEUDO[p] ?? '\u0000'));
}

/** Changed rules (reached in a captured state) whose selector provably matches every section element. */
function attributedRules(section: ChangeSection, entries: ElementEntry[], ctxRules: SectionRegistry['rules']) {
  const states = new Set<string>(section.states);
  return ctxRules.filter((rule) => {
    if (rule.status !== 'reached') return false;
    const parts = rule.key.split(' > ');
    while (parts[0]?.startsWith('@')) parts.shift();
    const selectors = parts.join(' > ').split(',');
    return entries.length > 0 && entries.every((entry) => selectors.some((sel) => compoundMatches(sel, entry, states)));
  });
}

/** " · changed rule `.card-title` in `/styles.css`" when Change Reach knows the rule. */
function ruleMeta(rules: SectionRegistry['rules']): string {
  if (!rules.length) return '';
  const sheets = [...new Set(rules.map((r) => r.sheet ?? ''))];
  const named = rules.map((r) => codeValue(r.key));
  const where = sheets.length === 1 && sheets[0] ? ` in ${codeValue(sheets[0])}` : '';
  return ` · changed rule${rules.length === 1 ? '' : 's'} ${named.join(', ')}${where}`;
}

/** "Show the CSS": the meta line, the property table, then spacing and folded geometry. */
function cssDetailLines(
  section: ChangeSection,
  extra: {
    spacing: SiblingSpacingChange[];
    folded: Finding[];
    describe: Parameters<typeof renderCropChanges>[2];
    surfaces?: string;
    rules: SectionRegistry['rules'];
    maps: [StyleMap, StyleMap];
  },
): string[] {
  if (section.paths[0] === SURFACE_SUBJECT) return stateLayerFold(section.findings);
  const first = section.findings.filter((f) => subjectPath(f) === section.paths[0]);
  const across = extra.surfaces ? ` · the same on ${extra.surfaces}` : '';
  const verb = first.find((f): f is Extract<Finding, { kind: 'dom' }> => f.kind === 'dom')?.change ?? 'restyled';
  const meta = `${codeValue(section.selector)} · ${counted(section.paths.length, 'element')} ${verb}${ruleMeta(extra.rules)}${across}`;
  const hasDom = first.some((f) => f.kind === 'dom');
  const rows = hasDom ? [] : cssRows(first);
  // Forced states: one block per owner path, as the capture records them (stateBlocks).
  const states = hasDom ? [] : stateBlocks(first.filter(isStateFinding));
  const table = hasDom
    ? renderCropChanges(first, Infinity, extra.describe).filter((line, i) => i > 0 || line !== '')
    : [
        ...(rows.length
          ? ['| Property | Before | After |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`)]
          : []),
        ...(rows.length ? states : states.filter((line, i) => i > 0 || line !== '')),
      ];
  const folded = extra.folded.length
    ? ['', 'Folded size/position rows:', ...renderCropChanges(extra.folded, Infinity, extra.describe)]
    : [];
  return [
    '',
    '<details>',
    '<summary>Show the CSS</summary>',
    '',
    meta,
    '',
    ...table,
    // A hint, not a finding: it belongs with the CSS, not in the change line.
    ...(isGeometryOnlyGroup(first) ? ['', GEOMETRY_HINT] : []),
    ...spacingLines(extra.spacing),
    ...folded,
    '',
    '</details>',
  ];
}

/** The state-layer section's fold: which side captured each layer, in the line's words. */
function stateLayerFold(findings: Finding[]): string[] {
  const side = (value: string) => (value === 'captured' ? 'captured' : value.replace(/; not compared$/, ''));
  return [
    '',
    '<details>',
    '<summary>Show the CSS</summary>',
    '',
    'Forced-state layers captured on one side only',
    '',
    '| Layer | Base | Head |',
    '| --- | --- | --- |',
    ...layerProps(findings).map((p) => `| ${layerName(p.prop)} | ${side(p.before)} | ${side(p.after)} |`),
    '',
    '</details>',
  ];
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

export type RenderedSection = {
  md: string[];
  region: Record<string, unknown>;
  /** Whether any before/after pair was written. */
  shown: boolean;
};

const stateWhat = (state: PairState): string =>
  state === 'rest' ? '' : ` ${stateLabel(state)?.replace(/^While/, 'while') ?? `in :${state}`}`;

/** Why a state has no pair: no screenshot for it, a zero-size box, or nothing changed is exposed in it. */
function noPairNote(
  ctx: RenderCtx,
  maps: [StyleMap, StyleMap],
  state: PairState,
  targets: string[],
  pngs: [PNG | null, PNG | null],
): string {
  if (state !== 'rest' && (!pngs[0] || !pngs[1])) {
    return `_No :${state} screenshot in these capture sets (re-capture to compare both sides in :${state})._`;
  }
  // Never crop unrelated pixels: say which of the reasons applies instead.
  const box = targets.map((p) => elementBox(ctx, maps, p)).find((b) => b);
  return cropNote(box ?? null, pngs[0], pngs[1]) ?? '';
}

type SectionInput = {
  section: ChangeSection;
  surface: string;
  /** Every surface in the change group, when there are several. */
  surfaces?: string;
  maps: [StyleMap, StyleMap];
  pngs: [PNG | null, PNG | null];
  seq: { crop: number };
  spacing: SiblingSpacingChange[];
  folded: Finding[];
  describe: Parameters<typeof renderCropChanges>[2];
  cropsAllowed: boolean;
};

type SectionPairs = {
  md: string[];
  note?: string;
  images: CropImages;
  stateImages: Record<string, CropImages>;
  /** The written pairs, for report.html. */
  meta: SectionMetaPair[];
  /** A pair was left out for a limit (the element is visible): which one. */
  omitted?: 'budget' | 'max-crops';
  /** Some pair the section needed had both screenshots. */
  screenshots?: true;
};

/** The elements a state's pair is about: every section element at rest, the state's targets otherwise. */
const pairTargets = (section: ChangeSection, state: PairState): string[] =>
  state === 'rest'
    ? section.paths
    : [...new Set(section.findings.filter((f) => f.kind === 'state' && f.state === state).map(subjectPath))];

type StatePair = {
  md: string[];
  note?: string;
  images?: CropImages;
  size?: PairSize;
  /** Why the pair was left out (the crop budget, or the image was too large). */
  omitted?: 'budget' | 'size';
  /** Both screenshots for this state exist. */
  screenshots?: true;
};

/** One state's clean pair, or the reason it has none. */
function statePair(ctx: RenderCtx, input: SectionInput, state: PairState, what: string): StatePair {
  const { section, surface, maps, seq } = input;
  const pngs = state === 'rest' ? input.pngs : screenshotPair(ctx, surface, `.${state}`);
  const targets = pairTargets(section, state);
  const target = targets.find((p) => hasExposedChangedEntry(maps[0], maps[1], [p], pngs) && elementBox(ctx, maps, p));
  // Both screenshots exist: a missing pair then means nothing changed is exposed in them (RV15-07).
  const screenshots = pngs[0] && pngs[1] ? { screenshots: true as const } : {};
  if (!target || !pngs[0] || !pngs[1]) {
    const missing = noPairNote(ctx, maps, state, targets, pngs);
    return state === 'rest'
      ? { md: [], note: missing, ...screenshots }
      : { md: ['', `**${stateLabel(state) ?? `In :${state}`}**`, '', missing], ...screenshots };
  }
  seq.crop++;
  const pair = renderCropPair(ctx, {
    surface,
    suffix: String(seq.crop),
    box: frameBox(ctx, maps, target)!,
    pngA: pngs[0],
    pngB: pngs[1],
    ...(state === 'rest' ? {} : { state }),
    what: `${what}${stateWhat(state)}`,
  })!;
  return {
    md: pair.md,
    images: pair.images,
    screenshots: true,
    ...(pair.size ? { size: pair.size } : {}),
    ...(pair.omitted ? { omitted: pair.omitted } : {}),
  };
}

/** One clean before/after pair per state, or the reason a state has none. */
function sectionPairs(ctx: RenderCtx, input: SectionInput, what: string): SectionPairs {
  const out: SectionPairs = { md: [], images: {}, stateImages: {}, meta: [] };
  // Past `--max-crops`: no pair and no note here; the report's opening says it once (rule 5).
  if (!input.cropsAllowed) {
    ctx.cropGaps?.push({ reason: 'max-crops', where: input.surface });
    return { ...out, omitted: 'max-crops' };
  }
  for (const state of input.section.states)
    addStatePair(ctx, input, out, state, statePair(ctx, input, state, what), what);
  return out;
}

/** Add one state's pair to the section: its lines, images and report.html data, or its gap. */
function addStatePair(
  ctx: RenderCtx,
  input: SectionInput,
  out: SectionPairs,
  state: PairState,
  pair: StatePair,
  what: string,
): void {
  pair.md.forEach((line) => out.md.push(line));
  if (pair.note) out.note = pair.note;
  if (pair.screenshots) out.screenshots = true;
  if (pair.omitted) {
    // One gap per section, however many of its pairs were left out (RV11-02).
    if (!out.omitted) ctx.cropGaps?.push({ reason: pair.omitted, where: input.surface });
    out.omitted = 'budget';
  }
  if (state === 'rest' && pair.images) out.images = pair.images;
  else if (pair.images?.after) out.stateImages[state] = pair.images;
  if (pair.images?.before && pair.images.after && pair.size) {
    out.meta.push({
      state,
      before: pair.images.before,
      after: pair.images.after,
      width: pair.size.w,
      height: pair.size.h,
      ...(pair.size.base ? { baseWidth: pair.size.base.w, baseHeight: pair.size.base.h } : {}),
      what: `${what}${stateWhat(state)}`,
    });
  }
}

/** The section's report.json region: the same shape as before, with clean images and Where receipts. */
function sectionRegion(ctx: RenderCtx, input: SectionInput, pairs: SectionPairs, where: WhereMap[], shown: boolean) {
  const { section, maps } = input;
  const boxes = (side: 0 | 1) =>
    section.paths.reduce<Box | null>(
      (acc, p) => unionVisibleBoxes(acc, paddedRect(maps[side].elements[p], ctx.padBy)),
      null,
    );
  return {
    paths: section.paths,
    before: boxes(0),
    after: boxes(1),
    images: pairs.images,
    ...(Object.keys(pairs.stateImages).length ? { stateImages: pairs.stateImages } : {}),
    ...(where.length ? { where: where.map(whereReceipt) } : {}),
    // A limit left the crop out: say which (main's `cropOmitted: 'budget'`, plus `'max-crops'`).
    ...(pairs.omitted ? { cropOmitted: pairs.omitted } : {}),
    // The section's own screenshots exist but no changed element is exposed in them: say so in the
    // receipt too. A state-only section with no state screenshots has nothing to be hidden in (RV15-07).
    ...(!shown && !pairs.omitted && pairs.screenshots
      ? { visualEvidence: 'not-rendered', reason: MISLEADING_CROP_REASON }
      : {}),
    ...(input.spacing.length ? { spacing: input.spacing } : {}),
  };
}

/** One change section: heading, line, Where map, a clean pair per state, then the CSS. */
export function renderChangeSection(ctx: RenderCtx, input: SectionInput): RenderedSection {
  const { section, surface, maps } = input;
  const noun = sectionNoun(subjectOf(section, maps));
  const pairs = sectionPairs(ctx, input, section.paths.length > 1 ? `the first ${noun}` : `the ${noun}`);
  const shown = Boolean(pairs.images.after || Object.keys(pairs.stateImages).length);
  // A Where map the crop budget leaves out is an omitted crop of this section (QA12-04): recorded
  // in report.json and counted once in the opening, like a pair the budget leaves out.
  const where = shown
    ? sectionWhereMaps(ctx, surface, section, maps, input.pngs, input.seq, () => {
        if (!pairs.omitted) ctx.cropGaps?.push({ reason: cropGapReason(ctx.crops), where: surface });
        pairs.omitted = 'budget';
      })
    : [];
  const things = section.paths.length > 1 ? `${section.paths.length} ${plural(noun)}` : `1 ${noun}`;
  const page = formatSurfaceWithContext(surface, ...maps);
  // The Where caption names the page; without a map, a short line does.
  const whereLines = where.length
    ? where.flatMap((map) => ['', whereMapLine(ctx, map, things, page)])
    : ['', `_On ${page}_`];
  const ref = registerSection(ctx, section, surface, pairs.meta, where);
  const md = [
    '',
    `### ${section.title}`,
    ...(ref ? ['', ref] : []),
    '',
    sectionLine(section, maps, input.folded),
    ...whereLines,
    ...(pairs.note ? ['', pairs.note] : []),
    ...pairs.md,
    ...cssDetailLines(section, { ...input, rules: sectionRules(ctx, section, maps, ref) }),
    ...(ref ? ['', SECTION_END] : []),
  ];
  return { md, region: sectionRegion(ctx, input, pairs, where, shown), shown };
}

/** Where maps: every section element boxed on the resting head page, removals on the base page. */
function sectionWhereMaps(
  ctx: RenderCtx,
  surface: string,
  section: ChangeSection,
  maps: [StyleMap, StyleMap],
  [pngA, pngB]: [PNG | null, PNG | null],
  seq: { crop: number },
  onOmitted: () => void,
): WhereMap[] {
  const rectsOf = (paths: string[], map: StyleMap): Rect[] =>
    paths.map((p) => screenshotRectOf(map.elements[p])).filter((r): r is Rect => !!r);
  const onHead = section.paths.filter((p) => maps[1].elements[p]);
  const gone = section.paths.filter((p) => !maps[1].elements[p]);
  const suffix = `${seq.crop}`;
  return [
    pngB &&
      writeWhereMap(ctx, { surface, suffix, page: pngB, side: 'after', rects: rectsOf(onHead, maps[1]), onOmitted }),
    pngA &&
      writeWhereMap(ctx, {
        surface,
        suffix: `${suffix}-before`,
        page: pngA,
        side: 'before',
        rects: rectsOf(gone, maps[0]),
        onOmitted,
      }),
  ].filter((m): m is WhereMap => !!m);
}

const MAX_META_PATHS = 20;

/** A URL-safe id, unique in the report: "card-titles", "card-titles-2". */
function sectionId(registry: SectionRegistry, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'change';
  // report.html's own ids ("What was captured", inlined pages) are never a section's.
  const base = slug === 'coverage-title' || slug.startsWith('sp-') ? `change-${slug}` : slug;
  const taken = new Set(registry.metas.map((m) => m.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The changed rules this section's elements match, recorded for "What was captured". */
function sectionRules(ctx: RenderCtx, section: ChangeSection, maps: [StyleMap, StyleMap], ref: string | null) {
  const registry = ctx.sections;
  if (!registry?.rules.length) return [];
  const entries = section.paths.map((p) => entryOf(maps, p)).filter((e): e is ElementEntry => !!e);
  const rules = attributedRules(section, entries, registry.rules);
  const id = ref ? registry.metas[sectionRefIndex(ref) ?? -1]?.id : undefined;
  for (const rule of rules) if (id && !registry.ruleSections.has(rule.key)) registry.ruleSections.set(rule.key, id);
  return rules;
}

/** Record the section's report.html data and return its placeholder line (null when not collecting). */
function registerSection(
  ctx: RenderCtx,
  section: ChangeSection,
  surface: string,
  pairs: SectionMetaPair[],
  where: WhereMap[],
): string | null {
  const registry = ctx.sections;
  if (!registry) return null;
  const meta: SectionMeta = {
    v: 1,
    id: sectionId(registry, section.title),
    // The surface-level state-layer finding has no element to list.
    paths: section.paths[0] === SURFACE_SUBJECT ? [] : section.paths.slice(0, MAX_META_PATHS),
    more: Math.max(0, section.paths.length - MAX_META_PATHS),
    pairs,
    where: where.map((map) => ({
      image: map.image,
      side: map.side,
      page: [map.page.w, map.page.h],
      view: [map.view.x, map.view.y, map.view.w, map.view.h],
      boxes: map.boxes.map((b) => [b.x, b.y, b.w, b.h]),
    })),
    pages: [],
  };
  registry.metas.push(meta);
  for (const state of pairs.length ? ['rest', ...pairs.map((p) => p.state)] : []) {
    if (!registry.pages.some((p) => p.surface === surface && p.state === state))
      registry.pages.push({ surface, state });
  }
  pageOwners.set(meta, { surface, states: [...new Set(pairs.map((p) => p.state))] });
  return sectionRef(registry.metas.length - 1);
}

/** Which surface and states each section's whole pages come from. */
const pageOwners = new WeakMap<SectionMeta, { surface: string; states: string[] }>();

/** Write each requested whole-page pair while the crop budget allows; keyed by surface and state. */
function writeWholePages(ctx: RenderCtx, registry: SectionRegistry): Map<string, SectionMetaPage> {
  const written = new Map<string, SectionMetaPage>();
  for (const { surface, state } of registry.pages) {
    const [pngA, pngB] = screenshotPair(ctx, surface, state === 'rest' ? '' : `.${state}`);
    if (!pngA || !pngB) continue;
    const stem = cropStem(surface, state === 'rest' ? 'page' : `page-${state}`);
    // `-base` / `-head`, never `-before` / `-after`: those names mean clean crops.
    const page: SectionMetaPage = {
      state,
      before: `${stem}-base.png`,
      after: `${stem}-head.png`,
      width: pngB.width,
      height: pngB.height,
      ...(pngA.width !== pngB.width || pngA.height !== pngB.height
        ? { baseWidth: pngA.width, baseHeight: pngA.height }
        : {}),
    };
    // Optional context, never evidence: a page that does not fit is left out without counting an omitted crop.
    // Its width and height stay the capture's: they are the SVG coordinates the Where boxes are drawn in.
    if (writeBudgetedPair(ctx, [page.before, pngA], [page.after, pngB], { context: true })) {
      written.set(`${surface}\0${state}`, page);
    }
  }
  return written;
}

/**
 * After every crop: write the whole-page captures the sections asked for, while the crop
 * budget allows, then put each section's final comment line in place of its placeholder.
 */
export function finishSections(ctx: RenderCtx, md: ReportMarkdown): void {
  const registry = ctx.sections;
  if (!registry) return;
  const written = writeWholePages(ctx, registry);
  for (const meta of registry.metas) {
    const owner = pageOwners.get(meta);
    const states = owner ? ['rest', ...owner.states.filter((state) => state !== 'rest')] : [];
    meta.pages = states.flatMap((state) => written.get(`${owner!.surface}\0${state}`) ?? []);
  }
  md.mapQueued((line) => {
    const index = sectionRefIndex(line);
    return index === null ? line : encodeSectionMeta(registry.metas[index]);
  });
}
