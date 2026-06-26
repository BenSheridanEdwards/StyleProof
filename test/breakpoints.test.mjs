import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakpointsFromCss, suggestWidths, suggestWidthsFromCss } from '../dist/breakpoints.js';

// ------------------------------------------------------- breakpointsFromCss

test('breakpointsFromCss: min-width opens a band at V; sorted + de-duplicated', () => {
  const css = '@media (min-width: 1024px){a{}} @media (min-width:768px){b{}} @media (min-width: 768px){c{}}';
  assert.deepEqual(breakpointsFromCss(css), [768, 1024]);
});

test('breakpointsFromCss: max-width opens the next band at V+1', () => {
  // max-width:767 → band below active through 767, next band opens at 768
  assert.deepEqual(breakpointsFromCss('@media (max-width: 767px){x{}}'), [768]);
});

test('breakpointsFromCss: ignores non-px units and matches inside complex preludes', () => {
  const css = '@media (min-width: 48em){a{}} @media screen and (min-width: 600px) and (max-width: 899px){b{}}';
  // 48em ignored; 600 (min) and 900 (max 899 + 1) kept
  assert.deepEqual(breakpointsFromCss(css), [600, 900]);
});

test('breakpointsFromCss: no media queries → empty', () => {
  assert.deepEqual(breakpointsFromCss('.a{color:red}'), []);
});

// ------------------------------------------------------- suggestWidths

test('suggestWidths: no breakpoints → just the base width', () => {
  assert.deepEqual(suggestWidths([]), [360]);
  assert.deepEqual(suggestWidths([], 414), [414]);
});

test('suggestWidths: base band + one width per boundary', () => {
  assert.deepEqual(suggestWidths([768, 1024]), [360, 768, 1024]);
});

test('suggestWidths: base width clamped strictly below the first boundary', () => {
  // first boundary 320 ≤ default 360, so base clamps to 319 (inside the base band)
  assert.deepEqual(suggestWidths([320, 768]), [319, 320, 768]);
});

test('suggestWidths: de-duplicates and sorts unsorted/dup input', () => {
  assert.deepEqual(suggestWidths([1024, 768, 768]), [360, 768, 1024]);
});

// ------------------------------------------------------- the soundness property

/** Bands for ascending boundaries: [0,b0-1], [b0,b1-1], …, [bLast, ∞). */
function bands(bps) {
  const edges = [0, ...bps];
  return edges.map((lo, i) => ({ lo, hi: i + 1 < edges.length ? edges[i + 1] - 1 : Infinity }));
}

test('suggestWidths: every band has at least one representative width', () => {
  for (const bps of [[768, 1024], [320, 768, 1200], [600], [1, 5, 9]]) {
    const widths = suggestWidths(bps);
    for (const band of bands(bps)) {
      if (band.hi < 1) continue; // a band that can't hold a real (≥1px) viewport
      const covered = widths.some((w) => w >= band.lo && w <= band.hi);
      assert.ok(covered, `band ${band.lo}..${band.hi} uncovered by ${widths} (bps ${bps})`);
    }
  }
});

// ------------------------------------------------------- suggestWidthsFromCss

test('suggestWidthsFromCss: composes parse + suggest', () => {
  const css = '@media (min-width: 768px){a{}} @media (min-width: 1280px){b{}}';
  assert.deepEqual(suggestWidthsFromCss(css), [360, 768, 1280]);
  assert.deepEqual(suggestWidthsFromCss('.a{}'), [360]); // no media queries
});
