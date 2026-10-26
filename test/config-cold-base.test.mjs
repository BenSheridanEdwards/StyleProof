import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

for (const extension of ['mjs', 'ts']) {
  test(`map CLI loads cold-base .${extension} config after head Playwright is imported`, () => {
    const root = mkTmp('styleproof-map-cold-config-');
    const require = createRequire(import.meta.url);
    try {
      fs.mkdirSync(path.join(root, '.git'));
      // A cold npm checkout has its own physical Playwright installation.
      for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
        const target = path.join(root, 'node_modules', name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.dirname(require.resolve(`${name}/package.json`)), target, { recursive: true });
      }
      fs.writeFileSync(
        path.join(root, `styleproof.config.${extension}`),
        "import { test } from '@playwright/test';\nexport default { spec: 'cold-base-selected.spec.ts' };\n",
      );
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../bin/styleproof-map.mjs', import.meta.url)), '--no-upload'],
        { cwd: root, encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(result.error, undefined);
      assert.doesNotMatch(result.stderr, /Requiring @playwright\/test second time/);
      assert.match(result.stderr, /cold-base-selected\.spec\.ts/);
      assert.equal(result.status, 2, result.stderr);
    } finally {
      rmTmp(root);
    }
  });
}

for (const [extension, source, expected] of [
  ['json', '{', /styleproof\.config\.json: invalid JSON/],
  ['mjs', 'export default { coverage: { strict: "yes" } };', /styleproof\.config\.mjs:.*strict/],
  ['mjs', "import 'styleproof-missing-config-package';", /Cannot find package 'styleproof-missing-config-package'/],
]) {
  test(`map CLI reports a clean single-line .${extension} config error: ${source}`, () => {
    const root = mkTmp('styleproof-map-config-error-');
    try {
      fs.mkdirSync(path.join(root, '.git'));
      fs.writeFileSync(path.join(root, `styleproof.config.${extension}`), source);
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../bin/styleproof-map.mjs', import.meta.url)), '--no-upload'],
        { cwd: root, encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, expected);
      assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
      assert.equal(result.stderr.split(`styleproof.config.${extension}:`).length - 1, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /Node\.js v|at file:|could not load — .*could not load/);
    } finally {
      rmTmp(root);
    }
  });
}
