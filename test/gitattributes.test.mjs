import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('CHANGELOG union driver documents local merges and GitHub limitations', () => {
  const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  const comments = attributes
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .join(' ');

  assert.match(attributes, /^CHANGELOG\.md merge=union$/m);
  assert.doesNotMatch(comments, /GitHub hono(?:u)?rs it for the merge button/i);
  assert.match(comments, /local merges only/i);
  assert.match(comments, /GitHub's (?:PR )?conflict check ignores (?:it|the union driver)/i);
});
