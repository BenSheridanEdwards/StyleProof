import { SUBMITS_FORM_SOURCE } from '../dist/danger.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../dist/variant-crawler.js', import.meta.url), 'utf8');

const performSource = source.match(/async function perform\([\s\S]*?(?=function liveStatesFrom)/)[0];
const perform = runInNewContext(`(${performSource.trim()})`);
for (const valid of [true, false]) {
  test(`empty submission only invokes validation for an invalid form: valid=${valid}`, async () => {
    let submissions = 0;

    const form = {
      querySelectorAll: () => [],
      checkValidity: () => valid,
      requestSubmit: () => submissions++,
    };

    const page = { locator: () => ({ first: () => ({ evaluate: (fn) => fn(form) }) }) };
    await perform(page, { action: 'submit-empty', selector: 'form' });
    assert.equal(submissions, valid ? 0 : 1);
  });
}

for (const relation of ['ancestor', 'label', 'wrapper', 'contained-label']) {
  test(`submit guard rejects ${relation}`, () => {
    const guard = runInNewContext(`(${SUBMITS_FORM_SOURCE})`);
    const submit = { tagName: 'BUTTON', type: 'submit', form: {} };

    const el = {
      closest: (selector) => (selector === 'label' ? { control: submit } : null),
      querySelectorAll: () => [relation === 'wrapper' ? submit : { tagName: 'LABEL', control: submit }],
    };

    if (relation === 'ancestor') el.closest = () => submit;

    if (relation === 'wrapper' || relation === 'contained-label') el.closest = () => null;
    assert.equal(guard(el), true);
    submit.form = null;
    assert.equal(guard(el), false);
  });
}
