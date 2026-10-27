import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkNonGitTmp, rmTmp, spawnSyncToCompletion } from './helpers.mjs';

const MAP = fileURLToPath(new URL('../bin/styleproof-map.mjs', import.meta.url));
const cpus = os.availableParallelism();
const expectedWorkers = Math.max(Math.ceil(cpus / 2), cpus - 2);

test('default capture workers leave two CPUs free, with at least half available', async () => {
  const { defaultCaptureWorkers } = await import('../dist/capture-workers.js');

  for (const [cpus, workers] of [
    [1, 1],
    [2, 1],
    [4, 2],
    [12, 10],
    [16, 14],
  ]) {
    assert.equal(defaultCaptureWorkers(cpus), workers, `${cpus} CPUs`);
  }
});

function capture(t, { args = [], workers, configFile, config } = {}) {
  const root = mkNonGitTmp('styleproof-workers-');
  t.after(() => rmTmp(root));
  fs.mkdirSync(path.join(root, 'e2e'));
  fs.writeFileSync(path.join(root, 'e2e/styleproof.spec.ts'), '// shimmed capture');
  const bin = path.join(root, 'fake-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'playwright'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > capture-argv\nmkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"\ntouch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@1280.json"\n',
    { mode: 0o755 },
  );

  if (configFile && config !== undefined) fs.writeFileSync(path.join(root, configFile), config);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.STYLEPROOF_WORKERS;

  if (workers !== undefined) env.STYLEPROOF_WORKERS = workers;

  const result = spawnSyncToCompletion(
    process.execPath,
    [MAP, '--no-upload', '--base-dir', path.join(root, 'maps'), '--', ...args],
    { cwd: root, env, encoding: 'utf8' },
  );

  const argvFile = path.join(root, 'capture-argv');
  const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').trim().split('\n') : [];

  return { ...result, argv };
}

function assertCapture(result, extraArgs, log) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.argv.slice(3), extraArgs);

  const workerLogs = (result.stdout + result.stderr)
    .split('\n')
    .filter((line) => line.startsWith('styleproof-map: workers='));

  assert.deepEqual(workerLogs, log ? [`styleproof-map: ${log}`] : []);
}

test('map capture supplies a default worker count and logs the CPU count', (t) => {
  assertCapture(capture(t), [`--workers=${expectedWorkers}`], `workers=${expectedWorkers} (default: ${cpus} cpus)`);
});

for (const args of [['-j', '3'], ['-j3'], ['--workers', '3'], ['--workers=3']]) {
  test(`map capture preserves explicit ${args.join(' ')} without another worker flag`, (t) => {
    assertCapture(capture(t, { args }), args);
    assertCapture(capture(t, { args, workers: '5' }), args);
  });
}

test('STYLEPROOF_WORKERS supplies the worker count and logs its source', (t) => {
  assertCapture(capture(t, { workers: '5' }), ['--workers=5'], 'workers=5 (STYLEPROOF_WORKERS)');
});

for (const workers of ['', '0', '-1', '1.5', '50%', 'many', '9007199254740992']) {
  test(`map capture rejects invalid STYLEPROOF_WORKERS=${JSON.stringify(workers)} before Playwright`, (t) => {
    const result = capture(t, { workers });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /STYLEPROOF_WORKERS.*positive integer/);
    assert.deepEqual(result.argv, []);
  });
}

for (const [configFile, args] of [
  ['playwright.styleproof.config.ts', []],
  ['playwright.config.ts', []],
  ['playwright.config.mjs', []],
  ['custom.ts', ['--config', 'custom.ts']],
  ['custom.ts', ['--config=custom.ts']],
  ['custom.ts', ['-c', 'custom.ts']],
  ['custom.ts', ['-ccustom.ts']],
]) {
  test(`map capture respects workers in ${configFile} via ${args.join(' ') || 'discovery'}`, (t) => {
    const config = 'const options = { workers: 4 }; export default { ...options };';
    const configArgs = configFile === 'playwright.styleproof.config.ts' ? ['--config', configFile] : args;
    assertCapture(capture(t, { configFile, config, args }), configArgs);
  });
}

test('map capture defaults workers when config has no top-level workers', (t) => {
  const result = capture(t, {
    configFile: 'playwright.config.mjs',
    config: 'export default { fullyParallel: true, metadata: { workers: 4 } };',
  });

  assertCapture(result, [`--workers=${expectedWorkers}`], `workers=${expectedWorkers} (default: ${cpus} cpus)`);
});

for (const config of [
  'throw new Error("unloadable config");',
  'export default { get workers() { throw new Error("unreadable workers"); } };',
  'export default { workers: undefined };',
]) {
  test(`map capture leaves workers alone when config inspection is uncertain: ${config}`, (t) => {
    const configFile = 'playwright.styleproof.config.ts';
    assertCapture(capture(t, { configFile, config }), ['--config', configFile]);
  });
}

test('STYLEPROOF_WORKERS overrides config workers', (t) => {
  assertCapture(
    capture(t, {
      workers: '5',
      configFile: 'playwright.styleproof.config.ts',
      config: 'export default { workers: 4 };',
    }),
    ['--config', 'playwright.styleproof.config.ts', '--workers=5'],
    'workers=5 (STYLEPROOF_WORKERS)',
  );
});
