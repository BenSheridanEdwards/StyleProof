import test from 'node:test';
import assert from 'node:assert/strict';
import { diffStyleMapDirs, summarizeComparability } from '../dist/diff.js';
import { assessComparisonTruth } from '../dist/change-groups.js';
import { makeMap, pairFixture, rmTmp, writeCapture } from './helpers.mjs';

const state = (id, revision = '1') => ({ metadata: { productState: { id, revision } } });
const scene = (color, metadata = undefined) => ({
  ...makeMap({
    elements: {
      'body > button:nth-child(1)': { tag: 'button', style: { color } },
    },
  }),
  ...(metadata ? { metadata } : {}),
});

test('same explicit product-state identity makes a style change comparable and reviewable', () => {
  const fixture = pairFixture({
    surface: 'checkout@1280',
    before: scene('black', state('checkout-ready').metadata),
    after: scene('red', state('checkout-ready').metadata),
  });
  const result = diffStyleMapDirs(fixture.beforeDir, fixture.afterDir);
  assert.deepEqual(result.comparability, [
    { surface: 'checkout@1280', status: 'comparable', required: true, reason: 'explicit-state-match' },
  ]);
  const truth = assessComparisonTruth(result.surfaces, result.counts, result.comparability);
  assert.equal(truth.reviewableCounts.style, 1);
  assert.equal(truth.incomparableSurfaces, 0);
  assert.equal(truth.unprovenSurfaces, 0);
  rmTmp(fixture.root);
});

test('different explicit product-state identities are incomparable and never reviewable', () => {
  const fixture = pairFixture({
    surface: 'checkout@1280',
    before: scene('black', state('checkout-loading').metadata),
    after: scene('red', state('checkout-ready').metadata),
  });
  const result = diffStyleMapDirs(fixture.beforeDir, fixture.afterDir);
  assert.equal(result.counts.style, 1, 'raw detector evidence remains visible');
  assert.deepEqual(result.comparability, [
    { surface: 'checkout@1280', status: 'incomparable', required: true, reason: 'explicit-state-mismatch' },
  ]);
  const truth = assessComparisonTruth(result.surfaces, result.counts, result.comparability);
  assert.equal(truth.reviewableCounts.style, 0);
  assert.equal(truth.hasReviewableEvidence, false);
  assert.equal(truth.incomparableSurfaces, 1);
  assert.equal(truth.unprovenSurfaces, 0);
  rmTmp(fixture.root);
});

test('asymmetric state identity is required but unproven; all-legacy identity is diagnostic unproven', () => {
  const fixture = pairFixture({
    surface: 'checkout@1280',
    before: scene('black'),
    after: scene('red', state('checkout-ready').metadata),
  });
  let result = diffStyleMapDirs(fixture.beforeDir, fixture.afterDir);
  assert.deepEqual(result.comparability, [
    { surface: 'checkout@1280', status: 'unproven', required: true, reason: 'state-identity-missing' },
  ]);
  let truth = assessComparisonTruth(result.surfaces, result.counts, result.comparability);
  assert.equal(truth.requiredUnprovenSurfaces, 1);
  assert.equal(truth.reviewableCounts.style, 0, 'one-sided declaration cannot create approval evidence');

  writeCapture(fixture.afterDir, 'checkout@1280', scene('red'), null);
  result = diffStyleMapDirs(fixture.beforeDir, fixture.afterDir);
  assert.deepEqual(result.comparability, [
    { surface: 'checkout@1280', status: 'unproven', required: false, reason: 'state-identity-missing' },
  ]);
  truth = assessComparisonTruth(result.surfaces, result.counts, result.comparability);
  assert.equal(
    truth.reviewableCounts.style,
    1,
    'legacy mode remains backward-compatible when identity is not required',
  );
  assert.equal(truth.globalRequiredUnprovenSurfaces, 0);
  const strictTruth = assessComparisonTruth(result.surfaces, result.counts, result.comparability, {
    requireStateIdentity: true,
  });
  assert.equal(strictTruth.reviewableCounts.style, 0);
  assert.equal(strictTruth.globalRequiredUnprovenSurfaces, 1);
  rmTmp(fixture.root);
});

test('malformed persisted product-state identity is required-unproven and receipt-safe', () => {
  const hostile = 'private[value=customer-secret]';
  const fixture = pairFixture({
    surface: 'checkout@1280',
    before: scene('black', { productState: { id: 'checkout-ready', revision: 'v1' } }),
    after: scene('red', { productState: { id: hostile, revision: 'v1', label: hostile } }),
  });
  const result = diffStyleMapDirs(fixture.beforeDir, fixture.afterDir);
  assert.deepEqual(result.comparability, [
    { surface: 'checkout@1280', status: 'unproven', required: true, reason: 'state-identity-invalid' },
  ]);
  assert.equal(JSON.stringify(result.comparability).includes(hostile), false);
  const truth = assessComparisonTruth(result.surfaces, result.counts, result.comparability);
  assert.equal(truth.requiredUnprovenSurfaces, 1);
  assert.equal(truth.reviewableCounts.style, 0);
  rmTmp(fixture.root);
});

test('one-sided surfaces have no comparison obligation', () => {
  const fixture = pairFixture({
    surface: 'home@1280',
    before: scene('black'),
    after: scene('black'),
  });
  writeCapture(fixture.afterDir, 'new-page@1280', scene('blue', state('new-page').metadata), null);
  const result = diffStyleMapDirs(fixture.beforeDir, fixture.afterDir);
  assert.deepEqual(
    result.comparability.find((entry) => entry.surface === 'new-page@1280'),
    {
      surface: 'new-page@1280',
      status: 'not-required',
      required: false,
      reason: 'missing-before',
    },
  );
  rmTmp(fixture.root);
});

test('unknown future comparability status fails closed and suppresses review evidence', () => {
  const receipt = { surface: 'checkout@1280', status: 'future-state', required: true };
  const summary = summarizeComparability([receipt]);
  assert.equal(summary.status, 'unproven');
  assert.equal(summary.blocksCertification, true);
  assert.equal(summary.counts.requiredUnproven, 1);

  const truth = assessComparisonTruth(
    [{ surface: 'checkout@1280', findings: [{ kind: 'style', path: 'button', pseudo: '', changes: [] }] }],
    { dom: 0, style: 1, state: 0 },
    [receipt],
  );
  assert.equal(truth.reviewableCounts.style, 0);
  assert.equal(truth.requiredUnprovenSurfaces, 1);
});
