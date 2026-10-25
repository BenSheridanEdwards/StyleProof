import { trackedBrowserCases } from './helpers/browser-lanes-fixtures.mjs';
import { registerLocalBrowserCase } from './helpers/pre-push-e2e-fixtures.mjs';

for (const row of [...trackedBrowserCases().specs, ...trackedBrowserCases().imports]) {
  registerLocalBrowserCase(row);
}
