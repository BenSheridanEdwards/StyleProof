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
    reason: 'mismatch',
    requiredRuns: 5,
    observedRuns: 5,
    matchingRuns: 4,
    runs: [stable, stable, stable, stable, drifted],
    diagnostics: ['expected all 5 runs to match, largest matching group was 4'],
  });
});

test('canonical map hashes ignore object insertion order', () => {
  const left = styleproof.hashDeterminismMap?.({ b: 2, nested: { z: 1, a: 3 }, a: 1 });
  const right = styleproof.hashDeterminismMap?.({ a: 1, nested: { a: 3, z: 1 }, b: 2 });

  assert.equal(typeof left, 'string');
  assert.match(left ?? '', /^[a-f0-9]{64}$/);
  assert.equal(left, right);
});

test('any run count other than exactly five is a flake', () => {
  const run = {
    stateKeys: ['demo@900'],
    mapHashes: { 'demo@900': 'a'.repeat(64) },
  };

  for (const observedRuns of [0, 1, 2, 3, 4, 6]) {
    const runs = Array.from({ length: observedRuns }, () => run);
    const verdict = styleproof.assessDeterminismOracle?.(runs);

    assert.deepEqual(verdict, {
      status: 'flake',
      reason: 'run-count',
      requiredRuns: 5,
      observedRuns,
      matchingRuns: observedRuns,
      runs,
      diagnostics: [`expected exactly 5 runs, received ${observedRuns}`],
    });
  }
});

test('malformed receipts fail closed without throwing', () => {
  const valid = {
    stateKeys: ['demo@900'],
    mapHashes: { 'demo@900': 'a'.repeat(64) },
  };
  const throwingReceipt = Object.defineProperty({}, 'stateKeys', {
    get() {
      throw new Error('hostile getter');
    },
  });
  const symbolMapHashes = { 'demo@900': 'a'.repeat(64) };
  symbolMapHashes[Symbol('extra')] = 'b'.repeat(64);
  const malformed = [
    {},
    null,
    throwingReceipt,
    { stateKeys: ['demo@900', 'demo@900'], mapHashes: { 'demo@900': 'a'.repeat(64) } },
    { stateKeys: ['demo@900'], mapHashes: {} },
    { stateKeys: ['demo@900'], mapHashes: { 'demo@900': 'a'.repeat(64), extra: 'b'.repeat(64) } },
    { stateKeys: ['demo@900'], mapHashes: symbolMapHashes },
    { stateKeys: ['demo@900'], mapHashes: { 'demo@900': 'not-a-sha256' } },
  ];

  for (const badRun of malformed) {
    const runs = [valid, valid, valid, valid, badRun];
    const verdict = styleproof.assessDeterminismOracle?.(runs);
    assert.equal(verdict?.status, 'flake');
    assert.equal(verdict?.reason, 'invalid-receipt');
    assert.equal(verdict?.observedRuns, 5);
    assert.equal(verdict?.matchingRuns, 4);
    assert.ok(verdict?.diagnostics.length);
  }
});

test('receipt comparison ignores map hash insertion order but preserves ordered state keys', () => {
  const left = {
    stateKeys: ['a@900', 'b@900'],
    mapHashes: { 'a@900': 'a'.repeat(64), 'b@900': 'b'.repeat(64) },
  };
  const equivalent = {
    stateKeys: ['a@900', 'b@900'],
    mapHashes: { 'b@900': 'b'.repeat(64), 'a@900': 'a'.repeat(64) },
  };

  assert.equal(styleproof.assessDeterminismOracle?.([left, left, left, left, equivalent]).status, 'deterministic');

  const reorderedStates = {
    stateKeys: ['b@900', 'a@900'],
    mapHashes: equivalent.mapHashes,
  };
  const flake = styleproof.assessDeterminismOracle?.([left, left, left, left, reorderedStates]);
  assert.equal(flake.status, 'flake');
  assert.equal(flake.reason, 'mismatch');
  assert.equal(flake.matchingRuns, 4);
});

test('canonical map hashing preserves __proto__ data and rejects non-JSON-safe values', () => {
  const withProtoData = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  assert.notEqual(styleproof.hashDeterminismMap?.(withProtoData), styleproof.hashDeterminismMap?.({ a: 1 }));

  for (const value of [
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    Array(2),
    new Date('2026-08-19T00:00:00.000Z'),
  ]) {
    assert.throws(() => styleproof.hashDeterminismMap?.(value), /JSON-safe/);
  }

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => styleproof.hashDeterminismMap?.(cyclic), /JSON-safe/);
});
