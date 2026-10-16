// C0/C1 controls plus the Unicode line/paragraph separators: any of them can end a
// Markdown line, so a map-supplied string carrying one could start a new block.
// eslint-disable-next-line no-control-regex -- intentional control-character class
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

// CSS values are author-influenced, so they get their own escaper at the render
// boundary: `|` is escaped (it would split the table row) and the code fence is
// widened past the value's longest backtick run (GitHub's code-span rule).
export function codeValue(v: string): string {
  const escaped = v.replace(CONTROL_CHARACTERS, ' ').replace(/\|/g, '\\|');
  const longestRun = Math.max(0, ...(escaped.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = /^`|`$/.test(escaped) ? ' ' : '';
  return `${fence}${pad}${escaped}${pad}${fence}`;
}
