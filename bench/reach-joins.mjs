// Src J3 adapter and historical J2 helpers for the reach noise replay.
// J1 and corpus J2 use src/. The historical J2 helpers below remain for the
// separately pinned reach-noise replay; the corpus does not call them.
// Each join answers one question about a changed unit of the PR, from evidence
// a real browser recorded during capture:
//
//   J2  did a changed line of render code run?              (V8 block coverage + source map)
//   J3  did a changed class token land on a captured element? (class-list delta)
import { execFileSync } from 'node:child_process';

import { classifyClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
export { classVocabulary } from '../dist/class-join.js';

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

/** Vendored dependencies are outside J2, including when a filename suffix collides. */
export function isAppSource(src) {
  return !/(^|[\\/])node_modules[\\/]/.test(src);
}

/** Per original line of `sourceSuffix`: did any / every mapped segment run in this capture? */
export function lineExecution(entry, sourceMap, sourceSuffix) {
  const ran = executedAt(entry);
  const lines = new Map();
  for (const s of mappedSegments(sourceMap, entry.source)) {
    if (!isAppSource(s.source) || !s.source.endsWith(sourceSuffix)) continue;
    const st = lines.get(s.line) ?? { any: false, all: true };
    const e = ran(s.offset);
    st.any ||= e;
    st.all &&= e;
    lines.set(s.line, st);
  }
  return lines;
}

/** App-line evidence read by J2; $mappedUrls also detects lost source maps. */
export function coverageProjection(data) {
  const projection = Object.create(null);
  for (const capture of data.coverage) {
    const surface = (projection[capture.surface] ??= Object.create(null));
    const urls = new Set(surface.$mappedUrls);
    for (const entry of capture.entries) {
      const map = data.sourceMaps[entry.url];
      if (!map) continue;
      urls.add(entry.url);
      for (const source of map.sources.filter(isAppSource)) {
        const lines = (surface[source] ??= Object.create(null));
        for (const [line, state] of lineExecution(entry, map, source)) {
          const previous = lines[line];
          // J2 is reached if any entry ran all segments of this source line.
          lines[line] = { any: state.any || !!previous?.any, all: state.all || !!previous?.all };
        }
      }
    }
    surface.$mappedUrls = [...urls].sort();
  }
  return projection;
}

/** J2 for one line across captures: some capture ran every segment, or how far it got. */
export function jsReach(line, executions) {
  const seen = executions.map((m) => m.get(line)).filter(Boolean);
  if (!seen.length) return 'unmeasured';
  if (seen.some((s) => s.all)) return 'ran';
  return seen.some((s) => s.any) ? 'partly-ran' : 'never-ran';
}

// ---- J3: class-list delta -------------------------------------------------------

/** Compatibility adapter for the historical noise replay. All J3 judgments use src/. */
export function classReach(baseLine, headLine, _vocabulary, pairs) {
  const changes = changedScriptRanges(
    `@@ -1 +1 @@\n-${baseLine}\n+${headLine}\n`,
    { base: baseLine, head: headLine },
    'app.jsx',
  );
  const result = classifyClassReach(
    pairs.map((p) => p.base),
    pairs.map((p) => p.head),
    changes,
    pairs,
  );
  return {
    status: result.units.length
      ? (['never-rendered', 'unmeasured', 'unknown'].find((status) =>
          result.units.some((unit) => unit.status === status),
        ) ?? 'unknown')
      : 'n/a',
    added: [...new Set(result.units.filter((u) => u.side === 'head').map((u) => u.token))],
    removed: [...new Set(result.units.filter((u) => u.side === 'base').map((u) => u.token))],
  };
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
