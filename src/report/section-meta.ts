export type PairState = string;
export type SectionMetaPair = {
  state: PairState;
  before: string;
  after: string;
  width: number;
  height: number;
  baseWidth?: number;
  baseHeight?: number;
  what: string;
};
export type SectionMetaWhere = {
  image: string;
  side: 'before' | 'after';
  page: [number, number];
  view: [number, number, number, number];
  boxes: Array<[number, number, number, number]>;
};
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
  more: number;
  pairs: SectionMetaPair[];
  where: SectionMetaWhere[];
  pages: SectionMetaPage[];
};
export type SectionRegistry = {
  metas: SectionMeta[];
  rules: Array<{ key: string; sheet?: string; status: string }>;
  ruleSections: Map<string, string>;
  pages: Array<{ surface: string; state: PairState }>;
};
export const createSectionRegistry = (): SectionRegistry => ({
  metas: [],
  pages: [],
  rules: [],
  ruleSections: new Map(),
});
export const sectionRef = (index: number): string => `<!-- styleproof-section-ref:${index} -->`;
const REF = /^<!-- styleproof-section-ref:(\d+) -->$/;
export const sectionRefIndex = (line: string): number | null => {
  const match = REF.exec(line);
  return match ? Number(match[1]) : null;
};
const PREFIX = '<!-- styleproof-section ';
const SUFFIX = ' -->';
export const SECTION_END = '<!-- styleproof-section-end -->';
export const isSectionMetaLine = (line: string): boolean => line.startsWith(PREFIX) && line.endsWith(SUFFIX);
export const WHERE_LINE = /^(<img [^<>]*>)<br><sub>([^<>]*)<\/sub>$/;
export const PAIR_ROW = /^\| (?:Before \| After|--- \| ---|<img [^|]*\| <img [^|]*) \|$/;
export const STATE_LABEL = /^\*\*While [^*]+\*\*$/;
export function encodeSectionMeta(meta: SectionMeta): string {
  return `${PREFIX}${encodeURIComponent(JSON.stringify(meta)).replace(/-/g, '%2D')}${SUFFIX}`;
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isTuple = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(isNumber);
const hasBothBaseSizesOrNeither = (p: { baseWidth?: number; baseHeight?: number }): boolean =>
  p.baseWidth === undefined ? p.baseHeight === undefined : isNumber(p.baseWidth) && isNumber(p.baseHeight);
const isPair = (v: unknown): v is SectionMetaPair => {
  const p = v as SectionMetaPair;
  return (
    !!p &&
    [p.state, p.before, p.after, p.what].every(isString) &&
    isNumber(p.width) &&
    isNumber(p.height) &&
    hasBothBaseSizesOrNeither(p)
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
    hasBothBaseSizesOrNeither(p)
  );
};
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
