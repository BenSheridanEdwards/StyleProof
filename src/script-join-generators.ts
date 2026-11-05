/** A file-wide conservative V8 limitation, independent of changed-line context. */
import { scriptLexemes, type ScriptLexeme } from './script-join-tokens.js';

const MODIFIERS = new Set([
  'static',
  'public',
  'private',
  'protected',
  'override',
  'abstract',
  'readonly',
  'declare',
  'async',
]);

function methodBoundary(tokens: ScriptLexeme[], star: number): boolean {
  let cursor = star - 1;
  while (cursor >= 0 && MODIFIERS.has(tokens[cursor].value)) cursor--;
  return cursor < 0 || ['{', '}', ';', ','].includes(tokens[cursor].value);
}

function afterKey(tokens: ScriptLexeme[], start: number): number {
  if (tokens[start]?.value !== '[') return tokens[start]?.key ? start + 1 : -1;
  let depth = 0;
  for (let cursor = start; cursor < tokens.length; cursor++) {
    if (tokens[cursor].value === '[') depth++;
    else if (tokens[cursor].value === ']' && --depth === 0) return cursor + 1;
  }
  return -1;
}

export function sourceContainsGenerator(text: string, sourceKey = ''): boolean {
  const tokens = scriptLexemes(text, sourceKey);
  return tokens.some((token, index) => {
    if (token.value !== '*') return false;
    if (tokens[index - 1]?.value === 'function') return true;
    return methodBoundary(tokens, index) && tokens[afterKey(tokens, index + 1)]?.value === '(';
  });
}
