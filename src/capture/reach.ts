// Served-rule ledger for Change Reach (#991): every CSS leaf rule the page serves,
// and whether it matched an element while the map was read. Chromium's rule usage
// tracking reports the matched ranges, forced :hover/:focus/:active included; the
// stylesheet text names the rules. Stylesheets StyleProof injects never enter it.
import { createHash } from 'node:crypto';
import type { CDPSession, Page } from '@playwright/test';
import type { ServedRule, ServedRules } from './types.js';

type UsedRange = { startOffset: number; endOffset: number };
type SheetHeader = {
  styleSheetId: string;
  sourceURL: string;
  origin: string;
  isInline: boolean;
  isConstructed?: boolean;
};

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
// Grouping at-rules hold rules; every other block is a leaf (style rule, @keyframes, @font-face…).
const GROUPING = /^@(media|supports|layer|container|scope|document|starting-style)\b/i;
function unknown(detail: string): never {
  throw new Error(`styleproof: served CSS reach is unknown: ${detail}`);
}

/** A CSS escape includes up to six hex digits and their optional whitespace terminator. */
function escapeEnd(text: string, i: number): number {
  const escape = /^\\(?:[\da-f]{1,6}(?:\r\n|[ \t\r\n\f])?|\r\n|[^\r])/i.exec(text.slice(i));
  if (!escape) unknown('unterminated escape');
  return i + escape[0].length;
}

/** Strings, escapes and comments are opaque to delimiter and whitespace scans. */
function opaqueEnd(text: string, i: number): number {
  if (text.startsWith('/*', i)) {
    const end = text.indexOf('*/', i + 2);
    if (end === -1) unknown('unterminated comment');
    return end + 2;
  }
  if (text[i] === '\\') return escapeEnd(text, i);
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return i;
  for (let end = i + 1; end < text.length;) {
    if (text[end] === quote) return end + 1;
    if (/[\r\n\f]/.test(text[end])) unknown('newline in string');
    end = text[end] === '\\' ? escapeEnd(text, end) : end + 1;
  }
  return unknown('unterminated string');
}

/** Next delimiter outside strings, comments, escapes and balanced component values. */
function delimiter(text: string, from: number, stops: string): number {
  const stack: string[] = [];
  const closes: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let i = from; i < text.length; i++) {
    const end = opaqueEnd(text, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    const ch = text[i];
    if (!stack.length && stops.includes(ch)) return i;
    if (closes[ch]) stack.push(closes[ch]);
    else if (')]}'.includes(ch) && stack.pop() !== ch) unknown('unbalanced delimiter');
  }
  if (stack.length) unknown('unclosed block or component value');
  return text.length;
}

/** Collapse only CSS whitespace outside opaque tokens, preserving their significant contents. */
function collapse(text: string): string {
  let result = '';
  let space = '';
  for (let i = 0; i < text.length;) {
    const end = opaqueEnd(text, i);
    if (end === i && /[ \t\r\n\f]/.test(text[i])) {
      if (result) space = ' ';
      i++;
    } else {
      result += space + text.slice(i, end > i ? end : i + 1);
      space = '';
      i = end > i ? end : i + 1;
    }
  }
  return result;
}

function skipTrivia(text: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    if (text.startsWith('/*', i)) i = opaqueEnd(text, i);
    else if (/[ \t\r\n\f]/.test(text[i])) i++;
    else break;
  }
  return i;
}

type LeafRule = { key: string; body: string; start: number; end: number };

/** Leaf rules with their offsets; `key` is the at-rule chain plus the prelude (`@media (…) > .panel`). */
function leafRules(text: string): LeafRule[] {
  const rules: LeafRule[] = [];
  const walk = (from: number, to: number, chain: string[]): void => {
    for (let i = skipTrivia(text, from, to); i < to; i = skipTrivia(text, i, to)) {
      const brace = delimiter(text, i, '{;}');
      if (text[brace] === ';' && text[i] === '@') {
        i = brace + 1;
        continue;
      }
      if (brace >= to || text[brace] !== '{') unknown('unsupported rule prelude');
      const close = delimiter(text, brace + 1, '}');
      if (close >= to) unknown('unclosed rule block');
      const prelude = collapse(text.slice(i, brace));
      if (GROUPING.test(prelude)) walk(brace + 1, close, [...chain, prelude]);
      else
        rules.push({
          key: [...chain, prelude].join(' > '),
          body: collapse(text.slice(brace + 1, close)),
          start: i,
          end: close + 1,
        });
      i = close + 1;
    }
  };
  walk(0, text.length, []);
  return rules;
}

/** Complete declaration values, including semicolons in strings/functions/custom-property blocks. */
function declarations(body: string): [string, string][] {
  const result: [string, string][] = [];
  for (let i = skipTrivia(body, 0, body.length); i < body.length;) {
    const end = delimiter(body, i, ';');
    const colon = delimiter(body.slice(0, end), i, ':{');
    if (body[colon] !== ':') unknown('nested rule or unsupported declaration');
    const property = collapse(body.slice(i, colon));
    if (!/^(?:--)?[\w-]+$/.test(property)) unknown('unsupported declaration name');
    const value = body.slice(colon + 1, end);
    if (!property.startsWith('--') && delimiter(value, 0, '{') < value.length)
      unknown('nested rule or unsupported declaration value');
    result.push([property, collapse(value)]);
    i = skipTrivia(body, end + 1, body.length);
  }
  return result;
}

/** The custom properties a body declares (name → value digest) and the ones it reads through `var()`. */
function customProperties(body: string, values: [string, string][]): Pick<ServedRule, 'vars' | 'uses'> {
  const declared = values.filter(([property]) => property.startsWith('--'));
  const read = [...new Set([...body.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))];
  return {
    ...(declared.length ? { vars: Object.fromEntries(declared.map(([name, value]) => [name, digest(value)])) } : {}),
    ...(read.length ? { uses: read } : {}),
  };
}

function commaValues(value: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < value.length;) {
    const end = delimiter(value, i, ',');
    values.push(value.slice(i, end).trim());
    i = end + 1;
  }
  return values;
}

function fontFamily(family: string): string {
  if (family[0] === '"' || family[0] === "'") {
    if (opaqueEnd(family, 0) !== family.length) unknown('unsupported font family');
    return family.slice(1, -1);
  }
  if (!/^[-\w]+(?: [-\w]+)*$/.test(family)) unknown('unsupported font family');
  return family;
}

/** Identifiers in `animation`/`font` declarations: candidate @keyframes and @font-face names. */
function referencedNames(values: [string, string][]): string[] {
  const names = values.flatMap(([property, value]) => {
    if (!/^(animation(?:-name)?|font(?:-family)?)$/i.test(property)) return [];
    if (/^font$/i.test(property) || /\\|\/\*|\(/.test(value)) unknown('unsupported font or animation dependency');
    if (/^font-family$/i.test(property)) return commaValues(value).map(fontFamily);
    if (/["']/.test(value)) unknown('unsupported animation dependency');
    return value.split(/[\s,]+/).filter((t) => /^-?[_a-zA-Z][\w-]*$/.test(t));
  });
  return [...new Set(names)];
}

/**
 * Ledger entries for one stylesheet's text, marking a rule used when a matched range
 * from rule usage overlaps it. @keyframes and @font-face are never reported used:
 * rule usage only covers style rules, so their reach resolves through `refs`.
 */
export function servedRulesOf(text: string, used: readonly UsedRange[]): Omit<ServedRule, 'sheet'>[] {
  return leafRules(text).map((rule) => {
    const keyframes = /^@(?:-\w+-)?keyframes\b/i.test(text.slice(rule.start));
    const values = keyframes
      ? leafRules(rule.body).flatMap((frame) => declarations(frame.body))
      : declarations(rule.body);
    const refs = referencedNames(values);
    return {
      key: rule.key,
      hash: digest(rule.body),
      ...(used.some((r) => r.startOffset < rule.end && r.endOffset > rule.start) ? { used: true as const } : {}),
      ...customProperties(rule.body, values),
      ...(refs.length ? { refs } : {}),
    };
  });
}

/** A stable label for where a stylesheet came from: its URL path, `inline`, or `constructed`. */
function sheetLabel(header: SheetHeader): string {
  if (header.isConstructed) return 'constructed';
  if (header.isInline || !header.sourceURL) return 'inline';
  try {
    return new URL(header.sourceURL).pathname;
  } catch {
    return header.sourceURL.split(/[?#]/)[0];
  }
}

export type ServedRuleTracker = {
  /** Start recording rule usage. Starting forces a style recalculation, so rules the page already matches count. */
  start: () => Promise<void>;
  /** Stop recording and read the ledger, leaving out stylesheets whose text is in `ownCss`. Can start again. */
  stop: (ownCss: readonly string[]) => Promise<ServedRules>;
  /** Release the CDP session. Safe after a failed capture and safe to repeat. */
  dispose: () => Promise<void>;
};

type ReadSheet = { label: string; text: string; styleSheetId: string };

/** Each regular stylesheet's text in a stable order; linked sheets with no retained text are counted unreadable. */
async function readSheets(
  client: CDPSession,
  headers: Iterable<SheetHeader>,
  ownCss: readonly string[],
): Promise<{ read: ReadSheet[]; unreadable: number }> {
  const read: ReadSheet[] = [];
  let unreadable = 0;
  for (const header of headers) {
    if (header.origin !== 'regular') continue;
    const text = await client
      .send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId })
      .then((r) => r.text)
      .catch(() => undefined);
    const label = sheetLabel(header);
    // Chromium keeps a linked sheet's text only when the CSS domain was enabled before it loaded.
    if (text === undefined || (!text && label !== 'inline' && label !== 'constructed')) unreadable++;
    else if (!ownCss.includes(text.trim())) read.push({ label, text, styleSheetId: header.styleSheetId });
  }
  // Discovery order varies between runs; the ledger must not.
  const order = (s: ReadSheet): string => JSON.stringify([s.label, s.text]);
  read.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  if (read.some((sheet, i) => i > 0 && order(sheet) === order(read[i - 1]))) unknown('ambiguous identical stylesheets');
  return { read, unreadable };
}

/**
 * Track the stylesheets a page serves. Arm it BEFORE navigating, like
 * `trackInflightRequests`: Chromium keeps a linked stylesheet's text, and reports its
 * rule usage, only when the CSS domain was enabled before the sheet loaded. A tracker
 * armed later still reads inline and constructed sheets and counts the rest unreadable.
 */
export async function trackServedRules(page: Page): Promise<ServedRuleTracker> {
  const client = await page.context().newCDPSession(page);
  const sheets = new Map<string, SheetHeader>();
  client.on('CSS.styleSheetAdded', ({ header }) => sheets.set(header.styleSheetId, header));
  client.on('CSS.styleSheetRemoved', ({ styleSheetId }) => sheets.delete(styleSheetId));
  const dispose = (): Promise<void> => client.detach().catch(() => undefined);
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
  } catch (error) {
    await dispose();
    throw error;
  }
  const start = async (): Promise<void> => {
    await client.send('CSS.startRuleUsageTracking');
  };
  const stop = async (ownCss: readonly string[]): Promise<ServedRules> => {
    const { ruleUsage } = await client.send('CSS.stopRuleUsageTracking');
    const { read, unreadable } = await readSheets(client, sheets.values(), ownCss);
    const rules: ServedRule[] = [];
    const seen = new Map<string, number>();
    read.forEach((sheet, index) => {
      const used = ruleUsage.filter((r) => r.used && r.styleSheetId === sheet.styleSheetId);
      for (const rule of servedRulesOf(sheet.text, used)) {
        const n = (seen.get(rule.key) ?? 0) + 1;
        seen.set(rule.key, n);
        rules.push({ ...rule, key: n > 1 ? `${rule.key} #${n}` : rule.key, sheet: index });
      }
    });
    return { sheets: read.map((s) => s.label), rules, ...(unreadable ? { unreadable } : {}) };
  };
  return { start, stop, dispose };
}
