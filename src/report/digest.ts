import { formatSurfaceList, safeKey, surfaceBase } from '../change-groups.js';
import { derivedLonghandCount } from '../findings-clean.js';
import { codeValue } from '../code-span.js';
import { describeElement, tokenIndex } from '../describe.js';
import type { OneSidedStatus } from './headline.js';
import { buildElementChanges, clipText } from './markdown.js';
import { presentationMaps, type ChangeGroup, type RenderCtx } from './shared.js';
import { formatChangeSentence, mergeSentenceChanges, sentenceChanges, type SentenceChange } from './change-sentence.js';

/** The "What changed" block: one row per one-sided surface and per change group, above the PR-comment cut. */

export type DigestElement = { name: string; phrase: string };
export type DigestRow = {
  surface: string;
  status: OneSidedStatus | 'changed';
  /** Other surfaces carrying the same change (changed rows only, when non-zero). */
  otherSurfaces?: number;
  /** The element changed on every surface base that renders the element. */
  chrome?: true;
  elements: DigestElement[];
  /** Changed elements not listed in `elements`. */
  more: number;
  foldedRows?: number;
  /** Plain-English distinct changes; legacy element/value fields remain unchanged. */
  sentences?: string[];
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

function changedRow(
  ctx: RenderCtx,
  cg: ChangeGroup,
  chrome: boolean,
  nameSurfaces: boolean,
): { row: DigestRow; changes: SentenceChange[] } {
  const { sd, findings } = cg.rep;
  const [mapA, mapB] = presentationMaps(ctx, sd.surface);
  const describeCtx = { tokensBefore: identTokens(mapA.tokens), tokensAfter: identTokens(mapB.tokens) };
  const els = buildElementChanges(findings);
  const elements = els.slice(0, MAX_ELEMENTS).map((el) => {
    const phrase = describeElement({ ...el, states: el.states?.map(safeState) }, describeCtx);
    return {
      name: safeName(el.label),
      phrase: phrase.length > MAX_PHRASE ? 'restyled (too long to summarise here)' : phrase,
    };
  });

  const row: DigestRow = {
    surface: sd.surface,
    status: 'changed',
    ...(cg.surfaces.length > 1 ? { otherSurfaces: cg.surfaces.length - 1 } : {}),
    ...(chrome ? { chrome: true as const } : {}),
    elements,
    more: els.length - elements.length,
    sentences: [],
  };
  const changes = sentenceChanges(
    findings.length ? findings : (cg.rep.folded ?? []),
    [
      ...new Set(
        cg.surfaces.map((surface) => ctx.load(ctx.afterDir, surface).metadata?.surfaceKey ?? surfaceBase(surface)),
      ),
    ],
    nameSurfaces,
  );

  const foldedRows = derivedLonghandCount(cg.rep.folded ?? []);

  if (foldedRows) row.foldedRows = foldedRows;

  return { row, changes };
}

/** One-sided surfaces first (review first), then shared-chrome groups, then the rest. */
export function buildDigest(
  ctx: RenderCtx,
  oneSided: Array<{ surface: string; status: OneSidedStatus }>,
  groups: { chrome: ChangeGroup[]; rest: ChangeGroup[] },
): DigestRow[] {
  const changedBases = new Set(
    [...groups.chrome, ...groups.rest].flatMap((group) =>
      group.surfaces.map((surface) => ctx.load(ctx.afterDir, surface).metadata?.surfaceKey ?? surfaceBase(surface)),
    ),
  );
  const changedRows = [
    ...groups.chrome.map((cg) => changedRow(ctx, cg, true, changedBases.size > 1)),
    ...groups.rest.map((cg) => changedRow(ctx, cg, false, changedBases.size > 1)),
  ];
  const entries = changedRows.flatMap(({ row, changes }) => changes.map((change) => ({ row, change })));
  for (const { change, firstIndex } of mergeSentenceChanges(entries.map((entry) => entry.change))) {
    entries[firstIndex].row.sentences!.push(formatChangeSentence(change));
  }
  return [
    ...oneSided.map(({ surface, status }) => ({ surface, status, elements: [], more: 0 })),
    ...changedRows.map(({ row }) => row),
  ];
}

function rowLines(row: DigestRow): string[] {
  const surface = codeValue(formatSurfaceList([safeKey(row.surface)]));
  if (row.status !== 'changed') return [`- ${surface} — ${ONE_SIDED_TEXT[row.status]}`];
  return (row.sentences ?? []).map((sentence) => `- ${sentence}`);
}

/** The block's Markdown, rows capped with a count of what is left out; empty when nothing changed. */
export function digestLines(rows: DigestRow[]): string[] {
  if (rows.length === 0) return [];
  const lines = rows.flatMap(rowLines);
  const shown = lines.slice(0, MAX_ROWS);
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`- …and ${rest} more ${rest === 1 ? 'change' : 'changes'}`);
  return ['**What changed**', '', ...shown];
}
