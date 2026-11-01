import assert from 'node:assert/strict';
import test from 'node:test';
import {
  flagOf,
  autoLabel,
  aggregate,
  verdict,
  assertAggregateOnly,
  privateOutOk,
  selectPairs,
} from '../bench/reach-noise-lib.mjs';

test('flags follow the three joins, excluding unknown and blind evidence', () => {
  for (const j1 of ['reached', 'never-rendered', 'partial', 'unmeasured', 'blind-channel'])
    for (const j2 of ['ran', 'never-ran', 'partly-ran', 'unmeasured', 'blind-channel'])
      for (const j3 of ['reached', 'never-rendered', 'n/a', 'unmeasured', 'blind-channel'])
        assert.equal(
          flagOf({ j1, j2, j3 }),
          j1 === 'never-rendered' ||
            (['never-ran', 'partly-ran'].includes(j2) && j3 !== 'reached') ||
            j3 === 'never-rendered',
        );
});

test('automatic labels require runtime or nonvisual evidence', () => {
  const unit = { paths: ['button'], tokens: ['selected'], headClasses: ['selected'] };
  assert.equal(autoLabel(unit, [], '+color: red;'), 'noise:join-miss');
  assert.equal(autoLabel({ ...unit, headClasses: [] }, [{ path: 'button' }], '+x'), 'noise:join-miss');
  for (const hunk of ['+// comment', '+import x from "x";', '+type X = string;', '+   '])
    assert.equal(autoLabel({}, [], hunk), 'noise:no-visual');
  assert.equal(autoLabel({}, [], '+return <button />;'), null);
  assert.equal(autoLabel({}, [], '+type X = {\n+color: string\n+};'), null);
});

test('aggregate has exact counts and rejects unknown labels', () => {
  assert.deepEqual(aggregate(['real', 'noise:join-miss', 'noise:no-visual', 'unclassified']), {
    total: 4,
    real: 1,
    joinMiss: 1,
    noVisual: 1,
    unclassified: 1,
  });
  assert.throws(() => aggregate(['unknown']));
  assert.equal(verdict({ replayed: 0, real: 0 }), 'NOT MEASURED');
  assert.equal(verdict({ replayed: 1, real: 0 }), 'FAILED');
  assert.equal(verdict({ replayed: 1, real: 1 }), 'PASSED');
});

test('receipt admits aggregate counts only', () => {
  const receipt = { prs: { attempted: 1, replayed: 1, unmeasured: 0 }, flags: aggregate([]) };
  assert.doesNotThrow(() => assertAggregateOnly(receipt));
  assert.throws(() => assertAggregateOnly({ ...receipt, title: 'private' }));
  assert.throws(() => assertAggregateOnly({ ...receipt, flags: { ...receipt.flags, real: 'private' } }));
  assert.throws(() => assertAggregateOnly({ ...receipt, prs: { attempted: -1 } }));
});

test('private output rejects worktrees and descendants', () => {
  assert.equal(privateOutOk(process.cwd(), process.cwd()), false);
  assert.equal(privateOutOk(`${process.cwd()}/new/private`, process.cwd()), false);
});

test('selection excludes reverts, oversized, dependency and test-only changes', () => {
  const row = { base: 'a', head: 'b', title: 'change', files: ['ui/button.tsx'] };
  const rows = [
    { ...row, title: 'Revert change' },
    { ...row, files: Array.from({ length: 41 }, (_, i) => `ui/${i}.tsx`) },
    { ...row, dependencyOnly: true },
    { ...row, files: ['test/button.tsx'] },
    ...Array.from({ length: 20 }, () => row),
  ];
  assert.equal(selectPairs(rows, { globs: ['**/*.tsx'], cap: 15 }).length, 15);
});
