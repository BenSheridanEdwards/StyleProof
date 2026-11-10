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

/** Sentences and list items; table rows and pure labels are not statements. Each unit knows the
 *  list it belongs to: items of one list are parallel by construction, so only an identical item
 *  counts as a repeat there. */
export function units(text) {
  const out = [];
  let list = 0;
  let inList = false;
  for (const line of text.split('\n')) {
    // Tables, folds, rules and images (an image's alt text labels it) are not statements.
    if (/^\s*(?:\||!\[|<img\b)/.test(line) || /^\s*(?:<\/?details>|<summary>|---+)\s*$/.test(line)) continue;
    const item = /^\s*[-*] /.test(line);
    if (item && !inList) list += 1;
    inList = item || (inList && !line.trim());
    for (const raw of line.split(/(?<=[.;!?])\s+(?=\S)/)) {
      const tokens = normalise(raw);
      if (tokens.length) out.push({ raw: raw.trim(), tokens, list: item ? list : 0 });
    }
  }
  return out;
}

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
    if (seen.has(key)) out.push(`said twice: "${u.raw.slice(0, 110)}"`);
    else seen.set(key, u);
  }
  const runs = all.map((u) => grams(u.tokens, SHARED_RUN));
  const words = all.map((u) => new Set(u.tokens.filter((t) => t.length > 3 && !GENERIC.has(t) && t !== 'N')));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i].tokens.join(' ') === all[j].tokens.join(' ')) continue;
      if (all[i].list && all[i].list === all[j].list) continue;
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

/** Lines that only say where something is (headings, captions, images, "_On home @ 1280_"). */
const LOCATION_LABEL = /^\s*(?:#{1,6} |!\[|<img\b|<sub>|\|)|^\s*_(?:on |after · |before · )?[\w.-]+ ?@ ?\d+_\s*$/i;

/**
 * An identifier stated in two different blocks (paragraphs or lists) repeats a list. Location
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
    for (const id of new Set((statements.match(IDENTIFIER) ?? []).map((s) => s.replace(/\s/g, '')))) {
      if (where.has(id) && where.get(id) !== i) out.add(`${id} is stated in two blocks`);
      else where.set(id, i);
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
  const approve = text.split('\n').find((line) => /\bapprov/i.test(line));
  if (approve) out.push(`${name}: report text mentions approval: "${approve.trim().slice(0, 110)}"`);
  return out;
}

/** Problems in a PR comment body. */
export function commentProblems(name, body) {
  const text = commentText(body);
  const [report, footer = ''] = text.split('\n### 📊');
  const approvalBox = body.includes('- [ ] **Approve all changes**') || body.includes('- [x] **Approve all changes**');
  const out = [...repeats(text), ...contradictions(text)].map((p) => `${name}: ${p}`);
  out.push(...repeatedIdentifiers(text.replace('\n### 📊', '\n\n### 📊')).map((p) => `${name}: ${p}`));
  const code = text.match(INTERNAL_CODE);
  if (code) out.push(`${name}: internal code ${code[0]}`);
  const reportApprove = report.split('\n').find((line) => /\bapprov/i.test(line));
  if (reportApprove) out.push(`${name}: the report part mentions approval: "${reportApprove.trim().slice(0, 110)}"`);
  // The footer may guide approval only beside a box, or say approval cannot clear the hold.
  const footerApprove = footer
    .split('\n')
    .find((line) => /\bapprov/i.test(line) && !approvalBox && !/cannot clear|can't clear/i.test(line));
  if (footerApprove) out.push(`${name}: footer mentions approval with no box: "${footerApprove.trim().slice(0, 110)}"`);
  out.push(...danglingReferences(report).map((p) => `${name}: ${p}`));
  return out;
}

/** Pointers at content the comment does not carry. */
export function danglingReferences(report) {
  const out = [];
  const headings = [...report.matchAll(/^#{2,3} (.+)$/gm)].map((m) => normalise(m[1]).join(' '));
  const carried = (name) => headings.some((h) => h.includes(normalise(name).join(' ')));
  for (const m of report.matchAll(/[^\n]*\b(?:below|above)\b[^\n]*/gi))
    out.push(`points "below/above": "${m[0].trim().slice(0, 110)}"`);
  for (const m of report.matchAll(/\(see ([^)]+)\)/gi)) {
    if (!/^the full report$/i.test(m[1].trim()) && !carried(m[1])) out.push(`"(see ${m[1]})" is not in the comment`);
  }
  for (const m of report.matchAll(
    /\b(?:listed|named)(?: once)? (?:under|in) (?:\*\*)?([A-Z][^.;,*]+?)(?:\*\*)?(?=[.;,]|$)/gm,
  )) {
    if (!/full report|report\.json/i.test(m[1]) && !carried(m[1]))
      out.push(`"listed under ${m[1]}" is not in the comment`);
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
  const visible = md.match(/\*\*(\d+) visible elements? (?:was|were) added or removed\*\*/);
  if (visible && Number(visible[1]) !== (json.reviewableCounts?.dom ?? 0)) {
    out.push(`says ${visible[1]} visible elements changed, report.json counts ${json.reviewableCounts?.dom ?? 0}`);
  }
  return out;
}
