import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionIn, indexScriptSources } from '../dist/script-join-index.js';

const index = (executed) =>
  indexScriptSources([
    { source: 'app.ts', sourceKey: 'app.ts', encoding: 'line-column-tuples', executed, unexecuted: [], mixed: [] },
  ]);

test('column-zero evidence discloses line scope when a changed range spans JavaScript lines', () => {
  const evidence = index([
    [1, 0, 0],
    [2, 0, 0],
  ]);
  const result = executionIn({ start: { line: 1, column: 0 }, end: { line: 2, column: 12 } }, evidence);
  assert.deepEqual(result, { execution: 'ran', scope: 'line' });
});

test('a column-zero anchor at an exclusive ending line does not broaden the changed range scope', () => {
  const evidence = index([
    [1, 4, 4],
    [2, 0, 0],
  ]);
  const result = executionIn({ start: { line: 1, column: 4 }, end: { line: 2, column: 0 } }, evidence);
  assert.deepEqual(result, { execution: 'ran', scope: 'range' });
});

test('a multiline trimmed range cannot infer entry from a preceding coarse start', () => {
  const evidence = index([[1, 0, 0]]);
  const result = executionIn({ start: { line: 1, column: 4 }, end: { line: 2, column: 12 } }, evidence);
  assert.equal(result.execution, 'unmeasured');
  assert.equal(result.scope, 'line');
  assert.match(result.why, /preceding anchor ran but cannot prove this code ran/);
});
