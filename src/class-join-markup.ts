/** Exact markup class-expression boundaries reuse the same positive-role reader. */
import { commentEnd, literalAt, sourceSpan, type ClassSource, type Part } from './class-join-source.js';
import type { ClassLiteral } from './class-join-literals.js';
export function mergeParts(parts: Part[]): Part[] {
  const merged: Part[] = [];
  for (const part of parts.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && part.start <= last.end) last.end = Math.max(last.end, part.end);
    else merged.push({ ...part });
  }
  return merged;
}
export function containingPart(parts: Part[], offset: number): boolean {
  let low = 0,
    high = parts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (parts[mid].start <= offset) low = mid + 1;
    else high = mid;
  }
  return low > 0 && offset < parts[low - 1].end;
}
function braceEnd(source: ClassSource, open: number): number {
  let depth = 1;
  for (let cursor = open + 1; cursor < source.text.length; cursor++) {
    const token = source.byStart.get(cursor),
      skip = token ? literalAt(source, token).end : commentEnd(source.text, cursor);
    if (skip !== undefined) {
      cursor = skip - 1;
      continue;
    }
    if (source.text[cursor] === '{') depth++;
    if (source.text[cursor] === '}' && --depth === 0) return cursor;
  }
  return source.text.length;
}
export function inMarkupTag(source: ClassSource, offset: number): boolean {
  const start = source.text.lastIndexOf('<', offset);
  return start > source.text.lastIndexOf('>', offset) && /^<[\w.-]+(?:\s|$)/.test(source.text.slice(start, offset));
}
export function markupExpressions(
  source: ClassSource,
  key: string,
  excluded: Part[],
  read: (s: ClassSource, a: number, b: number) => ClassLiteral[],
) {
  const literals: ClassLiteral[] = [],
    parts: Part[] = [];
  if (!/\.(?:vue|svelte|astro)$/i.test(key)) return { literals, parts };
  for (const match of source.text.matchAll(/(?<![\w:-])(?:class|className|classList)\s*=\s*\{/g)) {
    if (
      containingPart(parts, match.index) ||
      containingPart(excluded, match.index) ||
      !inMarkupTag(source, match.index)
    )
      continue;
    const open = match.index + match[0].length - 1,
      end = braceEnd(source, open);
    parts.push({ start: open, end: end + 1 });
    read(source, open + 1, end).forEach((literal) => literals.push(literal));
    literals.push({
      range: sourceSpan(source, open, Math.min(end + 1, source.text.length)),
      words: [],
      explicit: true,
      context: true,
    });
  }
  return { literals, parts };
}
