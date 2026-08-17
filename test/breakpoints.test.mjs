import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaTextWidthBoundaries, widthsFromBoundaries } from '../dist/breakpoints.js';

// ----------------------------------------- mediaTextWidthBoundaries (parsing real @media text)

test('min-width opens a band at V', () => {
  assert.deepEqual(mediaTextWidthBoundaries('(min-width: 768px)'), [768]);
});

test('max-width opens the next band at V+1', () => {
  assert.deepEqual(mediaTextWidthBoundaries('(max-width: 767px)'), [768]);
});

test('combined min+max inside a real prelude', () => {
  assert.deepEqual(mediaTextWidthBoundaries('screen and (min-width: 600px) and (max-width: 899px)'), [600, 900]);
});

test('range syntax: width >= / <= / < / >', () => {
  assert.deepEqual(mediaTextWidthBoundaries('(width >= 768px)'), [768]);
  assert.deepEqual(mediaTextWidthBoundaries('(width <= 767px)'), [768]);
  assert.deepEqual(mediaTextWidthBoundaries('(width < 900px)'), [900]);
  assert.deepEqual(mediaTextWidthBoundaries('(width > 1023px)'), [1024]);
});

test('range syntax mirrored: V <op> width', () => {
  assert.deepEqual(mediaTextWidthBoundaries('(768px <= width)'), [768]); // == width >= 768
  assert.deepEqual(mediaTextWidthBoundaries('(600px > width)'), [600]); // == width < 600
});

test('em/rem resolved against the root font size', () => {
  assert.deepEqual(mediaTextWidthBoundaries('(min-width: 40em)', 16), [640]);
  assert.deepEqual(mediaTextWidthBoundaries('(min-width: 48rem)', 16), [768]);
  assert.deepEqual(mediaTextWidthBoundaries('(min-width: 40em)', 10), [400]); // non-default root
});

test('non-width conditions yield nothing', () => {
  assert.deepEqual(mediaTextWidthBoundaries('print'), []);
  assert.deepEqual(mediaTextWidthBoundaries('(prefers-color-scheme: dark)'), []);
  assert.deepEqual(mediaTextWidthBoundaries('(min-height: 600px)'), []);
});

// ----------------------------------------- widthsFromBoundaries (band → representative widths)

test('no boundaries → a single band-invariant width', () => {
  assert.deepEqual(widthsFromBoundaries([]), [1280]);
  assert.deepEqual(widthsFromBoundaries([], { noQueryWidth: 1024 }), [1024]);
});

test('base band + one width per boundary', () => {
  assert.deepEqual(widthsFromBoundaries([768, 1024]), [360, 768, 1024]);
});

test('base width clamped strictly below the first boundary', () => {
  assert.deepEqual(widthsFromBoundaries([320, 768]), [319, 320, 768]);
});

test('de-duplicates and sorts unsorted/dup input', () => {
  assert.deepEqual(widthsFromBoundaries([1024, 768, 768]), [360, 768, 1024]);
});

// ----------------------------------------- the soundness property: every band is covered

/** Bands for ascending boundaries: [0,b0-1], [b0,b1-1], …, [bLast, ∞). */
function bands(bps) {
  const edges = [0, ...bps];
  return edges.map((lo, i) => ({ lo, hi: i + 1 < edges.length ? edges[i + 1] - 1 : Infinity }));
}

test('every band defined by the breakpoints has a representative width', () => {
  for (const bps of [[768, 1024], [320, 768, 1200], [600], [640, 768, 1024, 1280, 1536]]) {
    const widths = widthsFromBoundaries(bps);
    for (const band of bands(bps)) {
      if (band.hi < 1) continue; // a band too narrow to hold a real (≥1px) viewport
      const covered = widths.some((w) => w >= band.lo && w <= band.hi);
      assert.ok(covered, `band ${band.lo}..${band.hi} uncovered by ${widths} (bps ${bps})`);
    }
  }
});

// ----------------------------------------- end to end through parse → derive

test('a Tailwind-default sheet resolves to one width per breakpoint', () => {
  const medias = [
    '(min-width: 640px)',
    '(min-width: 768px)',
    '(min-width: 1024px)',
    '(min-width: 1280px)',
    '(min-width: 1536px)',
  ];
  const boundaries = medias.flatMap((t) => mediaTextWidthBoundaries(t));
  assert.deepEqual(widthsFromBoundaries(boundaries), [360, 640, 768, 1024, 1280, 1536]);
});
