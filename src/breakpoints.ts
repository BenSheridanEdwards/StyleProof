import type { Page } from '@playwright/test';

/**
 * Authoritative viewport-breakpoint detection — reads the breakpoints the browser
 * ACTUALLY applied, not a guess and not your source config.
 *
 * StyleProof already reads computed styles from the live page rather than your
 * source CSS; breakpoints are detected the same way. At capture time we walk the
 * loaded CSSOM (`document.styleSheets`) and read every `@media` width condition the
 * browser parsed — so it works for any style system that ends up as CSS (Tailwind,
 * CSS Modules, styled-components, Sass, vanilla) with no per-framework code and
 * nothing to configure.
 *
 * It is 100% accurate or it FAILS: if a stylesheet is unreadable (a cross-origin
 * `<link>` with no CORS), we can't see its `@media` rules, so detection throws
 * rather than silently miss a band. The only thing CSSOM can't see is a breakpoint
 * with no CSS rule (a layout swapped purely in JS via `matchMedia`); set explicit
 * `widths` to cover that.
 */

/** Collected in the browser; cannot reference module-scope helpers (it is serialized). */
type MediaCollection = { mediaTexts: string[]; unreadable: string[]; rootFontPx: number };

/** Serialized into the browser by page.evaluate; cannot call module helpers. */
function collectMediaTexts(): MediaCollection {
  const mediaTexts: string[] = [];
  const unreadable: string[] = [];
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      // CSSMediaRule has `.media`; a CSSContainerRule does not, so container
      // queries (container-relative, not viewport) are correctly skipped here.
      const media = (rule as CSSMediaRule).media;
      if (media && typeof media.mediaText === 'string') mediaTexts.push(media.mediaText);
      // Descend into @supports / @layer / nested @media groups.
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) {
        try {
          walk(nested);
        } catch {
          /* a nested rule list we can't read — ignore, top-level catch reports sheets */
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

/**
 * Parse the px width BOUNDARIES a single `@media` condition introduces — the widths
 * at which its match flips. A `min-width: V` opens a band at `V`; a `max-width: V`
 * keeps the band below active through `V`, so the next band opens at `V + 1`. Range
 * syntax (`width >= V`, `V <= width`, `width < V`, …) is normalised the same way.
 * `em`/`rem` are resolved against `rootFontPx`. Non-width conditions yield nothing.
 */
export function mediaTextWidthBoundaries(mediaText: string, rootFontPx = 16): number[] {
  const t = mediaText.toLowerCase();
  const out = new Set<number>();
  const px = (v: number, unit: string): number => (unit === 'px' ? v : v * rootFontPx);
  const add = (v: number): void => {
    const n = Math.round(v);
    if (n > 0) out.add(n);
  };
  let m: RegExpExecArray | null;

  const reMinMax = /\((min|max)-width\s*:\s*([\d.]+)(px|r?em)\)/g;
  while ((m = reMinMax.exec(t)) !== null) {
    const v = px(parseFloat(m[2]), m[3]);
    if (m[1] === 'min') add(v);
    else add(v + 1); // max-width: V → next band opens at V+1
  }

  // Range syntax: `width <op> Vpx` and the mirrored `Vpx <op> width`.
  const flip = (op: string): string => (op === '<=' ? '>=' : op === '<' ? '>' : op === '>=' ? '<=' : '<');
  const addCmp = (v: number, op: string): void => {
    if (op === '>=') add(v);
    else if (op === '>') add(v + 1);
    else if (op === '<=') add(v + 1);
    else if (op === '<') add(v);
  };
  const reRight = /width\s*(<=|>=|<|>)\s*([\d.]+)(px|r?em)/g;
  while ((m = reRight.exec(t)) !== null) addCmp(px(parseFloat(m[2]), m[3]), m[1]);
  const reLeft = /([\d.]+)(px|r?em)\s*(<=|>=|<|>)\s*width/g;
  while ((m = reLeft.exec(t)) !== null) addCmp(px(parseFloat(m[1]), m[2]), flip(m[3]));

  return [...out].sort((a, b) => a - b);
}

/**
 * Turn breakpoint boundaries into one representative viewport width per band: the
 * base band below the first boundary uses `baseWidth` (clamped strictly inside it),
 * every other band its lower boundary. With no boundaries (no width `@media` rules)
 * the layout is band-invariant, so a single `noQueryWidth` covers it. Ascending,
 * de-duplicated.
 */
export function widthsFromBoundaries(
  boundaries: number[],
  opts: { baseWidth?: number; noQueryWidth?: number } = {},
): number[] {
  const baseWidth = opts.baseWidth ?? 360;
  const noQueryWidth = opts.noQueryWidth ?? 1280;
  const bps = [...new Set(boundaries.map((n) => Math.round(n)))].filter((n) => n > 0).sort((a, b) => a - b);
  if (bps.length === 0) return [noQueryWidth];
  const base = Math.min(baseWidth, bps[0] - 1);
  return [...new Set([base, ...bps])].filter((n) => n > 0).sort((a, b) => a - b);
}

/**
 * Detect the viewport widths to sweep for the currently-loaded page: read every
 * `@media` width breakpoint from the live CSSOM and return one width per band.
 * Throws if any stylesheet is unreadable (cross-origin) — detection is authoritative
 * or it fails; it never guesses. Call after the page has loaded its styles.
 */
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
  const boundaries = mediaTexts.flatMap((t) => mediaTextWidthBoundaries(t, rootFontPx));
  return widthsFromBoundaries(boundaries, opts);
}
