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

const SECTION_DATA = /^<!-- styleproof-section [^<>]* -->$/;
const SECTION_END = '<!-- styleproof-section-end -->';
const WHERE_LINE = /^<img [^<>]*><br><sub>([^<>]*)<\/sub>$/;
const PAIR_ROW = /^\| (?:Before \| After|--- \| ---|<img [^|]*\| <img [^|]*) \|$/;
const STATE_LABEL = /^\*\*While [^*]+\*\*$/;
const APPROVAL_BOX = /^\s*- \[[ xX]\]/;

type Section = { title: string; body: string[] };

/** Split report.md into the lines above the first section heading and its change sections. */
function parse(lines: string[]): { top: string[]; sections: Section[] } {
  const first = lines.findIndex((l) => l.startsWith('### '));
  const top = first < 0 ? lines : lines.slice(0, first);
  const sections: Section[] = [];
  for (let i = Math.max(first, 0); first >= 0 && i < lines.length; i++) {
    const data = lines.slice(i + 1).find((l) => l.trim()) ?? '';
    if (!lines[i].startsWith('### ') || !SECTION_DATA.test(data)) continue;
    const end = lines.indexOf(SECTION_END, i);
    sections.push({ title: lines[i], body: lines.slice(i + 1, end < 0 ? lines.length : end) });
    i = end < 0 ? lines.length : end;
  }
  return { top, sections };
}

/** One section for the comment: absolute images behind `imageBase`, otherwise text only. */
function sectionLines(section: Section, imageBase: string): string[] {
  const out = [section.title];
  section.body.forEach((line, i) => {
    if (line.includes('<!--') || APPROVAL_BOX.test(line)) return;
    if (imageBase) {
      out.push(line.replace(/src="crops\/([^"?]+)"/g, (_m, file: string) => `src="${imageBase}crops/${file}?raw=1"`));
      return;
    }
    const where = line.match(WHERE_LINE);
    if (where) out.push(`<sub>${where[1]}</sub>`);
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

/** The comment's report content, inside `maxChars`. */
export function reportCommentSummary(
  markdown: string,
  options: { imageBase?: string; maxChars?: number } = {},
): string {
  const imageBase = /^https:\/\/github\.com\/[^\s"<>?#]+\/$/.test(options.imageBase ?? '') ? options.imageBase! : '';
  const maxChars = options.maxChars ?? COMMENT_SUMMARY_MAX_CHARS;
  const { top, sections } = parse(markdown.split('\n'));
  // Section-group H2s ("## Changes") would sit empty above the approval box.
  const head = tidy(
    top.filter((l, i) => (i === 0 || !l.startsWith('## ')) && !l.includes('<!--') && !APPROVAL_BOX.test(l)),
  ).join('\n');
  const blocks = sections.map((s) => sectionLines(s, imageBase).join('\n'));
  let body = head;
  for (const [n, block] of blocks.entries()) {
    const rest = blocks.length - n;
    const more = `\n\n_…and ${rest} more ${rest === 1 ? 'change' : 'changes'} in the full report._`;
    const reserve = n === blocks.length - 1 ? 0 : more.length + 40;
    if (body.length + 2 + block.length + reserve > maxChars) return `${body}${more}`;
    body = `${body}\n\n${block}`;
  }
  return body;
}
