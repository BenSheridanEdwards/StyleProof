import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLinearScaling } from './linearity-helper.mjs';
import { classifyClassReach, classVocabulary, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { classLiterals } from '../dist/class-join-literals.js';

const vocabulary = '.old.new.keep.btn.primary.item.known.other';
const capture = (cls = '', extra = {}) => ({
  defaults: {},
  states: {},
  classPresence: {
    version: 2,
    ignored: false,
    shadowHosts: 0,
    frames: 0,
    outsideBody: 0,
    shadowRootsVerified: true,
    documentBoundsVerified: true,
  },
  elements: { body: { tag: 'body', cls, style: {} } },
  reach: { version: 2, scope: 'compared', sheets: ['app.css'], rules: [{ key: vocabulary, hash: 'same', sheet: 0 }] },
  ...extra,
});
const edits = (base, head, patch, sourceKey = 'app.tsx') =>
  changedScriptRanges(
    patch ??
      `@@ -1,${base.split('\n').length} +1,${head.split('\n').length} @@\n${base
        .split('\n')
        .map((line) => '-' + line)
        .join('\n')}\n${head
        .split('\n')
        .map((line) => '+' + line)
        .join('\n')}\n`,
    { base, head },
    sourceKey,
  );
const judge = (changes, base = capture(), head = capture()) =>
  classifyClassReach([base], [head], changes, [{ base, head }]);

for (const [name, base, head, patch, token, side] of [
  [
    'inserted sibling',
    '<ul>\n  <li className="item">One</li>\n</ul>',
    '<ul>\n  <li className="item">Zero</li>\n  <li className="item">One</li>\n</ul>',
    '@@ -1,0 +2 @@\n+  <li className="item">Zero</li>\n',
    'item',
    'head',
  ],
  [
    'inserted constant',
    "const A = 'old';",
    "const B = 'old';\nconst A = 'old';",
    "@@ -0,0 +1 @@\n+const B = 'old';\n",
    'old',
    'head',
  ],
  [
    'deleted constant',
    "const B = 'old';\nconst A = 'old';",
    "const A = 'old';",
    "@@ -1 +0,0 @@\n-const B = 'old';\n",
    'old',
    'base',
  ],
])
  test(`${name} retains its occurrence when the opposite blob has the same word position`, () => {
    const result = judge(edits(base, head, patch), capture(token), capture(token));
    assert.equal(result.units.length, 1);
    assert.equal(result.units[0].token, token);
    assert.equal(result.units[0].side, side);
    assert.equal(result.units[0].status, 'unknown');
  });

test('replacement exclusion uses the hunk-relative counterpart, not global line numbers', () => {
  const base = "// before\nconst C = 'old known';";
  const head = "// extra\n// before\nconst C = 'new known';";
  const patch = "@@ -0,0 +1 @@\n+// extra\n@@ -2 +3 @@\n-const C = 'old known';\n+const C = 'new known';\n";
  assert.deepEqual(
    judge(edits(base, head, patch)).units.map((u) => u.token),
    ['old', 'new'],
  );
});

test('a class-constant refactor with identical captured class lists never lowers J2', () => {
  const changes = edits('<a className="btn primary"/>', "const CLS = 'btn primary';\n<a className={CLS}/>");
  const result = judge(changes, capture('btn primary'), capture('btn primary'));
  assert.equal(result.units.length, 4);
  assert.ok(result.units.every((u) => u.status === 'unknown'));
  assert.ok(result.units.every((u) => u.why === 'token present on a captured element; not tied to this occurrence'));
  const scripts = changes.map((change) => ({
    ...change,
    execution: 'ran',
    status: 'unknown',
    why: 'value; rendering not proved',
    level: 'warn',
  }));
  assert.ok(combineClassReach(scripts, result.units).every((u) => u.status === 'unknown'));
});

for (const shape of ['new element', 'tag change', 'volatile'])
  test(`tokens present on a ${shape} cannot be never-rendered`, () => {
    const base = capture('old'),
      head = capture('new');
    if (shape === 'new element') head.elements = { added: { tag: 'p', cls: 'new', style: {} } };
    if (shape === 'tag change') head.elements.body.tag = 'section';
    if (shape === 'volatile') head.volatile = ['body'];
    assert.ok(judge(edits("'old'", "'new'"), base, head).units.every((u) => u.status === 'unknown'));
  });

test('only absence from every captured element on the occurrence side is negative', () => {
  const result = judge(edits("'old'", "'new'"), capture('new'), capture('old'));
  assert.ok(result.units.every((u) => u.status === 'never-rendered'));
});

test('a missing base vocabulary does not poison healthy head evidence', () => {
  const result = judge(edits("'old'", "'new'"), capture('old', { reach: undefined }), capture('new'));
  assert.deepEqual(
    result.units.map((u) => u.status),
    ['unmeasured', 'unknown'],
  );
});

test('file-specific source gaps do not poison another file or the opposite side', () => {
  const broken = edits("'old'", "'new'", undefined, 'broken.tsx').map((c) =>
    c.side === 'head' ? { ...c, unmeasuredReason: 'head source root unavailable' } : c,
  );
  const result = judge(
    [...broken, ...edits("'old'", "'new'", undefined, 'healthy.tsx')],
    capture('old'),
    capture('new'),
  );
  assert.deepEqual(
    result.units.map((u) => [u.sourceKey, u.side, u.status]),
    [
      ['broken.tsx', 'base', 'unknown'],
      ['broken.tsx', 'head', 'unmeasured'],
      ['healthy.tsx', 'base', 'unknown'],
      ['healthy.tsx', 'head', 'unknown'],
    ],
  );
  assert.ok(result.gaps.some((g) => g.side === 'head' && g.paths?.includes('broken.tsx')));
});

for (const [name, base, head, file = 'app.tsx'] of [
  ['helper object keys', 'clsx({ old: on })', 'clsx({ new: on })'],
  ['nested templates', "`btn ${on ? `old` : ''}`", "`btn ${on ? `new` : ''}`"],
  ['Vue object binding', '<div :class="{ old: on }"/>', '<div :class="{ new: on }"/>', 'App.vue'],
  ['Vue array binding', '<div :class="[\'old\', variable]"/>', '<div :class="[\'new\', variable]"/>', 'App.vue'],
  ['Svelte directive', '<div class:old={on}/>', '<div class:new={on}/>', 'App.svelte'],
  [
    'Svelte interpolation',
    "<div class=\"btn {on ? 'old' : ''}\"/>",
    "<div class=\"btn {on ? 'new' : ''}\"/>",
    'App.svelte',
  ],
])
  test(`${name} retains known class-token occurrences`, () => {
    const result = judge(edits(base, head, undefined, file), capture('old'), capture('new'));
    assert.deepEqual(
      result.units.map((u) => u.token),
      ['old', 'new'],
    );
    assert.ok(result.units.every((u) => u.status === 'unknown'));
  });

test('unparsed explicit class contexts produce named side/file gaps', () => {
  const result = judge(edits('<div className={before()}/>', '<div className={after()}/>'));
  assert.ok(
    result.gaps.some(
      (g) =>
        g.side === 'head' &&
        g.paths?.includes('app.tsx') &&
        /class.*(?:unresolved|unparsed|no .*token)/i.test(g.reason),
    ),
  );
});

test('nested prose under a class helper remains a named conservative candidate', () => {
  const result = judge(edits("cn('btn', t('old thing'))", "cn('btn', t('new thing'))"), capture('old'), capture('new'));
  assert.deepEqual(
    result.units.map((u) => u.token),
    ['old', 'new'],
  );
});

test('CSS vocabulary respects escaped identifiers, attributes and selector functions', () => {
  assert.deepEqual([...classVocabulary(['#target\\.ghost-old', '#target\\.ghost-new'])], []);
  assert.deepEqual(
    [...classVocabulary(['.a\\:b', '.w-1\\/2', '[data-value=".ghost"]:not(.x)'])],
    ['a:b', 'w-1/2', 'x'],
  );
  const before = capture('', {
    reach: { ...capture().reach, rules: [{ key: '#target\\.ghost-old', hash: 'x', sheet: 0 }] },
  });
  const after = capture('', {
    reach: { ...capture().reach, rules: [{ key: '#target\\.ghost-new', hash: 'y', sheet: 0 }] },
  });
  assert.deepEqual(judge(edits("'ghost-old'", "'ghost-new'"), before, after).units, []);
});

test('substitution literals adjoining static text are fragments rather than whole class tokens', () => {
  const result = judge(
    edits("const C = `${flag ? 'old' : 'keep'}-suffix`;", "const C = `${flag ? 'new' : 'keep'}-suffix`;"),
  );
  assert.deepEqual(result.units, []);
});

test('positions retain JavaScript line terminators and UTF-16 columns', () => {
  const literals = classLiterals("// 😀\r\nconst C = 'old';\u2028const D = `new`;", 'app.ts');
  assert.deepEqual(
    literals.map((l) => l.range.start),
    [
      { line: 2, column: 10 },
      { line: 3, column: 10 },
    ],
  );
});

for (const kind of ['string', 'template'])
  test(`one MB of ${kind} literals scans with linear growth`, (t) => {
    const line = kind === 'string' ? "const C = 'old known';\n" : 'const C = `btn ${on ? "old" : "new"}`;\n';
    assertLinearScaling(t, {
      name: `${kind} literal extraction`,
      n: Math.ceil(1_000_000 / (4 * line.length)),
      make: (count) => line.repeat(count),
      run: (text) => classLiterals(text, 'app.ts'),
      check: (literals, text, count) => {
        assert.equal(literals.length, count * (kind === 'string' ? 1 : 3));
        assert.ok(literals.length > 0 && text.length >= count * line.length);
      },
    });
  });

test('a bare className assignment with no static tokens is a scoped gap', () => {
  const result = judge(edits('el.className = before;', 'el.className = after;'));
  assert.ok(
    result.gaps.some((gap) => gap.side === 'head' && gap.paths?.includes('app.tsx') && /unresolved/.test(gap.reason)),
  );
});
