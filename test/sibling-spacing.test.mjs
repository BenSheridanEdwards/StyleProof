// #755: spacing a sibling run gets from its parent is read from the rendered boxes,
// because a computed-style diff of the siblings themselves cannot see a lost gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimSpacing, siblingSpacingChanges, spacingLines } from '../dist/report/sibling-spacing.js';
import { makeMap } from './helpers.mjs';

const NAV = 'body > nav:nth-child(1)';
const WRAP = `${NAV} > div:nth-child(2)`;

/** Four stacked `section.group` boxes under `parent`, 64px tall each, `gap` apart. */
function groups(parent, gap, heights = [64, 64, 64, 64]) {
  const elements = { [NAV]: { tag: 'nav', cls: 'sidebar', rect: [0, 0, 220, 600] } };
  let y = 48;
  heights.forEach((height, i) => {
    elements[`${parent} > section:nth-child(${i + 1})`] = { tag: 'section', cls: 'group', rect: [12, y, 196, height] };
    y += height + gap;
  });
  return elements;
}

test('a run that loses its parent gap reports the lost spacing once (#755)', () => {
  const before = makeMap({ elements: { ...groups(WRAP, 14), [WRAP]: { tag: 'div', rect: [0, 0, 0, 0] } } });
  const after = makeMap({ elements: { ...groups(WRAP, 0), [WRAP]: { tag: 'div', rect: [12, 48, 196, 256] } } });
  assert.deepEqual(siblingSpacingChanges(before, after), [
    {
      parent: WRAP,
      siblings: ['section.group'],
      paths: [1, 2, 3, 4].map((n) => `${WRAP} > section:nth-child(${n})`),
      gaps: [{ before: 14, after: 0 }],
    },
  ]);
});

test('a run re-nested under a new parent pairs by its unique sibling signature', () => {
  const inner = `${WRAP} > div:nth-child(1)`;
  const before = makeMap({ elements: groups(WRAP, 14) });
  const after = makeMap({ elements: groups(inner, 0) });
  const [change, ...rest] = siblingSpacingChanges(before, after);
  assert.equal(rest.length, 0);
  assert.equal(change.parent, inner);
  assert.deepEqual(change.gaps, [{ before: 14, after: 0 }]);
});

test('an ambiguous re-nested run (same signature twice on a side) is not paired', () => {
  const other = `${NAV} > div:nth-child(3)`;
  const inner = `${WRAP} > div:nth-child(1)`;
  const before = makeMap({ elements: { ...groups(WRAP, 14), ...groups(other, 14) } });
  const after = makeMap({ elements: { ...groups(inner, 0), ...groups(`${other} > div:nth-child(1)`, 0) } });
  assert.deepEqual(siblingSpacingChanges(before, after), []);
});

test('no false positive: siblings that grow with their text but keep their gap are not reported', () => {
  const before = makeMap({ elements: groups(WRAP, 14) });
  const after = makeMap({ elements: groups(WRAP, 14, [64, 96, 40, 64]) });
  assert.deepEqual(siblingSpacingChanges(before, after), []);
});

test('no false positive: a distributed gap that moves only because a sibling resized is not reported', () => {
  // space-between: the second box shrinks, so the gaps around it widen with no spacing change.
  const before = makeMap({ elements: groups(WRAP, 14) });
  const after = makeMap({ elements: groups(WRAP, 14, [64, 32, 64, 64]) });
  const shifted = Object.keys(after.elements).filter((p) => /nth-child\([34]\)$/.test(p));
  for (const p of shifted) after.elements[p].rect[1] += 32;
  after.elements[`${WRAP} > section:nth-child(2)`].rect[1] += 16;
  assert.deepEqual(siblingSpacingChanges(before, after), []);
});

test('out-of-flow, unrendered and volatile siblings are not measured', () => {
  const before = makeMap({ elements: groups(WRAP, 14) });
  const after = makeMap({ elements: groups(WRAP, 0) });
  const absolute = structuredClone(after);
  for (const e of Object.values(absolute.elements)) if (e.tag === 'section') e.style = { position: 'absolute' };
  assert.deepEqual(siblingSpacingChanges(before, absolute), []);
  const hidden = structuredClone(after);
  for (const e of Object.values(hidden.elements)) if (e.tag === 'section') e.rect = [0, 0, 0, 0];
  assert.deepEqual(siblingSpacingChanges(before, hidden), []);
  assert.deepEqual(siblingSpacingChanges(before, { ...after, volatile: [WRAP] }), []);
});

test('an unchanged capture reports no spacing change', () => {
  const map = makeMap({ elements: groups(WRAP, 14) });
  assert.deepEqual(siblingSpacingChanges(map, structuredClone(map)), []);
});

test('a crop region claims the runs it shows; an unrelated run stays for the group', () => {
  const change = (parent, paths) => ({ parent, siblings: ['section.group'], paths, gaps: [{ before: 14, after: 0 }] });
  const wrapped = change(WRAP, [`${WRAP} > section:nth-child(1)`, `${WRAP} > section:nth-child(2)`]);
  const topLevel = change('body', ['body > header:nth-child(1)', 'body > main:nth-child(2)']);
  const claimed = new Set();
  assert.deepEqual(claimSpacing([wrapped, topLevel], [`${WRAP} > section:nth-child(1) > a:nth-child(2)`], claimed), [
    wrapped,
  ]);
  assert.deepEqual(claimSpacing([wrapped, topLevel], [WRAP], claimed), [], 'claimed once');
  assert.deepEqual([...claimed], [wrapped]);
});

test('the spacing line names the siblings and the before → after gap, capped per region', () => {
  const one = { parent: WRAP, siblings: ['section.group'], paths: [], gaps: [{ before: 14, after: 0 }] };
  assert.deepEqual(spacingLines([one]), [
    '',
    'Spacing between `section.group` siblings `14px` → `0px` _(measured between their rendered boxes)_',
  ]);
  assert.match(spacingLines(Array(7).fill(one))[1], /…and 2 more spacing change\(s\)/);
  assert.deepEqual(spacingLines([]), []);
});
