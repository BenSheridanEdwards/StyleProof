import { SUBMITS_FORM_SOURCE, cssContentText, DANGER_SOURCE, DANGER_TEXT_SOURCE } from '../dist/danger.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const cssSources = (...args) => [cssContentText(...args)].flat().filter((value) => typeof value === 'string');
const generatedUnsafe = (...args) => cssSources(...args).some((value) => new RegExp(DANGER_SOURCE, 'i').test(value));

test('cssContentText: joins and unescapes CSS string tokens', () => {
  assert.ok(cssSources('"Delete"').includes('Delete'));
  assert.ok(cssSources('"De" "lete"').includes('Delete'));
  assert.ok(cssSources('"\\44 elete"').includes('Delete'));
});

for (const content of [
  'none',
  'normal',
  'url(x)',
  'counter(c)',
  'open-quote',
  'close-quote',
  'no-open-quote',
  'no-close-quote',
  'counter(n, "Delete")',
  'url("Delete.svg")',
  'image("Delete.svg")',
]) {
  test(`cssContentText: non-text ${content}`, () => {
    assert.deepEqual(cssSources(content), []);
  });
}

for (const [content, expected] of [
  ['"a" counter(c)', 'a'],
  ['"Delete " counter(n)', 'Delete'],
  ['"\\f1f8" / "Delete"', 'Delete'],
  ['url(x.svg) / "Delete"', 'Delete'],
]) {
  test(`cssContentText: retains text in ${content}`, () => {
    assert.ok(cssSources(content).some((value) => value.includes(expected)));
  });
}

test('cssContentText: resolves attr(data-label) on its originating element', () => {
  const el =
    typeof globalThis.document === 'undefined'
      ? { getAttribute: (name) => (name === 'data-label' ? 'Delete' : null) }
      : globalThis.document.createElement('button');
  el.setAttribute?.('data-label', 'Delete');
  assert.ok(cssSources('attr(data-label)', el).includes('Delete'));
});

for (const content of [
  '"Trash" / "Delete"',
  '"Item" counter(n) "Delete"',
  'url(x.svg) "X" / "Remove"',
  '"X" "Delete" "Y"',
  'counters(n, "Delete")',
  'counter(n, symbols("Delete" "Remove"))',
  'symbols(cyclic "Delete" "Remove")',
]) {
  test(`generated guard: ${content} is unsafe`, () => {
    assert.equal(generatedUnsafe(content), true);
  });
}

for (const token of [
  'counter(n)',
  'counters(n, ".")',
  'url(x.svg)',
  'image("x.svg")',
  'open-quote',
  'close-quote',
  'no-open-quote',
  'no-close-quote',
  'attr(data-missing)',
]) {
  test(`cssContentText: ${token} preserves a word boundary`, () => {
    assert.ok(cssSources(`"Item" ${token} "Delete"`).includes('Item Delete'));
    assert.equal(generatedUnsafe(`"Item" ${token} "Delete"`), true);
  });
}

test('cssContentText: content and alt text are independent sources', () => {
  const sources = cssSources('"Trash" / "Delete"');
  assert.ok(sources.includes('Trash'));
  assert.ok(sources.includes('Delete'));
  assert.ok(!sources.includes('TrashDelete'));
});

for (const content of ['attr(data-x string)', 'attr(data-x type(<string>))', 'attr(ns|data-x string)']) {
  test(`generated guard: resolves ${content}`, () => {
    const el = { getAttribute: (name) => (['data-x', 'ns|data-x'].includes(name) ? 'Delete' : null) };
    assert.equal(generatedUnsafe(content, el), true);
  });
}

test('generated guard: attr(data-x, "Delete") uses a missing attribute fallback', () => {
  assert.equal(generatedUnsafe('attr(data-x, "Delete")', { getAttribute: () => null }), true);
});

test('cssContentText: attr() prefers the attribute and ignores missing values without fallback', () => {
  assert.equal(generatedUnsafe('attr(data-x, "Delete")', { getAttribute: () => 'Profile' }), false);
  assert.deepEqual(cssSources('attr(data-x string)', { getAttribute: () => null }), []);
});

test('danger text source: evaluates without imported helpers', () => {
  const gather = new Function(`return ${DANGER_TEXT_SOURCE}`)();
  assert.deepEqual(gather(null, 'Delete'), ['Delete', 'Delete']);
  assert.equal(gather(null), null);
  if (typeof globalThis.document !== 'undefined') {
    const el = globalThis.document.createElement('button');
    el.textContent = 'Delete';
    assert.ok(gather(el).includes('Delete'));
  }
});

const source = readFileSync(new URL('../dist/variant-crawler.js', import.meta.url), 'utf8');

const perform = runInNewContext(`(${source.match(/async function perform[\s\S]*?(?=function liveStatesFrom)/)[0]})`);

for (const valid of [true, false]) {
  test(`empty submission only invokes validation for an invalid form: valid=${valid}`, async () => {
    let submissions = 0;
    const form = { querySelectorAll: () => [], checkValidity: () => valid, requestSubmit: () => submissions++ };
    const page = { locator: () => ({ first: () => ({ evaluate: (fn) => fn(form) }) }) };
    await perform(page, { action: 'submit-empty', selector: 'form' });
    assert.equal(submissions, valid ? 0 : 1);
  });
}

for (const custom of [false, true])
  for (const relation of ['self', 'ancestor', 'label', 'wrapper', 'contained-label', 'attribute'])
    test(`submit guard: custom=${custom}, relation=${relation}`, () => {
      const form = { localName: 'form' };

      const submit = {
        localName: custom ? 'form-button' : 'button',
        type: 'submit',
        form,
        getAttribute: (name) =>
          name === 'type' ? submit.type : name === 'form' && relation === 'attribute' ? 'owner' : null,
        closest: () => (relation === 'attribute' ? null : submit.form),
      };

      const guard = runInNewContext(`(${SUBMITS_FORM_SOURCE})`, {
        customElements: { get: (name) => (name === 'form-button' ? { formAssociated: true } : undefined) },
        document: { getElementById: () => submit.form },
      });

      const candidates = {
        self: submit,
        attribute: submit,
        ancestor: { parentElement: submit },
        label: { closest: () => ({ control: submit }) },
        wrapper: { querySelectorAll: () => [submit] },
        'contained-label': { querySelectorAll: () => [{ localName: 'label', control: submit }] },
      };

      for (const state of ['submit', 'ownerless', 'button', 'reset']) {
        const owner = state === 'ownerless' ? null : form;
        const type = state === 'ownerless' ? 'submit' : state;
        submit.form = owner;
        submit.type = type;
        assert.equal(guard(candidates[relation]), Boolean(owner && type === 'submit'));
      }
    });
