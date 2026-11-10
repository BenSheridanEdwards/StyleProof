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
 * Action's marker, approval box, link and footer (which can name failed baseline surfaces).
 */
export const COMMENT_SUMMARY_MAX_CHARS = 50_000;

const APPROVAL_BOX = /^\s*- \[[ xX]\]/;
/** Where the comment's opening block ends: a report group heading or a fold (Evidence, reach tables). */
const HEAD_END = /^(?:## |<details>)/;
const MORE_RESERVE = 200;

type Section = { title: string; body: string[] };

/** Split report.md into the lines above the first section heading and its change sections. */
function parse(lines: string[]): { top: string[]; sections: Section[] } {
  const first = lines.findIndex((l) => l.startsWith('### '));
  const top = first < 0 ? lines : lines.slice(0, first);
  const sections: Section[] = [];
  for (let i = Math.max(first, 0); first >= 0 && i < lines.length; i++) {
    const data = lines.slice(i + 1).find((l) => l.trim()) ?? '';
    if (!lines[i].startsWith('### ') || !isSectionMetaLine(data)) continue;
    const end = lines.indexOf(SECTION_END, i);
    sections.push({ title: lines[i], body: lines.slice(i + 1, end < 0 ? lines.length : end) });
    i = end < 0 ? lines.length : end;
  }
  return { top, sections };
}

/** One section for the comment: images when `images` is set (rebased onto `imageBase`), otherwise text only. */
function sectionLines(section: Section, images: boolean, imageBase: string): string[] {
  const out = [section.title];
  section.body.forEach((line, i) => {
    if (line.includes('<!--') || APPROVAL_BOX.test(line)) return;
    if (images) {
      const rebase = (_m: string, file: string) => `src="${imageBase}crops/${file}?raw=1"`;
      out.push(imageBase ? line.replace(/src="crops\/([^"?]+)"/g, rebase) : line);
      return;
    }
    const where = line.match(WHERE_LINE);
    if (where) out.push(`<sub>${where[2]}</sub>`);
    else if (PAIR_ROW.test(line)) return;
    // A state label stays only when it heads a note, not a pair table.
    else if (
      STATE_LABEL.test(line) &&
      section.body
        .slice(i + 1)
        .find((l) => l)
        ?.startsWith('| Before')
    )
      return;
    else out.push(line);
  });
  return tidy(out);
}

/** Collapse repeated blank lines and trim the ends. */
function tidy(lines: string[]): string[] {
  const out = lines.filter((l, i) => !(l === '' && (i === 0 || lines[i - 1] === '')));
  while (out[out.length - 1] === '') out.pop();
  return out;
}

/** The summary and blocking lines only: group headings, Evidence and reach tables stay in the report. */
function openingLines(top: string[]): string[] {
  // The report's own title is not a group heading: an unbound report opens with its warning above it.
  const end = top.findIndex((l, i) => i > 0 && HEAD_END.test(l) && !l.startsWith('## 🗺️'));
  return tidy(
    (end < 0 ? top : top.slice(0, end))
      .filter((l) => !l.includes('<!--') && !APPROVAL_BOX.test(l) && !RULE_LINE.test(l))
      .map(pointAtFullReport),
  );
}

const RULE_LINE = /^\s*---+\s*$/;

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
  const imageBase = /^https:\/\/github\.com\/[^\s"<>?#]+\/$/.test(options.imageBase ?? '') ? options.imageBase! : '';
  const images = Boolean(imageBase || options.keepImages);
  const { top, sections } = parse(markdown.split('\n'));
  const blocks: Block[] = [
    ...openingLines(top).map((text) => ({ text, sep: '\n', section: false })),
    ...sections.map((s) => ({ text: sectionLines(s, images, imageBase).join('\n'), sep: '\n\n', section: true })),
  ];
  return cutToBudget(blocks, options.maxChars ?? COMMENT_SUMMARY_MAX_CHARS);
}
