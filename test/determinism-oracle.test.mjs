import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as styleproof from '../dist/index.js';

test('five identical capture receipts produce a deterministic 5/5 oracle verdict', () => {
  const run = {
    stateKeys: ['demo@900', 'demo-focus-email@900'],
    mapHashes: {
      'demo@900': 'a'.repeat(64),
      'demo-focus-email@900': 'b'.repeat(64),
    },
  };

  const verdict = styleproof.assessDeterminismOracle?.([run, run, run, run, run]);

  assert.deepEqual(verdict, {
    status: 'deterministic',
    requiredRuns: 5,
    observedRuns: 5,
    matchingRuns: 5,
    stateKeys: run.stateKeys,
    mapHashes: run.mapHashes,
  });
});

test('four matching receipts and one divergent receipt produce an explicit flake verdict', () => {
  const stable = {
    stateKeys: ['demo@900'],
    mapHashes: { 'demo@900': 'a'.repeat(64) },
  };
  const drifted = {
    stateKeys: ['demo@900'],
    mapHashes: { 'demo@900': 'b'.repeat(64) },
  };

  const verdict = styleproof.assessDeterminismOracle?.([stable, stable, stable, stable, drifted]);

  assert.deepEqual(verdict, {
    status: 'flake',
    requiredRuns: 5,
    observedRuns: 5,
    matchingRuns: 4,
    runs: [stable, stable, stable, stable, drifted],
  });
});

test('canonical map hashes ignore object insertion order', () => {
  const left = styleproof.hashDeterminismMap?.({ b: 2, nested: { z: 1, a: 3 }, a: 1 });
  const right = styleproof.hashDeterminismMap?.({ a: 1, nested: { a: 3, z: 1 }, b: 2 });

  assert.equal(typeof left, 'string');
  assert.match(left ?? '', /^[a-f0-9]{64}$/);
  assert.equal(left, right);
});

test('fewer than five matching receipts produce an explicit insufficient verdict', () => {
  const run = {
    stateKeys: ['demo@900'],
    mapHashes: { 'demo@900': 'a'.repeat(64) },
  };

  const verdict = styleproof.assessDeterminismOracle?.([run, run, run, run]);

  assert.deepEqual(verdict, {
    status: 'insufficient',
    requiredRuns: 5,
    observedRuns: 4,
    matchingRuns: 4,
    runs: [run, run, run, run],
  });
});
