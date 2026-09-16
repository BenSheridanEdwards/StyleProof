// Pure helpers shared across the library (no Node runtime imports, so the
// component catalog modules stay browser-bundleable).

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Forward slashes only, so keys and manifests agree across platforms. */
export const toSlash = (value: string): string => value.replace(/\\/g, '/');

/** Strip leading and trailing hyphens without a backtracking regex (linear time). */
export function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

/** Lower-case kebab slug, capped at `max` characters; never empty. */
export function slug(value: string, max = 24): string {
  return trimHyphens(value.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, max) || 'state';
}

/**
 * Embed a value in generated JavaScript source. JSON.stringify alone leaves U+2028 and
 * U+2029 unescaped, which older engines treat as line terminators inside a literal.
 */
export function codeLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
