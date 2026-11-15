import fs from 'node:fs';
import path from 'node:path';
import { andList, STATE_WORDS } from './change-line.js';
const RING_PAD = 8;
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
import {
  decodeCapturedMeta,
  decodeSectionMeta,
  PAIR_ROW,
  SECTION_END,
  STATE_LABEL,
  WHERE_LINE,
  type CapturedMeta,
  type SectionMeta,
  type SectionMetaPage,
} from './section-meta.js';

/**
 * Render report.md to a self-contained report.html — the in-browser review
 * surface for report packages that ship no rendered view: artifact storage
 * (the default), where reviewers otherwise read raw Markdown after unzipping,
 * and local `styleproof-report/` output. Images travel inside the page.
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
 * A comment the report generator writes itself (`<!-- styleproof-new -->`,
 * receipts). No `<` or `>` inside, so it cannot close early and smuggle markup.
 * Any other comment is untrusted text and is escaped.
 */
const STYLEPROOF_COMMENT = /<!-- styleproof-[^<>]*? -->/g;

/**
 * A code span with any fence length (`codeValue` widens the fence past the
 * value's backticks), per the CommonMark rule: the closing run matches the
 * opening run exactly. One pad space on each side is stripped.
 */
const CODE_SPAN = /(?<!(?<!\\)(?:\\\\)*\\)(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const unpad = (code: string) => (/^ .* $/.test(code) && code.trim() ? code.slice(1, -1) : code);

/** A Markdown backslash escape (`escapeInlineMarkdown` emits these): the character renders literally. */
const BACKSLASH_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/** The entities `escapeInlineMarkdown` emits; GitHub renders them once, so must we. */
const NAMED_ENTITY = /&(?:amp|lt|gt|quot);/g;

/** Link and image targets: http(s) or scheme-less (relative crops, anchors) only — never `javascript:`. */
const isSafeUrl = (url: string) => {
  const probe = url.replace(/[\u0000- \u007f-\u009f]/g, ''); // eslint-disable-line no-control-regex -- browsers strip these from a scheme
  return !/^[a-z][a-z0-9+.-]*:/i.test(probe) || /^https?:/i.test(probe);
};

/**
 * Inline markup. Code spans are staged out first, then StyleProof's own
 * comments, before escaping and emphasis, so their contents are never
 * reinterpreted; `_` only marks emphasis at word boundaries so identifiers
 * like `STYLE_REVIEW_REQUIRED` survive intact.
 */
function inline(text: string): string {
  const staged: string[] = [];
  const stage = (html: string) => {
    staged.push(html);
    return `\uE000${staged.length - 1}\uE000`;
  };
  const restore = (html: string) => html.replace(/\uE000(\d+)\uE000/g, (_m, index) => staged[Number(index)]);
  const protectedText = text
    .replace(CODE_SPAN, (_m, _fence, code) => stage(`<code>${escapeHtml(unpad(code))}</code>`))
    .replace(STYLEPROOF_COMMENT, (comment) => stage(comment))
    .replace(BACKSLASH_ESCAPE, (_m, char: string) => stage(escapeHtml(char)))
    .replace(NAMED_ENTITY, (entity) => stage(entity));
  // A link whose resolved target is not http(s) or relative stays literal text.
  const link = (markup: (label: string, url: string) => string) => (match: string, label: string, url: string) =>
    isSafeUrl(restore(url)) ? markup(label, url) : match;
  const html = escapeHtml(protectedText)
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      link((alt, src) => `<img src="${src}" alt="${alt}" loading="lazy">`),
    )
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      link((label, href) => `<a href="${href}">${label}</a>`),
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>"'])_(\S(?:[^_]*\S)?)_(?=[\s).,;:!?"'<]|$)/g, '$1<em>$2</em>');
  return restore(html);
}

const RAW_LINE = /^<(?:sub|details|summary|\/details|!--)/;
const FOLD_LINE = /^<\/?details>$/;
const COMMENT_LINE = /^<!-- styleproof-[^<>]*? -->$/;
const WRAPPED_LINE = /^<(sub|summary)>(.*)<\/\1>$/;

/** Raw HTML lines: fold tags and StyleProof comments verbatim, caption text as inline markup, anything else escaped. */
function rawLine(line: string): string {
  if (FOLD_LINE.test(line) || COMMENT_LINE.test(line)) return line;
  const wrapped = line.match(WRAPPED_LINE);
  if (wrapped) return `<${wrapped[1]}>${inline(wrapped[2])}</${wrapped[1]}>`;
  return `<p>${inline(line)}</p>`;
}
const BLANK = /^\s*$/;
const HEADING = /^#{1,6}\s/;
const RULE = /^\s*---+\s*$/;
const LIST_ITEM = /^- /;
const QUOTE = /^> /;
const IMAGE_LINE = /^!\[/;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;
/** A line ending in `<br>` not preceded by an odd run of backslashes (which would escape its `<`). */
const GENERATED_BREAK = /(?<!\\)(?:\\\\)*<br>$/;

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
  // GFM: `\|` is a literal pipe inside the cell (code spans included), never a column break.
  const cellsOf = (row: string) =>
    row
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/\\\|/g, '|'));
  const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
  const [header, ...rest] = rows.map(cellsOf);
  const body = rest.filter((cells) => !isSeparator(cells));
  const thead = `<thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map((cells) => `<tr>${cells.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
    : '';
  const label = header.length >= 4 ? ` aria-label="${escapeHtml(header.join(', '))}"` : '';
  return `<table class="table-scroll" role="table"${label}>${thead}${tbody}</table>`;
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
  oneLine(RAW_LINE.test.bind(RAW_LINE), rawLine),
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
    // The generator's trailing `<br>` (spacing lines) is a line break; an escaped `\<br>` stays text.
    const paragraph = taken.map((line) =>
      GENERATED_BREAK.test(line) ? `${inline(line.slice(0, -4))}<br>` : inline(line),
    );
    return { html: `<p>${paragraph.join(' ')}</p>`, next };
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

function readCropDataUrl(src: string, outDir: string, maxBytes: number): string | null {
  const target = src.match(/(?:^|\/)crops\/([^/]+\.png)$/);
  if (!target) return null;
  const filename = path.join(outDir, 'crops', target[1]);
  if (!fs.existsSync(filename)) return null;
  if ((fs.statSync(filename).size * 4) / 3 > maxBytes) return null;
  return `data:image/png;base64,${fs.readFileSync(filename).toString('base64')}`;
}

const decodeAttribute = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const attr = (value: string | number) => escapeHtml(String(value));
const safeCrop = (src: string) => /^(?:crops\/[^/"<>\s]+\.png|https?:\/\/[^"<>\s]+)$/.test(src) && isSafeUrl(src);
const stateWords = (state: string) =>
  state === 'rest' ? '' : STATE_WORDS[state] ? `while ${STATE_WORDS[state]}` : `in :${state}`;
function whereFigure(meta: SectionMeta, index: number, alt: string, caption: string): string {
  const where = meta.where[index];
  const page = meta.pages.find((p) => p.state === 'rest');
  const href = page ? (where.side === 'after' ? page.after : page.before) : '';
  const figcaption = `<figcaption>${inline(caption)}</figcaption>`;
  if (!href || !safeCrop(href)) {
    return safeCrop(where.image)
      ? `<figure class="where"><img class="map" src="${attr(where.image)}" alt="${attr(alt)}">${figcaption}</figure>`
      : `<figure class="where">${figcaption}</figure>`;
  }
  const [pw, ph] = where.page;
  const [vx, vy, vw, vh] = where.view;
  const boxes = where.boxes.map(([x, y, w, h]) => ({
    x: x - RING_PAD,
    y: y - RING_PAD,
    w: w + 2 * RING_PAD,
    h: h + 2 * RING_PAD,
  }));
  const rect = (b: { x: number; y: number; w: number; h: number }, extra: string) =>
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"${extra}/>`;
  const mask = `mask-${attr(meta.id)}-${index}`;
  return (
    `<figure class="where"><svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${attr(alt)}" class="map" data-fallback="${attr(where.image)}">` +
    `<defs><mask id="${mask}"><rect width="${pw}" height="${ph}" fill="#fff"/>${boxes.map((b) => rect(b, ' fill="#000"')).join('')}</mask></defs>` +
    `<image href="${attr(href)}" width="${pw}" height="${ph}"/>` +
    `<rect class="dim" width="${pw}" height="${ph}" fill="#fff" fill-opacity="0.55" mask="url(#${mask})"/>` +
    boxes.map((b) => rect(b, ' class="ring" fill="none" stroke="#e0119d" stroke-width="3"')).join('') +
    `</svg>${figcaption}</figure>`
  );
}
function pairBlock(pair: SectionMeta['pairs'][number], lazy = false, label = stateWords(pair.state)) {
  const tag = label ? `<span class="state">${escapeHtml(label)}</span>` : '';
  const loading = lazy ? ' loading="lazy"' : '';
  const side = (name: 'before' | 'after', src: string) => {
    const [w, h] =
      name === 'before' ? [pair.baseWidth ?? pair.width, pair.baseHeight ?? pair.height] : [pair.width, pair.height];
    return safeCrop(src)
      ? `<figure><figcaption><span class="side ${name}">${name === 'before' ? 'Before' : 'After'}</span>${tag}</figcaption>` +
          `<img class="shot ${name}" src="${attr(src)}" width="${w}" height="${h}" alt="${attr(`${name === 'before' ? 'Before' : 'After'}: ${(pair.what ?? 'the whole page').replace(/\\\|/g, '|')}`)}"${loading}></figure>`
      : '';
  };
  return `<div class="pair">${side('before', pair.before)}${side('after', pair.after)}</div>`;
}
function pagePairBlock(page: SectionMetaPage): string {
  const label = `whole page ${stateWords(page.state)}`.trim();
  const tag = `<span class="state">${escapeHtml(label)}</span>`;
  const side = (name: 'before' | 'after', src: string, width: number, height: number) =>
    safeCrop(src)
      ? `<figure><figcaption><span class="side ${name}">${name === 'before' ? 'Before' : 'After'}</span>${tag}</figcaption>` +
        `<svg class="shot ${name} page" viewBox="0 0 ${width} ${height}" role="img" aria-label="${attr(`${name === 'before' ? 'Before' : 'After'}: the ${label}`)}">` +
        `<image href="${attr(src)}" width="${width}" height="${height}"/></svg></figure>`
      : '';
  return `<div class="pair">${side('before', page.before, page.baseWidth ?? page.width, page.baseHeight ?? page.height)}${side('after', page.after, page.width, page.height)}</div>`;
}
const PAGE_LINE = /^_On (.+)_$/;
function sectionParts(body: string[]) {
  const css: string[] = [];
  const notes: string[] = [];
  const wheres: Array<{ alt: string; caption: string }> = [];
  let line = '';
  let page = '';
  let inCss = false;
  body.forEach((text, i) => {
    if (text === '<details>' && body[i + 1] === '<summary>Show the CSS</summary>') inCss = true;
    if (inCss) {
      css.push(text);
      if (text === '</details>') inCss = false;
      return;
    }
    const where = text.match(WHERE_LINE);
    if (where) {
      wheres.push({ alt: where[1].match(/ alt="([^"]*)"/)?.[1] ?? '', caption: where[2] });
      return;
    }
    const pageLine = text.match(PAGE_LINE);
    if (pageLine && !page) page = pageLine[1];
    else if (
      !line &&
      text &&
      !text.startsWith('<') &&
      !text.startsWith('|') &&
      !text.startsWith('_') &&
      !STATE_LABEL.test(text)
    )
      line = text;
    else if (!PAIR_ROW.test(text) && !STATE_LABEL.test(text)) notes.push(text);
  });
  return { line, page, wheres, notes, css: css.slice(2, -1) };
}
function cssTableHtml(html: string): string {
  return html
    .replace(
      /<td><code>(#[0-9a-f]{6}|rgb\([0-9, ]+\))<\/code><\/td>/gi,
      '<td><i class="sw" style="background:$1"></i><code>$1</code></td>',
    )
    .replace(/<tr>(<td><code>[^<]*<\/code> \(follows <code>color<\/code>\))/g, '<tr class="follower">$1');
}
function sectionCard(title: string, meta: SectionMeta, body: string[]): string {
  const parts = sectionParts(body);
  const figures = meta.where.map((_w, i) =>
    whereFigure(
      meta,
      i,
      decodeAttribute(parts.wheres[i]?.alt ?? 'Where on the page'),
      decodeAttribute(parts.wheres[i]?.caption ?? ''),
    ),
  );
  const page = parts.page && !figures.length ? `<p class="page">On ${inline(parts.page)}</p>` : '';
  const [selector, ...cssRest] = (() => {
    const first = parts.css.findIndex((l) => l.trim());
    return first < 0 ? [''] : [parts.css[first], ...parts.css.slice(first + 1)];
  })();
  const paths = meta.paths.length
    ? `<details class="paths"><summary>Element paths</summary><ol>${meta.paths.map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join('')}${meta.more ? `<li>…and ${meta.more} more</li>` : ''}</ol></details>`
    : '';
  const css = parts.css.length
    ? `<details class="more css"><summary>Show the CSS</summary><div class="more-body"><p class="selector">${inline(selector.startsWith('|') ? (meta.paths[0] ?? '') : selector)}</p>${cssTableHtml(renderBlocks(selector.startsWith('|') ? [selector, ...cssRest] : cssRest).join('\n'))}${paths}</div></details>`
    : '';
  const pages = meta.pages.length
    ? `<details class="more pages"><summary>Show the whole page</summary><div class="more-body">${meta.pages
        .map(pagePairBlock)
        .join('')}</div></details>`
    : '';
  return [
    `<section class="change" id="${attr(meta.id)}">`,
    `<div class="head"><div><h2>${inline(title)}</h2><p class="line">${inline(parts.line)}</p>${page}</div>${figures.join('')}</div>`,
    renderBlocks(parts.notes).join('\n'),
    meta.pairs.map((pair) => pairBlock(pair)).join(''),
    css,
    pages,
    '</section>',
  ].join('\n');
}
function capturedSection(meta: CapturedMeta): string {
  const items = meta.pages.map((p) => {
    const widths = p.widths.length ? ` at ${andList(p.widths.map(String))}px wide` : '';
    const states = p.states.length
      ? `, at rest and in ${counted(p.states.length, 'forced state')}: ${p.states.map((s) => `<code>:${escapeHtml(s)}</code>`).join(', ')}`
      : ', at rest';
    return `The <strong>${escapeHtml(p.base)}</strong> page${widths}${states}.`;
  });
  return `<section class="coverage" aria-labelledby="coverage-title"><h2 id="coverage-title">What was captured</h2><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></section>`;
}
const TITLE_LINE = /^## 🗺️ StyleProof report$/;

/** The verdict's opening: a count to review, a clean or scoped no-change, or what holds the check (RV19-07). */
const SUMMARY_LINE =
  /^(?:\*\*\d+ changes? to review\*\*|✓|✗ |⛔ |🧱 \*\*|⚠️? (?:\*\*|UNVERIFIED)|Computed-style scope)/;

/**
 * The lines above the first heading: the summary line goes to the header, the rest stay as notes.
 * A note written above the title (the unbound source-binding warning) leads the page, before the header.
 */
function topBlock(lines: string[]) {
  const title = lines.findIndex((l) => /^#{1,3} /.test(l));
  const titled = title >= 0 && TITLE_LINE.test(lines[title]);
  if (!titled) return { titled, lead: [] as string[], summary: '', notes: [] as string[], next: 0 };
  const end = lines.findIndex((l, n) => n > title && (/^#{2,3} /.test(l) || decodeCapturedMeta(l) !== null));
  const top = lines.slice(title + 1, end < 0 ? lines.length : end);
  // Only the opening paragraph can be the verdict, and only when it is that one line: a later line, or
  // the lead of a list, stays where report.md puts it, so the page keeps report.md's order (RV20-01).
  const first = top.findIndex((l) => l.trim());
  const at = first >= 0 && SUMMARY_LINE.test(top[first]) && !top[first + 1]?.trim() ? first : -1;
  return {
    titled,
    lead: lines.slice(0, title),
    summary: at >= 0 ? inline(top[at]) : '',
    notes: top.filter((_l, n) => n !== at),
    next: title + 1 + top.length,
  };
}

type PageBody = { html: string[]; cards: Array<{ id: string; title: string }>; captured: CapturedMeta | null };
function pageBody(lines: string[], start: number, notes: string[]): PageBody {
  const body: PageBody = { html: [], cards: [], captured: null };
  let generic = [...notes];
  const flush = () => {
    if (generic.length) body.html.push(renderBlocks(generic).join('\n'));
    generic = [];
  };
  for (let i = start; i < lines.length; i++) {
    const text = lines[i];
    const next = lines.slice(i + 1).find((l) => l.trim()) ?? '';
    const meta = text.startsWith('### ') ? decodeSectionMeta(next) : null;
    const captured = decodeCapturedMeta(text);
    if (captured) body.captured = captured;
    else if (text === '## Changes') continue;
    else if (!meta) generic.push(text);
    else {
      flush();
      const end = lines.indexOf(SECTION_END, i);
      const stop = end < 0 ? lines.length : end;
      body.cards.push({ id: meta.id, title: text.slice(4) });
      body.html.push(sectionCard(text.slice(4), meta, lines.slice(lines.indexOf(next, i) + 1, stop)));
      i = stop;
    }
  }
  flush();
  return body;
}
const FOOTER =
  '<footer>Made by StyleProof from the computed styles and screenshots it captured in a real browser. Every before/after image is an unedited crop of a capture; only the Where maps are marked.</footer>';
function renderPage(lines: string[]): string {
  const top = topBlock(lines);
  const body = pageBody(lines, top.next, top.notes);
  const toc = body.cards.length
    ? `<nav class="toc" aria-label="Changes">${body.cards.map((c) => `<a href="#${attr(c.id)}">${inline(c.title)}</a>`).join('')}</nav>`
    : '';
  const summary = top.summary ? `<p class="summary">${top.summary}</p>` : '';
  const header = top.titled
    ? `<header class="top"><div class="topbar"><h1>StyleProof report</h1>${THEME_SWITCH}</div>${summary}${toc}</header>`
    : '';
  const lead = top.lead.some((l) => l.trim()) ? renderBlocks(top.lead).join('\n') : '';
  const captured = body.captured ? capturedSection(body.captured) : '';
  return [lead, header, ...body.html, captured, FOOTER].filter(Boolean).join('\n');
}
const THEME_SWITCH =
  '<div class="theme" role="group" aria-label="Colour theme">' +
  ['auto', 'light', 'dark']
    .map(
      (t) =>
        `<button type="button" data-set-theme="${t}" aria-pressed="false">${t[0].toUpperCase()}${t.slice(1)}</button>`,
    )
    .join('') +
  '</div>';

// Light is the default; dark applies by system preference unless light is forced, or whenever dark is forced.
const LIGHT =
  '--bg: #f6f7f9; --panel: #fff; --ink: #14171c; --muted: #535b67; --line: #d5dae1; --link: #0b57c2; --focus: #0b57c2; --before: #7a4f00; --before-bg: #fff3d6; --after: #0a6436; --after-bg: #dcf5e6; --ring: #e0119d; --dim: rgb(255 255 255 / .55);';
const DARK =
  '--bg: #0f1216; --panel: #171b21; --ink: #e8ebef; --muted: #9aa3ae; --line: #2a3038; --link: #8ab4ff; --focus: #8ab4ff; --before-bg: #3a2b0a; --before: #f3c46b; --after-bg: #0e3320; --after: #74dba3; --ring: #e0119d; --dim: rgb(255 255 255 / .5);';

const STYLE = `
:root { color-scheme: light; ${LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${DARK} } }
:root[data-theme="dark"] { color-scheme: dark; ${DARK} }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--link); }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 64px; }
.topbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
header.top h1 { font-size: 1.25rem; margin: 0; }
header.top p.summary { margin: 4px 0 0; color: var(--muted); }
header.top p.summary strong { color: var(--ink); }
.theme { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--panel); }
.theme button { font: inherit; font-size: .85rem; padding: 4px 12px; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.theme button + button { border-left: 1px solid var(--line); }
.theme button[aria-pressed="true"] { background: var(--ink); color: var(--panel); }
.theme button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
nav.toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 8px; }
nav.toc a { display: inline-block; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; color: inherit; text-decoration: none; background: var(--panel); font-size: .9rem; }
nav.toc a:focus-visible { outline: 2px solid var(--focus); }
section.change, section.coverage { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-top: 20px; }
.head, .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
figure { margin: 0; }
.shot, .map { width: 100%; height: auto; }
.side { font-weight: bold; }
.more { margin-top: 16px; }
.sw { display: inline-block; width: 1em; height: 1em; margin-right: 6px; }
@media (max-width: 720px) { .head, .pair { grid-template-columns: 1fr; } }
img { max-width: 100%; }
.table-scroll { display: block; inline-size: max-content; max-inline-size: 100%; overflow-x: auto; }
.table-scroll:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.table-scroll code { overflow-wrap: break-word; }
th, td { border: 1px solid var(--line); padding: 6px; }
code { background: var(--panel); }
footer { color: var(--muted); margin-top: 32px; }
`;
const THEME_SCRIPT = `<script>
(() => {
  const root = document.documentElement;
  const fromUrl = new URLSearchParams(location.search).get('theme');
  let saved = null;
  try { saved = localStorage.getItem('styleproof-report-theme'); } catch {}
  const apply = (theme) => {
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
    document.querySelectorAll('[data-set-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setTheme === (theme || 'auto'))));
  };
  apply(fromUrl || saved || 'auto');
  addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme || 'auto');
    document.querySelectorAll('[data-set-theme]').forEach((b) => b.addEventListener('click', () => {
      apply(b.dataset.setTheme);
      try { localStorage.setItem('styleproof-report-theme', b.dataset.setTheme); } catch {}
    }));
  });
})();
</script>`;

function embedVisual(page: string, outDir: string, maxBytes: number): string {
  const banner = (count: number) =>
    `<p role="alert">${count} images omitted; use the original diff input for full findings.</p>`;
  let remaining = maxBytes - Buffer.byteLength(page + banner(9999));
  let omitted = 0;
  const read = (src: string) => {
    const decoded = decodeAttribute(src);
    const data = safeCrop(decoded) ? readCropDataUrl(decoded, outDir, remaining) : null;
    if (data) remaining -= Buffer.byteLength(data);
    else omitted += 1;
    return data;
  };
  const defs: string[] = [];
  const ids = new Map<string, string>();
  page = page.replace(/<svg [^>]*>[\s\S]*?<\/svg>/g, (svg) => {
    const image = svg.match(/<image href="([^"]*)"[^>]*\/>/);
    if (!image) return svg;
    const data = ids.has(image[1]) ? 'cached' : read(image[1]);
    if (!data) return '';
    let id = ids.get(image[1]);
    if (!id) {
      id = `sp-page-${ids.size + 1}`;
      ids.set(image[1], id);
      defs.push(image[0].replace('<image ', `<image id="${id}" `).replace(image[1], data));
    }
    return svg.replace(image[0], `<use href="#${id}"/>`);
  });
  page = page.replace(/<img ([^>]*?)src="([^"]*)"([^>]*)>/g, (_m, pre, src, post) => {
    const data = read(src);
    return data ? `<img ${pre}src="${data}"${post}>` : `<span>image omitted</span>`;
  });
  if (defs.length)
    page = page.replace(
      '<main>',
      `<main><svg width="0" height="0" aria-hidden="true"><defs>${defs.join('')}</defs></svg>`,
    );
  if (omitted) page = page.replace('<main>', `<main>${banner(omitted)}`);
  if (Buffer.byteLength(page) > maxBytes) throw new Error('HTML byte budget cannot fit report text');
  return page;
}

function compactVisual(page: string, body: string, maxBytes: number): string {
  if (Buffer.byteLength(page) <= maxBytes) return page;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>StyleProof report</title><main>${body}</main></html>`;
}

function pageHtml(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StyleProof report</title>
${THEME_SCRIPT}
<style>${STYLE}
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

export function renderReportHtml(
  markdown: string,
  options?: { outDir: string; maxBytes?: number; layout?: 'visual-first' },
): string {
  const maxBytes = options?.maxBytes ?? 2_000_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('HTML byte budget must be a positive integer');
  const body = renderBlocks(markdown.split('\n')).join('\n');
  let page = `<!doctype html>
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
  .table-scroll { display: block; inline-size: max-content; max-inline-size: 100%; overflow-x: auto;
    margin-block: 8px 16px;
    background:
      linear-gradient(to right, oklch(1 0 none) 50%, oklch(1 0 none / 0)) left / 40px 100%,
      linear-gradient(to left, oklch(1 0 none) 50%, oklch(1 0 none / 0)) right / 40px 100%,
      radial-gradient(farthest-side at 0 50%, oklch(0 0 none / 0.2), oklch(0 0 none / 0)) left / 14px 100%,
      radial-gradient(farthest-side at 100% 50%, oklch(0 0 none / 0.2), oklch(0 0 none / 0)) right / 14px 100%;
    background-repeat: no-repeat;
    background-attachment: local, local, scroll, scroll; }
  .table-scroll:focus-visible { outline: 2px solid oklch(0.55 0.18 255); outline-offset: 2px; }
  .table-scroll code { overflow-wrap: break-word; }
  table { border-collapse: collapse; }
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
  const visual = /<!-- styleproof-(?:section |captured )/.test(markdown) || options?.layout === 'visual-first';
  if (visual) page = pageHtml(renderPage(markdown.split('\n')));
  if (visual && options) return embedVisual(compactVisual(page, body, maxBytes), options.outDir, maxBytes);
  if (!options) return page;
  const images = [...page.matchAll(/<img src="([^"]*)" alt="([^"]*)" loading="lazy">/g)];
  const captions = images.map((image) => `<span>${image[2]} (image omitted)</span>`);
  images.forEach((image, i) => {
    page = page.replace(image[0], `<!-- image-${i} -->`);
  });
  const banner = (count: number) =>
    `<p role="alert">${count} image${count === 1 ? '' : 's'} omitted; use the original diff input for full findings.</p>`;
  let remaining = maxBytes - Buffer.byteLength(page + banner(images.length) + captions.join(''));
  const rendered = [...captions];
  let omitted = images.length;
  // Reserve text first; new and removed surfaces have no paired evidence.
  const priority = images
    .map((image, i) => ({ image, i }))
    .sort(
      (a, b) =>
        Number(/new surface|removed surface/i.test(b.image[2])) -
        Number(/new surface|removed surface/i.test(a.image[2])),
    );
  for (const { image, i } of priority) {
    const src = readCropDataUrl(image[1], options.outDir, remaining);
    if (!src) continue;
    const tag = `<img src="${src}" alt="${image[2]}" loading="lazy">`;
    const cost = Buffer.byteLength(tag) - Buffer.byteLength(captions[i]);
    if (cost > remaining) continue;
    rendered[i] = tag;
    remaining -= cost;
    omitted -= 1;
  }
  page = page.replace(/<!-- image-(\d+) -->/g, (_match, i) => rendered[Number(i)]);
  if (omitted) page = page.replace('<main>', `<main>${banner(omitted)}`);
  if (Buffer.byteLength(page) > maxBytes) {
    throw new Error('HTML byte budget cannot fit report text');
  }
  return page;
}

/** Preserve receipts when their remaining budget cannot hold the HTML text. */
export function renderArtifactHtml(
  markdown: string,
  options: { outDir: string; maxBytes: number; receiptBytes: number; htmlMaxBytes?: number },
): string {
  const htmlMaxBytes = Math.min(options.htmlMaxBytes ?? 2_000_000, options.maxBytes);
  const remaining = options.maxBytes - options.receiptBytes;

  if (remaining > 0) {
    try {
      return renderReportHtml(markdown, { outDir: options.outDir, maxBytes: Math.min(htmlMaxBytes, remaining) });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'HTML byte budget cannot fit report text') throw error;
    }
  }

  return renderReportHtml(`${markdown}\n\n_Combined artifact byte budget exceeded to preserve report receipts._`, {
    outDir: options.outDir,
    maxBytes: htmlMaxBytes,
  });
}
