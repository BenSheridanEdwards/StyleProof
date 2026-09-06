import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyE2eShards } from '../scripts/verify-e2e-shards.mjs';

function fixture() {
  const knownTest = {
    id: 'unsupported-state',
    file: 'test/cross-element-state.e2e.spec.ts',
    title: 'non-Chromium capture persists unsupported forced-state evidence',
  };
  const report = (specs, current) => ({
    errors: [],
    config: { shard: { current, total: 2 } },
    suites: [
      {
        specs: specs.map(
          ({
            id,
            file = `test/${id}.e2e.spec.ts`,
            title = id,
            projectName = 'chromium',
            expectedStatus = 'passed',
            status = 'expected',
            resultStatus = 'passed',
          }) => ({
            id,
            file,
            line: 1,
            column: 1,
            title,
            tests: [{ projectName, expectedStatus, status, results: [{ status: resultStatus }] }],
          }),
        ),
      },
    ],
  });
  const shards = [
    report(
      [
        { id: 'first' },
        {
          ...knownTest,
          expectedStatus: 'skipped',
          status: 'skipped',
          resultStatus: 'skipped',
        },
      ],
      1,
    ),
    report([{ id: 'second' }, { ...knownTest, projectName: 'firefox-unsupported-state' }], 2),
  ];
  const expected = { errors: [], suites: structuredClone(shards.flatMap((shard) => shard.suites)) };
  const receipts = [
    {
      schemaVersion: 1,
      fixture: 'state-recipes-capture',
      runLabels: ['maps-1', 'maps-2', 'maps-3', 'maps-4', 'maps-5'],
      verdict: {
        status: 'deterministic',
        requiredRuns: 5,
        observedRuns: 5,
        matchingRuns: 5,
        stateKeys: ['demo@900'],
        mapHashes: { 'demo@900': 'a'.repeat(64) },
      },
    },
  ];
  return structuredClone({ expected, shards, receipts });
}

test('two successful shards cover the complete inventory and preserve the oracle', () => {
  const { expected, shards, receipts } = fixture();
  assert.deepEqual(verifyE2eShards(expected, shards, receipts), {
    shards: 2,
    collected: 4,
    passed: 3,
    skipped: 1,
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
      f.shards[1].suites[0].specs[0] = structuredClone(f.shards[0].suites[0].specs[0]);
    },
    /duplicate executed/,
  ],
  [
    'unexpected test',
    (f) => {
      f.shards[1].suites[0].specs[0].title = 'extra';
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
    'self-declared unexpected skip',
    (f) => {
      const test = f.shards[0].suites[0].specs[0].tests[0];
      test.expectedStatus = 'skipped';
      test.status = 'skipped';
      test.results[0].status = 'skipped';
    },
    /non-passing expectation/,
  ],
  [
    'allowed skip with changed file identity',
    (f) => {
      f.shards[0].suites[0].specs[1].file = 'test/lookalike.e2e.spec.ts';
    },
    /non-passing expectation/,
  ],
  [
    'missing Firefox regression from collected inventory',
    (f) => {
      f.expected.suites[1].specs.pop();
    },
    /exact Chromium exclusion and Firefox regression/,
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
  [
    'incomplete oracle map evidence',
    (f) => {
      f.receipts[0].verdict.mapHashes = {};
    },
    /incomplete oracle map hashes/,
  ],
  [
    'invalid oracle map hash',
    (f) => {
      f.receipts[0].verdict.mapHashes['demo@900'] = 'not-a-sha256';
    },
    /invalid oracle map hash/,
  ],
]) {
  test(`shard evidence rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => verifyE2eShards(f.expected, f.shards, f.receipts), error);
  });
}
