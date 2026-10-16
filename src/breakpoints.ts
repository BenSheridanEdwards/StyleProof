import type { Page } from '@playwright/test';

/**
 * Authoritative viewport-breakpoint detection: read every `@media` width condition the browser
 * ACTUALLY parsed (the loaded CSSOM). It is 100% accurate or it FAILS — an unreadable cross-origin
 * sheet throws rather than silently missing a band. A pure `matchMedia` breakpoint needs explicit `widths`.
 */

/** Serialized into the browser by page.evaluate; cannot call module helpers. */
function collectMediaTexts(): { mediaTexts: string[]; unreadable: string[] } {
  const mediaTexts: string[] = [];
  const unreadable: string[] = [];
  const readSheet = (sheet: CSSStyleSheet, viaImport = false): void => {
    // `<style media>` / `<link media>` put the condition on the sheet itself.
    if (sheet.media?.mediaText) mediaTexts.push(sheet.media.mediaText);
    try {
      const rules = sheet.cssRules; // throws for a cross-origin sheet with no CORS
      if (rules) walk(rules);
    } catch {
      unreadable.push(`${sheet.href ?? '<inline>'}${viaImport ? ' (@import)' : ''}`);
    }
  };
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      // An @import keeps its condition on the rule (`@import url(x.css) (min-width: …)`) and its
      // rules on its own sheet, not on `.cssRules`.
      const imported = (rule as CSSImportRule).styleSheet;
      if (imported) {
        const importMedia = (rule as CSSImportRule).media?.mediaText;
        if (importMedia) mediaTexts.push(importMedia);
        readSheet(imported, true);
        continue;
      }
      // CSSMediaRule has `.media`; a CSSContainerRule does not, so container queries are skipped.
      const media = (rule as CSSMediaRule).media;
      if (media && typeof media.mediaText === 'string') mediaTexts.push(media.mediaText);
      const nested = (rule as CSSGroupingRule).cssRules; // @supports / @layer / nested @media
      if (nested) {
        try {
          walk(nested);
        } catch {
          /* unreadable nested list — the top-level catch reports sheets */
        }
      }
    }
  };
  for (const sheet of [...Array.from(document.styleSheets), ...(document.adoptedStyleSheets ?? [])]) readSheet(sheet);
  return { mediaTexts, unreadable };
}

/** Media Queries resolve `em`/`rem` against the initial font size, never the page's `html { font-size }`. */
const MEDIA_QUERY_EM_PX = 16;

/** Offset at which a range condition's next band opens: `>= V` / `< V` at V, `> V` / `<= V` at V+1. */
const OPENS_AT: Record<string, number> = { '>=': 0, '>': 1, '<=': 1, '<': 0 };
const FLIP: Record<string, string> = { '<=': '>=', '<': '>', '>=': '<=', '>': '<' };
const RE_MIN_MAX = /\((min|max)-width\s*:\s*([\d.]+)(px|r?em)\)/g;
// Exact `(width: V)` / `(width = V)`: true at V only, so bands open at V and V + 1.
const RE_EXACT = /\(width\s*[:=]\s*([\d.]+)(px|r?em)\)/g;
const RE_EXACT_MIRRORED = /\((\d+(?:\.\d*)?|\.\d+)(px|r?em)\s*=\s*width\)/g;
const RE_RIGHT = /width\s*(<=|>=|<|>)\s*([\d.]+)(px|r?em)/g;
// Mirrored `V <op> width`. The lookbehind pins the number's start, so a dot- or digit-heavy
// malformed prelude scans linearly instead of backtracking quadratically.
const RE_MIRRORED = /(?<![\d.])(\d+(?:\.\d*)?|\.\d+)(px|r?em)\s*(<=|>=|<|>)\s*width\b/g;

/** The px width BOUNDARIES one `@media` condition introduces — where its match flips: `min-width: V`
 *  opens a band at `V`, `max-width: V` at `V + 1`, `width: V` at both; range syntax is normalised the
 *  same way and `em`/`rem` resolve against `rootFontPx` (16px, the Media Queries initial font size,
 *  unless a caller passes another). Non-width conditions yield nothing. */
export function mediaTextWidthBoundaries(mediaText: string, rootFontPx = MEDIA_QUERY_EM_PX): number[] {
  const t = mediaText.toLowerCase();
  const out = new Set<number>();
  const add = (raw: string, unit: string, offset: number): void => {
    // Viewports are whole px: `>= V` / `< V` flip at the first integer >= V, `> V` / `<= V` at the
    // first integer > V. Trim float noise (`64.1 * 10`) so an exact value stays exact.
    const px = Math.round(parseFloat(raw) * (unit === 'px' ? 1 : rootFontPx) * 1e6) / 1e6;
    const n = offset === 0 ? Math.ceil(px) : Math.floor(px) + 1;
    if (n > 0) out.add(n);
  };
  for (const m of t.matchAll(RE_MIN_MAX)) add(m[2], m[3], m[1] === 'min' ? 0 : 1);
  for (const m of [...t.matchAll(RE_EXACT), ...t.matchAll(RE_EXACT_MIRRORED)]) {
    add(m[1], m[2], 0);
    add(m[1], m[2], 1);
  }
  for (const m of t.matchAll(RE_RIGHT)) add(m[2], m[3], OPENS_AT[m[1]]);
  for (const m of t.matchAll(RE_MIRRORED)) add(m[1], m[2], OPENS_AT[FLIP[m[3]]]);
  return [...out].sort((a, b) => a - b);
}

// A viewport width feature (`width`, `min-width`, `max-width`), never `device-width`.
const WIDTH_FEATURE = /(?<![-\w])(?:min-|max-)?width\b/;
// A length detection resolves: zero, or a number in px / em / rem.
const RESOLVABLE_LENGTH = /^(?:0|(?:\d+(?:\.\d*)?|\.\d+)(?:px|r?em))$/;

/** One `( … )` feature: resolvable when it is not a width feature, or every operand of it is a length above. */
function resolvableFeature(feature: string): boolean {
  if (!WIDTH_FEATURE.test(feature) || feature === 'width') return true; // boolean `(width)`: no boundary
  const colon = feature.match(/^(?:min-|max-)?width\s*:\s*(\S+)$/);
  if (colon) {
    if (!RESOLVABLE_LENGTH.test(colon[1])) return false;
    return /^0(?:px|r?em)?$/.test(colon[1]) || mediaTextWidthBoundaries(`(${feature})`).length > 0;
  }
  const operands = feature.split(/\s*(?:<=|>=|<|>|=)\s*/);
  if (operands.length < 2 || !operands.every((o) => o === 'width' || RESOLVABLE_LENGTH.test(o))) return false;
  // Every non-zero length must also yield a boundary, so a form the parser misses fails loudly.
  const nonZero = operands.some((o) => o !== 'width' && !/^0(?:px|r?em)?$/.test(o));
  return !nonZero || mediaTextWidthBoundaries(`(${feature})`).length > 0;
}

/** A width condition detection cannot turn into exact px boundaries — another unit (`9in`, `40ch`),
 *  a function (`calc()`, `min()`, `env()`), or any operand of a range that is not px/em/rem. Detection
 *  must fail rather than miss that band. */
export function hasUnparsedWidthCondition(mediaText: string): boolean {
  const t = mediaText.toLowerCase();
  if (!WIDTH_FEATURE.test(t)) return false;
  if (/[a-z-]\(/.test(t)) return true; // a function only the browser can evaluate
  return (t.match(/\(([^()]*)\)/g) ?? []).some((group) => !resolvableFeature(group.slice(1, -1).trim()));
}

/** One representative width per band: `baseWidth` (clamped strictly inside the base band), then each
 *  lower boundary. No boundaries → a single `noQueryWidth`. Ascending, de-duplicated. */
export function widthsFromBoundaries(
  boundaries: number[],
  opts: { baseWidth?: number; noQueryWidth?: number } = {},
): number[] {
  const bps = [...new Set(boundaries.map((n) => Math.round(n)))].filter((n) => n > 0).sort((a, b) => a - b);
  if (bps.length === 0) return [opts.noQueryWidth ?? 1280];
  const base = Math.min(opts.baseWidth ?? 360, bps[0] - 1);
  return [...new Set([base, ...bps])].filter((n) => n > 0).sort((a, b) => a - b);
}

/** Detect the widths to sweep for the loaded page — one per `@media` band. Throws if any
 *  stylesheet is unreadable or any width condition cannot be resolved to px: detection is
 *  authoritative or it fails; it never guesses. */
export async function detectViewportWidths(
  page: Page,
  opts: { baseWidth?: number; noQueryWidth?: number } = {},
): Promise<number[]> {
  const { mediaTexts, unreadable } = await page.evaluate(collectMediaTexts);
  if (unreadable.length > 0) {
    const viaImport = unreadable.some((u) => u.endsWith(' (@import)'));
    throw new Error(
      `styleproof: can't detect breakpoints — ${unreadable.length} stylesheet(s) are unreadable ` +
        `(cross-origin, no CORS): ${unreadable.join(', ')}. Detection reads every stylesheet to stay ` +
        `100% accurate, so it fails rather than guess. Make them same-origin / CORS-readable, or set ` +
        `\`widths\` on the surface to skip detection.` +
        (viaImport
          ? ' An @import is fetched without CORS, so headers cannot make it readable: inline or self-host it.'
          : ''),
    );
  }
  const unparsed = [...new Set(mediaTexts.filter(hasUnparsedWidthCondition))];
  if (unparsed.length > 0) {
    throw new Error(
      `styleproof: can't detect breakpoints — ${unparsed.length} @media width condition(s) detection ` +
        `cannot resolve to exact px: ${unparsed.join('; ')}. Detection fails rather than guess. Write ` +
        `the width as px/em/rem without calc() or other functions, or set \`widths\` on the surface to ` +
        `skip detection.`,
    );
  }
  return widthsFromBoundaries(
    mediaTexts.flatMap((t) => mediaTextWidthBoundaries(t)),
    opts,
  );
}
