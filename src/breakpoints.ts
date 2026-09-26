import type { Page } from '@playwright/test';

/**
 * Authoritative viewport-breakpoint detection: read every `@media` width condition the browser
 * ACTUALLY parsed (the loaded CSSOM). It is 100% accurate or it FAILS — an unreadable cross-origin
 * sheet throws rather than silently missing a band. A pure `matchMedia` breakpoint needs explicit `widths`.
 */

/** Serialized into the browser by page.evaluate; cannot call module helpers. */
function collectMediaTexts(): { mediaTexts: string[]; unreadable: string[]; rootFontPx: number } {
  const mediaTexts: string[] = [];
  const unreadable: string[] = [];
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
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
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules; // throws for a cross-origin sheet with no CORS
      if (rules) walk(rules);
    } catch {
      unreadable.push(sheet.href ?? '<inline>');
    }
  }
  const rootFontPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return { mediaTexts, unreadable, rootFontPx };
}

/** Offset at which a range condition's next band opens: `>= V` / `< V` at V, `> V` / `<= V` at V+1. */
const OPENS_AT: Record<string, number> = { '>=': 0, '>': 1, '<=': 1, '<': 0 };
const FLIP: Record<string, string> = { '<=': '>=', '<': '>', '>=': '<=', '>': '<' };
const RE_MIN_MAX = /\((min|max)-width\s*:\s*([\d.]+)(px|r?em)\)/g;
const RE_RIGHT = /width\s*(<=|>=|<|>)\s*([\d.]+)(px|r?em)/g;
// Mirrored `V <op> width`. The lookbehind pins the number's start, so a dot- or digit-heavy
// malformed prelude scans linearly instead of backtracking quadratically.
const RE_MIRRORED = /(?<![\d.])(\d+(?:\.\d*)?|\.\d+)(px|r?em)\s*(<=|>=|<|>)\s*width\b/g;

/** The px width BOUNDARIES one `@media` condition introduces — where its match flips: `min-width: V`
 *  opens a band at `V`, `max-width: V` at `V + 1`; range syntax is normalised the same way and
 *  `em`/`rem` resolve against `rootFontPx`. Non-width conditions yield nothing. */
export function mediaTextWidthBoundaries(mediaText: string, rootFontPx = 16): number[] {
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
  for (const m of t.matchAll(RE_RIGHT)) add(m[2], m[3], OPENS_AT[m[1]]);
  for (const m of t.matchAll(RE_MIRRORED)) add(m[1], m[2], OPENS_AT[FLIP[m[3]]]);
  return [...out].sort((a, b) => a - b);
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
 *  stylesheet is unreadable: detection is authoritative or it fails; it never guesses. */
export async function detectViewportWidths(
  page: Page,
  opts: { baseWidth?: number; noQueryWidth?: number } = {},
): Promise<number[]> {
  const { mediaTexts, unreadable, rootFontPx } = await page.evaluate(collectMediaTexts);
  if (unreadable.length > 0) {
    throw new Error(
      `styleproof: can't detect breakpoints — ${unreadable.length} stylesheet(s) are unreadable ` +
        `(cross-origin, no CORS): ${unreadable.join(', ')}. Detection reads every stylesheet to stay ` +
        `100% accurate, so it fails rather than guess. Make them same-origin / CORS-readable, or set ` +
        `\`widths\` on the surface to skip detection.`,
    );
  }
  return widthsFromBoundaries(
    mediaTexts.flatMap((t) => mediaTextWidthBoundaries(t, rootFontPx)),
    opts,
  );
}
