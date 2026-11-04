/** Git counts LF lines; source maps count JavaScript terminators and UTF-16 columns. */
import { sha256 } from './node-util.js';
import type { ScriptChange } from './script-join.js';
import type { SourcePosition } from './script-reach.js';

export type ScriptTexts = { base: string; head: string };

const TOKEN =
  /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[\p{ID_Start}_$][\p{ID_Continue}$]*|\d+(?:\.\d+)?/gu;

type Source = { text: string; lines: string[]; gitStarts: number[]; jsStarts: number[]; hash: string };

function sourceOf(text: string): Source {
  const gitStarts = [0],
    jsStarts = [0];

  for (const match of text.matchAll(/\n/g)) gitStarts.push(match.index + 1);

  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) jsStarts.push(match.index + match[0].length);
  const lines = text.split('\n').map((line, index, all) => (index < all.length - 1 ? line.replace(/\r$/, '') : line));

  return { text, lines, gitStarts, jsStarts, hash: sha256(text) };
}

function positionAt(source: Source, offset: number): SourcePosition {
  let low = 0,
    high = source.jsStarts.length;

  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);

    if (source.jsStarts[middle] <= offset) low = middle;
    else high = middle;
  }

  return { line: low + 1, column: offset - source.jsStarts[low] };
}

function tokenRange(line: string, start: number, end: number): [number, number] {
  if (start === end) return [start, end];

  let from = start,
    to = end;

  for (const token of line.matchAll(TOKEN)) {
    const right = token.index + token[0].length;

    if (token.index < end && start < right) {
      from = Math.min(from, token.index);
      to = Math.max(to, right);
    }
  }

  return [from, to];
}

function singleToken(text: string): boolean {
  const tokens = [...text.matchAll(TOKEN)];

  return tokens.length === 1 && tokens[0].index === 0 && tokens[0][0].length === text.length;
}

/** Trim only a single related line pair; multi-line replacements have no positional pairing. */
function changedColumns(before: string, after: string): { base: [number, number]; head: [number, number] } | undefined {
  let start = 0;

  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;

  let baseEnd = before.length,
    headEnd = after.length;

  while (baseEnd > start && headEnd > start && before[baseEnd - 1] === after[headEnd - 1]) {
    baseEnd--;
    headEnd--;
  }

  if (!before.slice(0, start).trim()) return undefined;

  const base = tokenRange(before, start, baseEnd),
    head = tokenRange(after, start, headEnd);

  const insertion = start === baseEnd || start === headEnd;

  if (!insertion && (!singleToken(before.slice(...base)) || !singleToken(after.slice(...head)))) return undefined;

  return { base, head };
}

function changedLine(
  source: Source,
  gitLine: number,
  columns: [number, number] | undefined,
  sourceKey: string,
  side: 'base' | 'head',
): ScriptChange[] {
  const text = source.lines[gitLine - 1] ?? '';
  const [start, end] = columns ?? [0, text.length];

  if (start === end) return [];
  const offset = source.gitStarts[gitLine - 1];

  return [
    {
      sourceKey,
      side,
      range: { start: positionAt(source, offset + start), end: positionAt(source, offset + end) },
      contentHash: source.hash,
      text,
    },
  ];
}

function hunkChanges(
  hunk: RegExpMatchArray,
  sources: { base: Source; head: Source },
  sourceKey: string,
): ScriptChange[] {
  const starts = { base: +hunk[1], head: +hunk[3] };
  const counts = { base: hunk[2] === undefined ? 1 : +hunk[2], head: hunk[4] === undefined ? 1 : +hunk[4] };

  const columns =
    counts.base === 1 && counts.head === 1
      ? changedColumns(sources.base.lines[starts.base - 1] ?? '', sources.head.lines[starts.head - 1] ?? '')
      : undefined;

  return (['base', 'head'] as const).flatMap((side) =>
    Array.from({ length: counts[side] }, (_, index) => starts[side] + index).flatMap((line) =>
      changedLine(sources[side], line, columns?.[side], sourceKey, side),
    ),
  );
}

export function changedScriptRanges(patch: string, texts: ScriptTexts, sourceKey: string): ScriptChange[] {
  const sources = { base: sourceOf(texts.base), head: sourceOf(texts.head) };

  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].flatMap((hunk) =>
    hunkChanges(hunk, sources, sourceKey),
  );
}
