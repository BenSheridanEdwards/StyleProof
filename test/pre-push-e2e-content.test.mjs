import { contentCases } from './helpers/browser-lanes-fixtures.mjs';
import { registerLocalBrowserCase } from './helpers/pre-push-e2e-fixtures.mjs';

for (const row of contentCases) {
  registerLocalBrowserCase(row);
}
