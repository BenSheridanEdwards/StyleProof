import { fileChangeCase, legacyPathCases } from './helpers/browser-lanes-fixtures.mjs';
import { registerLocalBrowserCase } from './helpers/pre-push-e2e-fixtures.mjs';

for (const row of [
  ...legacyPathCases.flatMap(([title, files], i) =>
    files.map((name, j) => ({
      ...fileChangeCase(`legacy-${i + 1}-${j + 1}`, name, title),
      ...(name === 'package.json' ? { before: '{"description":"base"}', after: '{"description":"changed"}' } : {}),
    })),
  ),
]) {
  registerLocalBrowserCase(row);
}
