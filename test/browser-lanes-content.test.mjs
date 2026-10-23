import test from 'node:test';
import { contentCases, createContentFixture } from './helpers/browser-lanes-fixtures.mjs';
import { assertHosted } from './helpers/hosted-browser-lanes.mjs';

for (const row of contentCases) {
  test(`H ${row.id}: ${row.title} runs browsers and required rejects skipped lanes`, (t) => {
    const fixture = createContentFixture(t, row);
    assertHosted(fixture);
  });
}
