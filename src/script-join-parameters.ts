/** Bounded lexical naming only: a parameter residual never proves execution. */
import type { ScriptChange } from './script-join.js';
import { scriptTokens } from './script-join-tokens.js';

type Delimiter = { start: number; end: number; kind: string };

function delimiters(text: string): Delimiter[] {
  const tokens = scriptTokens(text, 'parameters.ts');
  const stack: Delimiter[] = [],
    pairs: Delimiter[] = [];
  let token = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    while (tokens[token]?.end <= cursor) token++;
    if (tokens[token]?.index === cursor) {
      cursor = tokens[token++].end - 1;
      continue;
    }
    if ('([{'.includes(text[cursor])) stack.push({ start: cursor, end: text.length, kind: text[cursor] });
    else if (')]}'.includes(text[cursor])) {
      const pair = stack.pop();
      if (pair) {
        pair.end = cursor;
        pairs.push(pair);
      }
    }
  }
  return pairs;
}

function parameterList(text: string, pair: Delimiter): boolean {
  return (
    pair.kind === '(' &&
    (/\bfunction\b(?:\s*\*)?\s*(?:[\w$]+\s*)?$/.test(text.slice(0, pair.start)) ||
      /^\s*=>/.test(text.slice(pair.end + 1)))
  );
}

function initializerEnd(text: string, start: number, end: number, pairs: Delimiter[]): number {
  let cursor = start;
  while (cursor < end) {
    const nested = pairs.find((pair) => pair.start === cursor);
    if (nested) cursor = nested.end + 1;
    else if (',}]'.includes(text[cursor])) return cursor;
    else cursor++;
  }
  return end;
}

function namesIn(text: string, parameters: Delimiter, pairs: Delimiter[], from: number, to: number): string[] {
  const names: string[] = [];
  const content = text.slice(parameters.start + 1, parameters.end);
  for (const match of content.matchAll(/\b[\w$]+\s*=(?!=|>)\s*/g)) {
    const assignment = parameters.start + 1 + match.index;
    const fromValue = assignment + match[0].length;
    const end = initializerEnd(text, fromValue, parameters.end, pairs);
    if (from < fromValue || to > end) continue;
    const destructured = pairs.some(
      (pair) => pair.kind === '{' && pair.start > parameters.start && pair.start < assignment && pair.end >= end,
    );
    names.push(destructured ? 'destructuring defaults' : 'default parameter values');
  }
  return names;
}

export function parameterResiduals(change: ScriptChange): string[] {
  const before = change.parameterContext?.before ?? '';
  const text = before + change.text + '\n' + (change.parameterContext?.after ?? '');
  const breaks = [...change.text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)];
  const lastBreak = breaks[change.range.end.line - change.range.start.line - 1];
  const from = before.length + change.range.start.column;
  const to = before.length + (lastBreak ? lastBreak.index + lastBreak[0].length : 0) + change.range.end.column;
  const pairs = delimiters(text);
  return [
    ...new Set(
      pairs.filter((pair) => parameterList(text, pair)).flatMap((pair) => namesIn(text, pair, pairs, from, to)),
    ),
  ];
}
