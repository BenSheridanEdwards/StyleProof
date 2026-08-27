import test from 'node:test';
import assert from 'node:assert/strict';
import { assessProductStateComparability } from '../dist/diff.js';
import { makeMap } from './helpers.mjs';

function semanticMap(elements) {
  return makeMap({ semanticIdentityVersion: 1, elements });
}

const body = { tag: 'body', cls: '', ownTextLength: 0, style: {} };

test('product-state comparability fails closed when data-style landmarks diverge', () => {
  const before = semanticMap({
    body,
    'body > section': {
      tag: 'section',
      cls: 'guardian',
      ownTextLength: 0,
      style: {},
      semantic: { dataStyleHashes: ['c1', 'a1'] },
    },
  });
  const after = semanticMap({
    body,
    'body > section': {
      tag: 'section',
      cls: 'guardian',
      ownTextLength: 0,
      style: {},
      semantic: { dataStyleHashes: ['c1', 'b1'] },
    },
  });

  assert.deepEqual(assessProductStateComparability(before, after), {
    status: 'incomparable',
    reasons: [
      {
        kind: 'data-style',
        beforeOnly: ['a1'],
        afterOnly: ['b1'],
      },
    ],
  });
});

test('product-state comparability fails closed when semantic role inventory diverges', () => {
  const before = semanticMap({
    body,
    'body > div': { tag: 'div', cls: '', ownTextLength: 0, style: {}, semantic: { roleHash: 'r1' } },
  });
  const after = semanticMap({
    body,
    'body > div': { tag: 'div', cls: '', ownTextLength: 0, style: {}, semantic: { roleHash: 'r2' } },
  });

  assert.deepEqual(assessProductStateComparability(before, after), {
    status: 'incomparable',
    reasons: [
      {
        kind: 'role',
        beforeOnly: ['r1×1'],
        afterOnly: ['r2×1'],
      },
    ],
  });
});

test('product-state comparability is unknown for legacy maps without a semantic identity version', () => {
  assert.deepEqual(assessProductStateComparability(makeMap(), makeMap()), {
    status: 'unknown',
    reasons: [{ kind: 'legacy-map' }],
  });
});

test('product-state comparability rejects a legacy/new capture-schema mismatch', () => {
  assert.deepEqual(assessProductStateComparability(makeMap(), semanticMap({ body })), {
    status: 'incomparable',
    reasons: [{ kind: 'capture-schema-mismatch' }],
  });
});

test('product-state comparability labels unsupported future schemas without calling them legacy', () => {
  const future = makeMap({ semanticIdentityVersion: 2 });
  assert.deepEqual(assessProductStateComparability(future, future), {
    status: 'unknown',
    reasons: [{ kind: 'unsupported-semantic-schema' }],
  });
});

test('product-state comparability rejects malformed semantic metadata without echoing it', () => {
  const hostile = '<script>alert(1)</script>';
  const before = semanticMap({
    body,
    'body > div': {
      tag: 'div',
      cls: '',
      ownTextLength: 0,
      style: {},
      semantic: { dataStyleHashes: [hostile] },
    },
  });
  const after = semanticMap({ body });

  const result = assessProductStateComparability(before, after);
  assert.deepEqual(result, {
    status: 'incomparable',
    reasons: [{ kind: 'invalid-semantic', side: 'before' }],
  });
  assert.doesNotMatch(JSON.stringify(result), /script|alert/);
});

test('product-state comparability accepts equal semantic inventories despite path movement', () => {
  const before = semanticMap({
    body,
    'body > div:nth-child(1)': {
      tag: 'div',
      cls: '',
      ownTextLength: 0,
      style: {},
      semantic: { roleHash: 'r1', dataStyleHashes: ['c1', 'b1'] },
    },
  });
  const after = semanticMap({
    body,
    'body > main > div:nth-child(2)': {
      tag: 'div',
      cls: '',
      ownTextLength: 0,
      style: {},
      semantic: { roleHash: 'r1', dataStyleHashes: ['b1', 'c1'] },
    },
  });

  assert.deepEqual(assessProductStateComparability(before, after), { status: 'comparable', reasons: [] });
});
