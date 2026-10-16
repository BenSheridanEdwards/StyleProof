import assert from 'node:assert/strict';
import test from 'node:test';
import { describeChange, trackCount } from '../dist/describe.js';
import { summarizeProps } from '../dist/change-groups.js';

test('trackCount ignores named grid lines', () => {
  assert.equal(trackCount('[full-start] 100px [content-start] 200px [content-end full-end]'), 2);
  assert.equal(trackCount('[a] 100px [b] 100px [c] 100px [d]'), 3);
  assert.equal(trackCount('100px 200px'), 2);
});

test('adding grid line names is not described as a column-count change', () => {
  const props = summarizeProps([
    {
      prop: 'grid-template-columns',
      before: '100px 200px',
      after: '[full-start] 100px [content-start] 200px [content-end full-end]',
    },
  ]);
  assert.deepEqual(describeChange([{ label: 'div.layout', props }]), []);
});
