import assert from 'node:assert/strict';
import test from 'node:test';
import { referencedPaths, selectUnitTests } from '../scripts/affected-unit-tests.mjs';

const files = new Map([
  ['test/capture.test.mjs', "import { capture } from '../dist/capture.js';"],
  ['test/cli.test.mjs', "const bin = '../bin/styleproof.mjs';"],
  ['test/report.test.mjs', "import { render } from '../dist/report/render.js';"],
  ['dist/capture.js', "import { canon } from './canonicalize.js';"],
  ['dist/canonicalize.js', 'export const canon = 1;'],
  ['dist/report/render.js', "import { canon } from '../canonicalize.js';"],
  ['bin/styleproof.mjs', "import { capture } from '../dist/capture.js';"],
]);
const read = (file) => files.get(file) ?? '';
const tests = ['test/capture.test.mjs', 'test/cli.test.mjs', 'test/report.test.mjs'];
const select = (changed) => selectUnitTests({ changed, tests, read });

test('relative specifiers resolve against the importing file', () => {
  assert.deepEqual(referencedPaths('dist/report/render.js', read('dist/report/render.js')), ['dist/canonicalize.js']);
  assert.deepEqual(referencedPaths('test/cli.test.mjs', read('test/cli.test.mjs')), ['bin/styleproof.mjs']);
});

test('a changed source selects every test that reaches its build output, directly or through imports', () => {
  assert.deepEqual(select(['src/capture.ts']), { mode: 'some', files: ['test/capture.test.mjs', 'test/cli.test.mjs'] });
  assert.deepEqual(select(['src/canonicalize.ts']), { mode: 'some', files: tests });
});

test('a changed test file selects itself', () => {
  assert.deepEqual(select(['test/report.test.mjs']), { mode: 'some', files: ['test/report.test.mjs'] });
});

test('docs-only changes run no unit tests', () => {
  assert.deepEqual(select(['README.md', 'docs/quality-gates.md']), { mode: 'none', files: [] });
});

test('shared inputs, test helpers and unmapped code run the whole suite', () => {
  for (const changed of [
    ['package.json'],
    ['pnpm-lock.yaml'],
    ['tsconfig.json'],
    ['test/helpers.mjs'],
    ['src/unused.ts'],
  ]) {
    assert.equal(select(changed).mode, 'all', changed[0]);
  }
});
