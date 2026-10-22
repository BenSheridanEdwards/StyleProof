// C0/C1 controls plus the Unicode line/paragraph separators: any of them can end a
// Markdown line, so a map-supplied string carrying one could start a new block.
// eslint-disable-next-line no-control-regex -- intentional control-character class
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

// CSS values are author-influenced, so they get their own escaper at the render
// boundary: `|` is escaped (it would split the table row) and the code fence is
// widened past the value's longest backtick run (GitHub's code-span rule).
//
// Only the pipe is escaped. cmark-gfm splits a row at a `|` not directly preceded by a
// backslash and then unescapes `\|` alone, so a backslash already in the value
// renders as itself inside the code span; doubling it would print two. The
// split/join form keeps that intent from reading as a half-done backslash escaper.
//
// `<!--` gets an invisible zero-width space after the `!`: a code span shows it as
// written, but the raw text could otherwise carry a receipt marker into report.md.
export function codeValue(v: string): string {
  const escaped = v.replace(CONTROL_CHARACTERS, ' ').split('|').join('\\|').split('<!--').join('<!\u200b--');
  const longestRun = Math.max(0, ...(escaped.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = /^`|`$/.test(escaped) ? ' ' : '';
  return `${fence}${pad}${escaped}${pad}${fence}`;
}

/**
 * Escape a map-supplied string for inline Markdown prose (outside code spans), so it
 * renders as literal text in the report and the PR comment: control characters and
 * newlines collapse to one space (no injected lines, checkboxes, or receipt markers),
 * HTML and Markdown metacharacters are escaped, and `@` mentions are neutralised.
 */
export function escapeInlineMarkdown(text: string): string {
  return text
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#!|~]/g, '\\$&')
    .replace(/@/g, '@\u200b');
}
