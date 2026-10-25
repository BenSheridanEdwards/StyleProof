// Prototype J2/J3 reach joins for the reach corpus (#988). J1 now lives in
// src/rule-reach.ts (#995); J2/J3 stay here until Change Reach phase 2 (#934).
// Each join answers one question about a changed unit of the PR, from evidence
// a real browser recorded during capture:
//
//   J2  did a changed line of render code run?              (V8 block coverage + source map)
//   J3  did a changed class token land on a captured element? (class-list delta)
import { execFileSync } from 'node:child_process';

/** Class names any served ledger key can target — the J3 token vocabulary. */
export function classVocabulary(keys) {
  return new Set(keys.flatMap((key) => [...key.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])));
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
