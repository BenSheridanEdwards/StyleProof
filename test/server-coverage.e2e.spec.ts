import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { transform } from 'esbuild';
import { test, expect } from '@playwright/test';
import { readServerCoverage, serverCoverageConfig, persistServerCoverage } from '../bin/server-coverage.mjs';
import { classifyScriptReach } from '../dist/script-join.js';
import { loadStyleMap } from '../dist/capture.js';
import { sha256 } from '../dist/node-util.js';

test('Node webServer teardown supplies evidence for an unrendered server branch', async ({ browserName }, info) => {
  const root = info.outputPath(browserName, 'app');
  fs.mkdirSync(root, { recursive: true });
  const source = `import http from 'node:http'; import fs from 'node:fs'; const offer = '<aside>Offer</aside>', home = '<main>Home</main>';
const render = show => show ? offer : home;
const server = http.createServer((req, res) => res.end(render(false)));
server.listen(0, '127.0.0.1', () => { fs.writeFileSync('port', String(server.address().port)); console.log('READY'); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
  const bundle = await transform(source, { sourcefile: 'page.mjs', sourcemap: 'external', format: 'esm' });
  fs.writeFileSync(path.join(root, 'page.mjs'), source);
  fs.writeFileSync(path.join(root, 'server.mjs'), bundle.code + '\n//# sourceMappingURL=server.mjs.map');
  fs.writeFileSync(path.join(root, 'server.mjs.map'), bundle.map);
  const directory = path.join(root, 'server-v8');
  const server = serverCoverageConfig(
    { command: `node ${JSON.stringify(path.join(root, 'server.mjs'))}` },
    directory,
    false,
  );
  fs.writeFileSync(
    path.join(root, 'playwright.config.cjs'),
    `module.exports = { testDir: '.', outputDir: 'results', webServer: { ...${JSON.stringify(server)}, wait: { stdout: /READY/ }, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } } };`,
  );
  const playwright = path.resolve('node_modules/@playwright/test');
  fs.writeFileSync(
    path.join(root, 'request.spec.cjs'),
    `const { test } = require(${JSON.stringify(playwright)}); test('request', async () => { const fs = require('node:fs'); const port = fs.readFileSync('port', 'utf8'); const response = await fetch('http://127.0.0.1:' + port); if (!(await response.text()).includes('Home')) throw Error('wrong page'); });`,
  );
  execFileSync(
    process.execPath,
    [path.join(playwright, 'cli.js'), 'test', '--config', path.join(root, 'playwright.config.cjs'), '--workers=2'],
    { cwd: root, timeout: 30000, stdio: 'inherit' },
  );
  const scripts = readServerCoverage(directory, root);
  expect(scripts.length).toBeGreaterThan(0);
  const captureFile = path.join(root, 'capture.json');
  fs.writeFileSync(
    captureFile,
    JSON.stringify({ scriptReach: { version: 1, window: 'navigation', status: 'measured', scripts: [] } }),
  );
  persistServerCoverage(root, root);
  expect(loadStyleMap(captureFile).scriptReach?.scripts).toEqual(scripts);
  const reach = { version: 1 as const, window: 'navigation' as const, status: 'measured' as const, scripts };
  const start = source.split('\n')[1].indexOf('offer');
  const range = { start: { line: 2, column: start }, end: { line: 2, column: start + 5 } };
  const result = classifyScriptReach(
    [{ scriptReach: reach }],
    [{ scriptReach: reach }],
    [{ sourceKey: 'page.mjs', side: 'head', range, contentHash: sha256(source), text: source.split('\n')[1] }],
  );
  expect(result.units[0].status).toBe('never-rendered');
  const selected = source.split('\n')[1].indexOf('home');
  const selectedRange = { start: { line: 2, column: selected }, end: { line: 2, column: selected + 4 } };
  const change = {
    sourceKey: 'page.mjs',
    side: 'head' as const,
    range: selectedRange,
    contentHash: sha256(source),
    text: source.split('\n')[1],
  };
  const proof = [
    {
      join: 'J1' as const,
      status: 'reached' as const,
      sourceKey: 'page.mjs',
      side: 'head' as const,
      range: selectedRange,
    },
  ];
  expect(
    classifyScriptReach([{ scriptReach: reach }], [{ scriptReach: reach }], [change], proof).units[0],
  ).toMatchObject({ status: 'reached' });
  const absent = { scriptReach: { ...reach, scripts: [] } };
  expect(classifyScriptReach([absent], [absent], [change], proof).units[0].status).toBe('unmeasured');
});
