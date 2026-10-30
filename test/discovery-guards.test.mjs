import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../dist/variant-crawler.js', import.meta.url), 'utf8');

const performSource = source.slice(
  source.indexOf('async function perform('),
  source.indexOf('function liveStatesFrom('),
);

const perform = runInNewContext(`(${performSource.trim()})`);

for (const valid of [true, false]) {
  test(`empty submission only invokes validation for an invalid form: valid=${valid}`, async () => {
    let submissions = 0;

    const form = {
      querySelectorAll: () => [],
      checkValidity: () => valid,
      requestSubmit: () => {
        submissions++;
      },
    };

    const page = { locator: () => ({ first: () => ({ evaluate: (fn) => fn(form) }) }) };
    await perform(page, { action: 'submit-empty', selector: 'form' });
    assert.equal(submissions, valid ? 0 : 1);
  });
}
