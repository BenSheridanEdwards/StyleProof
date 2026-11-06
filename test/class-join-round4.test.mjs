import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { captureAuthorShadowRoots } from '../dist/capture/class-presence.js';

const map = () => ({
  defaults: {},
  states: {},
  elements: {},
  classPresence: { version: 2, ignored: false, shadowHosts: 0, frames: 0, outsideBody: 0, shadowRootsVerified: true },
  reach: {
    version: 2,
    scope: 'compared',
    sheets: ['app.css'],
    rules: [{ key: '.old.new.card.btn', hash: 'x', sheet: 0 }],
  },
});
for (const [name, expression, positive] of [
  ['helper equality', "clsx('card', state === 'TOKEN' && 'btn')", false],
  ['ternary predicate', "el.className = state === 'TOKEN' ? 'card btn' : 'card'", false],
  ['JSX predicate', "<div className={state === 'TOKEN' ? 'card' : 'btn'}/>", false],
  ['left operand', "cn('TOKEN' !== state && 'btn')", false],
  ['loose equality', "cn(state == 'TOKEN' && 'btn')", false],
  ['loose inequality', "cn(state != 'TOKEN' && 'btn')", false],
  ['lookup quoted key', "el.className = ({ 'TOKEN': 'card btn' })[size]", false],
  ['lookup identifier key', "el.className = ({ TOKEN: 'card btn' })[size]", false],
  ['lookup direct key', "cn({ TOKEN: 'card' }[size])", false],
  ['receiver array', "cn([a, 'TOKEN'].includes(b) && 'btn')", false],
  ['optional receiver array', "cn(['TOKEN'])", true],
  ['method call', "cn(utils.pick('TOKEN'))", false],
  ['method named helper', "cn(utils.clsx('TOKEN'))", false],
  ['case label', "cn(() => { switch (state) { case 'TOKEN': return 'card'; } })", false],
  ['dataset dot', "el.dataset.class = 'TOKEN'", false],
  ['dataset bracket single', "el.dataset['class'] = 'TOKEN'", false],
  ['dataset bracket double', 'el.dataset["class"] = "TOKEN"', false],
  ['helper object key', 'clsx({ TOKEN: on })', true],
  ['helper quoted key', "clsx({ 'TOKEN': on })", true],
  ['ternary result', "el.className = on ? 'TOKEN' : 'card'", true],
  ['and result', "cn(on && 'TOKEN')", true],
  ['lookup object value', "el.className = ({ size: 'TOKEN' })[size]", true],
  ['plain class property', "const fare = { class: 'TOKEN' }", true],
  ['Vue props', "h('div', { class: 'TOKEN' })", true],
  ['classList add', "el.classList.add('TOKEN')", true],
  ['classList replace second', "el.classList.replace('card', 'TOKEN')", true],
  ['cva base', "cva('TOKEN', { variants: { tone: { primary: 'card' } } })", true],
  ['nested template result', 'cn(`card ${on ? `TOKEN` : `btn`}`)', true],
])
  test(`${name}: ${positive ? 'value' : 'J3 only'}`, () => {
    const base = expression.replace('TOKEN', 'old'),
      head = expression.replace('TOKEN', 'new');
    const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.tsx');
    const before = map(),
      after = map();
    const result = classifyClassReach([before], [after], changes, [{ base: before, head: after }]);
    assert.equal(result.units.length, 2);
    assert.ok(
      result.units.every((u) => u.explicit === positive),
      JSON.stringify(result.units),
    );
    const j2 = changes.map(({ sourceKey, side, range }) => ({
      sourceKey,
      side,
      range,
      execution: 'ran',
      status: 'reached',
      why: 'executed',
      level: 'warn',
    }));
    assert.ok(combineClassReach(j2, result.units).every((u) => u.status === (positive ? 'never-rendered' : 'reached')));
  });

test('deep nested templates record a named gap instead of exhausting the stack', () => {
  const expression = (token) => 'cn(' + '`${'.repeat(4096) + `'${token}'` + '}`'.repeat(4096) + ')';
  const base = expression('old'),
    head = expression('new');
  const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'deep.ts');
  const before = map(),
    after = map();
  const result = classifyClassReach([before], [after], changes, [{ base: before, head: after }]);
  assert.ok(
    result.gaps.some((g) => /template.*(?:depth|nesting).*limit/i.test(g.reason)),
    JSON.stringify(result.gaps),
  );
  assert.ok(result.units.every((u) => u.status !== 'never-rendered'));
});

test('route announcers exempt their shadow tree but not light-DOM author children', async () => {
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({
          root: {
            nodeType: 9,
            children: [
              {
                nodeName: 'NEXT-ROUTE-ANNOUNCER',
                shadowRoots: [{ shadowRootType: 'closed' }],
                children: [{ nodeName: 'SPAN', shadowRoots: [{ shadowRootType: 'closed' }] }],
              },
            ],
          },
        }),
        detach: async () => {},
      }),
    }),
  };
  assert.equal(await captureAuthorShadowRoots(page), 1);
});

for (const [name, head] of [
  ['constant before', "const K = 'new'; cn('card', t(K));"],
  ['constant after', "cn('card', t(K)); const K = 'new';"],
])
  test(`unchanged literals survive inserted literals: ${name}`, () => {
    const base = "cn('card', t('new'));";
    const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.tsx');
    const before = map(),
      after = map();
    const result = classifyClassReach([before], [after], changes, [{ base: before, head: after }]);
    assert.ok(
      result.units.every((u) => u.token !== 'card'),
      JSON.stringify(result.units),
    );
    const j2 = changes.map(({ sourceKey, side, range }) => ({
      sourceKey,
      side,
      range,
      execution: 'ran',
      status: 'reached',
      why: 'executed',
      level: 'warn',
    }));
    assert.ok(combineClassReach(j2, result.units).every((u) => u.status === 'reached'));
  });

test('additional identical class literals retain their new occurrence', () => {
  const base = "cn('card')",
    head = "cn('card', 'card')";
  const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.tsx');
  const before = map(),
    after = map();
  const result = classifyClassReach([before], [after], changes, [{ base: before, head: after }]);
  assert.deepEqual(
    result.units.map((u) => [u.side, u.token]),
    [['head', 'card']],
  );
});
