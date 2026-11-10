// Ben's report rule 5 ("no repeated or internal diagnostics in report content") as a generic
// detector: it knows no report phrases, only how to compare an output with itself. Test-only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Two units repeat when they share this many consecutive normalised tokens. Parallel list items
 *  ("the home page at N px wide, at rest" / "the docs page …") share up to 6; a restated fact
 *  shares more. */
export const SHARED_RUN = 8;
/** An identical normalised unit this long, seen twice, is a repeat even when shorter than the run. */
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

/** Approval wording in any inflection (approve, approval, approving, approved), also inside
 *  Markdown emphasis (`_Approving …_`, `*approve*`), and its synonym "sign off". */
export const APPROVAL = /(?<!\p{L})(?:approv|sign(?:s|ed|ing)?[ -]off)/iu;

export const visibleMd = (md) =>
  md
    .split('\n')
    .filter((line) => !line.startsWith('<!-- '))
    .join('\n');

export const htmlText = (html) =>
  html
    .replace(/data:[^"')\s]+/g, '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<nav class="toc"[\s\S]*?<\/nav>/g, '')
    // As in report.md: tables, fold labels and captions are not statements.
    .replace(
      /<table\b[\s\S]*?<\/table>|<summary\b[\s\S]*?<\/summary>|<sub\b[\s\S]*?<\/sub>|<figcaption\b[\s\S]*?<\/figcaption>/g,
      '\n',
    )
    // A change section's title is an h2 inside <section class="change">; it reads as report.md's
    // `###` section heading. Other headings keep their level.
    .replace(/<section class="change"[\s\S]*?<\/section>/g, (section) =>
      section.replace(/<h2\b/g, '<h3').replace(/<\/h2>/g, '</h3>'),
    )
    // Headings keep their level, so change sections are known in report.html as in report.md.
    .replace(/<h([1-6])\b[^>]*>/g, (_, level) => `\n${'#'.repeat(Number(level))} `)
    // An entry's bold code label keeps its Markdown form, so entries are known as in report.md.
    .replace(/<p>\s*<strong>\s*<code>([^<]*)<\/code>\s*<\/strong>/g, '\n**`$1`**')
    // List items keep their marker, so parallel items are known as one list.
    .replace(/<li\b[^>]*>/g, '\n- ')
    // Inline tags join their text; block tags end a line.
    .replace(/<\/?(?:strong|code|em|a|span|i|b|sub|small)\b[^>]*>/g, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ');

/** Comment text without the Action's hidden markers and its own approval box line. */
export const commentText = (body) =>
  body
    .split('\n')
    .filter((line) => !line.startsWith('<!-- ') && !/^\s*- \[[ xX]\] \*\*Approve all changes\*\*/.test(line))
    .join('\n');

/** Markdown/HTML-free, emoji-free, number-folded, lower-case tokens. */
export function normalise(text) {
  return (
    text
      .replace(/<[^>]+>/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~#>|]/g, ' ')
      // Standalone numbers only: `p1@1280` and `p10@1280` stay different identifiers.
      .replace(/(?<![\p{L}\d@.])\d+(?:\.\d+)?(?![\p{L}\d@])/gu, 'N')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}@\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

/** The CSS line under "Show the CSS" names a selector, its count and its rule or driver: a label,
 *  like a location caption, not a statement (`label.opt · 2 elements restyled · when …`). */
const CSS_LABEL = /^\s*`?[\w.#:>[\]="'() -]+`? · \d+ elements? (?:restyled|added|removed|changed)\b/;

/** Lines that only say where or which: a caption (`<sub>…</sub>`, "_On home @ 1280_", "after ·
 *  long @ 1280 · part 2 of 8 …") or an element path on its own ("body > main > p"). */
const LABEL_LINE =
  /^\s*(?:<sub>.*<\/sub>|_?(?:on |after · |before · )?[\w.-]+ ?@ ?\d+(?: · [^\n]*)?_?|(?:- )?`?(?:html|body)\b[^\s.!?]*(?: > [^\s!?]+)*`?)\s*$/i;

/** A change section starts at a `###` heading (not the comment's report link); `#`/`##` end it. An
 *  entry of the Global chrome or content lists (a line that opens with a bold code label, such as
 *  "**`a.help`** — element added on all 2 surface bases …") is a section of its own for this rule. */
const SECTION_HEADING = /^#{3} (?!📊)/;
const ENTRY_LABEL = /^\*\*`[^`\n]+`\*\*/;

/**
 * Sentences and list items; table rows and pure labels are not statements. Each unit knows the
 * list it belongs to (items of one list are parallel by construction, so only an identical item
 * counts as a repeat there), its change section (0 outside one), its paragraph, and whether it is
 * that paragraph's only sentence.
 */
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
    // Tables, folds, rules, images (an image's alt text labels it), captions, element paths and
    // the CSS label line are not statements.
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

/**
 * Parallel per-section lines. Each change section describes its own elements, so two of its
 * statements may share wording with another section's ("At rest they look the same.", "the text
 * colour changes from green to red") without saying one fact twice. The rule:
 * - statements in two different change sections, in paragraphs that differ, are parallel: shared
 *   runs and shared words between them are allowed;
 * - an identical sentence is parallel only when it is part of a longer paragraph in both sections
 *   (a clause of each section's own change line);
 * - a sentence that is a paragraph on its own and recurs identically in another section is a
 *   repeated note ("Crop omitted …" under every section past a cap), and so is an identical
 *   paragraph.
 * Outside change sections, and within one, every rule applies as before.
 */
const crossSection = (a, b) => a.section > 0 && b.section > 0 && a.section !== b.section;
const parallelLines = (a, b) => crossSection(a, b) && a.paragraphText !== b.paragraphText;
const parallelSentence = (a, b) => parallelLines(a, b) && !a.alone && !b.alone;

const grams = (tokens, n) => {
  const out = new Set();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
};

/** Repeated statements in one output, by meaning-bearing content rather than exact wording. */
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
      // A paraphrase: the same distinctive words, reworded.
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

/** A paraphrase: two statements sharing this many distinctive (4+ letter, non-generic) words, … */
export const SHARED_WORDS = 5;
/** … that are at least this share of the shorter statement's distinctive words. */
export const SHARED_SHARE = 0.4;

/** A negated claim's words, in order within this many tokens of another line, contradict it. */
export const CONTRADICTION_WINDOW = 20;

/** Words a negated claim shares with too many statements to say anything on their own. */
const GENERIC = new Set(
  'a an the this that these those is are was were it its of on in at to for by and or no failure failures change changes review regression issue problem'.split(
    ' ',
  ),
);

/**
 * Two statements that contradict each other: one says "not (a) X" and another affirms X's
 * content words (for example "this is not a base recapture failure" beside "… and recapture").
 */
export function contradictions(text) {
  const all = units(text);
  // A claim is affirmed by any other paragraph, its sentences read together.
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => ({ raws: units(p).map((u) => u.raw), tokens: normalise(p) }))
    .filter((p) => p.tokens.length);
  const out = new Set();
  for (const u of all) {
    u.tokens.forEach((token, i) => {
      // A claim that something is "not a/an X": X needs two content words to be specific.
      if (token !== 'not' || !['a', 'an'].includes(u.tokens[i + 1])) return;
      const key = u.tokens.slice(i + 2, i + 6).filter((t) => !GENERIC.has(t) && t !== 'N');
      if (key.length < 2) return;
      for (const other of paragraphs) {
        if (other.raws.includes(u.raw) || other.tokens.includes('not')) continue;
        // Any occurrence of the first word may start the affirming run.
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

/** Surface keys, commits and element selectors. */
const IDENTIFIER = /\b[\w.-]+ ?@ ?\d{2,5}\b|\b[0-9a-f]{40}\b|\b[0-9a-f]{12}\b|`(?:body|html)\b[^`]*`/g;

/** Lines that only say where something is (headings, captions, images, "_On home @ 1280_"), and a
 *  per-surface index entry ("- `home@1280` · 10 added", the migration gallery's list). */
const LOCATION_LABEL =
  /^\s*(?:#{1,6} |!\[|<img\b|<sub>|\|)|^\s*_(?:on |after · |before · )?[\w.-]+ ?@ ?\d+_\s*$|^\s*- `[\w.-]+ ?@ ?\d+` · \d+ \w+(?:, \d+ \w+)*\s*$/i;

/** Distinctive words of a block's statements, identifiers removed: what the block says about them. */
const blockWords = (statements) =>
  new Set(normalise(statements.replace(IDENTIFIER, ' ')).filter((t) => t.length > 3 && !GENERIC.has(t) && t !== 'N'));

/**
 * An identifier stated in two different blocks that say the same thing about it repeats a list
 * (the failed surfaces named in the summary and again in the footer). Two blocks that name one
 * surface for different facts (it is new; it is only partly shown) do not: they must share at least
 * SHARED_WORDS distinctive words, SHARED_SHARE of the smaller block's, to count (RV11-10). Location
 * labels are not statements: a section may name its page in its heading and caption.
 */
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

/** The report's opening block: everything above the first section or group heading. */
export const openingBlock = (text) => text.split(/\n(?=#{2,3} (?!🗺️))/)[0];

/** Problems in report.md or report.html text. */
export function reportProblems(name, text) {
  const out = [...repeats(text), ...contradictions(text)].map((p) => `${name}: ${p}`);
  // report.html is rendered from report.md; its block structure is checked there.
  if (name !== 'report.html') out.push(...repeatedIdentifiers(text).map((p) => `${name}: ${p}`));
  const code = text.match(INTERNAL_CODE);
  if (code) out.push(`${name}: internal code ${code[0]}`);
  // The title is followed by one blank line and the opening paragraph, never an empty paragraph.
  if (/^## [^\n]*\n[ \t]*\n[ \t]*\n/.test(text)) out.push(`${name}: an empty paragraph under the title`);
  const approve = text.split('\n').find((line) => APPROVAL.test(line));
  if (approve) out.push(`${name}: report text mentions approval: "${approve.trim().slice(0, 110)}"`);
  return out;
}

/**
 * Problems in a PR comment body. `approvalMode` is whether approval is the action in this run
 * (review-gate, migration, require-approval); certify and advisory comments never mention it.
 */
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
  // The footer may guide approval only beside a box, or, where approval is the action, say that
  // approval cannot clear the hold.
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

/** Pointers at content the comment does not carry. */
export function danglingReferences(report) {
  const out = [];
  const headings = [...report.matchAll(/^#{2,3} (.+)$/gm)].map((m) => normalise(m[1]).join(' '));
  const carried = (name) => headings.some((h) => h.includes(normalise(name).join(' ')));
  // Position words point at a place in the full report; the comment is a different document.
  for (const m of report.matchAll(
    // Letter lookarounds, not \b: `_below_` and `**below**` must match through emphasis.
    /[^\n]*(?<!\p{L})(?:below|beneath|above|further (?:down|up|on)|(?:in|at) the (?:next|following|previous|last) section)(?!\p{L})[^\n]*/giu,
  ))
    out.push(`points at a position: "${m[0].trim().slice(0, 110)}"`);
  // "see X", "(see X)": X must be the full report or a section the comment carries.
  for (const m of report.matchAll(/\bsee (?:the )?(?:\*\*)?([^.;,)*\n]+)([^.;\n]*)/gi)) {
    const target = m[1].trim();
    if (!/full report/i.test(target + m[2]) && !carried(target)) out.push(`"see ${target}" is not in the comment`);
  }
  // Parts of the full report the comment never carries: one-sided page tiles and their captions.
  if (!/<sub>/.test(report))
    for (const m of report.matchAll(/[^\n]*(?<!\p{L})(?:tiles?|captions?)(?!\p{L})[^\n]*/giu))
      out.push(`points at captions or tiles the comment does not carry: "${m[0].trim().slice(0, 110)}"`);
  // "listed/named under X", "a section under X", "under **X**".
  for (const m of report.matchAll(
    /\b(?:(?:listed|named)(?: once)? (?:under|in)|under) (?:the )?(?:\*\*)?([A-Z][^.;,*\n]+?)(?:\*\*)?(?: section)?(?=[.;,)]|$)/gm,
  )) {
    if (!/full report|report\.json/i.test(m[1]) && !carried(m[1])) out.push(`"under ${m[1]}" is not in the comment`);
  }
  return out;
}

/** The summary line's counts against report.json, and no zero rule claim with a missing record. */
export function countProblems(md, json) {
  const out = [];
  const ledgerGap = (json.reach?.gaps ?? []).some((gap) => gap.kind === 'ledger');
  if (ledgerGap && (json.reach.counts || json.reach.rules?.length === 0)) {
    out.push('report.json claims rule counts though a served-CSS record is missing');
  }
  out.push(...situationCounts(visibleMd(md), json));
  const line = visibleMd(md).match(
    /\*\*(\d+) changes? to review\*\*(?:[^\n]*?: (\d+) elements?(?:, (\d+) changed CSS rules?)?)?/,
  );
  if (!line) return out;
  const sections = (json.surfaces ?? []).reduce((n, s) => n + (s.regions ? Math.max(1, s.regions.length) : 1), 0);
  if (Number(line[1]) !== sections) out.push(`summary says ${line[1]} changes, report.json has ${sections}`);
  if (line[2] !== undefined) {
    const elements = (json.surfaces ?? [])
      .flatMap((s) => s.regions ?? [])
      .reduce((n, r) => n + r.paths.filter((p) => p !== '(surface)').length, 0);
    if (Number(line[2]) !== elements) out.push(`summary says ${line[2]} elements, report.json has ${elements}`);
  }
  if (line[3] !== undefined) {
    if (ledgerGap) out.push(`summary counts ${line[3]} changed CSS rules though a served-CSS record is missing`);
    else if (Number(line[3]) !== json.reach.rules.length) {
      out.push(`summary says ${line[3]} rules, report.json has ${json.reach.rules.length}`);
    }
  }
  return out;
}

/** Counts the opening states, against report.json (the real situation). */
export function situationCounts(md, json) {
  const out = [];
  const failures = md.match(/\*\*(\d+) surfaces? failed to capture on the base:\*\* ([^\n]*)/);
  if (failures) {
    const total = Number(failures[1]);
    const named = (failures[2].match(/` at `/g) ?? []).length;
    const more = Number(failures[2].match(/ and (\d+) more/)?.[1] ?? 0);
    if (total !== (json.baselineFailures ?? []).length)
      out.push(`says ${total} failed surfaces, report.json has ${json.baselineFailures.length}`);
    if (named + more !== total) out.push(`names ${named} failed surfaces and ${more} more, but says ${total}`);
  }
  const oneSided = (key) =>
    (json.surfaces ?? []).filter((s) => s[key] && s.baselineStatus !== 'baseline-repair-needed').length;
  const fresh = md.match(/\*\*(\d+) new surfaces?\*\*/);
  if (fresh && Number(fresh[1]) !== oneSided('isNew'))
    out.push(`says ${fresh[1]} new surfaces, report.json has ${oneSided('isNew')}`);
  const gone = md.match(/\*\*(\d+) removed surfaces?\*\*/);
  if (gone && Number(gone[1]) !== oneSided('isRemoved'))
    out.push(`says ${gone[1]} removed surfaces, report.json has ${oneSided('isRemoved')}`);
  // Changes missing crops: a count of changes, not image pairs (RV11-02). It is checked against the
  // change sections report.json marks `cropOmitted` (one region per section), not against the
  // renderer's own tally: the stated total equals the per-surface counts it lists; it is at least
  // those sections; and with no content layer and no one-sided page it is exactly those sections.
  const cap = md.match(/\*\*(\d+) changes? (?:is|are) missing crops\*\*([^\n]*)/);
  if (cap) {
    const total = Number(cap[1]);
    const listed = [...cap[2].matchAll(/(\d+) on /g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const sections = (json.surfaces ?? []).flatMap((s) => s.regions ?? []).filter((r) => r.cropOmitted).length;
    const oneSidedPages = (json.surfaces ?? []).filter((s) => s.isNew || s.isRemoved).length;
    if (listed !== total) out.push(`says ${total} changes are missing crops, but lists ${listed}`);
    if (total < sections) out.push(`says ${total} changes are missing crops, report.json has ${sections} sections`);
    if (!json.content && !oneSidedPages && total !== sections)
      out.push(
        `says ${total} changes are missing crops, but ${sections} change sections are (pairs counted, not changes?)`,
      );
  }
  const visible = md.match(/\*\*(\d+) visible elements? (?:was|were) added or removed\*\*/);
  if (visible && Number(visible[1]) !== (json.reviewableCounts?.dom ?? 0)) {
    out.push(`says ${visible[1]} visible elements changed, report.json counts ${json.reviewableCounts?.dom ?? 0}`);
  }
  return out;
}
