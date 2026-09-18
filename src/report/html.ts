/**
 * Render report.md to a self-contained report.html — the in-browser review
 * surface for report packages that ship no rendered view: artifact storage
 * (the default), where reviewers otherwise read raw Markdown after unzipping,
 * and local `styleproof-report/` output. Crop references stay relative, so
 * the page renders wherever the package lands.
 *
 * The grammar handled is exactly what the report generator emits: headings,
 * paragraphs, `**bold**`/`_italic_`/`code`/links, standalone images, `<sub>`
 * captions, `<details>` folds, pipe tables, `- ` lists, `> ` quotes, `---`
 * rules, and HTML comments (kept — the new-surface markers ride in them).
 * Anything outside that grammar degrades to escaped text, never dropped and
 * never interpreted as markup.
 */

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Inline markup. Code spans and HTML comments are staged out before escaping
 * and emphasis so their contents are never reinterpreted; `_` only marks
 * emphasis at word boundaries so identifiers like `STYLE_REVIEW_REQUIRED`
 * survive intact.
 */
function inline(text: string): string {
  const staged: string[] = [];
  const stage = (html: string) => {
    staged.push(html);
    return `\uE000${staged.length - 1}\uE000`;
  };
  const protectedText = text
    .replace(/<!--.*?-->/g, (comment) => stage(comment))
    .replace(/`([^`\n]+)`/g, (_m, code) => stage(`<code>${escapeHtml(code)}</code>`));
  const html = escapeHtml(protectedText)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>"'])_(\S(?:[^_]*\S)?)_(?=[\s).,;:!?"'<]|$)/g, '$1<em>$2</em>');
  return html.replace(/\uE000(\d+)\uE000/g, (_m, index) => staged[Number(index)]);
}

const RAW_LINE = /^<(?:sub|details|summary|\/details|!--)/;
const BLANK = /^\s*$/;
const HEADING = /^#{1,6}\s/;
const RULE = /^\s*---+\s*$/;
const LIST_ITEM = /^- /;
const QUOTE = /^> /;
const IMAGE_LINE = /^!\[/;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;

const startsBlock = (line: string) =>
  BLANK.test(line) ||
  RAW_LINE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  line.startsWith('|') ||
  LIST_ITEM.test(line) ||
  QUOTE.test(line) ||
  IMAGE_LINE.test(line);

const takeWhile = (lines: string[], start: number, predicate: (line: string) => boolean) => {
  let end = start;
  while (end < lines.length && predicate(lines[end])) end += 1;
  return { taken: lines.slice(start, end), next: end };
};

function renderTable(rows: string[]): string {
  const cellsOf = (row: string) =>
    row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
  const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
  const [header, ...rest] = rows.map(cellsOf);
  const body = rest.filter((cells) => !isSeparator(cells));
  const thead = `<thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map((cells) => `<tr>${cells.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
    : '';
  return `<table>${thead}${tbody}</table>`;
}

type Block = { html: string; next: number };

/** Read the block starting at `i`, or null when this reader does not own it. */
type BlockReader = (lines: string[], i: number) => Block | null;

const oneLine = (test: (line: string) => boolean, html: (line: string) => string): BlockReader => {
  return (lines, i) => (test(lines[i]) ? { html: html(lines[i]), next: i + 1 } : null);
};

const runOf = (test: RegExp, html: (taken: string[]) => string): BlockReader => {
  return (lines, i) => {
    if (!test.test(lines[i])) return null;
    const { taken, next } = takeWhile(lines, i, (l) => test.test(l));
    return { html: html(taken), next };
  };
};

const blockReaders: BlockReader[] = [
  oneLine(BLANK.test.bind(BLANK), () => ''),
  oneLine(RAW_LINE.test.bind(RAW_LINE), (line) => line),
  (lines, i) => {
    const heading = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!heading) return null;
    const level = heading[1].length;
    return { html: `<h${level}>${inline(heading[2])}</h${level}>`, next: i + 1 };
  },
  oneLine(RULE.test.bind(RULE), () => '<hr>'),
  (lines, i) => {
    if (!lines[i].startsWith('|')) return null;
    const { taken, next } = takeWhile(lines, i, (l) => l.startsWith('|'));
    return { html: renderTable(taken), next };
  },
  runOf(LIST_ITEM, (taken) => `<ul>${taken.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`),
  runOf(QUOTE, (taken) => `<blockquote>${taken.map((l) => inline(l.slice(2))).join('<br>')}</blockquote>`),
  oneLine(IMAGE_LINE.test.bind(IMAGE_LINE), (line) => `<p class="shot">${inline(line)}</p>`),
  (lines, i) => {
    const { taken, next } = takeWhile(lines, i, (l) => !startsBlock(l));
    return { html: `<p>${taken.map(inline).join(' ')}</p>`, next };
  },
];

function renderBlocks(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const block = blockReaders.map((read) => read(lines, i)).find((b) => b !== null);
    if (!block) throw new Error('unreachable: the paragraph reader accepts every line');
    if (block.html) out.push(block.html);
    i = block.next;
  }
  return out;
}

export function renderReportHtml(markdown: string): string {
  const body = renderBlocks(markdown.split('\n')).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StyleProof report</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; color: #1f2328; background: #fff;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h2 { border-bottom: 1px solid #d1d9e0; padding-bottom: 6px; }
  h3 { margin-top: 28px; }
  img { max-width: 100%; height: auto; border: 1px solid #d1d9e0; border-radius: 6px; }
  table { border-collapse: collapse; margin: 8px 0 16px; }
  th, td { border: 1px solid #d1d9e0; padding: 6px 12px; text-align: left; }
  th { background: #f6f8fa; }
  code { background: #eff1f3; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  details { margin: 8px 0; }
  summary { cursor: pointer; color: #0969da; }
  sub { color: #59636e; }
  blockquote { border-left: 3px solid #d1d9e0; margin: 8px 0; padding: 0 12px; color: #59636e; }
  hr { border: 0; border-top: 1px solid #d1d9e0; margin: 24px 0; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
