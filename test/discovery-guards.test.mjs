import { SUBMITS_FORM_SOURCE } from '../dist/danger.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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
