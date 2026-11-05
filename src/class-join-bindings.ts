/** Simple Vue/Svelte class bindings; unresolved explicit expressions retain a gap anchor. */
import { classWords, sourceSpan, type ClassSource, type Part } from './class-join-source.js';
import type { ClassLiteral } from './class-join-literals.js';

type ClassExpressionReader = (source: ClassSource, start: number, end: number) => ClassLiteral[];
function svelteParts(
  source: ClassSource,
  start: number,
  end: number,
  readExpression: ClassExpressionReader,
): ClassLiteral[] {
  const text = source.text.slice(start, end),
    parts: Part[] = [],
    literals: ClassLiteral[] = [];
  let from = start;
  for (const match of text.matchAll(/\{[^{}]*\}/g)) {
    const open = start + match.index,
      close = open + match[0].length;
    const before = source.text.slice(from, open);
    parts.push({ start: from, end: open - (before.match(/\S+$/)?.[0].length ?? 0) });
    if ((open === start || /\s/.test(source.text[open - 1])) && (close === end || /\s/.test(source.text[close])))
      literals.push(...readExpression(source, open + 1, close - 1));
    from = close;
    while (from < end && !/\s/.test(source.text[from])) from++;
  }
  parts.push({ start: from, end });
  literals.push({ range: sourceSpan(source, start - 1, end + 1), words: classWords(source, parts), explicit: true });
  return literals;
}

export function bindingLiteral(
  source: ClassSource,
  start: number,
  end: number,
  key: string,
  readExpression: ClassExpressionReader,
): ClassLiteral[] | undefined {
  const prefix = source.text.slice(Math.max(0, start - 256), start);
  if (/\.vue$/i.test(key) && /(?<![\w-])(?:v-bind:class|:class)\s*=\s*$/.test(prefix))
    return [
      ...readExpression(source, start + 1, end - 1),
      { range: sourceSpan(source, start, end), words: [], explicit: true, context: true },
    ];
  if (/\.svelte$/i.test(key) && /(?<![\w-])class\s*=\s*$/.test(prefix))
    return svelteParts(source, start + 1, end - 1, readExpression);
}
export function svelteDirectives(source: ClassSource, key: string): ClassLiteral[] {
  if (!/\.svelte$/i.test(key)) return [];
  return [...source.text.matchAll(/(?<![\w-])class:([\w-]+)\s*=/g)].map((match) => {
    const start = match.index + 6,
      end = start + match[1].length;
    return { range: sourceSpan(source, start, end), words: classWords(source, [{ start, end }]), explicit: true };
  });
}
