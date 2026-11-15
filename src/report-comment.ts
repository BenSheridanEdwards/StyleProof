import { isSectionMetaLine, PAIR_ROW, SECTION_END, STATE_LABEL, WHERE_LINE } from './report/section-meta.js';

/**
 * The PR comment's report content: report.md's summary plus every change section (name,
 * line, Where, the CSS on demand), as the approved design shows it. The Action adds the
 * marker, approval box, link and receipts around it.
 *
 * Images are embedded only behind `imageBase`, a verified absolute URL for the published
 * report directory (the commit-bound branch-storage URL on a public repository). Without
 * one, the comment carries the same sections as text and the full report holds the images.
 */

/**
 * GitHub refuses comments past 65,536 characters; this leaves over 15,000 for the
 * Action's marker, approval box, link, footer and hidden receipts.
 */
export const COMMENT_SUMMARY_MAX_CHARS = 50_000;

/** GitHub also renders *, +, ordered, and quoted list markers as checkboxes. */
const APPROVAL_BOX = /^\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+\[[ xX]\]/;
/** Where the comment's opening block ends: a report group heading or a fold (Evidence, reach tables). */
const HEAD_END = /^(?:## |<details>)/;
const MORE_RESERVE = 200;
/** Must match the hidden marker `src/report/sections.ts` writes on a new-surface heading. */
const NEW_SURFACE_MARKER = '<!-- styleproof-new -->';
/** Commit-bound public blob directory: owner/repo/blob/<40-hex-sha>/optional/dirs/. */
const IMAGE_BASE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{40}\/(?:[\w.-]+\/)*$/;
/** Crop files are stems plus an extension; `..` and slashes are never allowed. */
const CROP_FILE = /^[A-Za-z0-9._-]+$/;
const REF_DEF = /^\s*\[[^\]]+\]:\s+\S/;
const RULE_LINE = /^\s*---+\s*$/;
/** Entity markers or markup in a src value mean it is not a plain imageBase URL. */
const UNSAFE_SRC = /[<>&#]/;

type Section = { title: string; body: string[] };

const isNewSurfaceHeading = (line: string): boolean => line.startsWith('### ') && line.includes(NEW_SURFACE_MARKER);

const sectionTitle = (title: string): string => title.replace(NEW_SURFACE_MARKER, '').trimEnd();

/** True when this heading opens a change section or a new-surface section. */
function isCommentSection(lines: string[], i: number): boolean {
  if (isNewSurfaceHeading(lines[i])) return true;
  const data = lines.slice(i + 1).find((l) => l.trim()) ?? '';
  return lines[i].startsWith('### ') && isSectionMetaLine(data);
}

/** Change sections end at their closer; new-surface sections have no closer, so they end at the next heading. */
function sectionEnd(lines: string[], i: number): number {
  if (isNewSurfaceHeading(lines[i])) {
    const next = lines.findIndex((l, j) => j > i && (l.startsWith('### ') || HEAD_END.test(l)));
    return next < 0 ? lines.length : next;
  }
  const end = lines.indexOf(SECTION_END, i);
  return end < 0 ? lines.length : end;
}

/** Split report.md into the lines above the first section heading and its change and new-surface sections. */
function parse(lines: string[]): { top: string[]; sections: Section[] } {
  const start = lines.findIndex((_, i) => isCommentSection(lines, i));
  const top = start < 0 ? lines : lines.slice(0, start);
  const sections: Section[] = [];
  for (let i = Math.max(start, 0); start >= 0 && i < lines.length; i++) {
    if (!isCommentSection(lines, i)) continue;
    const end = sectionEnd(lines, i);
    sections.push({ title: sectionTitle(lines[i]), body: lines.slice(i + 1, end) });
    i = end === lines.length || lines[end] === SECTION_END ? end : end - 1;
  }
  return { top, sections };
}

function verifiedImageBase(raw: string | undefined): string {
  if (!raw || raw.split('/').some((s) => s === '.' || s === '..')) return '';
  return IMAGE_BASE.test(raw) ? raw : '';
}

const isSafeCrop = (file: string): boolean => CROP_FILE.test(file) && !file.includes('..');

/** Rewrite recognised double-quoted crop images and markdown tiles onto `imageBase`. */
function rebaseRecognisedImages(text: string, imageBase: string, allowMarkdown: boolean): string {
  const abs = (file: string) => `${imageBase}crops/${file}?raw=1`;
  let rewritten = text.replace(/src="crops\/([^"?]+)"/g, (m, file: string) =>
    isSafeCrop(file) ? `src="${abs(file)}"` : m,
  );
  if (allowMarkdown) {
    rewritten = rewritten.replace(/!\[([^\]]*)\]\(crops\/([^)]+)\)/g, (m, alt: string, file: string) =>
      isSafeCrop(file) ? `![${alt}](${abs(file)})` : m,
    );
  }
  return rewritten;
}
const hasImageMarkup = (line: string): boolean => /<img|<source|srcset|!\[[^\]]*\]\(|!\[[^\]]*\]\[|crops\//i.test(line);

/** Drop HTML comments, including ones that span lines; unclosed comments are dropped to the end. */
function withoutHtmlComments(lines: string[]): string[] {
  let text = lines.join('\n');
  for (let i = 0; i < 64; i++) {
    const next = text.replace(/<!--[\s\S]*?(?:-->|--!>|$)/g, '');
    if (next === text) break;
    text = next;
  }
  // Anything the cap left behind must not stay a live comment or a forged receipt.
  text = text.replace(/<!--|-->|--!>/g, '').replace(/styleproof-receipt/gi, '');
  return text.split('\n');
}

const srcAllowed = (value: string, imageBase: string): boolean =>
  Boolean(imageBase) && value.startsWith(imageBase) && !UNSAFE_SRC.test(value);

/** Keep a complete <img> only when its only src is a double-quoted imageBase URL. */
function keepAllowedImgTag(tag: string, imageBase: string): string {
  if (/\bsrcset\b/i.test(tag) || /src\s*=\s*'/i.test(tag)) return '';
  const srcs = [...tag.matchAll(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
  if (srcs.length !== 1) return '';
  const value = srcs[0][1] ?? srcs[0][2] ?? srcs[0][3] ?? '';
  return srcs[0][1] !== undefined && srcAllowed(value, imageBase) ? tag : '';
}

const isAllowedSrcLine = (line: string, imageBase: string): boolean => {
  if (!/\bsrc(?:set)?\s*=/i.test(line)) return true;
  const srcs = [...line.matchAll(/\bsrc(?:set)?\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
  return (
    srcs.length > 0 && srcs.every((m) => m[1] !== undefined && srcAllowed(m[1], imageBase) && !/^srcset/i.test(m[0]))
  );
};

/**
 * After rebasing, keep only image targets that start with `imageBase`. An empty base drops
 * every image, including split tags, reference-style images, and reference definitions.
 */
/** Drop an unclosed <img> or <source> that has no later `>`. Kept complete tags are left alone. */
function dropUnclosed(text: string, tag: 'img' | 'source'): string {
  const lower = text.toLowerCase();
  const open = `<${tag}`;
  let i = 0;
  while (true) {
    const at = lower.indexOf(open, i);
    if (at < 0) return text;
    if (!text.slice(at).includes('>')) return text.slice(0, at);
    i = at + open.length;
  }
}

function dropForeignImages(text: string, imageBase: string): string {
  let out = text.replace(/<img\b[\s\S]*?>/gi, (tag) => keepAllowedImgTag(tag, imageBase));
  out = out.replace(/<source\b[\s\S]*?>/gi, '');
  out = dropUnclosed(out, 'img');
  out = dropUnclosed(out, 'source');
  out = out.replace(/!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))\)/g, (m, bracketed?: string, plain?: string) => {
    const url = bracketed ?? plain ?? '';
    return srcAllowed(url, imageBase) ? m : '';
  });
  out = out.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');
  out = out
    .split('\n')
    .filter((line) => !REF_DEF.test(line) && isAllowedSrcLine(line, imageBase))
    .join('\n');
  return out;
}

function filterKeptImages(lines: string[], imageBase: string, keepUnverified: boolean): string[] {
  if (keepUnverified) return lines;
  return dropForeignImages(lines.join('\n'), imageBase).split('\n');
}

/** Text-only mode: keep the Where caption, drop pair rows and any remaining image markup. */
function textOnlyLine(line: string, body: string[], i: number): string | null {
  const where = line.match(WHERE_LINE);
  if (where) return `<sub>${where[2]}</sub>`;
  if (PAIR_ROW.test(line) || hasImageMarkup(line) || REF_DEF.test(line)) return null;
  // A state label stays only when it heads a note, not a pair table.
  if (
    STATE_LABEL.test(line) &&
    body
      .slice(i + 1)
      .find((l) => l)
      ?.startsWith('| Before')
  )
    return null;
  return line;
}

function mapSectionLines(
  lines: string[],
  images: boolean,
  imageBase: string,
  keepUnverified: boolean,
): Array<string | null> {
  return lines.map((line, i) => {
    if (APPROVAL_BOX.test(line) || RULE_LINE.test(line)) return null;
    if (images && imageBase) return line;
    if (keepUnverified) return line;
    return textOnlyLine(line, lines, i);
  });
}

/** One section for the comment: images when `images` is set (rebased onto `imageBase`), otherwise text only. */
function sectionLines(section: Section, images: boolean, imageBase: string, keepImages: boolean): string[] {
  const body = withoutHtmlComments(section.body);
  const newSurface = /· new surface$/.test(section.title);
  const keepUnverified = Boolean(images && keepImages && !imageBase);
  let text = body.join('\n');
  if (!keepUnverified) {
    if (images && imageBase) text = rebaseRecognisedImages(text, imageBase, newSurface);
    text = dropForeignImages(text, imageBase);
  }
  const mapped = mapSectionLines(text.split('\n'), images, imageBase, keepUnverified);
  const raw = [section.title, ...mapped.filter((l): l is string => l !== null)];
  return tidy(filterKeptImages(raw, imageBase, keepUnverified));
}

/** Collapse repeated blank lines and trim the ends. */
function tidy(lines: string[]): string[] {
  const out = lines.filter((l, i) => !(l === '' && (i === 0 || lines[i - 1] === '')));
  while (out[out.length - 1] === '') out.pop();
  return out;
}

/** The summary and blocking lines only: group headings, Evidence and reach tables stay in the report. */
function openingLines(top: string[], imageBase: string, keepUnverified: boolean): string[] {
  // The report's own title is not a group heading: an unbound report opens with its warning above it.
  const end = top.findIndex((l, i) => i > 0 && HEAD_END.test(l) && !l.startsWith('## 🗺️'));
  const lines = tidy(
    withoutHtmlComments(end < 0 ? top : top.slice(0, end))
      .filter((l) => !APPROVAL_BOX.test(l) && !RULE_LINE.test(l))
      .map(pointAtFullReport),
  );
  return tidy(filterKeptImages(lines, imageBase, keepUnverified));
}

/**
 * The opening lines point at report sections the comment does not carry ("see below",
 * "see **Changed but never matched**", "listed … below"): point at the full report instead.
 */
function pointAtFullReport(line: string): string {
  return line
    .replace(/\(see (?:below|\*\*[^*]+\*\*)\)/g, '(see the full report)')
    .replace(/ below\b/g, ' in the full report');
}

type Block = { text: string; sep: string; section: boolean };

/** Join blocks until `maxChars`, then close with what was left out. */
function cutToBudget(blocks: Block[], maxChars: number): string {
  let body = '';
  for (const [n, block] of blocks.entries()) {
    const next = body ? `${body}${block.sep}${block.text}` : block.text;
    // Room for whichever closing line a later cut would need.
    const reserve = n === blocks.length - 1 ? 0 : MORE_RESERVE;
    if (next.length + reserve > maxChars) return `${body}${moreLine(blocks.slice(n).filter((b) => b.section).length)}`;
    body = next;
  }
  return body;
}

/**
 * The note where the comment stops at GitHub's size limit: it says why, how many changes it left
 * out, and what to do (QA18-05). The full report names every change. The approval box may sit
 * between it and the link, so it says where the link is rather than ending on a colon.
 */
const moreLine = (left: number): string =>
  left
    ? `\n\n_This comment reached GitHub's size limit. ${left} more ${left === 1 ? 'change is' : 'changes are'} listed in the full report: open it from the link at the end of this comment._`
    : "\n\n_This comment reached GitHub's size limit. The rest is in the full report: open it from the link at the end of this comment._";

/** The comment's report content, inside `maxChars`. */
export function reportCommentSummary(
  markdown: string,
  options: {
    imageBase?: string;
    /** Keep image lines as they are: the caller already made their sources resolvable (the README example). */
    keepImages?: boolean;
    maxChars?: number;
  } = {},
): string {
  const imageBase = verifiedImageBase(options.imageBase);
  const keepImages = Boolean(options.keepImages);
  const images = Boolean(imageBase || keepImages);
  const keepUnverified = Boolean(images && keepImages && !imageBase);
  const { top, sections } = parse(markdown.split('\n'));
  const blocks: Block[] = [
    ...openingLines(top, imageBase, keepUnverified).map((text) => ({ text, sep: '\n', section: false })),
    ...sections.map((s) => ({
      text: sectionLines(s, images, imageBase, keepImages).join('\n'),
      sep: '\n\n',
      section: true,
    })),
  ];
  return cutToBudget(blocks, options.maxChars ?? COMMENT_SUMMARY_MAX_CHARS);
}
