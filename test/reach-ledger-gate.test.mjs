import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleReachKey } from '../dist/reach-ledger.js';
test('declaration edits invalidate range acknowledgements', () => {
  const row = { key: '.panel', sheet: '/app.css', hash: 'old' };
  assert.notEqual(ruleReachKey(row), ruleReachKey({ ...row, hash: 'new' }));
  assert.equal(ruleReachKey({ key: '.panel', hash: 'old' }), undefined);
});
