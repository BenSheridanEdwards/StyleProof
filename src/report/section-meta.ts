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
  /** The after crop's size in pixels; `baseWidth`/`baseHeight` the before crop's when it differs. */
  width: number;
  height: number;
  baseWidth?: number;
  baseHeight?: number;
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

/** A whole-page pair; `width`/`height` is the head page, `baseWidth`/`baseHeight` the base page when its size differs. */
export type SectionMetaPage = {
  state: PairState;
  before: string;
  after: string;
  width: number;
  height: number;
  baseWidth?: number;
  baseHeight?: number;
};

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
  /** Changed CSS rules (Change Reach), and the section each one is attributed to by key. */
  rules: Array<{ key: string; sheet?: string; status: string }>;
  ruleSections: Map<string, string>;
  /** Whole-page captures the sections want, in first-request order. */
  pages: Array<{ surface: string; state: PairState }>;
};

export const createSectionRegistry = (): SectionRegistry => ({
  metas: [],
  pages: [],
  rules: [],
  ruleSections: new Map(),
});

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

/** Whether a line is a section's hidden data comment (without decoding it). */
export const isSectionMetaLine = (line: string): boolean => line.startsWith(PREFIX) && line.endsWith(SUFFIX);

// The Markdown lines a section writes around its data, read back by report.html and the PR comment.
/** The Where map line: its `<img>` tag and caption. */
export const WHERE_LINE = /^(<img [^<>]*>)<br><sub>([^<>]*)<\/sub>$/;
/** A before/after pair table row: header, separator or the two images. */
export const PAIR_ROW = /^\| (?:Before \| After|--- \| ---|<img [^|]*\| <img [^|]*) \|$/;
/** The bold label above a forced state's pair ("**While hovered**"). */
export const STATE_LABEL = /^\*\*While [^*]+\*\*$/;

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
  return (
    !!p &&
    [p.state, p.before, p.after, p.what].every(isString) &&
    isNumber(p.width) &&
    isNumber(p.height) &&
    [p.baseWidth, p.baseHeight].every((n) => n === undefined || isNumber(n))
  );
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
  return (
    !!p &&
    [p.state, p.before, p.after].every(isString) &&
    [p.width, p.height].every(isNumber) &&
    [p.baseWidth, p.baseHeight].every((n) => n === undefined || isNumber(n))
  );
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

/** "What was captured" for report.html: pages, widths, forced states, recipe states and changed rules. */
export type CapturedMeta = {
  v: 1;
  pages: Array<{ base: string; widths: number[]; states: string[] }>;
  recipes: Array<{ surface: string; state: string; action: string }>;
  rules: Array<{ key: string; sheet: string; status: string; section?: string }>;
};

const CAPTURED_PREFIX = '<!-- styleproof-captured ';

export function encodeCapturedMeta(meta: CapturedMeta): string {
  return `${CAPTURED_PREFIX}${encodeURIComponent(JSON.stringify(meta)).replace(/-/g, '%2D')}${SUFFIX}`;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

export function decodeCapturedMeta(line: string): CapturedMeta | null {
  if (!line.startsWith(CAPTURED_PREFIX) || !line.endsWith(SUFFIX)) return null;
  try {
    const meta = JSON.parse(decodeURIComponent(line.slice(CAPTURED_PREFIX.length, -SUFFIX.length))) as CapturedMeta;
    const valid =
      meta?.v === 1 &&
      Array.isArray(meta.pages) &&
      meta.pages.every(
        (p) => isString(p?.base) && Array.isArray(p.widths) && p.widths.every(isNumber) && isStringArray(p.states),
      ) &&
      Array.isArray(meta.recipes) &&
      meta.recipes.every((r) => [r?.surface, r?.state, r?.action].every(isString)) &&
      Array.isArray(meta.rules) &&
      meta.rules.every(
        (r) => [r?.key, r?.sheet, r?.status].every(isString) && (r.section === undefined || isString(r.section)),
      );
    return valid ? meta : null;
  } catch {
    return null;
  }
}
