import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RequiredStateComparisonError,
  parseRequiredStateComparisons,
  auditRequiredStateComparisons,
} from '../dist/required-state-comparisons.js';
import { tmpDirs, writeCapture, makeMap, rmTmp } from './helpers.mjs';

const requirement = {
  surface: 'dashboard-seat-visible',
  productState: { id: 'seat:visible', revision: 'fixture-v1' },
  owner: 'ui-platform',
  reason: 'The assigned seat must be represented in this state.',
};
const map = (surface, productState) => ({
  ...makeMap({ elements: { body: { style: { color: 'rgb(0, 0, 0)' } } } }),
  metadata: {
    ...(surface === undefined ? {} : { surfaceKey: surface }),
    ...(productState === undefined ? {} : { productState }),
  },
});
function dirsWith(before = [], after = []) {
  const dirs = tmpDirs();
  for (const entry of before) writeCapture(dirs.beforeDir, entry.key, map(entry.surface, entry.state), null);
  for (const entry of after) writeCapture(dirs.afterDir, entry.key, map(entry.surface, entry.state), null);
  return dirs;
}
const exact = (key = `${requirement.surface}@1440`) => ({
  key,
  surface: requirement.surface,
  state: requirement.productState,
});

test('required state declarations are closed-world, bounded, and copied', () => {
  const parsed = parseRequiredStateComparisons([requirement]);
  assert.deepEqual(parsed, [requirement]);
  assert.notEqual(parsed[0], requirement);
  assert.notEqual(parsed[0].productState, requirement.productState);
  for (const value of [
    'not-an-array',
    [{}],
    [{ ...requirement, extra: true }],
    [{ ...requirement, surface: 'dashboard@1440' }],
    [{ ...requirement, owner: '' }],
    [{ ...requirement, reason: '   ' }],
    [requirement, { ...requirement }],
  ])
    assert.throws(() => parseRequiredStateComparisons(value), RequiredStateComparisonError);
});

test('required state arrays reject sparse indices, accessors, symbols, and extra properties without invoking getters', () => {
  let getterCalls = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return requirement;
    },
  });
  accessor.length = 1;
  assert.throws(() => parseRequiredStateComparisons(accessor), RequiredStateComparisonError);
  assert.equal(getterCalls, 0);

  const sparse = new Array(1);
  assert.throws(() => parseRequiredStateComparisons(sparse), RequiredStateComparisonError);

  const extra = [requirement];
  extra.policy = 'shadow';
  assert.throws(() => parseRequiredStateComparisons(extra), RequiredStateComparisonError);

  const symbolic = [requirement];
  symbolic[Symbol('policy')] = 'shadow';
  assert.throws(() => parseRequiredStateComparisons(symbolic), RequiredStateComparisonError);
});

test('required state public metadata rejects controls, markup, credential markers, and token-like values', () => {
  for (const patch of [
    { reason: 'line one\nline two' },
    { reason: '**rendered as emphasis**' },
    { reason: '<script>alert(1)</script>' },
    { reason: 'Authorization Bearer public receipt' },
    { reason: `opaque ${'a'.repeat(40)}` },
    { owner: 'api_token' },
    { owner: `opaque_${'z'.repeat(40)}` },
    { owner: 'jake.hunter' },
    { reason: 'Contact Jake Hunter at jake@example.com' },
    { reason: 'Escalate using 123-45-6789' },
    { reason: 'Call +44 7700 900123' },
    { reason: 'Ask jane.smith for approval' },
    { reason: 'Review https://internal.example/users/jane' },
    { reason: ['See ', '/', 'Users', '/jane.smith/private/roadmap'].join('') },
    { reason: ['See file:', '//', '/Users', '/jane.smith/private/roadmap'].join('') },
    { reason: ['See C:', '\\', 'Users\\jane.smith\\private\\roadmap'].join('') },
  ]) {
    assert.throws(() => parseRequiredStateComparisons([{ ...requirement, ...patch }]), RequiredStateComparisonError);
  }
});

test('required state audit certifies exact metadata identity across width-normalized surfaces', () => {
  const dirs = dirsWith([exact()], [exact()]);
  try {
    assert.deepEqual(auditRequiredStateComparisons(dirs.beforeDir, dirs.afterDir, [requirement]), {
      status: 'satisfied',
      blocksCertification: false,
      counts: { declared: 1, satisfied: 1, unsatisfied: 0 },
      receipts: [{ ...requirement, status: 'satisfied', failures: [] }],
    });
  } finally {
    rmTmp(dirs.root);
  }
});

test('required state audit fails closed for missing, wrong-surface, wrong-revision, and unshared evidence', () => {
  const cases = [
    [[], [], 'missing-both'],
    [[], [exact()], 'missing-base'],
    [[exact()], [], 'missing-head'],
    [[{ ...exact(), surface: 'other' }], [{ ...exact(), surface: 'other' }], 'wrong-surface'],
    [
      [{ ...exact(), state: { ...requirement.productState, revision: 'v2' } }],
      [{ ...exact(), state: { ...requirement.productState, revision: 'v2' } }],
      'wrong-revision',
    ],
    [[exact('dashboard-seat-visible@1280')], [exact('dashboard-seat-visible@1440')], 'no-shared-capture-key'],
    [[{ ...exact(), surface: undefined }], [{ ...exact(), surface: undefined }], 'surface-metadata-missing'],
  ];
  for (const [before, after, reason] of cases) {
    // diffStyleMapDirs requires at least one map on each side; add an unrelated comparable control.
    const control = { key: 'control@1440', surface: 'control', state: { id: 'control', revision: '1' } };
    const dirs = dirsWith([control, ...before], [control, ...after]);
    try {
      const result = auditRequiredStateComparisons(dirs.beforeDir, dirs.afterDir, [requirement]);
      assert.equal(result.status, 'unsatisfied');
      assert.equal(result.blocksCertification, true);
      assert.deepEqual(result.receipts[0].failures, [reason]);
    } finally {
      rmTmp(dirs.root);
    }
  }
});
