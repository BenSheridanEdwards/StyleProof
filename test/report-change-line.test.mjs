import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeLine } from '../dist/report/change-line.js';
const subject = { tag: 'div', cls: 'card', path: 'div', texts: [], count: 1, sameSelectorCount: 1 };
test('resting padding and shared size', () => {
  assert.equal(
    changeLine({
      subject: { ...subject, count: 3, sameSelectorCount: 3 },
      rest: [{ prop: 'padding', before: '16px', after: '24px' }],
      size: { dw: 0, dh: 16 },
    }),
    'All 3 cards change padding from `16px` to `24px`. Each is now 16px taller.',
  );
});
test('structural resting sentences', () => {
  for (const [extra, expected] of [
    [{ geometryOnly: true }, 'changes size/position only, no styling property changed'],
    [{ dom: 'added' }, 'is new on the page'],
    [{ dom: 'removed' }, 'is gone from the page'],
  ]) {
    assert.equal(changeLine({ subject, rest: [], ...extra }), `The card ${expected}.`);
  }
});
test('colour words require two close names', () => {
  const line = (before, after) => changeLine({ subject, rest: [{ prop: 'color', before, after }] });
  assert.equal(line('#000000', '#ffffff'), 'The card changes text colour from black to white.');
  assert.match(line('#a5f3fc', '#ffffff'), /`#a5f3fc` to `#ffffff`/);
});
