/**
 * The data report.html needs for a change section that GitHub must not show: element
 * paths, pair sizes, the Where map's geometry and the whole-page images. It rides in
 * report.md as one hidden comment under the section heading, so report.html can still
 * be rendered from report.md alone (the CLI and the Action re-render it after editing
 * the Markdown). JSON is percent-encoded so the comment never holds `<`, `>` or `--`.
 */

export type PairState = string;

export type SectionMetaPair = {
  /** 'rest' or a forced state name. */
  state: PairState;
  before: string;
  after: string;
  w: number;
  h: number;
  /** The noun phrase in the images' alt text: "the first card title while hovered". */
  what: string;
};

export type SectionMetaWhere = {
  /** The overview PNG (the fallback when the page image is unavailable). */
  image: string;
  side: 'before' | 'after';
  /** The page size and the window shown, in page pixels. */
  page: [number, number];
  view: [number, number, number, number];
  boxes: Array<[number, number, number, number]>;
};

export type SectionMetaPage = { state: PairState; before: string; after: string; w: number; h: number };

export type SectionMeta = {
  v: 1;
  id: string;
  paths: string[];
  /** Paths left out past the cap. */
  more: number;
  pairs: SectionMetaPair[];
  where: SectionMetaWhere[];
  pages: SectionMetaPage[];
};

/** Sections collected during one report render; whole pages are written once every crop is done. */
export type SectionRegistry = {
  metas: SectionMeta[];
  /** Whole-page captures the sections want, in first-request order. */
  pages: Array<{ surface: string; state: PairState }>;
};

export const createSectionRegistry = (): SectionRegistry => ({ metas: [], pages: [] });

/** The placeholder a section's comment line holds until its whole pages are written. */
export const sectionRef = (index: number): string => `<!-- styleproof-section-ref:${index} -->`;
const REF = /^<!-- styleproof-section-ref:(\d+) -->$/;
export const sectionRefIndex = (line: string): number | null => {
  const match = REF.exec(line);
  return match ? Number(match[1]) : null;
};

const PREFIX = '<!-- styleproof-section ';
const SUFFIX = ' -->';
export const SECTION_END = '<!-- styleproof-section-end -->';

/** The hidden comment line for one section. */
export function encodeSectionMeta(meta: SectionMeta): string {
  // `-` is encoded too, so the comment body can never hold `--`.
  return `${PREFIX}${encodeURIComponent(JSON.stringify(meta)).replace(/-/g, '%2D')}${SUFFIX}`;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isTuple = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(isNumber);
const isPair = (v: unknown): v is SectionMetaPair => {
  const p = v as SectionMetaPair;
  return !!p && [p.state, p.before, p.after, p.what].every(isString) && isNumber(p.w) && isNumber(p.h);
};
const isWhere = (v: unknown): v is SectionMetaWhere => {
  const w = v as SectionMetaWhere;
  return (
    !!w &&
    isString(w.image) &&
    (w.side === 'before' || w.side === 'after') &&
    isTuple(w.page, 2) &&
    isTuple(w.view, 4) &&
    Array.isArray(w.boxes) &&
    w.boxes.every((b) => isTuple(b, 4))
  );
};
const isPage = (v: unknown): v is SectionMetaPage => {
  const p = v as SectionMetaPage;
  return !!p && [p.state, p.before, p.after].every(isString) && isNumber(p.w) && isNumber(p.h);
};

/** The section data in a comment line, or null when the line is not a valid section comment. */
export function decodeSectionMeta(line: string): SectionMeta | null {
  if (!line.startsWith(PREFIX) || !line.endsWith(SUFFIX)) return null;
  try {
    const meta = JSON.parse(decodeURIComponent(line.slice(PREFIX.length, -SUFFIX.length))) as SectionMeta;
    const valid =
      meta?.v === 1 &&
      isString(meta.id) &&
      Array.isArray(meta.paths) &&
      meta.paths.every(isString) &&
      isNumber(meta.more) &&
      Array.isArray(meta.pairs) &&
      meta.pairs.every(isPair) &&
      Array.isArray(meta.where) &&
      meta.where.every(isWhere) &&
      Array.isArray(meta.pages) &&
      meta.pages.every(isPage);
    return valid ? meta : null;
  } catch {
    return null;
  }
}
