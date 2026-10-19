import { formatSurfaceList, safeKey } from '../change-groups.js';
import { codeValue } from '../code-span.js';
import { describeElement, tokenIndex } from '../describe.js';
import { presentationBeforeMap } from '../path-correspondence.js';
import type { OneSidedStatus } from './headline.js';
import { buildElementChanges, clipText } from './markdown.js';
import type { ChangeGroup, RenderCtx } from './shared.js';

/** The "What changed" block: one row per one-sided surface and per change group, above the PR-comment cut. */

export type DigestElement = { name: string; phrase: string };
export type DigestRow = {
  surface: string;
  status: OneSidedStatus | 'changed';
  /** Other surfaces carrying the same change (changed rows only, when non-zero). */
  otherSurfaces?: number;
  /** The change rode the shared frame: every surface base that renders the element. */
  chrome?: true;
  elements: DigestElement[];
  /** Changed elements not listed in `elements`. */
  more: number;
};

const MAX_ROWS = 10;
const MAX_ELEMENTS = 3;
// A hostile map can make a phrase arbitrarily long; past this it stops being a glance.
const MAX_PHRASE = 240;
// Real labels are `tag.class` idents and real states plain words; anything else is
// map-authored and must not reach the comment, not even inside a code span.
const safeName = (label: string): string => clipText(label.replace(/[^\w.-]/g, '-'), 80);
const safeState = (state: string): string => state.replace(/[^\w -]/g, '-');
// Same rule for token names: a code span keeps them inert as Markdown but not as a receipt marker.
const identTokens = (tokens?: Record<string, string>): Map<string, string> =>
  new Map([...tokenIndex(tokens)].filter(([, name]) => /^[\p{L}\p{N}_-]+$/u.test(name)));

const ONE_SIDED_TEXT: Record<OneSidedStatus, string> = {
  new: '🆕 new surface, no baseline',
  removed: '🗑️ removed surface',
  'capture-failed': '⚠️ baseline repair needed',
};

function changedRow(ctx: RenderCtx, cg: ChangeGroup, chrome: boolean): DigestRow {
  const { sd, findings } = cg.rep;
  const mapB = ctx.load(ctx.afterDir, sd.surface);
  const mapA = presentationBeforeMap(ctx.load(ctx.beforeDir, sd.surface), mapB);
  const describeCtx = { tokensBefore: identTokens(mapA.tokens), tokensAfter: identTokens(mapB.tokens) };
  const els = buildElementChanges(findings);
  const elements = els.slice(0, MAX_ELEMENTS).map((el) => {
    const phrase = describeElement({ ...el, states: el.states?.map(safeState) }, describeCtx);
    return { name: safeName(el.label), phrase: phrase.length > MAX_PHRASE ? 'restyled' : phrase };
  });
  return {
    surface: sd.surface,
    status: 'changed',
    ...(cg.surfaces.length > 1 ? { otherSurfaces: cg.surfaces.length - 1 } : {}),
    ...(chrome ? { chrome: true as const } : {}),
    elements,
    more: els.length - elements.length,
  };
}

/** One-sided surfaces first (review first), then shared-chrome groups, then the rest. */
export function buildDigest(
  ctx: RenderCtx,
  oneSided: Array<{ surface: string; status: OneSidedStatus }>,
  groups: { chrome: ChangeGroup[]; rest: ChangeGroup[] },
): DigestRow[] {
  return [
    ...oneSided.map(({ surface, status }) => ({ surface, status, elements: [], more: 0 })),
    ...groups.chrome.map((cg) => changedRow(ctx, cg, true)),
    ...groups.rest.map((cg) => changedRow(ctx, cg, false)),
  ];
}

function rowLine(row: DigestRow): string {
  const surface = codeValue(formatSurfaceList([safeKey(row.surface)]));
  if (row.status !== 'changed') return `- ${surface} — ${ONE_SIDED_TEXT[row.status]}`;
  const where = row.chrome
    ? `${surface} · 🧱 global chrome, on every surface base that renders it`
    : row.otherSurfaces
      ? `${surface} +${row.otherSurfaces} more surface(s)`
      : surface;
  const parts = row.elements.map((e) => `**${codeValue(e.name)}** ${e.phrase}`);
  if (row.more > 0) parts.push(`+${row.more} more element(s)`);
  return `- ${where} — ${parts.join(' · ')}`;
}

/** The block's Markdown, rows capped with a count of what is left out; empty when nothing changed. */
export function digestLines(rows: DigestRow[]): string[] {
  if (rows.length === 0) return [];
  const shown = rows.slice(0, MAX_ROWS).map(rowLine);
  const rest = rows.length - shown.length;
  if (rest > 0) shown.push(`- …and ${rest} more ${rest === 1 ? 'change' : 'changes'}`);
  return ['**What changed**', '', ...shown];
}
