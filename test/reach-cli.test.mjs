import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { reachKey } from '../dist/reach-ledger.js';
const corpus = JSON.parse(fs.readFileSync('bench/reach-corpus.json'));
const run = (input, ledger = '', expectedStatus = 1) => {
  const result = spawnSync(
    process.execPath,
    ['bin/styleproof.mjs', 'reach', '--json', ...(input ? [] : ['bench/reach-corpus.results.json'])],
    {
      encoding: 'utf8',
      input: input && JSON.stringify(input),
      env: { ...process.env, STYLEPROOF_REACH: ledger },
    },
  );
  assert.equal(result.status, expectedStatus, result.stderr);
  return JSON.parse(result.stdout);
};
test('reach --json names the guarding condition for every unreached reach-corpus case', () => {
  const output = run();
  const actual = Object.groupBy(output.units, (r) => `${r.case}/${r.scenario}`);
  const expected = {};
  for (const c of corpus.cases)
    for (const [scenario, value] of Object.entries(c.expect))
      if (value.remedy) expected[`${c.id}/${scenario}`] = value.remedy;
  assert.equal(Object.keys(expected).length, 27);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [pair, remedy] of Object.entries(expected))
    assert.deepEqual(
      actual[pair].map((r) => [r.key, r.guardingCondition, r.enclosingSurfaces, r.guard.armRanOn ?? null]),
      remedy,
    );
  for (const [id, condition] of [
    ['dark-mode', '@media (prefers-color-scheme: dark)'],
    ['wide-media', '@media (min-width: 1440px)'],
    ['ternary-arm', "app.jsx:62 !(status === 'ok')"],
    ['fault-rule', 'app.jsx:88 probe.fault'],
  ])
    assert.equal(actual[`${id}/declared`][0].guardingCondition, condition);
});
test('reach --json derives guards instead of echoing supplied ones', () => {
  const output = run({
    units: [
      {
        kind: 'css',
        key: '@media (min-width: 1440px) > .panel',
        condition: '@media (min-width: 1440px)',
        status: 'never-rendered',
        change: 'changed',
        guardingCondition: 'fault',
        enclosingSurfaces: ['bogus'],
      },
    ],
    remediation: { scenarios: { s: ['home'] }, ledger: { head: { home: ['.panel'] } }, sources: {}, execution: {} },
    scenario: 's',
  });
  assert.equal(output.units[0].guardingCondition, '@media (min-width: 1440px)');
  assert.deepEqual(output.units[0].enclosingSurfaces, ['home']);
});
test('reach --json audits acknowledgements against derived unreached keys', () => {
  const row = run().units.find((r) => r.case === 'ternary-arm' && r.scenario === 'declared');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-reach-ack-'));
  const ledger = path.join(dir, 'styleproof.reach.json');
  try {
    fs.writeFileSync(
      ledger,
      JSON.stringify({ [row.reachKey]: 'Reviewed join', [reachKey('stale.js', 'stale')]: 'Old' }),
    );
    const output = run(null, ledger, 1);
    assert.equal(output.units.find((r) => r.reachKey === row.reachKey).acknowledged, true);
    assert.ok(!output.audit.unacknowledged.includes(row.reachKey));
    assert.equal(output.audit.staleAcknowledgements.length, 1);
    assert.equal(output.audit.passed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
