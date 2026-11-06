/** Git counts LF lines; source maps count JavaScript terminators and UTF-16 columns. */
import { sha256 } from './node-util.js';
import type { ScriptChange } from './script-join.js';
import type { SourcePosition } from './script-reach.js';
import { scriptTokens, type ScriptToken } from './script-join-tokens.js';
import { sourceContainsGenerator } from './script-join-generators.js';

export type ScriptTexts = { base: string; head: string };

type Source = {
  text: string;
  lines: string[];
  endings: string[];
  gitStarts: number[];
  jsStarts: number[];
  hash: string;
  typescript: Set<number>;
  generatorFile: boolean;
};

/** Index embedded TS blocks once; their HTML container's extension is not a JS dialect. */
function typescriptLines(text: string, starts: number[], sourceKey: string): Set<number> {
  const lines = new Set<number>();
  const blocks = /<script\b[^>]*>/gi;
  let line = 0;
  for (const block of text.matchAll(blocks)) {
    if (
      !sourceKey.endsWith('.astro') &&
      !/\b(?:lang\s*=\s*(?:["'](?:ts|typescript)["']|(?:ts|typescript)(?=\s|>))|type\s*=\s*(?:["']text\/typescript["']|text\/typescript(?=\s|>)))/i.test(
        block[0],
      )
    )
      continue;
    const end = text.indexOf('</script', block.index + block[0].length);
    while (line < starts.length && starts[line] <= (end < 0 ? text.length : end)) {
      if ((starts[line + 1] ?? text.length + 1) > block.index) lines.add(line + 1);
      line++;
    }
  }
  return lines;
}

function sourceOf(text: string, sourceKey: string): Source {
  const gitStarts = [0],
    jsStarts = [0];

  for (const match of text.matchAll(/\n/g)) gitStarts.push(match.index + 1);

  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) jsStarts.push(match.index + match[0].length);
  const rawLines = text.split('\n');
  const endings = rawLines.map((line, i) => (i < rawLines.length - 1 ? (line.endsWith('\r') ? '\r\n' : '\n') : ''));
  const lines = rawLines.map((line, i) => (endings[i] ? line.replace(/\r$/, '') : line));

  return {
    text,
    lines,
    endings,
    gitStarts,
    jsStarts,
    hash: sha256(text),
    typescript: typescriptLines(text, gitStarts, sourceKey),
    generatorFile: sourceContainsGenerator(text),
  };
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

function tokenRange(tokens: ScriptToken[], start: number, end: number): [number, number] {
  if (start === end) {
    const touching = tokens.find((token) => token.index <= start && start <= token.end);
    return touching ? [touching.index, touching.end] : [start, end];
  }
  let from = start,
    to = end;

  for (const token of tokens) {
    const right = token.end;

    if (token.index < end && start < right) {
      from = Math.min(from, token.index);
      to = Math.max(to, right);
    }
  }

  return [from, to];
}

function singleToken(tokens: ScriptToken[], range: [number, number]): boolean {
  return tokens.some((token) => token.index === range[0] && token.end === range[1]);
}

function hasToken(tokens: ScriptToken[], range: [number, number]): boolean {
  return range[0] === range[1] || tokens.some((token) => token.index < range[1] && range[0] < token.end);
}

function differingColumns(before: string, after: string): { start: number; baseEnd: number; headEnd: number } {
  let start = 0;

  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;

  let baseEnd = before.length,
    headEnd = after.length;

  while (baseEnd > start && headEnd > start && before[baseEnd - 1] === after[headEnd - 1]) {
    baseEnd--;
    headEnd--;
  }
  return { start, baseEnd, headEnd };
}

/** Trim only a single related line pair; multi-line replacements have no positional pairing. */
function changedColumns(
  before: string,
  after: string,
  sourceKey: string,
  baseLanguage?: 'ts',
  headLanguage?: 'ts',
): { base: [number, number]; head: [number, number] } | undefined {
  if (before === after) return undefined;
  const { start, baseEnd, headEnd } = differingColumns(before, after);

  if (!before.slice(0, start).trim()) return undefined;

  const baseTokens = scriptTokens(before, sourceKey, baseLanguage),
    headTokens = scriptTokens(after, sourceKey, headLanguage);
  const [baseFrom, baseTo] = tokenRange(baseTokens, start, baseEnd),
    [headFrom, headTo] = tokenRange(headTokens, start, headEnd);
  const from = Math.min(baseFrom, headFrom),
    tail = Math.min(before.length - baseTo, after.length - headTo);
  const base: [number, number] = [from, before.length - tail],
    head: [number, number] = [from, after.length - tail];

  // A token touched only on its left edge belongs to that side; its unchanged
  // suffix must not widen the opposite deletion/insertion into an idle operand.
  if (start === baseEnd && baseFrom === start && headEnd > start) head[1] = headTo;
  if (start === headEnd && headFrom === start && baseEnd > start) base[1] = baseTo;

  const insertion = start === baseEnd || start === headEnd;

  if (!hasToken(baseTokens, base) || !hasToken(headTokens, head)) return undefined;

  if (!insertion && (!singleToken(baseTokens, base) || !singleToken(headTokens, head))) return undefined;

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
  const range = { start: positionAt(source, offset + start), end: positionAt(source, offset + end) };
  // Git lines can contain several JavaScript lines; token columns belong to
  // the JavaScript line where the range begins, never the preceding segment.
  const original = source.text
    .slice(source.jsStarts[range.start.line - 1], source.jsStarts[range.end.line] ?? source.text.length)
    .replace(/(?:\r\n|[\n\r\u2028\u2029])$/, '');

  return [
    {
      sourceKey,
      side,
      range,
      contentHash: source.hash,
      text: original,
      generatorFile: source.generatorFile,
      parameterContext: {
        before: source.text
          .slice(source.jsStarts[Math.max(0, range.start.line - 5)], source.jsStarts[range.start.line - 1])
          .slice(-128),
        after: source.text
          .slice(
            source.jsStarts[range.end.line] ?? source.text.length,
            source.jsStarts[range.end.line + 4] ?? source.text.length,
          )
          .slice(0, 128),
      },
      ...(source.typescript.has(gitLine) ? { language: 'ts' as const } : {}),
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
      ? changedColumns(
          sources.base.lines[lines.base[0] - 1] ?? '',
          sources.head.lines[lines.head[0] - 1] ?? '',
          sourceKey,
          sources.base.typescript.has(lines.base[0]) ? 'ts' : undefined,
          sources.head.typescript.has(lines.head[0]) ? 'ts' : undefined,
        )
      : undefined;
  const raw =
    lines.base.length === 1 && lines.head.length === 1
      ? differingColumns(sources.base.lines[lines.base[0] - 1] ?? '', sources.head.lines[lines.head[0] - 1] ?? '')
      : undefined;
  const endings = { base: endingIndex(sources.base, lines.base), head: endingIndex(sources.head, lines.head) };
  return (['base', 'head'] as const).flatMap((side) => {
    const source = sources[side],
      other = endings[side === 'base' ? 'head' : 'base'];
    return lines[side].flatMap((line) => {
      const changedEnding = [...(other.get(source.lines[line - 1]) ?? [])].some(
        (ending) => ending !== source.endings[line - 1],
      );
      const entries = changedLine(
        source,
        line,
        changedEnding ? undefined : columns?.[side],
        sourceKey,
        side,
        changedEnding
          ? 'line ending changed; execution anchors cannot attribute an EOF newline or CRLF/LF change'
          : undefined,
      );
      const offset = source.gitStarts[line - 1];
      const opposite = side === 'base' ? 'head' : 'base';
      const counterpart = lines[opposite][0];
      const otherSource = sources[opposite];
      const endOf = (s: Source, changed: number[]) => {
        const last = changed.at(-1)!;
        return positionAt(s, s.gitStarts[last - 1] + s.lines[last - 1].length);
      };
      return entries.map((entry) => ({
        ...entry,
        ...(raw
          ? {
              classRange: {
                start: positionAt(source, offset + raw.start),
                end: positionAt(source, offset + (side === 'base' ? raw.baseEnd : raw.headEnd)),
              },
            }
          : {}),
        ...(counterpart
          ? {
              classCounterpart: {
                current: positionAt(source, source.gitStarts[lines[side][0] - 1]),
                end: endOf(source, lines[side]),
                range: {
                  start: positionAt(otherSource, otherSource.gitStarts[counterpart - 1]),
                  end: endOf(otherSource, lines[opposite]),
                },
              },
            }
          : {}),
      }));
    });
  });
}

/** Read +/- body lines. Header counts include context and never grant attribution themselves. */
export function changedScriptRanges(patch: string, texts: ScriptTexts, sourceKey: string): ScriptChange[] {
  const sources = { base: sourceOf(texts.base, sourceKey), head: sourceOf(texts.head, sourceKey) };
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
  return changes.map((change) => ({
    ...change,
    classSource: texts[change.side],
    classOtherSource: texts[change.side === 'base' ? 'head' : 'base'],
  }));
}
