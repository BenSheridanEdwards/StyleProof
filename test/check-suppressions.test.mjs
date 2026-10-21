import assert from 'node:assert/strict';
import test from 'node:test';
import { findSuppressions } from '../scripts/check-suppressions.mjs';

// Assembled from fragments so this tracked file never holds a bare suppression
// comment that the real check would flag.
const disable = (rest) => `// eslint-${'disable'}${rest}`;
const ts = (rest) => `// @ts-${rest}`;

const kinds = (text) => findSuppressions(text).map(({ line, kind }) => [line, kind]);

test('an ESLint disable with its rules and a reason passes', () => {
  assert.deepEqual(kinds(disable('-next-line no-console -- tests spy on the warning channel')), []);
  assert.deepEqual(kinds(`/* eslint-${'disable'} no-console -- these tests spy on capture warnings */`), []);
  assert.deepEqual(kinds(`x(); ${disable('-line no-control-regex -- browsers strip these from a scheme')}`), []);
});

test('an ESLint disable without a reason, or with a token one, fails', () => {
  assert.deepEqual(kinds(disable('-next-line no-console')), [[1, 'eslint-reason']]);
  assert.deepEqual(kinds(disable('-next-line no-empty-pattern -- as above.')), [[1, 'eslint-reason']]);
  assert.deepEqual(kinds(`ok();\n/* eslint-${'disable'} no-console */`), [[2, 'eslint-reason']]);
});

test('an ESLint disable that names no rule fails', () => {
  assert.deepEqual(kinds(disable('-next-line')), [[1, 'eslint-rules']]);
  assert.deepEqual(kinds(disable(' -- turn everything off here')), [[1, 'eslint-rules']]);
});

test('inline ESLint rule config fails; prose that mentions eslint does not', () => {
  assert.deepEqual(kinds(`/* ${'eslint'} no-console: "off" */`), [[1, 'eslint-config']]);
  assert.deepEqual(kinds(`/* ${'global'} window */`), [[1, 'eslint-config']]);
  assert.deepEqual(kinds('// eslint runs in CI on Node 22'), []);
  assert.deepEqual(kinds(`const rule = 'eslint-${'disable'}d-looking-name';`), []);
});

test('a type suppression must be a reasoned @ts-expect-error', () => {
  assert.deepEqual(kinds(ts('expect-error the upstream types omit this overload')), []);
  assert.deepEqual(kinds(ts('expect-error')), [[1, 'ts-reason']]);
  assert.deepEqual(kinds(ts('ignore because')), [[1, 'ts-ignore']]);
  assert.deepEqual(kinds(ts('nocheck')), [[1, 'ts-nocheck']]);
});
