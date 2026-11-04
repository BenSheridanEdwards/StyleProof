import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkTmp, rmTmp, spawnSyncBounded } from './helpers.mjs';

const configUrl = new URL('../dist/config.js', import.meta.url).href;
const playwrightUrl = new URL('../bin/project-playwright.mjs', import.meta.url).href;
const workersUrl = new URL('../dist/capture-workers.js', import.meta.url).href;
const require = createRequire(import.meta.url);
const nodeModules = path.resolve(require.resolve('@playwright/test/package.json'), '../../..');
const unwanted =
  /Failed to load the ES module|To load an ES module|MODULE_TYPELESS_PACKAGE_JSON|Type Stripping is an experimental feature/;

function fixture(t, packageType = 'commonjs') {
  const cwd = mkTmp('styleproof-config-warnings-');
  t.after(() => rmTmp(cwd));
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ private: true, ...(packageType === 'commonjs' ? { type: packageType } : {}) }),
  );
  fs.symlinkSync(nodeModules, path.join(cwd, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(cwd, 'user preload.cjs'), 'globalThis.userPreload = true;');
  return cwd;
}

function run(cwd, source) {
  return spawnSyncBounded(process.execPath, ['--input-type=module', '-e', source], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require="./user preload.cjs" --trace-warnings`,
    },
  });
}

for (const [isolated, packageType] of [
  [false, 'commonjs'],
  [true, 'commonjs'],
  [false, 'unspecified'],
  [true, 'unspecified'],
]) {
  test(`CommonJS TypeScript policy loads quietly and preserves warnings/options: isolated=${isolated}, type=${packageType}`, (t) => {
    const cwd = fixture(t, packageType);
    fs.writeFileSync(
      path.join(cwd, 'styleproof.config.ts'),
      `if (!globalThis.userPreload) throw new Error('user preload missing');
       process.emitWarning('policy advisory');
       process.emitWarning('unrelated experiment', 'ExperimentalWarning');
       export default { coverage: { strict: false } };`,
    );
    const result = run(
      cwd,
      `import { loadStyleProofConfigWithLocation, loadStyleProofConfigWithLocationAsync } from ${JSON.stringify(configUrl)};
       const loaded = ${isolated ? 'await loadStyleProofConfigWithLocationAsync(process.cwd(), { isolated: true })' : 'loadStyleProofConfigWithLocation()'};
       console.log(JSON.stringify(loaded.config));`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).coverage.strict, false);
    assert.doesNotMatch(result.stderr, unwanted);
    assert.match(result.stderr, /Warning: policy advisory/);
    assert.match(result.stderr, /ExperimentalWarning: unrelated experiment/);
    assert.match(result.stderr, /at /, 'user trace-warnings option still applies');
  });
}

for (const [usePath, packageType] of [
  [false, 'commonjs'],
  [true, 'commonjs'],
  [false, 'unspecified'],
  [true, 'unspecified'],
]) {
  test(`CommonJS Playwright config loads quietly with settings and warnings: PATH=${usePath}, type=${packageType}`, (t) => {
    const cwd = fixture(t, packageType);
    fs.writeFileSync(
      path.join(cwd, 'playwright.styleproof.config.ts'),
      `import { defineConfig } from '@playwright/test';
       if (!globalThis.userPreload) throw new Error('user preload missing');
       process.emitWarning('playwright advisory');
       process.emitWarning('unrelated experiment', 'ExperimentalWarning');
       export default defineConfig({ testMatch: '**/selected.spec.ts' });`,
    );
    fs.writeFileSync(
      path.join(cwd, 'selected.spec.ts'),
      "import { test } from '@playwright/test'; test('selected', () => {});",
    );
    fs.writeFileSync(path.join(cwd, 'ignored.spec.ts'), "throw new Error('testMatch was ignored');");
    const bin = path.join(cwd, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'playwright'),
      `#!/usr/bin/env node\nprocess.stderr.write('PATH Playwright reached\\n'); require(${JSON.stringify(require.resolve('@playwright/test/cli'))});`,
      { mode: 0o755 },
    );
    const source = `import { projectPlaywright } from ${JSON.stringify(playwrightUrl)};
      import { selectCaptureWorkers } from ${JSON.stringify(workersUrl)};
      await selectCaptureWorkers(['--config=playwright.styleproof.config.ts'], undefined, 8, process.cwd());
      const result = projectPlaywright(['test', '--config=playwright.styleproof.config.ts', '--list'], {
        encoding: 'utf8', env: { ...process.env, PATH: ${JSON.stringify(usePath ? bin + path.delimiter + path.dirname(process.execPath) : '')} }
      });
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
      process.exitCode = result.status ?? 1;`;
    const result = run(cwd, source);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Total: 1 test in 1 file/);
    if (usePath && process.platform !== 'win32') assert.match(result.stderr, /PATH Playwright reached/);
    assert.doesNotMatch(result.stderr, unwanted);
    assert.match(result.stderr, /Warning: playwright advisory/);
    assert.match(result.stderr, /ExperimentalWarning: unrelated experiment/);
    fs.appendFileSync(
      path.join(cwd, 'playwright.styleproof.config.ts'),
      "\nthrow new Error('broken playwright config');",
    );
    const broken = run(cwd, source);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /broken playwright config/);
  });
}

test('CommonJS policy errors remain visible', (t) => {
  const cwd = fixture(t);
  fs.writeFileSync(
    path.join(cwd, 'styleproof.config.ts'),
    "throw new Error('broken policy config'); export default {};",
  );
  const result = run(
    cwd,
    `import { loadStyleProofConfigWithLocation } from ${JSON.stringify(configUrl)}; loadStyleProofConfigWithLocation();`,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken policy config/);
});
