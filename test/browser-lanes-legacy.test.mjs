import test from 'node:test';
import { createContentFixture, fileChangeCase, legacyPathCases } from './helpers/browser-lanes-fixtures.mjs';
import { assertHosted } from './helpers/hosted-browser-lanes.mjs';

for (const [title, files] of legacyPathCases) {
  test(`${title} runs the browser lanes`, (t) => {
    for (const [i, name] of files.entries()) assertHosted(createContentFixture(t, fileChangeCase(`legacy-${i}`, name)));
  });
}
