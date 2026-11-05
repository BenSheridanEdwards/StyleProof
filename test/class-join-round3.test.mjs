import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { assertDeterministicReach } from '../dist/runner/self-check.js';
import { captureAuthorShadowRoots } from '../dist/capture/class-presence.js';

const facts = { version: 2, ignored: false, shadowHosts: 0, frames: 0, outsideBody: 0, shadowRootsVerified: true };
const map = (extra = {}) => ({
  defaults: {},
  states: {},
  elements: {},
  classPresence: facts,
  reach: {
    version: 2,
    scope: 'compared',
    sheets: ['app.css'],
    rules: [{ key: '.old.new.open.card.btn.known', hash: 'x', sheet: 0 }],
  },
  ...extra,
});
const edits = (base, head) => changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.tsx');
const judge = (base, head, before = map(), after = map()) =>
  classifyClassReach([before], [after], edits(base, head), [{ base: before, head: after }]);
const scriptUnits = (changes) =>
  changes.map(({ sourceKey, side, range }) => ({
    sourceKey,
    side,
    range,
    execution: 'ran',
    status: 'reached',
    why: 'statement executed',
    level: 'warn',
  }));

for (const [name, before, after, positive] of [
  ['add', "el.classList.add('old')", "el.classList.add('new')", true],
  ['add later argument', "el.classList.add('card', 'old')", "el.classList.add('card', 'new')", true],
  ['remove', "el.classList.remove('old')", "el.classList.remove('new')", false],
  ['contains', "el.classList.contains('old')", "el.classList.contains('new')", false],
  ['toggle no force', "el.classList.toggle('old')", "el.classList.toggle('new')", false],
  ['toggle false', "el.classList.toggle('old', false)", "el.classList.toggle('new', false)", false],
  ['toggle true', "el.classList.toggle('old', true)", "el.classList.toggle('new', true)", false],
  ['replace first argument', "el.classList.replace('old', 'card')", "el.classList.replace('new', 'card')", false],
  ['replace second argument', "el.classList.replace('card', 'old')", "el.classList.replace('card', 'new')", true],
  [
    'replace third argument',
    "el.classList.replace('card', 'btn', 'old')",
    "el.classList.replace('card', 'btn', 'new')",
    false,
  ],
  ['data-class', '<div data-class="old"/>', '<div data-class="new"/>', false],
  ['aria-class', '<div aria-class="old"/>', '<div aria-class="new"/>', false],
  ['nested non-helper call', "cn('card', t('old'))", "cn('card', t('new'))", false],
  ['non-helper in class assignment', "el.className = t('old')", "el.className = t('new')", false],
  ['non-helper in template substitution', "cn(`card ${t('old')}`)", "cn(`card ${t('new')}`)", false],
  ['nested recognised helper', "cn('card', clsx('old'))", "cn('card', clsx('new'))", true],
])
  test(`${name} has ${positive ? 'positive' : 'J3-only'} class evidence`, () => {
    const result = judge(before, after);
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((u) => u.explicit === positive));
    const combined = combineClassReach(scriptUnits(edits(before, after)), result.units);
    assert.ok(combined.every((u) => u.status === (positive ? 'never-rendered' : 'reached')));
  });

for (const [before, after, tokens] of [
  ['card', 'btn card', [['head', 'btn']]],
  ['btn card', 'card', [['base', 'btn']]],
  ['card', 'card btn', [['head', 'btn']]],
  ['card card', 'btn card card', [['head', 'btn']]],
  [
    'old card known',
    'new btn card known',
    [
      ['base', 'old'],
      ['head', 'btn'],
      ['head', 'new'],
    ],
  ],
])
  test(`aligned unchanged words survive column movement: ${before} → ${after}`, () => {
    assert.deepEqual(
      judge(`<div className="${before}"/>`, `<div className="${after}"/>`).units.map((u) => [u.side, u.token]),
      tokens,
    );
  });

for (const [name, extra] of [
  ['version one', { classPresence: { version: 1, ignored: false, shadowHosts: 0, frames: 0 } }],
  ['outside-body children', { classPresence: { ...facts, outsideBody: 1 } }],
  ['unverified shadow roots', { classPresence: { ...facts, shadowRootsVerified: undefined } }],
  ['unstable omission facts', { classPresence: { ...facts, unstable: true } }],
])
  test(`${name} cannot prove class absence`, () => {
    const result = judge('el.className="old"', 'el.className="new"', map(extra), map(extra));
    assert.ok(result.units.every((u) => u.status === 'unknown'));
  });

test('matching unchanged neighbours does not erase reordered class words', () => {
  const result = judge("twMerge('old new')", "twMerge('new old')");
  assert.deepEqual(new Set(result.units.map((u) => u.side)), new Set(['base', 'head']));
});

for (const [file, before, after] of [
  ['App.svelte', '<div data-class="old"/>', '<div data-class="new"/>'],
  ['App.vue', '<div data-class="old"/>', '<div data-class="new"/>'],
  ['App.svelte', '<div class="card {t(\'old\')}"/>', '<div class="card {t(\'new\')}"/>'],
  ['App.vue', "<div :class=\"cn('card', t('old'))\"/>", "<div :class=\"cn('card', t('new'))\"/>"],
])
  test(`framework bindings preserve J3-only contexts: ${file} ${before}`, () => {
    const beforeMap = map(),
      afterMap = map();
    const changes = changedScriptRanges(`@@ -1 +1 @@\n-${before}\n+${after}\n`, { base: before, head: after }, file);
    const result = classifyClassReach([beforeMap], [afterMap], changes, [{ base: beforeMap, head: afterMap }]);
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((u) => !u.explicit));
    assert.ok(combineClassReach(scriptUnits(changes), result.units).every((u) => u.status === 'reached'));
  });

for (const side of ['base', 'head'])
  test(`an unpaired ${side} surface leaves both sides conservative`, () => {
    const base = map(),
      head = map(),
      extra = map();
    const result = classifyClassReach(
      side === 'base' ? [base, extra] : [base],
      side === 'head' ? [head, extra] : [head],
      edits('el.className="old"', 'el.className="new"'),
      [{ base, head }],
    );
    assert.ok(result.units.every((u) => u.status === 'unknown'));
  });

for (const [firstFrames, secondFrames] of [
  [0, 1],
  [1, 0],
])
  test(`self-check keeps omission uncertainty: ${firstFrames} → ${secondFrames}`, () => {
    const first = map({ classPresence: { ...facts, frames: firstFrames } }),
      again = map({ classPresence: { ...facts, frames: secondFrames } });
    assert.doesNotThrow(() => assertDeterministicReach(first, again, 'home'));
    assert.equal(first.classPresence.unstable, true);
    assert.ok(
      judge('el.className="old"', 'el.className="new"', first, first).units.every((u) => u.status === 'unknown'),
    );
  });

test('CDP counts author roots, excludes user-agent/framework roots and detaches', async () => {
  let detached = false;
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (method, options) => {
          assert.equal(method, 'DOM.getDocument');
          assert.deepEqual(options, { depth: -1, pierce: true });
          return {
            root: {
              nodeType: 9,
              children: [
                { nodeName: 'INPUT', shadowRoots: [{ shadowRootType: 'user-agent' }] },
                { nodeName: 'DIV', shadowRoots: [{ shadowRootType: 'closed' }] },
                { nodeName: 'NEXT-ROUTE-ANNOUNCER', shadowRoots: [{ shadowRootType: 'open' }] },
              ],
            },
          };
        },
        detach: async () => {
          detached = true;
        },
      }),
    }),
  };
  assert.equal(await captureAuthorShadowRoots(page), 1);
  assert.equal(detached, true);
});

test('failed CDP never supplies a verified zero', async () => {
  let detached = false;
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async () => {
          throw new Error('protocol unavailable');
        },
        detach: async () => {
          detached = true;
        },
      }),
    }),
  };
  assert.equal(await captureAuthorShadowRoots(page), undefined);
  assert.equal(detached, true);
});
