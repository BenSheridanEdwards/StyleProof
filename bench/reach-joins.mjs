// Prototype reach joins for the reach corpus (#988). Bench-only reference
// behaviour: Change Reach phases 1 and 2 (#934) replace these with src/ code and
// the corpus keeps scoring them. Each join answers one question about a changed
// unit of the PR, from evidence a real browser recorded during capture:
//
//   J1  did a changed served CSS rule match an element?     (CSS rule usage)
//   J2  did a changed line of render code run?              (V8 block coverage + source map)
//   J3  did a changed class token land on a captured element? (class-list delta)
import { execFileSync } from 'node:child_process';

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
// Grouping at-rules hold rules; every other block is a leaf (style rule, @keyframes, @font-face…).
const GROUPING = /^@(media|supports|layer|container|scope|document)\b/i;

/** Index just past the `close` that ends the run opened at `from`, or `limit` when it never closes. */
function past(text, close, from, limit) {
  const at = text.indexOf(close, from);
  return at === -1 ? limit : at + close.length;
}

/** Matching close brace for the `{` at `open`, skipping comments and strings. */
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (text.startsWith('/*', i)) i = past(text, '*/', i + 2, text.length) - 1;
    else if (ch === '"' || ch === "'") i = past(text, ch, i + 1, text.length) - 1;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Next significant index at or after `i`: past whitespace, comments, and the `}` of a closed block. */
function skipTrivia(text, i, to) {
  while (i < to && (text.startsWith('/*', i) || /\s|}/.test(text[i])))
    i = text.startsWith('/*', i) ? past(text, '*/', i + 2, to) : i + 1;
  return i;
}

/** End of a statement at-rule such as `@import …;` at `i`, or -1 when a block opens first. */
function statementEnd(text, i, to) {
  const brace = text.indexOf('{', i);
  const semi = text.indexOf(';', i);
  if (brace !== -1 && brace < to && (semi === -1 || semi > brace)) return -1;
  return semi === -1 || semi >= to ? to : semi + 1;
}

/**
 * Leaf rules of one stylesheet text with their offsets, so a rule-usage range can
 * be attributed. `key` is the at-rule chain plus the prelude (`@media (…) > .panel`).
 */
function parseCssRules(text) {
  const rules = [];
  const walk = (from, to, chain) => {
    for (let i = skipTrivia(text, from, to); i < to; i = skipTrivia(text, i, to)) {
      const end = statementEnd(text, i, to);
      if (end !== -1) {
        i = end;
        continue;
      }
      const brace = text.indexOf('{', i);
      const close = closeOf(text, brace);
      const prelude = collapse(text.slice(i, brace));
      const body = collapse(text.slice(brace + 1, close));
      if (GROUPING.test(prelude)) walk(brace + 1, close, [...chain, prelude]);
      else rules.push({ key: [...chain, prelude].join(' > '), chain, prelude, body, start: i, end: close + 1 });
      i = close + 1;
    }
  };
  walk(0, text.length, []);
  return rules;
}

/** Custom-property declarations of a rule body: `{ '--warn': '#f59e0b' }`. */
function customProps(body) {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()]));
}

const readsProp = (body, prop) => [...body.matchAll(/\bvar\(\s*(--[\w-]+)\s*[,)]/g)].some((m) => m[1] === prop);

/** Every dependent alias and consumer must resolve to captured usage. */
function customPropertyGap(prop, side, path = new Set()) {
  if (path.has(prop)) return `cyclic consumer of ${prop}`;
  const consumers = side.rules.filter((r) => readsProp(r.body, prop));
  if (!consumers.length) return `no resolved consumer of ${prop}`;
  const next = new Set([...path, prop]);
  for (const consumer of consumers) {
    if (!side.used.has(consumer.key)) return `consumer of ${prop} never matched: ${consumer.key}`;
    for (const [alias, value] of Object.entries(customProps(consumer.body))) {
      if (!readsProp(value, prop)) continue;
      const gap = customPropertyGap(alias, side, next);
      if (gap) return gap;
    }
  }
}

/** Class names any served selector can target — the J3 token vocabulary. */
export function classVocabulary(rules) {
  return new Set(rules.flatMap((r) => [...r.prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])));
}

/**
 * J1 for one changed rule. `side` holds the judged side's rule catalog and the
 * keys a captured state matched. Added/changed rules are judged on head, removed
 * rules on base. A changed custom property is reached only when every rule that
 * consumes it matched; @keyframes / @font-face never appear in rule usage, so they
 * resolve through the rules that reference them, and a reached reference is a
 * blind channel: computed styles do not hold keyframe or font bodies.
 */
export function cssReach(rule, side, before) {
  const used = (r) => side.used.has(r.key);
  const at = rule.prelude.match(/^@(keyframes|font-face)\b\s*(.*)$/i);
  if (at) {
    const name =
      at[1].toLowerCase() === 'keyframes' ? at[2] : (rule.body.match(/font-family\s*:\s*([^;]+)/)?.[1] ?? '');
    const ref = name.replace(/["']/g, '').trim();
    const refs = side.rules.filter((r) => r !== rule && ref && r.body.includes(ref) && !r.prelude.startsWith('@'));
    return refs.some(used)
      ? { status: 'blind-channel', why: `referenced by ${refs.find(used).key}` }
      : { status: 'never-rendered', why: 'no rendered rule references it' };
  }
  if (!used(rule))
    return {
      status: 'never-rendered',
      why: rule.chain.length ? `gated by ${rule.chain.join(' > ')}` : 'selector never matched',
    };
  const now = customProps(rule.body);
  const was = before ? customProps(before.body) : {};
  for (const prop of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (now[prop] === was[prop]) continue;
    const gap = customPropertyGap(prop, side);
    if (gap) return { status: 'never-rendered', why: gap };
  }
  return { status: 'reached', why: 'matched in a captured state' };
}

/**
 * Rule catalog from coverage entries with stable stylesheet URLs and capture IDs.
 * Repeated captures may union usage only when the same sheet has identical text.
 */
export function servedRules(coverageEntries) {
  const sheets = new Map();
  for (const entry of coverageEntries) {
    if (!entry.url) throw new Error('missing stylesheet identity: CSS reach is unknown');
    const sheet = sheets.get(entry.url) ?? { text: entry.text, captures: new Set(), ranges: [] };
    const capture = entry.capture ?? 0;
    if (sheet.text !== entry.text || sheet.captures.has(capture))
      throw new Error(`ambiguous stylesheet ${entry.url}: CSS reach is unknown`);
    sheet.captures.add(capture);
    sheet.ranges.push(...entry.ranges);
    sheets.set(entry.url, sheet);
  }
  const rules = [];
  const used = new Set();
  for (const sheet of [...sheets.keys()].sort()) {
    const entry = sheets.get(sheet);
    const ordinals = new Map();
    for (const rule of parseCssRules(entry.text)) {
      const ordinal = ordinals.get(rule.key) ?? 0;
      ordinals.set(rule.key, ordinal + 1);
      const key = JSON.stringify([sheet, ordinal, rule.key]);
      rules.push({ ...rule, selector: rule.key, sheet, ordinal, key });
      if (entry.ranges.some((r) => r.start < rule.end && r.end > rule.start)) used.add(key);
    }
  }
  return { rules, used };
}

/** Rules that differ between two catalogs, each with the side it is judged on. */
export function changedRules(base, head) {
  const byKey = (side) => new Map(side.rules.map((r) => [r.key, r]));
  const b = byKey(base);
  const h = byKey(head);
  const out = [];
  for (const [key, rule] of h)
    if (!b.has(key) || b.get(key).body !== rule.body) out.push({ key, rule, before: b.get(key), side: 'head' });
  for (const [key, rule] of b) if (!h.has(key)) out.push({ key, rule, side: 'base' });
  return out;
}

// ---- J2: V8 block coverage resolved through a source map ------------------------

const B64 = Object.fromEntries(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]),
);

function decodeVlq(segment) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64[ch];
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      out.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/** Every mapped segment: generated offset → original source and 1-based line. */
function mappedSegments(sourceMap, generated) {
  const lineStarts = [0];
  for (let i = 0; i < generated.length; i++) if (generated[i] === '\n') lineStarts.push(i + 1);
  const segments = [];
  let source = 0;
  let line = 0;
  sourceMap.mappings.split(';').forEach((row, genLine) => {
    let col = 0;
    for (const raw of row.split(',').filter(Boolean)) {
      const f = decodeVlq(raw);
      col += f[0];
      if (f.length < 4) continue;
      source += f[1];
      line += f[2];
      segments.push({ offset: lineStarts[genLine] + col, source: sourceMap.sources[source], line: line + 1 });
    }
  });
  return segments;
}

/** Innermost V8 range decides whether a generated offset ran. */
function executedAt(entry) {
  const ranges = entry.functions.flatMap((f) => f.ranges);
  return (offset) => {
    let best;
    for (const r of ranges)
      if (
        r.startOffset <= offset &&
        offset < r.endOffset &&
        (!best || r.endOffset - r.startOffset < best.endOffset - best.startOffset)
      )
        best = r;
    return best ? best.count > 0 : false;
  };
}

/** Per original line of `sourceSuffix`: did any / every mapped segment run in this capture? */
export function lineExecution(entry, sourceMap, sourceSuffix) {
  const ran = executedAt(entry);
  const lines = new Map();
  for (const s of mappedSegments(sourceMap, entry.source)) {
    if (!s.source.endsWith(sourceSuffix)) continue;
    const st = lines.get(s.line) ?? { any: false, all: true };
    const e = ran(s.offset);
    st.any ||= e;
    st.all &&= e;
    lines.set(s.line, st);
  }
  return lines;
}

/** J2 for one line across captures: some capture ran every segment, or how far it got. */
export function jsReach(line, executions) {
  const seen = executions.map((m) => m.get(line)).filter(Boolean);
  if (!seen.length) return 'unmeasured';
  if (seen.some((s) => s.all)) return 'ran';
  return seen.some((s) => s.any) ? 'partly-ran' : 'never-ran';
}

// ---- J3: class-list delta -------------------------------------------------------

/** Whitespace-split tokens of the quoted string literals on one source line. */
function literalTokens(line) {
  return new Set([...line.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].flatMap((m) => m[2].split(/\s+/)).filter(Boolean));
}

/**
 * J3 for one changed line pair. Only tokens a served selector can target count.
 * Reached when some paired element's class list gained an added token or lost a
 * removed one between base and head, in any captured state.
 */
export function classReach(baseLine, headLine, vocabulary, pairs) {
  const b = literalTokens(baseLine);
  const h = literalTokens(headLine);
  const added = [...h].filter((t) => !b.has(t) && vocabulary.has(t));
  const removed = [...b].filter((t) => !h.has(t) && vocabulary.has(t));
  if (!added.length && !removed.length) return { status: 'n/a', added, removed };
  const classes = (map, path) => new Set((map.elements[path]?.cls ?? '').split(/\s+/).filter(Boolean));
  const moved = pairs.some(({ base, head }) =>
    Object.keys({ ...base.elements, ...head.elements }).some((path) => {
      const was = classes(base, path);
      const now = classes(head, path);
      return added.some((t) => now.has(t) && !was.has(t)) || removed.some((t) => was.has(t) && !now.has(t));
    }),
  );
  return { status: moved ? 'reached' : 'never-rendered', added, removed };
}

// ---- the PR diff ----------------------------------------------------------------

/** `git diff -U0` hunks between two files, line numbers 1-based on each side. */
export function diffHunks(baseFile, headFile) {
  let out = '';
  try {
    execFileSync('git', ['diff', '--no-index', '--no-color', '-U0', baseFile, headFile], { encoding: 'utf8' });
  } catch (error) {
    if (error.status !== 1) throw error;
    out = error.stdout;
  }
  const lines = (start, count) => Array.from({ length: count }, (_, i) => start + i);
  return [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    base: lines(+m[1], m[2] === undefined ? 1 : +m[2]),
    head: lines(+m[3], m[4] === undefined ? 1 : +m[4]),
  }));
}
