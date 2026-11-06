import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

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
const edits = (base, head) =>
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
    'app.tsx',
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
    assert.equal(gap.range.start.line, 1);
    assert.equal(gap.range.end.line, 2);
  }
  assert.ok(result.units.every((u) => u.status !== 'never-rendered'));
});
