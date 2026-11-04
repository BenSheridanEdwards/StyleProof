/** Git counts LF lines; source maps count JavaScript terminators and UTF-16 columns. */
import { sha256 } from './node-util.js';
import type { ScriptChange } from './script-join.js';
import type { SourcePosition } from './script-reach.js';

export type ScriptTexts = { base: string; head: string };

const TOKEN =
  /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[\p{ID_Start}_$][\p{ID_Continue}$]*|\d+(?:\.\d+)?/gu;

type Source = {
  text: string;
  lines: string[];
  endings: string[];
  gitStarts: number[];
  jsStarts: number[];
  hash: string;
};

function sourceOf(text: string): Source {
  const gitStarts = [0],
    jsStarts = [0];

  for (const match of text.matchAll(/\n/g)) gitStarts.push(match.index + 1);

  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) jsStarts.push(match.index + match[0].length);
  const rawLines = text.split('\n');
  const endings = rawLines.map((line, i) => (i < rawLines.length - 1 ? (line.endsWith('\r') ? '\r\n' : '\n') : ''));
  const lines = rawLines.map((line, i) => (endings[i] ? line.replace(/\r$/, '') : line));

  return { text, lines, endings, gitStarts, jsStarts, hash: sha256(text) };
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
  let from = start,
    to = end;

  for (const token of line.matchAll(TOKEN)) {
    const right = token.index + token[0].length;

    if (start === end ? token.index < start && start < right : token.index < end && start < right) {
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
  if (before === after) return undefined;
  let start = 0;

  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;

  let baseEnd = before.length,
    headEnd = after.length;

  while (baseEnd > start && headEnd > start && before[baseEnd - 1] === after[headEnd - 1]) {
    baseEnd--;
    headEnd--;
  }

  if (!before.slice(0, start).trim()) return undefined;

  const [baseFrom, baseTo] = tokenRange(before, start, baseEnd),
    [headFrom, headTo] = tokenRange(after, start, headEnd);
  const from = Math.min(baseFrom, headFrom),
    tail = Math.min(before.length - baseTo, after.length - headTo);
  const base: [number, number] = [from, before.length - tail],
    head: [number, number] = [from, after.length - tail];

  const insertion = start === baseEnd || start === headEnd;

  if (
    (base[0] < base[1] && !before.slice(...base).match(TOKEN)) ||
    (head[0] < head[1] && !after.slice(...head).match(TOKEN))
  )
    return undefined;

  if (!insertion && (!singleToken(before.slice(...base)) || !singleToken(after.slice(...head)))) return undefined;

  return { base, head };
}

function changedLine(
  source: Source,
  gitLine: number,
  columns: [number, number] | undefined,
  sourceKey: string,
  side: 'base' | 'head',
  unmeasuredReason?: string,
): ScriptChange[] {
  const text = source.lines[gitLine - 1] ?? '';
  const lineScope = !columns || columns[0] === columns[1];
  const [start, end] = lineScope ? [0, text.length] : columns;

  const offset = source.gitStarts[gitLine - 1];

  return [
    {
      sourceKey,
      side,
      range: { start: positionAt(source, offset + start), end: positionAt(source, offset + end) },
      contentHash: source.hash,
      text,
      ...(unmeasuredReason ? { unmeasuredReason } : {}),
      ...(lineScope ? { changeScope: 'line' as const } : {}),
    },
  ];
}

type ChangedLines = { base: number[]; head: number[] };

/** Match identical changed text by content, never pair unrelated lines by their hunk position. */
function endingIndex(source: Source, lines: number[]): Map<string, Set<string>> {
  const endings = new Map<string, Set<string>>();
  for (const line of lines) {
    const text = source.lines[line - 1];
    if (!endings.has(text)) endings.set(text, new Set());
    endings.get(text)!.add(source.endings[line - 1]);
  }
  return endings;
}

function blockChanges(lines: ChangedLines, sources: { base: Source; head: Source }, sourceKey: string): ScriptChange[] {
  const columns =
    lines.base.length === 1 && lines.head.length === 1
      ? changedColumns(sources.base.lines[lines.base[0] - 1] ?? '', sources.head.lines[lines.head[0] - 1] ?? '')
      : undefined;
  const endings = { base: endingIndex(sources.base, lines.base), head: endingIndex(sources.head, lines.head) };
  return (['base', 'head'] as const).flatMap((side) => {
    const source = sources[side],
      other = endings[side === 'base' ? 'head' : 'base'];
    return lines[side].flatMap((line) => {
      const changedEnding = [...(other.get(source.lines[line - 1]) ?? [])].some(
        (ending) => ending !== source.endings[line - 1],
      );
      return changedLine(
        source,
        line,
        changedEnding ? undefined : columns?.[side],
        sourceKey,
        side,
        changedEnding
          ? 'line ending changed; execution anchors cannot attribute an EOF newline or CRLF/LF change'
          : undefined,
      );
    });
  });
}

/** Read +/- body lines. Header counts include context and never grant attribution themselves. */
export function changedScriptRanges(patch: string, texts: ScriptTexts, sourceKey: string): ScriptChange[] {
  const sources = { base: sourceOf(texts.base), head: sourceOf(texts.head) };
  const changes: ScriptChange[] = [];
  let position: { base: number; head: number } | undefined;
  let block: ChangedLines = { base: [], head: [] };
  const flush = () => {
    changes.push(...blockChanges(block, sources, sourceKey));
    block = { base: [], head: [] };
  };
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      flush();
      position = { base: +header[1], head: +header[2] };
    } else if (position && line.startsWith('-')) block.base.push(position.base++);
    else if (position && line.startsWith('+')) block.head.push(position.head++);
    else if (position && line.startsWith(' ')) {
      flush();
      position.base++;
      position.head++;
    } else if (!line.startsWith('\\')) {
      flush();
      position = undefined;
    }
  }
  flush();
  return changes;
}
