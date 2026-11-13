import test from 'node:test';
import assert from 'node:assert/strict';
const helperUrl = new URL('./visible-text.mjs', import.meta.url);
const { visibleText } = await import(helperUrl.href);

test('visible text skips hidden blocks and decodes entities once', () => {
  assert.equal(visibleText('<SCRIPT>hidden</SCRIPT><p>Shown</p>'), 'Shown');
  assert.equal(visibleText('<scr<script>ipt>hidden</script><p>Shown</p>'), 'Shown');
  assert.equal(visibleText('A<!-- multi\nline -->B'), 'AB');
  assert.equal(visibleText('&amp;lt;'), '&lt;');
  assert.equal(visibleText('<p>Review <strong>one</strong> &amp; two.</p>'), 'Review one & two.');
});

test('report statements keep inline closing tags within the same sentence', () => {
  assert.equal(visibleText('<p>A <em>B</em> C</p>', { reportStatements: true }), '\nA B C\n');
});
