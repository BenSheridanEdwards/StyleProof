import fs from 'node:fs';
import path from 'node:path';
import { andList, counted, STATE_WORDS } from './change-line.js';
import { RING_PAD } from './where-map.js';
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

/** Only the attribute order and dimensions emitted by clean crop tables are accepted. */
const CROP_IMAGE =
  /<img src="((?:[^"&<>]|&(?:amp|quot|lt|gt);)*)" (width|height)="([0-9]+)" alt="((?:[^"&<>]|&(?:amp|quot|lt|gt);)*)">/;
const CODE_OR_CROP_IMAGE = new RegExp(`${CODE_SPAN.source}|${CROP_IMAGE.source}`, 'g');
const decodeAttribute = (value: string): string =>
  value.replace(
    /&(amp|quot|lt|gt);/g,
    (_match, entity: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>' })[entity]!,
  );

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
    .replace(CODE_OR_CROP_IMAGE, (match, fence, code, src, dimension, size, alt) => {
      if (fence) return stage(`<code>${escapeHtml(unpad(code))}</code>`);
      const url = decodeAttribute(src);
      if (!isSafeUrl(url)) return stage(escapeHtml(match));
      return stage(
        `<img src="${escapeHtml(url)}" ${dimension}="${size}" alt="${escapeHtml(decodeAttribute(alt))}" loading="lazy">`,
      );
    })
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
    // The Where map line: an image and its caption on one line (GitHub keeps them inline).
    const where = lines[i].match(WHERE_LINE);
    return where
      ? { html: `<p class="where">${inline(where[1])}<br><sub>${inline(where[2])}</sub></p>`, next: i + 1 }
      : null;
  },
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

// ---------------------------------------------------------------- the visual page

const attr = (value: string | number) => escapeHtml(String(value));
/** A crop reference the page may load: relative `crops/<file>.png` or http(s), never anything else. */
const safeCrop = (src: string) => /^(?:crops\/[^/"<>\s]+\.png|https?:\/\/[^"<>\s]+)$/.test(src) && isSafeUrl(src);

const stateWords = (state: string) =>
  state === 'rest' ? '' : STATE_WORDS[state] ? `while ${STATE_WORDS[state]}` : `in :${state}`;

/** The Where map as an SVG over the head (or base) page, or the PNG overview when the page is not available. */
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
    // Fill and stroke also as attributes: the compact page has no stylesheet for them.
    `<rect class="dim" width="${pw}" height="${ph}" fill="#fff" fill-opacity="0.55" mask="url(#${mask})"/>` +
    boxes.map((b) => rect(b, ' class="ring" fill="none" stroke="#e0119d" stroke-width="3"')).join('') +
    `</svg>${figcaption}</figure>`
  );
}

/** One before/after pair: two clean images side by side (stacked on narrow screens). */
function pairBlock(
  pair: { state: string; before: string; after: string; width: number; height: number; what?: string },
  lazy = false,
  label = stateWords(pair.state),
) {
  const words = label;
  const tag = words ? `<span class="state">${escapeHtml(words)}</span>` : '';
  const loading = lazy ? ' loading="lazy"' : '';
  const side = (name: 'before' | 'after', src: string) =>
    safeCrop(src)
      ? `<figure><figcaption><span class="side ${name}">${name === 'before' ? 'Before' : 'After'}</span>${tag}</figcaption>` +
        `<img class="shot ${name}" src="${attr(src)}" width="${pair.width}" height="${pair.height}" alt="${attr(`${name === 'before' ? 'Before' : 'After'}: ${(pair.what ?? 'the whole page').replace(/\\\|/g, '|')}`)}"${loading}></figure>`
      : '';
  return `<div class="pair">${side('before', pair.before)}${side('after', pair.after)}</div>`;
}

/**
 * A whole-page pair as SVG panels over the page image, so report.html can inline each page once
 * and draw it here and in the Where maps through `<use>` (no script needed).
 */
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

/** Split a section's Markdown body into its line, Where captions, notes and the CSS fold. */
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
    // A state label stays only when it heads a note (a pair with no images), not a pair table.
    else if (
      !PAIR_ROW.test(text) &&
      !(
        STATE_LABEL.test(text) &&
        body
          .slice(i + 1)
          .find((l) => l)
          ?.startsWith('| Before')
      )
    )
      notes.push(text);
  });
  return { line, page, wheres, notes, css: css.slice(2, -1) };
}

/** The CSS fold's table, as the preview draws it: a swatch beside each hex colour, currentColor followers muted. */
function cssTableHtml(html: string): string {
  return html
    .replace(
      /<td><code>(#[0-9a-f]{6})<\/code><\/td>/gi,
      '<td><i class="sw" style="background:$1"></i><code>$1</code></td>',
    )
    .replace(/<tr>(<td><code>[^<]*<\/code> \(follows <code>color<\/code>\))/g, '<tr class="follower">$1');
}

/** One change section as a card: name and line beside the Where map, pairs, then the CSS and whole pages on demand. */
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
    ? `<details class="more css"><summary>Show the CSS</summary><div class="more-body"><p class="selector">${inline(selector)}</p>${cssTableHtml(renderBlocks(cssRest).join('\n'))}${paths}</div></details>`
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

/** "What was captured": pages and widths, forced states, recipe states and the changed rules. */
function capturedSection(meta: CapturedMeta, sectionIds: Set<string>): string {
  const items = meta.pages.map((p) => {
    const widths = p.widths.length ? ` at ${andList(p.widths.map(String))}px wide` : '';
    const states = p.states.length
      ? `, at rest and in ${counted(p.states.length, 'forced state')}: ${p.states.map((s) => `<code>:${escapeHtml(s)}</code>`).join(', ')}`
      : ', at rest';
    return `The <strong>${escapeHtml(p.base)}</strong> page${widths}${states}.`;
  });
  if (meta.recipes.length) {
    items.push(
      `Recipe states: ${meta.recipes.map((r) => `<code>${escapeHtml(r.state)}</code> (${escapeHtml(r.action)}) on <strong>${escapeHtml(r.surface)}</strong>`).join(', ')}.`,
    );
  }
  const ruleLink = (r: CapturedMeta['rules'][number]) =>
    r.section && sectionIds.has(r.section)
      ? `<a href="#${attr(r.section)}"><code>${escapeHtml(r.key)}</code></a>`
      : `<code>${escapeHtml(r.key)}</code>`;
  // Rules reach could not match or check are stated at the top (warn lines or the gate section).
  const groups: Array<[string, string]> = [['reached', 'each matched by elements on a captured page']];
  for (const [status, words] of groups) {
    const rules = meta.rules.filter((r) => r.status === status);
    if (!rules.length) continue;
    const sheets = [...new Set(rules.map((r) => r.sheet).filter(Boolean))];
    const where = sheets.length === 1 ? ` in <code>${escapeHtml(sheets[0])}</code>` : '';
    items.push(`${counted(rules.length, 'changed CSS rule')}${where}, ${words}: ${rules.map(ruleLink).join(', ')}.`);
  }
  if (!items.length) return '';
  return `<section class="coverage" aria-labelledby="coverage-title"><h2 id="coverage-title">What was captured</h2><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></section>`;
}

const TITLE_LINE = /^## 🗺️ StyleProof report$/;

const SUMMARY_LINE = /^(?:\*\*\d+ changes? to review\*\*|✓|⚠ UNVERIFIED|Computed-style scope)/;

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
  const at = top.findIndex((l) => SUMMARY_LINE.test(l));
  return {
    titled,
    lead: lines.slice(0, title),
    summary: at >= 0 ? inline(top[at]) : '',
    notes: top.filter((_l, n) => n !== at),
    next: title + 1 + top.length,
  };
}

type PageBody = { html: string[]; cards: Array<{ id: string; title: string }>; captured: CapturedMeta | null };

/** Walk the Markdown after the top block: section cards, the captured data, and everything else as written. */
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
    // The GitHub "Changes" heading is not repeated: the cards carry their own names.
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

/** The page body: any lead note, header (title, theme switch, summary, jump links), top notes, sections, captured, footer. */
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
  const captured = body.captured ? capturedSection(body.captured, new Set(body.cards.map((c) => c.id))) : '';
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
nav.toc a:focus-visible, a:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
section.change, section.coverage { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-top: 20px; }
.head { display: grid; grid-template-columns: 1fr minmax(160px, 240px); gap: 16px; align-items: start; }
.head h2, .coverage h2 { margin: 0 0 4px; font-size: 1.15rem; border: 0; padding: 0; }
.head p.line { margin: 0; font-size: 1.05rem; }
.head p.page { margin: 4px 0 0; color: var(--muted); font-size: .9rem; }
.coverage ul { margin: 8px 0 0; padding-left: 20px; }
.coverage li + li { margin-top: 4px; }
figure { margin: 0; }
.where figcaption { font-size: .8rem; color: var(--muted); margin-top: 4px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
.pair figcaption { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.side { font-weight: 700; font-size: .8rem; letter-spacing: .06em; text-transform: uppercase; padding: 2px 10px; border-radius: 6px; }
.side.before { background: var(--before-bg); color: var(--before); }
.side.after { background: var(--after-bg); color: var(--after); }
.state { font-size: .85rem; color: var(--muted); }
.shot, .map { display: block; width: 100%; height: auto; border-radius: 8px; border: 2px solid var(--line); background: #fff; }
.shot.before { border-color: color-mix(in srgb, var(--before) 45%, transparent); }
.shot.after { border-color: color-mix(in srgb, var(--after) 45%, transparent); }
.map { border-width: 1px; }
.map .dim { fill: var(--dim); }
.map .ring { fill: none; stroke: var(--ring); stroke-width: 3; vector-effect: non-scaling-stroke; }
details.more { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
details.more + details.more { margin-top: 0; border-top: 0; }
details.more > summary { cursor: pointer; font-weight: 600; color: var(--muted); width: fit-content; }
details.more > summary:hover { color: var(--ink); }
summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
.more-body { margin-top: 12px; overflow-x: auto; }
.selector { margin: 0 0 8px; color: var(--muted); font-size: .9rem; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; margin-bottom: 12px; font-size: .9rem; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { color: var(--muted); font-weight: 600; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
.sw { display: inline-block; width: .9em; height: .9em; border-radius: 3px; margin-right: 6px; vertical-align: -1px; border: 1px solid rgb(127 127 127 / .5); }
tr.follower td { color: var(--muted); font-size: .85rem; }
.paths summary { cursor: pointer; color: var(--muted); font-size: .85rem; }
.paths ol { margin: 6px 0 0; padding-left: 20px; font-size: .8rem; overflow-wrap: anywhere; }
main > h2, main > h3 { margin-top: 28px; }
main > p img, main > p.shot img, td img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
blockquote { border-left: 3px solid var(--line); margin: 8px 0; padding: 0 12px; color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
sub { color: var(--muted); }
footer { margin-top: 32px; color: var(--muted); font-size: .85rem; }
@media (max-width: 720px) {
  .head { grid-template-columns: 1fr; }
  .where { max-width: 320px; }
  .pair { grid-template-columns: 1fr; gap: 12px; }
  section.change, section.coverage { padding: 16px; }
}`;

// The theme switch: ?theme= or the saved choice, else the system setting; storage may be unavailable.
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

/** `shared`: an SVG drawing a page `<image>`; each page is inlined once in `<defs>` and drawn with `<use>`. */
type ImageSlot = { match: string; src: string; alt: string; priority: number; fallback?: string; shared?: boolean };

/** Embedding order: one-sided pages first, then pairs and other images, Where maps, whole pages last. */
function imagePriority(tag: string, alt: string): number {
  if (/new surface|removed surface/i.test(alt)) return 0;
  if (tag.includes('loading="lazy"') && tag.includes('class="shot')) return 3;
  return tag.includes('class="map"') ? 2 : 1;
}

const attrOf = (tag: string, name: string) => tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? '';

/** Every image in the page with its embedding priority; an SVG map carries its PNG fallback. */
function imageSlots(page: string): ImageSlot[] {
  const maps = [...page.matchAll(/<svg [^>]*class="map" data-fallback="([^"]*)"[^>]*>[\s\S]*?<\/svg>/g)].map((m) => {
    const alt = attrOf(m[0], 'aria-label');
    return {
      match: m[0],
      src: m[0].match(/<image href="([^"]*)"/)?.[1] ?? '',
      alt,
      priority: 2,
      fallback: `<img class="map" src="${m[1]}" alt="${alt}">`,
      shared: true,
    };
  });
  const pages = [...page.matchAll(/<svg [^>]*class="shot [^"]*page"[^>]*>[\s\S]*?<\/svg>/g)].map((m) => ({
    match: m[0],
    src: m[0].match(/<image href="([^"]*)"/)?.[1] ?? '',
    alt: attrOf(m[0], 'aria-label'),
    priority: 3,
    shared: true,
  }));
  const images = [...page.matchAll(/<img [^>]*>/g)].map((m) => {
    const alt = attrOf(m[0], 'alt');
    return { match: m[0], src: attrOf(m[0], 'src'), alt, priority: imagePriority(m[0], alt) };
  });
  return [...maps, ...pages, ...images];
}

const PAGE_IMAGE = /<image href="[^"]*" width="[^"]*" height="[^"]*"\/>/;
const DEFS_WRAPPER =
  '<svg class="sp-defs" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute"><defs></defs></svg>';

/** Embed images as data URLs by priority while the byte budget allows; the rest become short captions. */
function embedImages(page: string, outDir: string, maxBytes: number): string {
  const slots = imageSlots(page);
  const caption = (slot: ImageSlot) => `<span>${slot.alt} (image omitted)</span>`;
  let body = page;
  slots.forEach((slot, i) => {
    body = body.replace(slot.match, `<!-- image-${i} -->`);
  });
  const banner = (count: number) =>
    `<p role="alert">${count} image${count === 1 ? '' : 's'} omitted; use the original diff input for full findings.</p>`;
  const rendered = slots.map(caption);
  let remaining = maxBytes - Buffer.byteLength(body + banner(slots.length) + rendered.join(''));
  let omitted = slots.length;
  const order = slots.map((slot, i) => ({ slot, i })).sort((a, b) => a.slot.priority - b.slot.priority || a.i - b.i);
  const embed = (tag: string, src: string, attrName: 'src' | 'href', i: number): boolean => {
    const data = readCropDataUrl(decodeAttribute(src), outDir, remaining);
    if (!data) return false;
    const html = tag.replace(`${attrName}="${src}"`, `${attrName}="${data}"`);
    const cost = Buffer.byteLength(html) - Buffer.byteLength(rendered[i]);
    if (cost > remaining) return false;
    rendered[i] = html;
    remaining -= cost;
    omitted -= 1;
    return true;
  };
  // Every page image is inlined once, in a hidden <defs>; each map and whole-page panel <use>s it.
  const pageIds = new Map<string, string>();
  const defs: string[] = [];
  const shareImage = (slot: ImageSlot, i: number): boolean => {
    const image = slot.match.match(PAGE_IMAGE)?.[0];
    if (!image) return false;
    let id = pageIds.get(image);
    let def = '';
    if (!id) {
      const data = readCropDataUrl(decodeAttribute(slot.src), outDir, remaining);
      if (!data) return false;
      id = `sp-page-${pageIds.size + 1}`;
      def = image.replace('<image href=', `<image id="${id}" href=`).replace(`href="${slot.src}"`, `href="${data}"`);
    }
    const html = slot.match.replace(image, `<use href="#${id}"/>`);
    const cost =
      Buffer.byteLength(def) +
      (def && !defs.length ? DEFS_WRAPPER.length : 0) +
      Buffer.byteLength(html) -
      Buffer.byteLength(rendered[i]);
    if (cost > remaining) return false;
    if (def) {
      pageIds.set(image, id);
      defs.push(def);
    }
    rendered[i] = html;
    remaining -= cost;
    omitted -= 1;
    return true;
  };
  for (const { slot, i } of order) {
    if (slot.shared && shareImage(slot, i)) continue;
    // The SVG map needs the whole page; without it, the PNG overview stands in.
    if (slot.fallback) embed(slot.fallback, slot.fallback.match(/ src="([^"]*)"/)?.[1] ?? '', 'src', i);
    else if (!slot.shared) embed(slot.match, slot.src, 'src', i);
  }
  const shared = defs.length ? DEFS_WRAPPER.replace('</defs>', `${defs.join('')}</defs>`) : '';
  body = body.replace(/<!-- image-(\d+) -->/g, (_match, i) => rendered[Number(i)]);
  body = body.replace('<main>', `<main>${shared}${omitted ? banner(omitted) : ''}`);
  return body;
}

/** Plain styles for a page too small a budget leaves no room for the full design. */
const COMPACT_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.55 system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #8888; padding: 4px 8px; text-align: left; }
  .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }`;

function pageHtml(fullBody: string, compact: boolean): string {
  // The theme buttons need the theme script, which the compact page leaves out.
  const body = compact ? fullBody.replace(THEME_SWITCH, '') : fullBody;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StyleProof report</title>
${compact ? '' : THEME_SCRIPT}
<style>${compact ? COMPACT_STYLE : STYLE}
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

export function renderReportHtml(markdown: string, options?: { outDir: string; maxBytes?: number }): string {
  const maxBytes = options?.maxBytes ?? 2_000_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('HTML byte budget must be a positive integer');
  const body = renderPage(markdown.split('\n'));
  if (!options) return pageHtml(body, false);
  // The full design first; a budget too small for its styles still gets every word of the report.
  for (const compact of [false, true]) {
    const embedded = embedImages(pageHtml(body, compact), options.outDir, maxBytes);
    if (Buffer.byteLength(embedded) <= maxBytes) return embedded;
  }
  throw new Error('HTML byte budget cannot fit report text');
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
