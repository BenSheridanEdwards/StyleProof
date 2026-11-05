import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

const map = (cls = '', extra = {}) => ({
  defaults: {},
  states: {},
  elements: { body: { tag: 'body', cls, style: {} } },
  reach: {
    version: 2,
    scope: 'compared',
    sheets: ['app.css'],
    rules: [{ key: '.old.new.known.other', hash: 'same', sheet: 0 }],
  },
  ...extra,
});
const changes = (base, head, file = 'app.tsx') =>
  changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, file);
const classify = (base, head, before = map('old'), after = map('new')) =>
  classifyClassReach([before], [after], changes(base, head), [{ base: before, head: after }]);

test('a token-name delta never reaches any occurrence, including a unique token', () => {
  const result = classify("const C = 'old';", "const C = 'new';");
  assert.deepEqual(result.gaps, []);
  assert.equal(result.units.length, 2);
  assert.ok(result.units.every((u) => u.status === 'unknown' && u.level === 'warn'));
  assert.ok(result.units.every((u) => u.why === 'class token; delta not tied to this occurrence'));
  assert.deepEqual(
    result.units.map((u) => u.token),
    ['old', 'new'],
  );
  assert.deepEqual(result.units[1].range, { start: { line: 1, column: 10 }, end: { line: 1, column: 15 } });
});

test('no directional delta is sound negative evidence even when J2 ran', () => {
  const result = classify("const C = 'old';", "const C = 'new';", map('old'), map('old'));
  assert.ok(result.units.every((u) => u.status === 'never-rendered'));
  const scripts = changes("const C = 'old';", "const C = 'new';").map((c) => ({
    ...c,
    execution: 'ran',
    status: 'unknown',
    why: 'value; rendering not proved',
    level: 'warn',
  }));
  const combined = combineClassReach(scripts, result.units);
  assert.ok(combined.every((u) => u.status === 'never-rendered' && u.execution === 'ran'));
  const unresolved = classify("const C = 'old';", "const C = 'new';");
  assert.ok(combineClassReach(scripts, unresolved.units).every((u) => u.status === 'unknown'));
});

test('prose with a vocabulary word is skipped; a string of only known classes joins', () => {
  assert.deepEqual(classify("const text = 'old sentence';", "const text = 'new sentence';").units, []);
  assert.equal(classify("const C = 'old known';", "const C = 'new known';").units.length, 2);
});

for (const [name, base, head] of [
  ['JSX className', '<div className="old marker" />', '<div className="new marker" />'],
  ['HTML class', '<div class="old marker" />', '<div class="new marker" />'],
  ['object className', "h('div', { className: 'old marker' })", "h('div', { className: 'new marker' })"],
  ['clsx', "clsx(flag && 'old marker')", "clsx(flag && 'new marker')"],
  [
    'cva',
    "cva('marker', { variants: { tone: { danger: 'old marker' } } })",
    "cva('marker', { variants: { tone: { danger: 'new marker' } } })",
  ],
  ['classList', "el.classList.add('old marker')", "el.classList.add('new marker')"],
  ['template', 'el.className = `marker ${flag} old`', 'el.className = `marker ${flag} new`'],
])
  test(`${name} identifies vocabulary tokens in an explicit class source`, () => {
    const result = classify(base, head);
    assert.deepEqual(
      result.units.map((u) => u.token),
      ['old', 'new'],
    );
  });

test('only literals intersecting the changed range are occurrences', () => {
  const result = classify("const A = 'known'; const C = 'old';", "const A = 'known'; const C = 'new';");
  assert.deepEqual(
    result.units.map((u) => u.token),
    ['old', 'new'],
  );
});

test('collision retains distinct occurrence ranges and never upgrades a J2 unit', () => {
  const result = classify("const OK = 'old'; const FAULT = 'old';", "const OK = 'new'; const FAULT = 'new';");
  assert.equal(result.units.length, 4);
  assert.ok(result.units.every((u) => u.status === 'unknown'));
  assert.notDeepEqual(result.units[2].range, result.units[3].range);
  const scripts = [{ ...result.units[2], execution: 'never-ran', status: 'never-rendered' }];
  assert.equal(combineClassReach(scripts, result.units)[0].status, 'never-rendered');
});

test('gained head and lost base tokens use their own directions', () => {
  const result = classify("const C = 'old';", "const C = 'new';", map('new'), map('old'));
  assert.ok(result.units.every((u) => u.status === 'never-rendered'));
});

test('one-sided elements and volatile subtrees cannot provide paired deltas', () => {
  const before = map('old'),
    after = map('new');
  after.elements = { other: after.elements.body };
  assert.ok(
    classify("const C = 'old';", "const C = 'new';", before, after).units.every((u) => u.status === 'never-rendered'),
  );
  assert.ok(
    classify("const C = 'old';", "const C = 'new';", map('old', { volatile: ['body'] }), map('new')).units.every(
      (u) => u.status === 'never-rendered',
    ),
  );
});

test('missing/partial/empty class vocabulary and absent map pairing name J3 gaps', () => {
  for (const reach of [
    undefined,
    { version: 2, scope: 'compared', sheets: [], rules: [] },
    { ...map().reach, unreadable: 1 },
  ]) {
    const result = classify("const C = 'old';", "const C = 'new';", map('old', { reach }));
    assert.ok(result.gaps.some((g) => g.join === 'J3' && g.status === 'unmeasured' && g.side === 'base'));
    assert.ok(result.units.every((u) => u.status === 'unmeasured'));
  }
  assert.ok(
    classifyClassReach([map()], [map()], changes("'old'", "'new'"), []).gaps.some((g) => /pair/i.test(g.reason)),
  );
});

test('comments, regex and template substitutions are not invented class text', () => {
  assert.deepEqual(classify("// 'old'", "// 'new'").units, []);
  assert.deepEqual(classify("const r = /'old'/", "const r = /'new'/").units, []);
  assert.deepEqual(classify('const C = `old${value}`', 'const C = `new${value}`').units, []);
});

test('class units sort by code point and exact range, independent of change order', () => {
  const input = [...changes("'old'", "'new'", '𐀀.tsx'), ...changes("'old'", "'new'", 'Ａ.tsx')];
  const before = map('old'),
    after = map('new'),
    pairs = [{ base: before, head: after }];
  const one = classifyClassReach([before], [after], input, pairs);
  assert.deepEqual(classifyClassReach([before], [after], [...input].reverse(), pairs), one);
  assert.equal(one.units[0].sourceKey, 'Ａ.tsx');
});

test('className ternary context accepts marker words but ends before another property', () => {
  const result = classify(
    "h({ className: flag ? 'old marker' : 'other', title: 'old sentence' })",
    "h({ className: flag ? 'new marker' : 'other', title: 'new sentence' })",
  );
  assert.deepEqual(
    result.units.map((unit) => unit.token),
    ['old', 'new'],
  );
});

test('unchanged words in an edited class string cannot invent negative evidence', () => {
  const result = classify("const C = 'old known';", "const C = 'new known';");
  assert.deepEqual(
    result.units.map((unit) => unit.token),
    ['old', 'new'],
  );
  assert.ok(result.units.every((unit) => unit.status === 'unknown'));
});
