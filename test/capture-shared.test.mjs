import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipSelector } from '../dist/capture/shared.js';

test('skipSelector: a selector-list entry skips the descendants of every selector in it (#981)', () => {
  // `.ticker, .clock *` would only reach children of .clock; the descendant
  // clause must group the whole list so children of .ticker are skipped too.
  assert.equal(skipSelector(['.ticker, .clock']), '.ticker, .clock, :is(.ticker, .clock) *');
});

test('skipSelector: nothing ignored is the empty selector', () => {
  assert.equal(skipSelector([]), '');
});
