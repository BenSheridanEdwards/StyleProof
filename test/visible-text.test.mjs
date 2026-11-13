import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleText } from './visible-text.mjs';

test('visible text skips hidden blocks and decodes entities once', () => {
  assert.equal(visibleText('<SCRIPT>hidden</SCRIPT><p>Shown</p>'), 'Shown');
  assert.equal(visibleText('<scr<script>ipt>hidden</script><p>Shown</p>'), 'Shown');
  assert.equal(visibleText('A<!-- multi\nline -->B'), 'AB');
  assert.equal(visibleText('&amp;lt;'), '&lt;');
  assert.equal(visibleText('<p>Review <strong>one</strong> &amp; two.</p>'), 'Review one & two.');
});
