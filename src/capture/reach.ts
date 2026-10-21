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

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
// Grouping at-rules hold rules; every other block is a leaf (style rule, @keyframes, @font-face…).
const GROUPING = /^@(media|supports|layer|container|scope|document|starting-style)\b/i;
// Declarations that name a @keyframes or @font-face by identifier.
const REFERENCING = /(?:^|;)\s*(animation(?:-name)?|font(?:-family)?)\s*:\s*([^;]+)/gi;

/** Index just past the `close` that ends the run opened at `from`, or `limit` when it never closes. */
function past(text: string, close: string, from: number, limit: number): number {
  const at = text.indexOf(close, from);
  return at === -1 ? limit : at + close.length;
}

/** Matching close brace for the `{` at `open`, skipping comments and strings. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (text.startsWith('/*', i)) i = past(text, '*/', i + 2, text.length) - 1;
    else if (ch === '"' || ch === "'") i = past(text, ch, i + 1, text.length) - 1;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Next significant index at or after `i`: past whitespace, comments, and the `}` of a closed block. */
function skipTrivia(text: string, i: number, to: number): number {
  while (i < to && (text.startsWith('/*', i) || /\s|}/.test(text[i])))
    i = text.startsWith('/*', i) ? past(text, '*/', i + 2, to) : i + 1;
  return i;
}

/** End of a statement at-rule such as `@import …;` at `i`, or -1 when a block opens first. */
function statementEnd(text: string, i: number, to: number): number {
  const brace = text.indexOf('{', i);
  const semi = text.indexOf(';', i);
  if (brace !== -1 && brace < to && (semi === -1 || semi > brace)) return -1;
  return semi === -1 || semi >= to ? to : semi + 1;
}

type LeafRule = { key: string; body: string; start: number; end: number };

/** Leaf rules with their offsets; `key` is the at-rule chain plus the prelude (`@media (…) > .panel`). */
function leafRules(text: string): LeafRule[] {
  const rules: LeafRule[] = [];
  const walk = (from: number, to: number, chain: string[]): void => {
    for (let i = skipTrivia(text, from, to); i < to; i = skipTrivia(text, i, to)) {
      const end = statementEnd(text, i, to);
      if (end !== -1) {
        i = end;
        continue;
      }
      const brace = text.indexOf('{', i);
      const close = closeOf(text, brace);
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

/** The custom properties a body declares (name → value digest) and the ones it reads through `var()`. */
function customProperties(body: string): Pick<ServedRule, 'vars' | 'uses'> {
  const declared = [...body.matchAll(/(?:^|;)\s*(--[\w-]+)\s*:\s*([^;]*)/g)];
  const read = [...new Set([...body.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))];
  return {
    ...(declared.length ? { vars: Object.fromEntries(declared.map((m) => [m[1], digest(collapse(m[2]))])) } : {}),
    ...(read.length ? { uses: read } : {}),
  };
}

/** Identifiers in `animation`/`font` declarations: candidate @keyframes and @font-face names. */
function referencedNames(body: string): string[] {
  const names = [...body.matchAll(REFERENCING)].flatMap((m) =>
    m[2].split(/[\s,]+/).map((t) => t.replace(/^["']|["']$/g, '')),
  );
  return [...new Set(names.filter((t) => /^-?[_a-zA-Z][\w-]*$/.test(t)))];
}

/**
 * Ledger entries for one stylesheet's text, marking a rule used when a matched range
 * from rule usage overlaps it. @keyframes and @font-face are never reported used:
 * rule usage only covers style rules, so their reach resolves through `refs`.
 */
export function servedRulesOf(text: string, used: readonly UsedRange[]): Omit<ServedRule, 'sheet'>[] {
  return leafRules(text).map((rule) => {
    const refs = referencedNames(rule.body);
    return {
      key: rule.key,
      hash: digest(rule.body),
      ...(used.some((r) => r.startOffset < rule.end && r.endOffset > rule.start) ? { used: true as const } : {}),
      ...customProperties(rule.body),
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
  const order = (s: ReadSheet): string => `${s.label}\n${digest(s.text)}`;
  return { read: read.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0)), unreadable };
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
