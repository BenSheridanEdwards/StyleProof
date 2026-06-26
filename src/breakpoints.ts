/**
 * Advisory breakpoint helper — OFF the capture path.
 *
 * `Surface.widths` ("one viewport per @media band") stays the source of truth and
 * is never auto-derived, because detection is necessarily incomplete: it can't see
 * `@container` queries, JS `matchMedia` breakpoints, CSS-in-JS that isn't in a
 * parsed stylesheet, or a framework's config-defined breakpoints. Letting detection
 * *narrow* the sweep would silently under-test a band — a per-width false negative.
 *
 * So these helpers only **suggest** a starting `widths` array from a stylesheet's
 * `@media` rules, for a human to review and paste. They do not feed capture, add no
 * dependency, and don't touch the StyleMap format.
 */

/**
 * Extract the distinct px breakpoint boundaries from a stylesheet's `@media` rules.
 *
 * A `min-width: V` rule opens a band at `V`; a `max-width: V` rule keeps the band
 * below active through `V`, so the next band opens at `V + 1`. Non-px units and
 * malformed values are ignored. Returns the boundaries ascending and de-duplicated.
 */
export function breakpointsFromCss(css: string): number[] {
  const boundaries = new Set<number>();
  const re = /\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const v = Math.round(parseFloat(m[2]));
    if (!Number.isFinite(v) || v <= 0) continue;
    boundaries.add(m[1].toLowerCase() === 'max' ? v + 1 : v);
  }
  return [...boundaries].sort((a, b) => a - b);
}

/**
 * Suggest one representative viewport width per band defined by `breakpoints`
 * (e.g. from {@link breakpointsFromCss}). The base band below the first boundary is
 * represented by `baseWidth`, clamped to sit strictly inside it; every other band by
 * its lower boundary. Ascending, de-duplicated.
 *
 * Advisory only — review the result before using it as `Surface.widths`.
 */
export function suggestWidths(breakpoints: number[], baseWidth = 360): number[] {
  const bps = [...new Set(breakpoints.map((n) => Math.round(n)))]
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (bps.length === 0) return [baseWidth];
  const base = Math.min(baseWidth, bps[0] - 1);
  return [...new Set([base, ...bps])].filter((n) => n > 0).sort((a, b) => a - b);
}

/**
 * Convenience: {@link suggestWidths}({@link breakpointsFromCss}(css)). Pass a
 * stylesheet's text (read the built CSS, or collect `document.styleSheets` cssText
 * once in a throwaway capture) and get a suggested `widths` array to review.
 */
export function suggestWidthsFromCss(css: string, baseWidth = 360): number[] {
  return suggestWidths(breakpointsFromCss(css), baseWidth);
}
