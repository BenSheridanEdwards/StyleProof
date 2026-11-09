import { derivedLonghandCount } from '../findings-clean.js';
import { describeElement, tokenIndex } from '../describe.js';
import type { OneSidedStatus } from './headline.js';
import { buildElementChanges, clipText } from './markdown.js';
import { presentationMaps, type ChangeGroup, type RenderCtx } from './shared.js';

/** The report.json `digest`: one row per one-sided surface and per change group (machine output; not printed in report.md). */

/** `count` is present when more than one element carries the same name and phrase. */
export type DigestElement = { name: string; phrase: string; count?: number };
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
};

const MAX_ELEMENTS = 5;
// A hostile map can make a phrase arbitrarily long; past this it stops being a glance.
const MAX_PHRASE = 240;
// Real labels are `tag.class` idents and real states plain words; anything else is
// map-authored and must not reach the comment, not even inside a code span.
const safeName = (label: string): string => clipText(label.replace(/[^\w.-]/g, '-'), 80);
const safeState = (state: string): string => state.replace(/[^\w -]/g, '-');
// Same rule for token names: a code span keeps them inert as Markdown but not as a receipt marker.
const identTokens = (tokens?: Record<string, string>): Map<string, string> =>
  new Map([...tokenIndex(tokens)].filter(([, name]) => /^[\p{L}\p{N}_-]+$/u.test(name)));

function changedRow(ctx: RenderCtx, cg: ChangeGroup, chrome: boolean): DigestRow {
  const { sd, findings } = cg.rep;
  const [mapA, mapB] = presentationMaps(ctx, sd.surface);
  const describeCtx = { tokensBefore: identTokens(mapA.tokens), tokensAfter: identTokens(mapB.tokens) };
  const els = buildElementChanges(findings);
  // Elements with the same name and phrase fold into one entry, so seven identical
  // nav items take one slot and the row can name the other changes.
  const folded: DigestElement[] = [];
  for (const el of els) {
    const described = describeElement({ ...el, states: el.states?.map(safeState) }, describeCtx);
    const name = safeName(el.label);
    const phrase = described.length > MAX_PHRASE ? 'restyled (too long to summarise here)' : described;
    const same = folded.find((entry) => entry.name === name && entry.phrase === phrase);

    if (same) same.count = (same.count ?? 1) + 1;
    else folded.push({ name, phrase });
  }
  const elements = folded.slice(0, MAX_ELEMENTS);

  const row: DigestRow = {
    surface: sd.surface,
    status: 'changed',
    ...(cg.surfaces.length > 1 ? { otherSurfaces: cg.surfaces.length - 1 } : {}),
    ...(chrome ? { chrome: true as const } : {}),
    elements,
    more: els.length - elements.reduce((sum, entry) => sum + (entry.count ?? 1), 0),
  };

  const foldedRows = derivedLonghandCount(cg.rep.folded ?? []);

  if (foldedRows) row.foldedRows = foldedRows;

  return row;
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
