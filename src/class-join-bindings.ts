/** Simple Vue/Svelte class bindings; unresolved explicit expressions retain a gap anchor. */
import { scriptTokens } from './script-join-tokens.js';
import { classWords, sourceSpan, type ClassSource, type Part } from './class-join-source.js';
import type { ClassLiteral } from './class-join-literals.js';

function expressionLiterals(source: ClassSource, start: number, end: number): ClassLiteral[] {
  const text = source.text.slice(start, end),
    literals: ClassLiteral[] = [];
  for (const token of scriptTokens(text, 'binding.ts')) {
    const from = start + token.index,
      to = start + token.end;
    const raw = text.slice(token.index, token.end);
    const quoted = /^['"]/.test(raw) && raw.at(-1) === raw[0];
    const key = /^[\w$-]+$/.test(raw) && /^\s*:/.test(text.slice(token.end));
    if (!quoted && !key) continue;
    literals.push({
      range: sourceSpan(source, from, to),
      words: classWords(source, [{ start: from + Number(quoted), end: to - Number(quoted) }]),
      explicit: true,
    });
  }
  return literals;
}
function svelteParts(source: ClassSource, start: number, end: number): ClassLiteral[] {
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
      literals.push(...expressionLiterals(source, open + 1, close - 1));
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
): ClassLiteral[] | undefined {
  const prefix = source.text.slice(Math.max(0, start - 256), start);
  if (/\.vue$/i.test(key) && /(?:\bv-bind:class|:class)\s*=\s*$/.test(prefix))
    return [
      ...expressionLiterals(source, start + 1, end - 1),
      { range: sourceSpan(source, start, end), words: [], explicit: true, context: true },
    ];
  if (/\.svelte$/i.test(key) && /\bclass\s*=\s*$/.test(prefix)) return svelteParts(source, start + 1, end - 1);
}
export function svelteDirectives(source: ClassSource, key: string): ClassLiteral[] {
  if (!/\.svelte$/i.test(key)) return [];
  return [...source.text.matchAll(/\bclass:([\w-]+)\s*=/g)].map((match) => {
    const start = match.index + 6,
      end = start + match[1].length;
    return { range: sourceSpan(source, start, end), words: classWords(source, [{ start, end }]), explicit: true };
  });
}
