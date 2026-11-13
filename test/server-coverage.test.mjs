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
