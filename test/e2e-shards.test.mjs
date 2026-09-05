import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyE2eShards } from '../scripts/verify-e2e-shards.mjs';

function fixture() {
  const report = (id, current) => ({
    errors: [],
    config: { shard: { current, total: 2 } },
    suites: [
      {
        specs: [
          {
            id,
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'expected',
                results: [{ status: 'passed' }],
              },
            ],
          },
        ],
      },
    ],
  });
  const shards = [report('first', 1), report('second', 2)];
  const expected = { errors: [], suites: structuredClone(shards.flatMap((shard) => shard.suites)) };
  const receipts = [
    {
      schemaVersion: 1,
      fixture: 'state-recipes-capture',
      verdict: { status: 'deterministic', requiredRuns: 5, observedRuns: 5, matchingRuns: 5 },
    },
  ];
  return structuredClone({ expected, shards, receipts });
}

test('two successful shards cover the complete inventory and preserve the oracle', () => {
  const { expected, shards, receipts } = fixture();
  assert.deepEqual(verifyE2eShards(expected, shards, receipts), {
    shards: 2,
    collected: 2,
    passed: 2,
    oracle: 'deterministic',
  });
});

for (const [name, mutate, error] of [
  ['missing shard', (f) => f.shards.pop(), /two browser shards/],
  [
    'wrong shard identity',
    (f) => {
      f.shards[1].config.shard.current = 1;
    },
    /mismatched shard/,
  ],
  [
    'omitted test',
    (f) => {
      f.shards[1].suites = [];
    },
    /differ from full inventory/,
  ],
  [
    'duplicate test',
    (f) => {
      f.shards[1].suites[0].specs[0].id = 'first';
    },
    /duplicate executed/,
  ],
  [
    'unexpected test',
    (f) => {
      f.shards[1].suites[0].specs[0].id = 'extra';
    },
    /differ from full inventory/,
  ],
  [
    'skipped result',
    (f) => {
      f.shards[0].suites[0].specs[0].tests[0].results[0].status = 'skipped';
    },
    /did not pass/,
  ],
  [
    'failed test',
    (f) => {
      f.shards[0].suites[0].specs[0].tests[0].status = 'unexpected';
    },
    /unsuccessful/,
  ],
  [
    'retried test',
    (f) => {
      f.shards[0].suites[0].specs[0].tests[0].results.push({ status: 'passed' });
    },
    /retried result/,
  ],
  [
    'interrupted report',
    (f) => {
      f.shards[0].errors.push({ message: 'interrupted' });
    },
    /report contains errors/,
  ],
  [
    'missing oracle',
    (f) => {
      f.receipts = [];
    },
    /missing or duplicate determinism/,
  ],
  [
    'duplicate oracle',
    (f) => {
      f.receipts.push(f.receipts[0]);
    },
    /missing or duplicate determinism/,
  ],
  [
    'non-deterministic oracle',
    (f) => {
      f.receipts[0].verdict.status = 'flake';
    },
    /did not prove determinism/,
  ],
  [
    'incomplete oracle',
    (f) => {
      f.receipts[0].verdict.observedRuns = 4;
    },
    /invalid oracle observedRuns/,
  ],
]) {
  test(`shard evidence rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => verifyE2eShards(f.expected, f.shards, f.receipts), error);
  });
}
