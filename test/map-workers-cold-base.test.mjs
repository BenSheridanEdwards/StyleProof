import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import '../dist/runner.js';
import { defaultCaptureWorkers, selectCaptureWorkers } from '../dist/capture-workers.js';
import { mkNonGitTmp, rmTmp, spawnSyncToCompletion } from './helpers.mjs';

const MAP = fileURLToPath(new URL('../bin/styleproof-map.mjs', import.meta.url));

function coldCheckout(t, extension, options) {
  const root = mkNonGitTmp('styleproof-cold-workers-');
  t.after(() => rmTmp(root));
  const packageDir = path.join(root, 'node_modules/@playwright/test');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@playwright/test', type: 'module', exports: './index.js' }),
  );
  // Match Playwright's process-wide guard: this checkout loads alone, but a
  // capture CLI that already imported the head runner cannot load a second copy.
  fs.writeFileSync(
    path.join(packageDir, 'index.js'),
    `if (process.__pw_initiator__) throw new Error('Requiring @playwright/test second time');
     process.__pw_initiator__ = new Error().stack;
     export const defineConfig = config => config;`,
  );
  const configFile = `playwright.styleproof.config.${extension}`;
  fs.writeFileSync(
    path.join(root, configFile),
    `import { defineConfig } from '@playwright/test';
     export default defineConfig(${options});`,
  );

  return { root, configFile, args: ['--config', configFile] };
}

for (const extension of ['ts', 'mjs']) {
  test(`cold-base .${extension} config without workers retains the default after loading the head runner`, async (t) => {
    const fixture = coldCheckout(t, extension, '{ fullyParallel: true, metadata: { workers: 4 } }');
    const configUrl = pathToFileURL(path.join(fixture.root, fixture.configFile)).href;

    const standalone = spawnSyncToCompletion(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `console.log(JSON.stringify((await import(${JSON.stringify(configUrl)})).default));`,
      ],
      { cwd: fixture.root, encoding: 'utf8' },
    );

    assert.equal(standalone.status, 0, standalone.stderr);
    assert.deepEqual(JSON.parse(standalone.stdout), { fullyParallel: true, metadata: { workers: 4 } });

    assert.deepEqual(await selectCaptureWorkers(fixture.args, undefined, 12, fixture.root), {
      count: defaultCaptureWorkers(12),
      source: 'default',
    });
  });

  test(`cold-base .${extension} config with workers preserves its own choice`, async (t) => {
    const fixture = coldCheckout(t, extension, '{ ...{ workers: 4 }, fullyParallel: true }');

    assert.equal(await selectCaptureWorkers(fixture.args, undefined, 12, fixture.root), undefined);
  });

  test(`unloadable cold-base .${extension} config conservatively leaves workers alone`, async (t) => {
    const fixture = coldCheckout(t, extension, '{}');
    fs.writeFileSync(path.join(fixture.root, fixture.configFile), "import './missing-config-dependency.js';");

    assert.equal(await selectCaptureWorkers(fixture.args, undefined, 12, fixture.root), undefined);
  });
}

test('cold-base worker selection keeps explicit arguments ahead of STYLEPROOF_WORKERS and config', async (t) => {
  const fixture = coldCheckout(t, 'ts', '{ workers: 4 }');

  for (const args of [['--workers', '3'], ['--workers=3'], ['-j', '3'], ['-j3']]) {
    assert.equal(await selectCaptureWorkers([...fixture.args, ...args], '5', 12, fixture.root), undefined);
  }

  assert.deepEqual(await selectCaptureWorkers(fixture.args, '5', 12, fixture.root), {
    count: 5,
    source: 'STYLEPROOF_WORKERS',
  });
});

test('head map CLI capturing a cold checkout passes and logs the default worker count', (t) => {
  const fixture = coldCheckout(t, 'ts', '{ fullyParallel: true }');
  fs.mkdirSync(path.join(fixture.root, 'e2e'));
  fs.writeFileSync(path.join(fixture.root, 'e2e/styleproof.spec.ts'), '// shimmed capture');
  const bin = path.join(fixture.root, 'fake-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'playwright'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > capture-argv\nmkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"\ntouch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@1280.json"\n',
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.STYLEPROOF_WORKERS;

  const result = spawnSyncToCompletion(
    process.execPath,
    [MAP, '--no-upload', '--base-dir', path.join(fixture.root, 'maps')],
    { cwd: fixture.root, env, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const cpus = os.availableParallelism();
  const workers = defaultCaptureWorkers(cpus);
  const argv = fs.readFileSync(path.join(fixture.root, 'capture-argv'), 'utf8').trim().split('\n');
  assert.deepEqual(argv.slice(3), ['--config', fixture.configFile, `--workers=${workers}`]);
  assert.ok(result.stderr.includes(`styleproof-map: workers=${workers} (default: ${cpus} cpus)\n`), result.stderr);
});
