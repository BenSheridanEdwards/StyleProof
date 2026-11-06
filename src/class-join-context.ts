/** Syntactic roles that cannot supply positive class-value evidence. */
import { commentEnd, literalAt, type ClassSource } from './class-join-source.js';

/** Each scan walks its own expression, skipping literal bodies (substitutions have separate scans). */
export function delimiterEnds(source: ClassSource, start: number, end: number): Map<number, number> {
  const result = new Map<number, number>(),
    pending: number[] = [];
  for (let cursor = start; cursor < end; cursor++) {
    const token = source.byStart.get(cursor);
    const skip = token ? literalAt(source, token).end : commentEnd(source.text, cursor);
    if (skip !== undefined) {
      cursor = skip - 1;
      continue;
    }
    const char = source.text[cursor];
    if ('([{'.includes(char)) pending.push(cursor);
    else if (')]}'.includes(char)) {
      const open = pending.pop();
      if (open !== undefined) result.set(open, cursor);
    }
  }
  return result;
}
export function followedBy(source: ClassSource, close: number | undefined, pattern: RegExp): boolean {
  return close !== undefined && pattern.test(source.text.slice(close + 1, close + 257));
}
const dataset = /\bdataset\s*(?:\.\s*class|\[\s*['"]class['"]\s*\])\s*[:=]\s*$/;
export function classAttribute(prefix: string): boolean {
  return /(?<![\w-])class(?:Name|List)?\s*[:=]\s*$/.test(prefix) && !dataset.test(prefix);
}
export function nonValue(
  source: ClassSource,
  prefix: string,
  range: { start: number; end: number },
  indexedKey: boolean,
): boolean {
  const suffix = source.text.slice(range.end, range.end + 128);
  const before = source.text.slice(Math.max(0, range.start - 256), range.start);
  return (
    /(?:[!=]={1,2}|\bcase)\s*\(*\s*$/.test(before) ||
    /^\s*\)*\s*(?:={2,3}|!={1,2})/.test(suffix) ||
    dataset.test(before) ||
    dataset.test(prefix) ||
    (indexedKey && /^\s*:/.test(suffix))
  );
}

/** Distinguish bare class helpers from method calls, including similarly named methods. */
export function callRole(prefix: string, char: string): { method?: string; own: boolean; call: boolean } {
  const method = char === '(' ? /\bclassList\s*\.\s*(\w+)\s*$/.exec(prefix)?.[1] : undefined;
  const helper =
    /\b(?:clsx|cx|classnames|classNames|cva|twMerge|twJoin|cn)\s*$/.test(prefix) && !/\.\s*\w+\s*$/.test(prefix);
  const own = helper || classAttribute(prefix) || method === 'add' || method === 'replace';
  return { method, own, call: char === '(' && !own && !method && /[\w$)\]]\s*$/.test(prefix) };
}
