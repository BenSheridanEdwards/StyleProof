import test from 'node:test';
import { createContentFixture, trackedBrowserCases } from './helpers/browser-lanes-fixtures.mjs';
import { assertHosted } from './helpers/hosted-browser-lanes.mjs';

const tracked = trackedBrowserCases();
test('every tracked e2e spec runs browsers (Playwright collects **/*.e2e.spec.ts anywhere)', (t) => {
  for (const row of tracked.specs) assertHosted(createContentFixture(t, row));
});
test('every browser-lane entry import runs browsers', (t) => {
  for (const row of tracked.imports) assertHosted(createContentFixture(t, row));
});
