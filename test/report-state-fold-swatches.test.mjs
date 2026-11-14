import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sections from '../dist/report/change-sections.js';

test('resting CSS folds longhands and labels color followers', () => {
  const props = [
    'color',
    'caret-color',
    ...['top', 'right', 'bottom', 'left'].map((side) => `border-${side}-color`),
  ].map((prop) => ({ prop, before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' }));
  assert.equal(typeof sections.cssRows, 'function');
  const rows = sections.cssRows([{ kind: 'style', path: 'p', props }]);
  assert.equal(rows[0][0], '`color`');
  assert.match(JSON.stringify(rows), /follows `color`/);
});
