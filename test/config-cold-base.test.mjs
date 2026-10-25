import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadStyleProofConfigWithLocationAsync } from '../dist/config.js';
import { mkTmp, rmTmp } from './helpers.mjs';

for (const extension of ['mjs', 'ts']) {
  test(`CI loads head then isolated cold-base .${extension} config with separate Playwright copies`, async () => {
    const root = mkTmp('styleproof-cold-config-');
    const guard = `styleproof-test-playwright-${root}`;
    try {
      for (const checkout of ['head', 'base']) {
        const dir = path.join(root, checkout);
        fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
        for (const [name, source] of [
          [
            'playwright',
            `const key = Symbol.for(${JSON.stringify(guard)});
            if (globalThis[key] && globalThis[key] !== import.meta.url)
              throw new Error('Requiring @playwright/test second time');
            globalThis[key] = import.meta.url;`,
          ],
          ['@playwright/test', "import 'playwright';"],
          ['styleproof', "import '@playwright/test'; export const defineConfig = config => config;"],
        ]) {
          const packageDir = path.join(dir, 'node_modules', name);
          fs.mkdirSync(packageDir, { recursive: true });
          fs.writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ name, type: 'module', exports: './index.js' }),
          );
          fs.writeFileSync(path.join(packageDir, 'index.js'), source);
        }
        fs.writeFileSync(
          path.join(dir, `styleproof.config.${extension}`),
          `import { defineConfig } from 'styleproof';
           export default defineConfig({ spec: '${checkout}/capture.spec.ts', coverage: { strict: true } });`,
        );
      }
      const head = await loadStyleProofConfigWithLocationAsync(path.join(root, 'head'));
      assert.equal(head.config.spec, 'head/capture.spec.ts');
      const base = await loadStyleProofConfigWithLocationAsync(path.join(root, 'base'), { isolated: true });
      assert.equal(base.config.spec, 'base/capture.spec.ts');
      assert.equal(base.config.coverage.strict, true);
      assert.equal(base.configDir, path.join(root, 'base'));
      assert.equal(base.configFile, `styleproof.config.${extension}`);
    } finally {
      delete globalThis[Symbol.for(guard)];
      rmTmp(root);
    }
  });
}
