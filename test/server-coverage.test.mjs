import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeWebServer } from '../bin/server-coverage.mjs';

test('recognises explicit Node launchers conservatively', () => {
  for (const command of ['node server.mjs', 'tsx server.ts', 'ts-node server.ts', 'pnpm exec next dev'])
    assert.equal(nodeWebServer(command), true, command);
});

test('non-Node and ambiguous shell commands stay unmeasured', () => {
  for (const command of [
    'python server.py',
    'nginx',
    './server',
    'echo node',
    'npm run dev',
    'node server.mjs && python server.py',
  ])
    assert.equal(nodeWebServer(command), false, command);
});

test('only recognised servers receive coverage and existing env is retained', async () => {
  const { serverCoverageConfig } = await import('../bin/server-coverage.mjs');
  assert.deepEqual(serverCoverageConfig({ command: 'node server.mjs', env: { PORT: '3000' } }, '/coverage', false), {
    command: 'node server.mjs',
    env: {
      PORT: '3000',
      NODE_V8_COVERAGE: '/coverage',
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('../bin/server-coverage-preload.mjs', import.meta.url).href}`.trim(),
    },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    reuseExistingServer: false,
  });
  assert.deepEqual(serverCoverageConfig({ command: 'python server.py' }, '/coverage', false), {
    command: 'python server.py',
    reuseExistingServer: false,
  });
  assert.deepEqual(serverCoverageConfig({ command: 'node server.mjs' }, '/coverage', true), {
    command: 'node server.mjs',
    reuseExistingServer: true,
  });
});

test('absent server coverage supplies no execution evidence', async () => {
  const { readServerCoverage } = await import('../bin/server-coverage.mjs');
  assert.deepEqual(readServerCoverage('/nonexistent-styleproof-coverage', process.cwd()), []);
});

test('runCapture wrapper and persistence isolate primary and oracle coverage', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { randomUUID } = await import('node:crypto');
  const { persistServerCoverage } = await import('../bin/server-coverage.mjs');
  const { loadStyleMap } = await import('../dist/capture/map-io.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-run-'));
  try {
    const selectedConfig = path.join(root, 'playwright.config.mjs');
    fs.writeFileSync(selectedConfig, 'export default { webServer: { command: "node server.mjs" } };');
    const source = fs.readFileSync(new URL('../bin/styleproof-map.mjs', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('const runCapture ='), source.indexOf('/** Capture test titles'));
    const moduleSource = body.replaceAll(
      'import.meta.url',
      JSON.stringify(new URL('../bin/styleproof-map.mjs', import.meta.url).href),
    );
    const runCapture = new Function(
      'fs',
      'path',
      'selectedConfig',
      'randomUUID',
      'process',
      'externalServer',
      'projectPlaywrightAsync',
      'captureEnv',
      'persistServerCoverage',
      'baseDir',
      'targetDir',
      'CAPTURE_TEST_GREP',
      'configArgs',
      'playwrightArgs',
      'workerArgs',
      'pathToFileURL',
      moduleSource + '\nreturn runCapture;',
    )(
      fs,
      path,
      selectedConfig,
      randomUUID,
      process,
      false,
      async (args, { env }) => {
        const config = (await import(args.at(-1))).default;
        const directory = path.resolve(root, env.STYLEMAP_DIR);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, 'map.json'),
          JSON.stringify({
            scriptReach: { version: 1, window: 'navigation', status: 'measured', scripts: [] },
          }),
        );
        const coverage = config.webServer.env.NODE_V8_COVERAGE;
        fs.mkdirSync(coverage, { recursive: true });
        const filename = path.join(process.cwd(), path.basename(root) + '.js');
        const map = { version: 3, sources: ['page.js'], sourcesContent: ['hello'], names: [], mappings: 'AAAA' };
        fs.writeFileSync(
          filename,
          'hello\n//# sourceMappingURL=data:application/json;base64,' +
            Buffer.from(JSON.stringify(map)).toString('base64'),
        );
        {
          fs.writeFileSync(
            path.join(coverage, 'coverage.json'),
            JSON.stringify({
              result: [
                {
                  url: (await import('node:url')).pathToFileURL(filename).href,
                  functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }],
                },
              ],
            }),
          );
          return { status: 0 };
        }
      },
      (label) => ({ STYLEMAP_DIR: label }),
      persistServerCoverage,
      root,
      path.join(root, 'primary'),
      'capture',
      [],
      [],
      [],
      (await import('node:url')).pathToFileURL,
    );
    for (const label of ['primary', path.join(root, 'oracle')]) await runCapture(label);
    for (const label of ['primary', 'oracle']) {
      assert.equal(loadStyleMap(path.join(root, label, 'map.json')).scriptReach.scripts.length, 1, label);
      assert.equal(fs.existsSync(path.join(root, label, 'server-v8')), false);
    }
  } finally {
    fs.rmSync(path.join(process.cwd(), path.basename(root) + '.js'), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
