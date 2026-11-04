import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../dist/node-util.js';
import { classifyScriptReach } from '../dist/script-join.js';

const range = (start, end) => ({ start: { line: 1, column: start }, end: { line: 1, column: end } });

const change = (start = 4, end = 5, extra = {}) => ({
  sourceKey: 'src/app.tsx',
  side: 'head',
  range: range(start, end),
  contentHash: sha256('x = a ?? b'),
  text: 'x = a ?? b',
  ...extra,
});

const capture = (executed = [[1, 4, 4]], unexecuted = [[1, 9, 10]], extra = {}) => ({
  scriptReach: {
    version: 1,
    window: 'navigation',
    status: 'measured',
    scripts: [
      {
        url: '/app.js',
        status: 'mapped',
        files: [
          {
            source: 'src/app.tsx',
            sourceKey: 'src/app.tsx',
            contentHash: sha256('x = a ?? b'),
            encoding: 'line-column-tuples',
            executed,
            unexecuted,
            mixed: [],
            ...extra,
          },
        ],
      },
    ],
  },
});

const classify = (changes, base = [capture()], head = [capture()], proof = []) =>
  classifyScriptReach(base, head, changes, proof);

test('a changed main operand ran even when the nullish fallback on the same line did not', () => {
  const { units } = classify([change(), change(9, 10)]);
  assert.deepEqual(
    units.map((unit) => [unit.execution, unit.status]),
    [
      ['ran', 'unknown'],
      ['never-ran', 'never-rendered'],
    ],
  );
  assert.equal(units[0].why, 'value; rendering not proved');
});

test('executed evidence supplies only a start point while mixed and unexecuted evidence supply spans', () => {
  const head = [capture([[1, 0, 10]], [], { mixed: [[1, 6, 10]] })];
  const units = classify([change(4, 5), change(8, 9)], [capture()], head).units;
  assert.equal(units[0].execution, 'unmeasured');
  assert.equal(units[1].execution, 'partly-ran');
});

test('each changed expression can be witnessed across captures without importing unrelated branches', () => {
  const head = [capture([[1, 4, 4]], [[1, 9, 10]]), capture([[1, 9, 9]], [[1, 4, 5]])];
  assert.equal(classify([change(4, 10)], [capture()], head).units[0].execution, 'ran');
});

test('removed ranges use base evidence and added ranges use head evidence', () => {
  const units = classify([change(4, 5, { side: 'base' }), change()], [capture([], [[1, 4, 5]])]).units;
  assert.deepEqual(
    units.map((unit) => [unit.side, unit.execution]),
    [
      ['base', 'never-ran'],
      ['head', 'ran'],
    ],
  );
});

test('an exact source range is required for rendering corroboration including on the same line', () => {
  const proof = { join: 'J1', status: 'reached', sourceKey: 'src/app.tsx', side: 'head', range: range(4, 5) };
  assert.equal(classify([change()], undefined, undefined, [proof]).units[0].status, 'reached');

  for (const altered of [
    { range: range(0, 10) },
    { side: 'base' },
    { sourceKey: 'other.tsx' },
    { status: 'never-rendered' },
    { join: 'J2' },
  ]) {
    assert.equal(classify([change()], undefined, undefined, [{ ...proof, ...altered }]).units[0].status, 'unknown');
  }
});

test('missing capture coverage stays a named run gap even with no changed units', () => {
  const { gaps } = classify([], [{}], []);
  assert.deepEqual(
    gaps.map((gap) => gap.side),
    ['base', 'head'],
  );
  assert.ok(gaps.every((gap) => gap.status === 'unmeasured' && gap.reason.includes('captureScriptReach')));
});

test('not loaded, missing source maps and mismatched source content cannot prove execution', () => {
  const absent = { scriptReach: { version: 1, window: 'navigation', status: 'measured', scripts: [] } };

  const unmapped = {
    scriptReach: {
      ...absent.scriptReach,
      scripts: [{ url: '/app.js', status: 'unmeasured', reason: 'source map absent' }],
    },
  };

  for (const [head, execution, reason] of [
    [[absent], 'not-loaded', /not loaded/],
    [[unmapped], 'unmeasured', /source map absent/],
    [[capture(undefined, undefined, { contentHash: 'wrong' })], 'unmeasured', /content.hash mismatch/],
    [[capture(undefined, undefined, { contentHash: undefined })], 'unmeasured', /content hash absent/],
  ]) {
    const unit = classify([change()], undefined, head).units[0];
    assert.equal(unit.execution, execution);
    assert.equal(unit.status, 'unmeasured');
    assert.match(unit.why, reason);
  }
});

test('J2 names all five block-entry residuals and never treats their anchors as rendering proof', () => {
  const samples = [
    ['function f(x = value) {}', 'default parameter'],
    ['const { x = value } = object;', 'destructuring default'],
    ['x ??= value;', 'logical assignment'],
    ['x?.y?.z;', 'optional chain'],
    ['mightThrow(); value();', 'throwing expression'],
  ];

  for (const [text, reason] of samples) {
    const unit = classify([change(0, text.length, { text })], undefined, [capture([[1, 0, 0]], [])]).units[0];
    assert.equal(unit.status, 'unknown');
    assert.match(unit.why, new RegExp(reason));
  }
});

test('ordering is by source code point, side, then numeric range and independent of capture order', () => {
  const changes = [change(9, 10), change(4, 5, { side: 'base' }), change()];
  const a = classify(changes);
  const b = classify([...changes].reverse());
  assert.deepEqual(a, b);
});
