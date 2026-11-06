import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLinearScaling } from './linearity-helper.mjs';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

const complete = {
  version: 2,
  ignored: false,
  shadowHosts: 0,
  frames: 0,
  outsideBody: 0,
  shadowRootsVerified: true,
  documentBoundsVerified: true,
};
const map = (extra = {}) => ({
  defaults: {},
  states: {},
  elements: {},
  classPresence: complete,
  reach: {
    version: 2,
    scope: 'compared',
    sheets: ['app.css'],
    rules: [
      { key: '.old.new.open.btn.primary.x.y.danger.safe.card.card--.btn-x.card-a.ab.a.p-2.p-20', hash: 'x', sheet: 0 },
    ],
  },
  ...extra,
});
const edits = (base, head, patch) =>
  changedScriptRanges(patch ?? `@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.tsx');
const judge = (changes, base = map(), head = map()) => classifyClassReach([base], [head], changes, [{ base, head }]);
const scripts = (changes) =>
  changes.map(({ sourceKey, side, range }) => ({
    sourceKey,
    side,
    range,
    status: 'unknown',
    execution: 'ran',
    why: 'ran; rendering unproved',
    level: 'warn',
  }));

for (const [name, extra] of [
  ['volatile elements', { volatile: ['body > time'] }],
  ['ignored elements', { classPresence: { ...complete, ignored: true } }],
  ['shadow hosts', { classPresence: { ...complete, shadowHosts: 1 } }],
  ['frames', { classPresence: { ...complete, frames: 1 } }],
  ['legacy omission metadata', { classPresence: undefined }],
])
  test(`${name} leave absence unproven only on the affected side`, () => {
    const changes = edits('<div className="old"/>', '<div className="new"/>');
    const result = judge(changes, map(extra), map());
    assert.deepEqual(
      result.units.map((u) => [u.side, u.status]),
      [
        ['base', 'unknown'],
        ['head', 'never-rendered'],
      ],
    );
    assert.match(result.units[0].why, /absence.*unproven/);
    assert.equal(combineClassReach(scripts(changes), result.units)[0].status, 'unknown');
  });

test('one incomplete surface prevents absence proof across the whole occurrence side', () => {
  const base = map(),
    head = map(),
    hidden = map({ volatile: ['body > time'] });
  const result = classifyClassReach([base], [head, hidden], edits("'old'", "'new'"), [{ base, head }]);
  assert.equal(result.units.find((u) => u.side === 'head').status, 'unknown');
});

test('reordered vocabulary-only dataset values stay J3-only and cannot lower J2', () => {
  const base = "const MODE = 'open';\nconst a = 1;\nconst b = 2;\nel.dataset.mode = MODE;";
  const head = "const a = 1;\nconst b = 2;\nconst MODE = 'open';\nel.dataset.mode = MODE;";
  const changes = edits(base, head, "@@ -1 +0,0 @@\n-const MODE = 'open';\n@@ -3,0 +3 @@\n+const MODE = 'open';\n");
  const result = judge(changes);
  assert.equal(result.units.length, 2);
  assert.ok(result.units.every((u) => u.status === 'never-rendered' && u.explicit === false));
  assert.ok(combineClassReach(scripts(changes), result.units).every((u) => u.status === 'unknown'));
});

test('explicit class negatives may still lower J2 while legacy units cannot', () => {
  const changes = edits('<div className="old"/>', '<div className="new"/>');
  const result = judge(changes);
  assert.ok(result.units.every((u) => u.explicit));
  assert.ok(combineClassReach(scripts(changes), result.units).every((u) => u.status === 'never-rendered'));
  const legacy = result.units.map((u) => ({ ...u, explicit: undefined }));
  assert.ok(combineClassReach(scripts(changes), legacy).every((u) => u.status === 'unknown'));
});

test('cva class strings include base and variant values, excluding bare and quoted variant keys', () => {
  const base = "cva('old', { variants: { tone: { primary: 'x', 'open': 'old' } } })";
  const head = "cva('new', { variants: { tone: { open: 'y', 'primary': 'new' } } })";
  const result = judge(edits(base, head));
  assert.deepEqual(
    result.units.map((u) => u.token),
    ['old', 'x', 'old', 'new', 'y', 'new'],
  );
  assert.ok(result.units.every((u) => u.explicit));
});

test('cva computed keys and quoted options do not turn configuration into class values', () => {
  for (const key of ['variants', "'variants'"]) {
    const base = `cva('old', { ${key}: { tone: { ['primary']: 'x' } }, defaultVariants: { tone: 'open' } })`;
    const head = `cva('new', { ${key}: { tone: { ['open']: 'y' } }, defaultVariants: { tone: 'primary' } })`;
    const result = judge(edits(base, head));
    assert.deepEqual(
      result.units.map((u) => u.token),
      ['old', 'x', 'new', 'y'],
    );
  }
});

for (const [a, b] of [
  ['btn-x', 'btn'],
  ['card-a', 'card'],
  ['ab', 'a'],
  ['p-2', 'p-20'],
])
  for (const [before, after] of [
    [a, b],
    [b, a],
  ])
    test(`zero-width change retains both occurrences: ${before} → ${after}`, () => {
      const result = judge(edits(`<div className="${before}"/>`, `<div className="${after}"/>`));
      assert.deepEqual(
        result.units.map((u) => [u.side, u.token]),
        [
          ['base', before],
          ['head', after],
        ],
      );
    });

test('class concatenation emits a named fragment gap and cannot lower J2', () => {
  const changes = edits("<div className={'card card--' + old}/>", "<div className={'card card--' + tone}/>");
  const result = judge(changes);
  assert.ok(
    result.gaps.some(
      (g) => /concatenation.*fragment/.test(g.reason) && g.side === 'head' && g.paths?.includes('app.tsx'),
    ),
  );
  assert.ok(combineClassReach(scripts(changes), result.units).every((u) => u.status === 'unknown'));
});

test('Solid classList object keys yield explicit class occurrences', () => {
  const result = judge(edits('<div classList={{ danger: on }}/>', '<div classList={{ safe: on }}/>'));
  assert.deepEqual(
    result.units.map((u) => [u.token, u.explicit]),
    [
      ['danger', true],
      ['safe', true],
    ],
  );
});

test('scoped gaps and negative lookups scale linearly from 4k to 16k lines', (t) => {
  const make = (count) => {
    const source = 'el.className="old"; el.className=dynamic;\n'.repeat(count);
    return Array.from({ length: count }, (_, i) => ({
      sourceKey: 'app.tsx',
      side: 'head',
      contentHash: 'same',
      text: 'el.className="old";',
      classSource: source,
      range: { start: { line: i + 1, column: 0 }, end: { line: i + 2, column: 0 } },
    }));
  };
  assertLinearScaling(t, {
    name: 'scoped gap classification',
    n: 4000,
    make,
    run: judge,
    check: (result, changes, count) => {
      assert.equal(result.units.length, count);
      assert.equal(result.gaps.length, 1);
      assert.equal(result.gaps[0].occurrenceCount, count);
      assert.equal(result.gaps[0].sampleRanges.length, 10);
      assert.ok(result.units.every((u) => u.status === 'never-rendered'));
    },
  });
  assertLinearScaling(t, {
    name: 'negative evidence lookup',
    n: 4000,
    make: (count) => {
      const changes = make(count),
        result = judge(changes);
      return {
        scripts: scripts(changes),
        negatives: result.units.map((u) => ({ ...u, explicit: true, status: 'never-rendered' })),
      };
    },
    run: ({ scripts, negatives }) => combineClassReach(scripts, negatives),
    check: (combined, input, count) => {
      assert.equal(combined.length, count);
      assert.ok(combined.every((u) => u.status === 'never-rendered'));
    },
  });
});
