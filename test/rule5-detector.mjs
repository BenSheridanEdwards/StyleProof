import { visibleText } from './visible-text.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED_RUN = 8;
export const SAME_UNIT = 4;
const TRUST_STATES = [...fs.readFileSync(path.join(root, 'src/verdict.ts'), 'utf8').matchAll(/\| '([A-Z_]+)'/g)].map(
  (m) => m[1],
);
export const INTERNAL_CODE = new RegExp(
  [
    ...TRUST_STATES,
    'REPORT_PUBLICATION_FAILED',
    'capture_failed',
    'base-capture-failed',
    '\\bJ2\\b',
    '\\bJ3\\b',
    'Reach (?:in)?complete',
    'warn-only',
    'scriptReach',
    'run-level gap',
    'Product-state identity unproven',
  ].join('|'),
);
export const APPROVAL = /(?<!\p{L})(?:approv|sign(?:s|ed|ing)?[ -]off)/iu;
export const visibleMd = (md) =>
  md
    .split('\n')
    .filter((line) => !line.startsWith('<!-- '))
    .join('\n');
export const htmlText = (html) =>
  visibleText(
    html
      .replace(/data:[^"')\s]+/g, '')
      .replace(/<section class="change"[\s\S]*?<\/section>/g, (section) =>
        section.replace(/<h2\b/g, '<h3').replace(/<\/h2>/g, '</h3>'),
      )
      .replace(/<p>\s*<strong>\s*<code>([^<]*)<\/code>\s*<\/strong>/g, '\n**`$1`**'),
    { reportStatements: true },
  ).replace(/[ \t]+/g, ' ');
export const commentText = (body) =>
  body
    .split('\n')
    .filter((line) => !line.startsWith('<!-- ') && !/^\s*- \[[ xX]\] \*\*Approve all changes\*\*/.test(line))
    .join('\n');
export function normalise(text) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~#>|]/g, ' ')
    .replace(/(?<![\p{L}\d@.])\d+(?:\.\d+)?(?![\p{L}\d@])/gu, 'N')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
const CSS_LABEL = /^\s*`?[\w.#:>[\]="'() -]+`? · \d+ elements? (?:restyled|added|removed|changed)\b/;
const LABEL_LINE =
  /^\s*(?:<sub>.*<\/sub>|_?(?:on |after · |before · )?[\w.-]+ ?@ ?\d+(?: · [^\n]*)?_?|(?:- )?`?(?:html|body)\b[^\s.!?]*(?: > [^\s!?]+)*`?)\s*$/i;
const SECTION_HEADING = /^#{3} (?!📊)/;
const ENTRY_LABEL = /^\*\*`[^`\n]+`\*\*/;
export function units(text) {
  const out = [];
  let list = 0;
  let inList = false;
  let section = 0;
  let sections = 0;
  let paragraph = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      paragraph += 1;
      continue;
    }
    if (/^#{1,6} /.test(line)) {
      section = SECTION_HEADING.test(line) ? ++sections : 0;
      paragraph += 1;
    } else if (ENTRY_LABEL.test(line)) section = ++sections;
    if (
      /^\s*(?:\||!\[|<img\b)/.test(line) ||
      /^\s*(?:<\/?details>|<summary>.*|---+)\s*$/.test(line) ||
      CSS_LABEL.test(line) ||
      LABEL_LINE.test(line)
    )
      continue;
    const item = /^\s*[-*] /.test(line);
    if (item && !inList) list += 1;
    inList = item || (inList && !line.trim());
    for (const raw of line.split(/(?<=[.;!?])\s+(?=\S)/)) {
      const tokens = normalise(raw);
      if (tokens.length) out.push({ raw: raw.trim(), tokens, list: item ? list : 0, section, paragraph });
    }
  }
  const sizes = new Map();
  const texts = new Map();
  for (const u of out) {
    sizes.set(u.paragraph, (sizes.get(u.paragraph) ?? 0) + 1);
    texts.set(u.paragraph, `${texts.get(u.paragraph) ?? ''} ${u.tokens.join(' ')}`);
  }
  return out.map((u) => ({ ...u, alone: sizes.get(u.paragraph) === 1, paragraphText: texts.get(u.paragraph) }));
}
const crossSection = (a, b) => a.section > 0 && b.section > 0 && a.section !== b.section;
const parallelLines = (a, b) => crossSection(a, b) && a.paragraphText !== b.paragraphText;
const parallelSentence = (a, b) => parallelLines(a, b) && !a.alone && !b.alone;
const grams = (tokens, n) => {
  const out = new Set();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
};
export function repeats(text) {
  const all = units(text);
  const out = [];
  const seen = new Map();
  for (const u of all) {
    if (u.tokens.length < SAME_UNIT) continue;
    const key = u.tokens.join(' ');
    const earlier = seen.get(key) ?? [];
    if (earlier.some((e) => !parallelSentence(e, u))) out.push(`said twice: "${u.raw.slice(0, 110)}"`);
    seen.set(key, [...earlier, u]);
  }
  const runs = all.map((u) => grams(u.tokens, SHARED_RUN));
  const words = all.map((u) => new Set(u.tokens.filter((t) => t.length > 3 && !GENERIC.has(t) && t !== 'N')));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i].tokens.join(' ') === all[j].tokens.join(' ')) continue;
      if (all[i].list && all[i].list === all[j].list) continue;
      if (parallelLines(all[i], all[j])) continue;
      const shared = [...runs[i]].find((g) => runs[j].has(g));
      if (shared) {
        out.push(`two statements share "${shared}": "${all[i].raw.slice(0, 80)}" / "${all[j].raw.slice(0, 80)}"`);
        continue;
      }
      const common = [...words[i]].filter((w) => words[j].has(w));
      if (common.length >= SHARED_WORDS && common.length / Math.min(words[i].size, words[j].size) >= SHARED_SHARE) {
        out.push(
          `two statements say the same thing (${common.join(', ')}): "${all[i].raw.slice(0, 70)}" / "${all[j].raw.slice(0, 70)}"`,
        );
      }
    }
  }
  return out;
}
export const SHARED_WORDS = 5;
export const SHARED_SHARE = 0.4;
export const CONTRADICTION_WINDOW = 20;
const GENERIC = new Set(
  'a an the this that these those is are was were it its of on in at to for by and or no failure failures change changes review regression issue problem'.split(
    ' ',
  ),
);
export function contradictions(text) {
  const all = units(text);
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => ({ raws: units(p).map((u) => u.raw), tokens: normalise(p) }))
    .filter((p) => p.tokens.length);
  const out = new Set();
  for (const u of all) {
    u.tokens.forEach((token, i) => {
      if (token !== 'not' || !['a', 'an'].includes(u.tokens[i + 1])) return;
      const key = u.tokens.slice(i + 2, i + 6).filter((t) => !GENERIC.has(t) && t !== 'N');
      if (key.length < 2) return;
      for (const other of paragraphs) {
        if (other.raws.includes(u.raw) || other.tokens.includes('not')) continue;
        const inOrder = other.tokens.some((t, at) => {
          if (t !== key[0]) return false;
          const window = other.tokens.slice(at, at + CONTRADICTION_WINDOW);
          let from = 0;
          return key.every((word) => {
            const found = window.indexOf(word, from);
            from = found + 1;
            return found >= 0;
          });
        });
        if (inOrder) out.add(`contradiction: "${u.raw.slice(0, 80)}" / "${other.raws.join(' ').slice(0, 80)}"`);
      }
    });
  }
  return [...out];
}
const IDENTIFIER = /\b[\w.-]+ ?@ ?\d{2,5}\b|\b[0-9a-f]{40}\b|\b[0-9a-f]{12}\b|`(?:body|html)\b[^`]*`/g;
const LOCATION_LABEL =
  /^\s*(?:#{1,6} |!\[|<img\b|<sub>|\|)|^\s*_(?:on |after · |before · )?[\w.-]+ ?@ ?\d+_\s*$|^\s*- `[\w.-]+ ?@ ?\d+` · \d+ \w+(?:, \d+ \w+)*\s*$/i;
const blockWords = (statements) =>
  new Set(normalise(statements.replace(IDENTIFIER, ' ')).filter((t) => t.length > 3 && !GENERIC.has(t) && t !== 'N'));
export function repeatedIdentifiers(text) {
  const blocks = [];
  let current = [];
  for (const line of text.split('\n')) {
    const item = /^\s*[-*] /.test(line);
    const previousItem = current.length > 0 && /^\s*[-*] /.test(current[current.length - 1]);
    if (!line.trim() || (current.length && item !== previousItem)) {
      if (current.length) blocks.push(current);
      current = [];
    }
    if (line.trim()) current.push(line);
  }
  if (current.length) blocks.push(current);
  const where = new Map();
  const out = new Set();
  blocks.forEach((block, i) => {
    const statements = block.filter((line) => !LOCATION_LABEL.test(line)).join('\n');
    const words = blockWords(statements);
    for (const id of new Set((statements.match(IDENTIFIER) ?? []).map((s) => s.replace(/\s/g, '')))) {
      const earlier = where.get(id);
      if (!earlier) {
        where.set(id, { i, words });
        continue;
      }
      if (earlier.i === i) continue;
      const common = [...words].filter((w) => earlier.words.has(w));
      if (common.length >= SHARED_WORDS && common.length / Math.min(words.size, earlier.words.size) >= SHARED_SHARE)
        out.add(`${id} is stated in two blocks that say the same thing (${common.join(', ')})`);
    }
  });
  return [...out];
}
export function reportProblems(name, text) {
  const out = [...repeats(text), ...contradictions(text)].map((p) => `${name}: ${p}`);
  if (name !== 'report.html') out.push(...repeatedIdentifiers(text).map((p) => `${name}: ${p}`));
  const code = text.match(INTERNAL_CODE);
  if (code) out.push(`${name}: internal code ${code[0]}`);
  if (/^## [^\n]*\n[ \t]*\n[ \t]*\n/.test(text)) out.push(`${name}: an empty paragraph under the title`);
  const approve = text.split('\n').find((line) => APPROVAL.test(line));
  if (approve) out.push(`${name}: report text mentions approval: "${approve.trim().slice(0, 110)}"`);
  return out;
}
export function commentProblems(name, body, { approvalMode = true } = {}) {
  const text = commentText(body);
  const [report, footer = ''] = text.split('\n### 📊');
  const approvalBox = body.includes('- [ ] **Approve all changes**') || body.includes('- [x] **Approve all changes**');
  const out = [...repeats(text), ...contradictions(text)].map((p) => `${name}: ${p}`);
  out.push(...repeatedIdentifiers(text.replace('\n### 📊', '\n\n### 📊')).map((p) => `${name}: ${p}`));
  const code = text.match(INTERNAL_CODE);
  if (code) out.push(`${name}: internal code ${code[0]}`);
  const reportApprove = report.split('\n').find((line) => APPROVAL.test(line));
  if (reportApprove) out.push(`${name}: the report part mentions approval: "${reportApprove.trim().slice(0, 110)}"`);
  const footerApprove = footer
    .split('\n')
    .find((line) => APPROVAL.test(line) && !approvalBox && !(approvalMode && /cannot clear|can't clear/i.test(line)));
  if (footerApprove)
    out.push(
      `${name}: footer mentions approval where ${approvalMode ? 'there is no box' : 'approval is not the action'}: "${footerApprove.trim().slice(0, 110)}"`,
    );
  out.push(...danglingReferences(report).map((p) => `${name}: ${p}`));
  return out;
}
export function danglingReferences(report) {
  const out = [];
  const headings = [...report.matchAll(/^#{2,3} (.+)$/gm)].map((m) => normalise(m[1]).join(' '));
  const carried = (name) => headings.some((h) => h.includes(normalise(name).join(' ')));
  for (const m of report.matchAll(
    /[^\n]*(?<!\p{L})(?:below|beneath|above|further (?:down|up|on)|(?:in|at) the (?:next|following|previous|last) section)(?!\p{L})[^\n]*/giu,
  ))
    out.push(`points at a position: "${m[0].trim().slice(0, 110)}"`);
  for (const m of report.matchAll(/\bsee (?:the )?(?:\*\*)?([^.;,)*\n]+)([^.;\n]*)/gi)) {
    const target = m[1].trim();
    if (!/full report/i.test(target + m[2]) && !carried(target)) out.push(`"see ${target}" is not in the comment`);
  }
  for (const m of report.matchAll(
    /\b(?:(?:listed|named)(?: once)? (?:under|in)|under) (?:the )?(?:\*\*)?([A-Z][^.;,*\n]+?)(?:\*\*)?(?: section)?(?=[.;,)]|$)/gm,
  )) {
    if (!/full report|report\.json/i.test(m[1]) && !carried(m[1])) out.push(`"under ${m[1]}" is not in the comment`);
  }
  return out;
}
