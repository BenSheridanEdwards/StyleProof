import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import * as joins from '../bench/reach-joins.mjs';
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

const coverageMap = {
  sources: ['src/app/Card.tsx', 'node_modules/lib/dom.js'],
  mappings: 'AAAA,EAAA,GCAA',
};
function coverageFixture(app = 1, vendor = 1, scriptId = '1') {
  return {
    coverage: [
      {
        surface: 'screen',
        entries: [
          {
            url: 'bundle.js',
            source: 'abcdefghij',
            scriptId,
            functions: [
              {
                ranges: [
                  { startOffset: 0, endOffset: 10, count: 1 },
                  { startOffset: 2, endOffset: 5, count: app },
                  { startOffset: 5, endOffset: 10, count: vendor },
                ],
              },
            ],
          },
        ],
      },
    ],
    sourceMaps: { 'bundle.js': coverageMap },
  };
}

test('vendor-only coverage drift passes with a third-party-only surface count', () => {
  const first = coverageFixture();
  const twice = coverageFixture(1, 0);
  assert.deepEqual(joins.coverageProjection(first), joins.coverageProjection(twice));
  const thirdPartyOnly = first.coverage.filter(
    (c, i) =>
      !isDeepStrictEqual(c, twice.coverage[i]) &&
      isDeepStrictEqual(joins.coverageProjection(first)[c.surface], joins.coverageProjection(twice)[c.surface]),
  ).length;
  assert.equal(thirdPartyOnly, 1);
});

test('app coverage drift aborts projection equality', () => {
  assert.notDeepEqual(joins.coverageProjection(coverageFixture()), joins.coverageProjection(coverageFixture(0)));
});

test('vendor suffix collision cannot reach an app line', () => {
  assert.equal(joins.isAppSource('node_modules/lib/dom.js'), false);
  assert.equal(joins.isAppSource('x/node_modules/lib/dom.js'), false);
  assert.equal(joins.isAppSource('src/app/Card.tsx'), true);
  assert.equal(joins.lineExecution(coverageFixture().coverage[0].entries[0], coverageMap, 'dom.js').size, 0);
});

test('losing a source map counts as projection drift', () => {
  const missing = coverageFixture();
  missing.sourceMaps = {};
  assert.notDeepEqual(joins.coverageProjection(coverageFixture()), joins.coverageProjection(missing));
});

test('script IDs do not affect coverage projection', () => {
  assert.deepEqual(joins.coverageProjection(coverageFixture()), joins.coverageProjection(coverageFixture(1, 1, '99')));
});

test('J2 retains ran, partly-ran and never-ran verdicts', () => {
  const entry = coverageFixture().coverage[0].entries[0];
  const execution = () => joins.lineExecution(entry, coverageMap, 'Card.tsx');
  assert.equal(joins.jsReach(1, [execution()]), 'ran');
  entry.functions[0].ranges[1].count = 0;
  assert.equal(joins.jsReach(1, [execution()]), 'partly-ran');
  entry.functions[0].ranges[0].count = 0;
  assert.equal(joins.jsReach(1, [execution()]), 'never-ran');
});
