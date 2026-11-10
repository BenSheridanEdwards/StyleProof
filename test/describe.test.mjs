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

test('a low-signal property is named only when it is all that changed', () => {
  const el = (props) => ({ label: 'p.lead', props });
  const family = { prop: 'font-family', before: 'serif', after: 'sans-serif' };
  assert.deepEqual(describeChange([el([family])]), ['**`p.lead`** — font-family serif → sans-serif']);
  assert.deepEqual(
    describeChange([el([family, { prop: 'line-height', before: '20px', after: '24px' }])]),
    ['**`p.lead`** — line-height 20px → 24px'],
    'beside a real change it stays in the table only',
  );
});
