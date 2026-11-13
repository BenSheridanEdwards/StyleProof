import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { assertLinearScaling } from './linearity-helper.mjs';

const map = () => ({
  defaults: {},
  states: {},
  elements: {},
  classPresence: {
    version: 2,
    ignored: false,
    shadowHosts: 0,
    frames: 0,
    outsideBody: 0,
    shadowRootsVerified: true,
    documentBoundsVerified: true,
  },
  reach: {
    version: 2,
    scope: 'compared',
    sheets: ['app.css'],
    rules: [{ key: '.old.new.open.active.selected.card.tab.btn.x.y', hash: 'x', sheet: 0 }],
  },
});
const edits = (base, head, key = 'app.tsx') =>
  changedScriptRanges(
    `@@ -1,${base.split('\n').length} +1,${head.split('\n').length} @@\n` +
      base
        .split('\n')
        .map((l) => '-' + l + '\n')
        .join('') +
      head
        .split('\n')
        .map((l) => '+' + l + '\n')
        .join(''),
    { base, head },
    key,
  );
const judge = (base, head, changes = edits(base, head)) => {
  const before = map(),
    after = map();
  return classifyClassReach([before], [after], changes, [{ base: before, head: after }]);
};
const scripts = (changes) =>
  changes.map(({ sourceKey, side, range }) => ({
    sourceKey,
    side,
    range,
    execution: 'ran',
    status: 'reached',
    why: 'executed',
    level: 'warn',
  }));

for (const [name, expression, positive] of [
  ['tagged translation', "cn('card', t`TOKEN`)", false],
  ['tagged CSS', 'cx(css`TOKEN`)', false],
  ['tagged standalone class value', 'el.className = t`TOKEN`', false],
  ['in operator', "cn('TOKEN' in flags && 'tab')", false],
  ['instanceof operand', "cn('TOKEN' instanceof flags && 'tab')", false],
  ['optional call', "cn('card', isState?.('TOKEN'))", false],
  ['non-null call', "cn('card', fn!('TOKEN'))", false],
  ['generic call', "cn('card', fn<T>('TOKEN'))", false],
  ['generic helper call', "cn<string>('TOKEN')", false],
  ['comment beside equality', "cn(state === /* enum */ 'TOKEN' && 'tab')", false],
  ['line comment beside equality', "cn(state === // enum\n'TOKEN' && 'tab')", false],
  ['comment after left operand', "cn('TOKEN' /* enum */ === state && 'tab')", false],
  ['optional computed lookup', "cn(styles?.['TOKEN'])", false],
  ['optional object lookup', "el.className = ({TOKEN:'card'})?.[size]", false],
  ['cast object lookup', "el.className = ({TOKEN:'card'} as Record<string,string>)[size]", false],
  ['satisfies object lookup', "el.className = ({TOKEN:'card'} satisfies M)[size]", false],
  ['less than', "cn(state < 'TOKEN' && 'tab')", false],
  ['less than or equal', "cn(state <= 'TOKEN' && 'tab')", false],
  ['greater than', "cn(state > 'TOKEN' && 'tab')", false],
  ['greater than or equal', "cn(state >= 'TOKEN' && 'tab')", false],
  ['arrow body', "cn(s => 'TOKEN')", false],
  ['void operand', "cn(void 'TOKEN')", false],
  ['increment assignment', "cn(s += 'TOKEN')", false],
  ['bare className variable assignment', "className = 'TOKEN'", false],
  ['class expando assignment', "el.class = 'TOKEN'", false],
  ['classList property assignment', "el.classList = 'TOKEN'", false],
  ['ordinary assignment', "cn(s = 'TOKEN')", false],
  ['unary operand', "cn(!'TOKEN')", false],
  ['arithmetic operand', "cn(1 + 'TOKEN')", false],
  ['and left operand', "cn('TOKEN' && 'tab')", false],
  ['direct helper argument', "cn('TOKEN')", true],
  ['helper array', "cn(['TOKEN'])", true],
  ['helper object key', 'clsx({ TOKEN: on })', true],
  ['helper object condition', "clsx({ card: 'TOKEN' })", false],
  ['false and result', "cn('card', false && 'TOKEN')", true],
  ['or result', "cn(on || 'TOKEN')", true],
  ['nullish result', "cn(on ?? 'TOKEN')", true],
  ['ternary consequent', "el.className = on ? 'TOKEN' : 'card'", true],
  ['ternary alternate', "el.className = on ? 'card' : 'TOKEN'", true],
  ['nested positive roles', "cn([on ? 'TOKEN' : 'card'])", true],
  ['comments in positive roles', "cn(/* class */ on && /* result */ 'TOKEN')", true],
  ['direct class attribute', '<div className="TOKEN"/>', true],
  ['queried class assignment', "document.querySelector('main').className = 'TOKEN'", true],
])
  test(`allow-list ${name}: ${positive ? 'positive' : 'J3 only'}`, () => {
    const base = expression.replace('TOKEN', 'old'),
      head = expression.replace('TOKEN', 'new');
    const changes = edits(base, head),
      result = judge(base, head, changes);
    assert.equal(result.units.length, 2, JSON.stringify(result));
    assert.ok(
      result.units.every((u) => u.explicit === positive),
      JSON.stringify(result.units),
    );
    assert.ok(
      combineClassReach(scripts(changes), result.units).every(
        (u) => u.status === (positive ? 'never-rendered' : 'reached'),
      ),
    );
  });

for (const [base, head] of [
  ["cn('card', t`open`)", "cn('card', t('open'))"],
  ["cn('card', 'open' in flags && 'tab')", "cn('card', Object.hasOwn(flags,'open') && 'tab')"],
])
  test(`non-class syntax refactor cannot lower J2: ${base}`, () => {
    const changes = edits(base, head),
      result = judge(base, head, changes);
    assert.ok(
      result.units.every((u) => !u.explicit),
      JSON.stringify(result.units),
    );
    assert.ok(combineClassReach(scripts(changes), result.units).every((u) => u.status === 'reached'));
  });

for (const head of [
  "const K = 'open';\ncn('card', t(K));",
  "cn('card', t(K));\nconst K = 'open';",
  "const K = 'open';\n\n\ncn('card', t(K));",
  "cn('card', t(K));\n\nconst K = 'open';",
])
  test(`replacement-hunk matching preserves card: ${JSON.stringify(head)}`, () => {
    const base = "cn('card', t('open'));",
      changes = edits(base, head),
      result = judge(base, head, changes);
    assert.ok(
      result.units.every((u) => u.token !== 'card'),
      JSON.stringify(result),
    );
    assert.ok(combineClassReach(scripts(changes), result.units).every((u) => u.status === 'reached'));
  });

test('same token in a different positive role or slot remains changed', () => {
  const result = judge("cn(on && 'old', 'card')", "cn(on && 'card', 'old')");
  assert.equal(result.units.length, 4, JSON.stringify(result.units));
  assert.ok(result.units.every((u) => u.explicit));
});

test('depth limit outside a class context names the uncaptured remainder on both sides', () => {
  const deep = 'const deep = ' + '`${'.repeat(130) + "'x'" + '}`'.repeat(130) + ';\n';
  const base = deep + "document.body.className = on ? 'card' : 'old';";
  const head = deep + "document.body.className = on ? 'card' : 'new';";
  const changes = changedScriptRanges(
    '@@ -2 +2 @@\n-' + base.split('\n')[1] + '\n+' + head.split('\n')[1] + '\n',
    { base, head },
    'app.tsx',
  );
  const result = judge(base, head, changes);
  for (const side of ['base', 'head']) {
    const gap = result.gaps.find((g) => g.side === side && /template.*depth.*limit/.test(g.reason));
    assert.ok(gap, JSON.stringify(result.gaps));
    assert.equal(gap.sampleRanges[0].start.line, 1);
    assert.equal(gap.sampleRanges[0].end.line, 2);
  }
  assert.ok(result.units.every((u) => u.status !== 'never-rendered'));
});

for (const file of ['App.svelte', 'App.vue'])
  test(`class attribute expression retains positive roles: ${file}`, () => {
    const base = "<div class={on ? 'old' : 'card'}/>",
      head = "<div class={on ? 'new' : 'card'}/>";
    const result = judge(base, head, edits(base, head, file));
    assert.equal(result.units.length, 2, JSON.stringify(result));
    assert.ok(
      result.units.every((u) => u.explicit),
      JSON.stringify(result.units),
    );
  });

test('component markup inside a script template remains prose', () => {
  const base = "<script>const copy = `prefix ${'x'} <div class={on ? 'old' : 'card'}>`;</script>";
  const head = base.replace("'old'", "'new'");
  const result = judge(base, head, edits(base, head, 'App.svelte'));
  assert.ok(
    result.units.every((u) => !u.explicit),
    JSON.stringify(result),
  );
});

test('cached replacement-hunk matching scales linearly from 4k to 16k changed lines', (t) => {
  assertLinearScaling(t, {
    name: 'replacement-hunk matching',
    n: 4000,
    make: (count) => {
      const base = Array.from({ length: count }, (_, i) => `el${i}.className = 'old';`).join('\n');
      const head = base.replaceAll("'old'", "'new'");
      return { base, head, changes: edits(base, head) };
    },
    run: ({ base, head, changes }) => judge(base, head, changes),
    check: (result, input, count) => {
      assert.equal(result.units.length, count * 2);
      assert.ok(result.units.every((u) => u.explicit));
      assert.equal(result.gaps.length, 0);
    },
  });
});

test('JSX entity spelling does not create an absent runtime token', () => {
  const base = '<div className="o&#108;d"/>',
    head = '<div className="o&#x6c;d"/>';
  const before = map(),
    after = map();
  for (const m of [before, after]) {
    m.elements = { body: { tag: 'body', cls: 'old', style: {} } };
    m.reach.rules[0].key = '.old.o\\&\\#108\\;d.o\\&\\#x6c\\;d';
  }
  const changes = edits(base, head);
  const result = classifyClassReach([before], [after], changes, [{ base: before, head: after }]);
  assert.ok(
    result.units.every((u) => !u.explicit || u.status !== 'never-rendered'),
    JSON.stringify(result),
  );
  assert.ok(combineClassReach(scripts(changes), result.units).every((u) => u.status === 'reached'));
});

test('component entity encodings get a named conservative gap', () => {
  const base = '<div class="o&#108;d"/>',
    head = '<div class="n&#101;w"/>';
  const result = judge(base, head, edits(base, head, 'App.svelte'));
  assert.ok(
    result.gaps.some((g) => /encoded markup/.test(g.reason)),
    JSON.stringify(result),
  );
  assert.ok(result.units.every((u) => !u.explicit || u.status !== 'never-rendered'));
});

test('an unrelated helper identifier cannot change an unchanged quoted class property', () => {
  const base = "const props = { 'class': 'old' };";
  const head = "const cn = 1; const props = { 'class': 'old' };";
  const changes = edits(base, head),
    result = judge(base, head, changes);
  assert.ok(
    result.units.every((u) => u.token !== 'old' || !u.explicit),
    JSON.stringify(result),
  );
  assert.ok(combineClassReach(scripts(changes), result.units).every((u) => u.status === 'reached'));
});

test('cva selection data cannot introduce a positive nested helper root', () => {
  const result = judge(
    "cva('card',{defaultVariants:{tone:cn('old')}})",
    "cva('card',{defaultVariants:{tone:cn('new')}})",
  );
  assert.ok(
    result.units.every((u) => !u.explicit),
    JSON.stringify(result),
  );
});

for (const [before, after] of [
  ['old', 'new'],
  ['new', 'old'],
])
  test(`a multiline literal cannot match ${before} outside its replacement hunk`, () => {
    const base = `el.className = \`card\n${before}\nold\`;`,
      head = `el.className = \`card\n${after}\nold\`;`;
    const changes = changedScriptRanges(`@@ -2 +2 @@\n-${before}\n+${after}\n`, { base, head }, 'app.tsx');
    const result = judge(base, head, changes);
    assert.deepEqual(
      result.units.map((u) => [u.side, u.token]),
      [
        ['base', before],
        ['head', after],
      ],
    );
  });
